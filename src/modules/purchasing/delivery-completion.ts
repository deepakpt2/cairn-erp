/**
 * Delivery completion policy — whether a goods receipt closes the item it posts against.
 *
 * One plant wants the balance closed as soon as a delivery lands inside the underdelivery
 * tolerance: the supplier has done enough, and an open residue of four units is noise that
 * somebody would otherwise chase for a month. Another wants a buyer to decide every time,
 * because a closed item stops receiving and the buyer is the one who knows whether more is
 * coming. Both are right, so the rule is configuration rather than a constant.
 *
 * It is held as a company-code default with a plant override. A plant row wins; a plant
 * with no row inherits the company code it belongs to; and with no row at all the answer
 * is no — an item closes when somebody closes it, which is how the application behaved
 * before this policy existed.
 *
 * The decision is a pure function of what was configured and what has been received, so it
 * can be read without a database in reach.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { companyCode, plant } from '../foundation/schema';
import { purchaseDeliveryCompletionPlant, purchaseDeliveryCompletionPolicy } from './schema';

/** The capability that names this screen. */
export const ACTIVITY = 'PROC.DELIVERYCOMPLETION.CONFIGURE';

export interface DeliveryCompletionDecision {
  /** Whether the receipt closes the item. */
  close: boolean;
  /** Why. Shown to the buyer, so it names the figures it judged. */
  reason: string;
}

export interface DeliveryCompletionPolicy {
  autoClose: boolean;
  /** Where the answer came from, so a refusal can say whose rule it was. */
  source: string;
}

/**
 * Whether a receipt that has brought an item to `receivedAfter` closes it.
 *
 * Tolerance is a floor, not a ceiling: the item closes once what has been received is at
 * least what was ordered less the underdelivery tolerance. A receipt that overshoots closes
 * it too — the quantity is met and passed.
 */
export function deliveryCompletionDecision(input: {
  autoClose: boolean;
  ordered: number;
  receivedAfter: number;
  underdeliveryTolerance: number;
}): DeliveryCompletionDecision {
  if (!input.autoClose) {
    return {
      close: false,
      reason: 'Delivery completion is not set by a receipt here. The item stays open until someone closes it.',
    };
  }
  const floor = input.ordered * (1 - Math.max(0, input.underdeliveryTolerance) / 100);
  if (input.receivedAfter + 1e-9 < floor) {
    return {
      close: false,
      reason:
        `Received ${input.receivedAfter} of ${input.ordered} is below the underdelivery floor of ${round3(floor)} `
        + `(${input.underdeliveryTolerance}% under). The item stays open.`,
    };
  }
  return {
    close: true,
    reason:
      `Received ${input.receivedAfter} of ${input.ordered} has reached the underdelivery floor of ${round3(floor)} `
      + `(${input.underdeliveryTolerance}% under). The item is closed.`,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The rule that stands for a plant: its own row if it keeps one, otherwise the company it
 * belongs to, otherwise no closure by receipt at all.
 */
export async function readDeliveryCompletionPolicy(
  tx: Tx,
  client: string,
  companyCode: string,
  plantCode: string,
): Promise<DeliveryCompletionPolicy> {
  const [override] = await tx.select().from(purchaseDeliveryCompletionPlant).where(and(
    eq(purchaseDeliveryCompletionPlant.client, client),
    eq(purchaseDeliveryCompletionPlant.plant, plantCode),
  )).limit(1);
  if (override) {
    return { autoClose: override.autoClose, source: `the rule kept for plant ${plantCode}` };
  }
  const [fallback] = await tx.select().from(purchaseDeliveryCompletionPolicy).where(and(
    eq(purchaseDeliveryCompletionPolicy.client, client),
    eq(purchaseDeliveryCompletionPolicy.companyCode, companyCode),
  )).limit(1);
  if (fallback) {
    return { autoClose: fallback.autoClose, source: `the rule kept for company code ${companyCode}` };
  }
  return { autoClose: false, source: 'no delivery-completion rule' };
}

export interface DeliveryCompletionPolicyView {
  companies: Array<{ companyCode: string; name: string; autoClose: boolean }>;
  /** `autoClose` is null where the plant keeps no row of its own and inherits its company. */
  plants: Array<{ plant: string; name: string; companyCode: string | null; autoClose: boolean | null }>;
}

export async function listDeliveryCompletionPolicy(client: string): Promise<DeliveryCompletionPolicyView> {
  return withTenant(client, async (tx) => {
    const companies = await tx.select().from(companyCode)
      .where(eq(companyCode.client, client)).orderBy(asc(companyCode.companyCode));
    const rules = await tx.select().from(purchaseDeliveryCompletionPolicy)
      .where(eq(purchaseDeliveryCompletionPolicy.client, client));
    const plants = await tx.select().from(plant)
      .where(eq(plant.client, client)).orderBy(asc(plant.plant));
    const overrides = await tx.select().from(purchaseDeliveryCompletionPlant)
      .where(eq(purchaseDeliveryCompletionPlant.client, client));
    return {
      companies: companies.map((row) => ({
        companyCode: row.companyCode,
        name: row.name,
        autoClose: rules.find((rule) => rule.companyCode === row.companyCode)?.autoClose ?? false,
      })),
      plants: plants.map((row) => ({
        plant: row.plant,
        name: row.name,
        companyCode: row.companyCode,
        autoClose: overrides.find((rule) => rule.plant === row.plant)?.autoClose ?? null,
      })),
    };
  });
}

/** The company-code default. A plant with no row of its own inherits it. */
export async function setDeliveryCompletionPolicy(input: {
  client: string;
  changedBy: string;
  companyCode: string;
  autoClose: boolean;
}): Promise<{ changed: boolean }> {
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(purchaseDeliveryCompletionPolicy).where(and(
      eq(purchaseDeliveryCompletionPolicy.client, input.client),
      eq(purchaseDeliveryCompletionPolicy.companyCode, input.companyCode),
    ));
    if (standing && standing.autoClose === input.autoClose) return { changed: false };
    await tx.insert(purchaseDeliveryCompletionPolicy).values({
      client: input.client,
      companyCode: input.companyCode,
      autoClose: input.autoClose,
      createdBy: input.changedBy,
      changedBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [purchaseDeliveryCompletionPolicy.client, purchaseDeliveryCompletionPolicy.companyCode],
      set: {
        autoClose: input.autoClose,
        version: sql`${purchaseDeliveryCompletionPolicy.version} + 1`,
        changedBy: input.changedBy,
        changedAt: new Date(),
      },
    });
    await recordChange(tx, {
      client: input.client,
      objectClass: 'purchase_delivery_completion_policy',
      objectKey: input.companyCode,
      changeType: standing ? 'CHANGE' : 'CREATE',
      changedBy: input.changedBy,
      before: standing ? { autoClose: standing.autoClose } : undefined,
      after: { autoClose: input.autoClose },
    });
    return { changed: true };
  });
}

/**
 * A plant's own answer. Passing null removes the plant's row, which returns the plant to
 * inheriting its company code.
 */
export async function setDeliveryCompletionPlantPolicy(input: {
  client: string;
  changedBy: string;
  plant: string;
  autoClose: boolean | null;
}): Promise<{ changed: boolean }> {
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(purchaseDeliveryCompletionPlant).where(and(
      eq(purchaseDeliveryCompletionPlant.client, input.client),
      eq(purchaseDeliveryCompletionPlant.plant, input.plant),
    ));
    if (!standing && input.autoClose == null) return { changed: false };
    if (standing && standing.autoClose === input.autoClose) return { changed: false };
    if (input.autoClose == null) {
      await tx.delete(purchaseDeliveryCompletionPlant).where(and(
        eq(purchaseDeliveryCompletionPlant.client, input.client),
        eq(purchaseDeliveryCompletionPlant.plant, input.plant),
      ));
    } else {
      await tx.insert(purchaseDeliveryCompletionPlant).values({
        client: input.client,
        plant: input.plant,
        autoClose: input.autoClose,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
      }).onConflictDoUpdate({
        target: [purchaseDeliveryCompletionPlant.client, purchaseDeliveryCompletionPlant.plant],
        set: {
          autoClose: input.autoClose,
          version: sql`${purchaseDeliveryCompletionPlant.version} + 1`,
          changedBy: input.changedBy,
          changedAt: new Date(),
        },
      });
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'purchase_delivery_completion_plant',
      objectKey: input.plant,
      changeType: input.autoClose == null ? 'DELETE' : standing ? 'CHANGE' : 'CREATE',
      changedBy: input.changedBy,
      before: standing ? { autoClose: standing.autoClose } : undefined,
      after: input.autoClose == null ? undefined : { autoClose: input.autoClose },
    });
    return { changed: true };
  });
}
