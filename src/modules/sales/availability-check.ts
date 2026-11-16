/**
 * Check a sales order's availability on demand — SALES.ORDER.AVAILABILITY.CHECK (SAP: VA02 / ATP).
 *
 * An order is already checked when it is created and when it is changed (`availability.ts`). This asks the
 * same engine again, for an order that stands: stock may have arrived, a purchase order may have been
 * raised, another order may have been promised the same goods. The answer is shown *beside* the
 * confirmation that stands — a re-check can raise a promise as readily as lower it, and either direction
 * is visible before anything is written. `simulateSalesOrderAvailability` writes nothing;
 * `checkSalesOrderAvailability` writes the confirmation it returned, on the lines that could be checked.
 *
 * A confirmation is a promise written down at the moment it was asked, never re-derived from stock later:
 * the only thing that rewrites one is somebody asking again here (or a change to the order), and what it
 * replaces is recorded in the order's change document.
 *
 * A line that cannot be checked is reported, not thrown: one unconfigured material must not stop the
 * other lines of the order from being checked. A material with no checking group (or one marked
 * no-check) is not checked — as at order entry, it stays confirmed in full and nothing is written to it.
 * Only a whole-order refusal throws: the order does not stand or is not open, or the actor lacks the
 * authority.
 *
 * Not here: replenishment lead time (none is stored), a split of one confirmation across several dates,
 * and an automatic re-check. The confirmed date is the earliest date inside the horizon at which the full
 * quantity stands; where it never stands, what stands at the requested date is confirmed and the
 * remainder is reported as undated.
 */
import { and, asc, eq } from 'drizzle-orm';

import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { hasOrgAccess } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  AvailabilityError, ORDER_CHECKING_RULE, planOrderLines, writeScheduleLines, type LinePlan, type SupplyElement,
} from './availability';
import { salesDocumentTypeFor } from './document-type';
import { deliveredOf, orderLineProgress } from './fulfillment-quantities';
import { salesOrder, salesOrderLine, salesOrderSchedule } from './schema';

export const AVAILABILITY_CHECK_CAPABILITY = 'SALES.ORDER.AVAILABILITY.CHECK';
export const AVAILABILITY_CHECK_ROUTE = '/sales/orders';
const SALES_ORDER_OBJECT_CLASS = 'sales_order';

export class SalesAvailabilityError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SalesAvailabilityError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new SalesAvailabilityError(message, remedy);
}

export type SkipReason = 'NOT_CHECKED' | 'NOT_CONFIGURED' | 'NO_SCOPE' | 'SCOPE_UNSUPPORTED' | 'UNIT_CONVERSION' | 'SUPPLY_LIST';

export interface SalesAvailabilityLineResult {
  lineNumber: number;
  materialNumber: string;
  plant: string;
  orderQuantity: string;
  quantityUnit: string;
  deliveredQuantity: string;
  requestedDate: string;
  /** What stands on the order today. Null is never checked, which is not zero. */
  standing: { confirmedQuantity: string | null; confirmedDate: string | null };
  /** What the check returned now. Null where the line could not be checked. */
  proposed: {
    availableAtRequestedDate: string;
    confirmedQuantity: string;
    confirmedDate: string | null;
    partial: boolean;
    /** The full quantity stands, but later than asked. */
    delayed: boolean;
    /** Less than the full quantity is confirmed and no date inside the horizon supplies the rest. */
    remainderUndated: boolean;
    horizonEnd: string | null;
    checkingGroup: string;
    checkingRule: string;
    /** The elements that were counted, so a user can see where the number came from (base unit). */
    basis: Array<{ date: string; elementType: string; direction: string; quantity: string; documentNumber: string }>;
  } | null;
  /** How the proposal compares with what stands. */
  change: 'RAISED' | 'LOWERED' | 'UNCHANGED' | 'FIRST' | 'DATE_ONLY' | null;
  /** Set, not thrown, when the line cannot be checked. */
  skipped: { reason: SkipReason; message: string; remedy?: string } | null;
}

export interface SalesAvailabilityResult {
  orderNumber: string;
  checkingRule: string;
  /** True when the rule came from the order's document type; false when it is the order rule OR by default. */
  ruleFromDocumentType: boolean;
  /** True when the confirmations were written; a simulation never writes. */
  written: boolean;
  lines: SalesAvailabilityLineResult[];
}

const q3 = (value: number) => value.toFixed(3);

function toBasis(elements: readonly SupplyElement[]) {
  return elements.map((e) => ({ date: e.date, elementType: e.elementType, direction: e.direction, quantity: q3(e.quantity), documentNumber: e.documentNumber }));
}

function compare(standing: string | null, standingDate: string | null, plan: LinePlan): SalesAvailabilityLineResult['change'] {
  if (standing === null) return 'FIRST';
  const before = Number(standing);
  if (plan.confirmedQuantity > before + 1e-9) return 'RAISED';
  if (plan.confirmedQuantity < before - 1e-9) return 'LOWERED';
  return (plan.confirmedDate ?? null) === (standingDate ?? null) ? 'UNCHANGED' : 'DATE_ONLY';
}

async function run(tx: Tx, client: string, orderNumber: string, write: { username: string } | null): Promise<SalesAvailabilityResult> {
  const [order] = await tx.select().from(salesOrder).where(and(eq(salesOrder.client, client), eq(salesOrder.orderNumber, orderNumber))).limit(1);
  if (!order) fail(`Sales order ${orderNumber} does not stand.`, 'Open an order that exists at /sales/orders.');
  if (order.status !== 'OPEN') {
    fail(`Sales order ${orderNumber} is ${order.status.toLowerCase()}, and only an open order is checked.`, 'A cancelled or completed order carries the promise it was last given.');
  }
  const type = await salesDocumentTypeFor(tx, client, order.documentType);
  const named = (type?.availabilityCheckRule ?? '').trim().toUpperCase();
  const rule = named || ORDER_CHECKING_RULE;

  const lines = await tx.select().from(salesOrderLine)
    .where(and(eq(salesOrderLine.client, client), eq(salesOrderLine.orderNumber, orderNumber), eq(salesOrderLine.status, 'OPEN')))
    .orderBy(asc(salesOrderLine.lineNumber));
  const schedules = await tx.select().from(salesOrderSchedule)
    .where(and(eq(salesOrderSchedule.client, client), eq(salesOrderSchedule.orderNumber, orderNumber)));
  const standingDate = new Map(schedules.filter((s) => s.scheduleNumber === 10).map((s) => [s.orderLineNumber, s.confirmedDate]));
  const progress = await orderLineProgress(tx, client, orderNumber);
  const fallbackDate = order.requestedDate ?? order.orderDate;

  const input = lines.map((line) => ({
    lineNumber: line.lineNumber, materialNumber: line.materialNumber, plant: line.plant,
    orderQuantity: Number(line.orderQuantity), baseQuantity: Number(line.baseQuantity),
    requestedDate: line.requestedDeliveryDate ?? fallbackDate,
    deliveredQuantity: deliveredOf(progress, line.lineNumber),
  }));

  // One bucket per material and plant, so the lines of one material consume stock in the order they stand
  // and one bucket that cannot be checked does not stop the others.
  const buckets = new Map<string, typeof input>();
  for (const line of input) buckets.set(`${line.materialNumber}/${line.plant}`, [...(buckets.get(`${line.materialNumber}/${line.plant}`) ?? []), line]);
  const plans = new Map<number, LinePlan>();
  const skipped = new Map<number, { reason: SkipReason; message: string; remedy?: string }>();
  for (const bucket of buckets.values()) {
    try {
      const planned = await planOrderLines(tx, client, {
        salesOrg: order.salesOrg, distributionChannel: order.distributionChannel, checkingRule: rule,
        ...(named ? { ruleNamed: true } : {}), exclude: { orderNumber }, lines: bucket,
      });
      for (const [lineNumber, plan] of planned) plans.set(lineNumber, plan);
    } catch (error) {
      if (!(error instanceof AvailabilityError)) throw error;
      for (const line of bucket) skipped.set(line.lineNumber, { reason: error.code, message: error.message, remedy: error.remedy });
    }
  }

  const results: SalesAvailabilityLineResult[] = [];
  const toWrite: Array<{ line: (typeof lines)[number]; plan: LinePlan }> = [];
  for (const line of lines) {
    const plan = plans.get(line.lineNumber);
    const base = {
      lineNumber: line.lineNumber, materialNumber: line.materialNumber, plant: line.plant,
      orderQuantity: String(line.orderQuantity), quantityUnit: line.quantityUnit.trim(),
      deliveredQuantity: q3(deliveredOf(progress, line.lineNumber)),
      requestedDate: line.requestedDeliveryDate ?? fallbackDate,
      standing: { confirmedQuantity: line.confirmedQuantity, confirmedDate: standingDate.get(line.lineNumber) ?? null },
    };
    if (!plan) {
      results.push({ ...base, proposed: null, change: null, skipped: skipped.get(line.lineNumber) ?? { reason: 'NOT_CONFIGURED', message: 'The line could not be checked.' } });
      continue;
    }
    if (!plan.checked) {
      results.push({
        ...base, proposed: null, change: null,
        skipped: {
          reason: 'NOT_CHECKED',
          message: `Material ${line.materialNumber} carries no checking group (or its group is marked no-check), so it is not checked: it stays confirmed in full, as at order entry.`,
        },
      });
      continue;
    }
    results.push({
      ...base,
      proposed: {
        availableAtRequestedDate: q3(plan.availableAtRequestedDate),
        confirmedQuantity: q3(plan.confirmedQuantity), confirmedDate: plan.confirmedDate,
        partial: plan.partial, delayed: plan.delayed, remainderUndated: plan.remainderUndated, horizonEnd: plan.horizonEnd,
        checkingGroup: plan.checkingGroup!, checkingRule: plan.checkingRule!, basis: toBasis(plan.basis),
      },
      change: compare(line.confirmedQuantity, standingDate.get(line.lineNumber) ?? null, plan),
      skipped: null,
    });
    toWrite.push({ line, plan });
  }

  if (write && toWrite.length > 0) {
    for (const { line, plan } of toWrite) {
      await tx.update(salesOrderLine).set({
        confirmedQuantity: q3(plan.confirmedQuantity), changedBy: write.username, changedAt: new Date(),
      }).where(and(eq(salesOrderLine.client, client), eq(salesOrderLine.orderNumber, orderNumber), eq(salesOrderLine.lineNumber, line.lineNumber)));
    }
    await writeScheduleLines(tx, {
      client, orderNumber, changedBy: write.username,
      lines: toWrite.map(({ line, plan }) => ({
        lineNumber: line.lineNumber, requestedQuantity: Number(line.orderQuantity),
        confirmedQuantity: plan.confirmedQuantity, requestedDate: plan.requestedDate, confirmedDate: plan.confirmedDate,
      })),
    });
    await recordChange(tx, {
      client, objectClass: SALES_ORDER_OBJECT_CLASS, objectKey: orderNumber, changeType: 'CHANGE', changedBy: write.username,
      reason: 'Availability checked on demand; confirmations rewritten.',
      before: Object.fromEntries(toWrite.map(({ line }) => [`item ${line.lineNumber}`, `${line.confirmedQuantity ?? 'not checked'} on ${standingDate.get(line.lineNumber) ?? '—'}`])),
      after: Object.fromEntries(toWrite.map(({ line, plan }) => [`item ${line.lineNumber}`, `${q3(plan.confirmedQuantity)} on ${plan.confirmedDate ?? '—'}`])),
    });
  }
  return { orderNumber, checkingRule: rule, ruleFromDocumentType: named !== '', written: !!write && toWrite.length > 0, lines: results };
}

async function authorise(tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined, orderNumber: string): Promise<string> {
  const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, AVAILABILITY_CHECK_CAPABILITY);
  if (!verdict.ok) throw new SalesAvailabilityError(verdict.refusal.message, verdict.refusal.remedy);
  const [order] = await tx.select({ companyCode: salesOrder.companyCode }).from(salesOrder)
    .where(and(eq(salesOrder.client, client), eq(salesOrder.orderNumber, orderNumber))).limit(1);
  if (order && !hasOrgAccess(verdict.restrictions, 'COMPANY_CODE', order.companyCode)) {
    fail(`Your Company Code scope does not cover company code ${order.companyCode}.`, 'Ask an administrator to extend your Company Code scope, then repeat the check.');
  }
  return verdict.username;
}

/** The same arithmetic, without writing — for the screen to show before anyone acts on it. */
export async function simulateSalesOrderAvailability(
  input: { client: string; orderNumber: string },
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<SalesAvailabilityResult> {
  const orderNumber = input.orderNumber.trim();
  return withTenant(input.client, async (tx) => {
    await authorise(tx, input.client, options.authorization, orderNumber);
    return run(tx, input.client, orderNumber, null);
  });
}

/** Check one sales order and write the confirmations the check returned, on the lines that could be checked. */
export async function checkSalesOrderAvailability(
  input: { client: string; orderNumber: string },
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<SalesAvailabilityResult> {
  const orderNumber = input.orderNumber.trim();
  return withTenant(input.client, async (tx) => {
    const username = await authorise(tx, input.client, options.authorization, orderNumber);
    return run(tx, input.client, orderNumber, { username });
  });
}
