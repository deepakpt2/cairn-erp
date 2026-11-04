import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import {
  PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY,
  PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY,
} from '../../platform/auth/capability-policy';
import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { productionOrderComponent } from '../inventory/schema';
import {
  productionOrderAvailabilityRun,
  productionOrderComponentCommitmentEvent,
} from './schema';
import {
  ORDER_AVAILABILITY_ORDER_CAPABILITY,
  checkOrderAvailability,
  holdsOrderAvailabilityAuthority,
  type ComponentAvailability,
  type OrderAvailabilityResult,
} from './order-availability';

export class OrderAvailabilityCommitmentError extends Error {
  readonly remedy: string | null;

  constructor(message: string, remedy: string | null = null) {
    super(message);
    this.name = 'OrderAvailabilityCommitmentError';
    this.remedy = remedy;
  }
}

export type OrderAvailabilityCommitmentOutcome = 'COMMITTED' | 'RELEASED' | 'RESET' | 'NO_ACTIVE_COMMITMENT';

export interface OrderAvailabilityCommitmentResult {
  action: 'COMMIT' | 'RESET';
  outcome: OrderAvailabilityCommitmentOutcome;
  orderNumber: string;
  itemNumber: number;
  materialNumber: string;
  plant: string;
  committedQuantity: number;
  requirementDate: string | null;
  message: string;
  availability: OrderAvailabilityResult | null;
}

function fail(message: string, remedy?: string): never {
  throw new OrderAvailabilityCommitmentError(message, remedy ?? null);
}

function normalizedKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 64) fail('A request key of 1 to 64 characters is required.', 'Retry with the same request key for the same request, or use a fresh key for a new run.');
  return key;
}

function normalizedItem(value: string | number): number {
  const text = String(value).trim();
  if (!/^\d{1,4}$/.test(text) || Number(text) <= 0) fail('A valid component item number is required.', 'Open the action from a component row on the CO09 result.');
  return Number(text);
}

function fingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function holds(capabilities: readonly string[], capability: string): boolean {
  return hasCapability([...capabilities], capability);
}

export function holdsOrderAvailabilityCommitAuthority(capabilities: readonly string[]): boolean {
  return holds(capabilities, PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY);
}

export function holdsOrderAvailabilityResetAuthority(capabilities: readonly string[]): boolean {
  return holds(capabilities, PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY);
}

async function assertRequestReplay<T extends OrderAvailabilityCommitmentResult>(
  tx: Tx,
  input: { client: string; requestKey: string; requestFingerprint: string },
): Promise<T | null> {
  const [existing] = await tx.select().from(productionOrderAvailabilityRun).where(and(
    eq(productionOrderAvailabilityRun.client, input.client),
    eq(productionOrderAvailabilityRun.requestKey, input.requestKey),
  ));
  if (!existing) return null;
  if (existing.requestFingerprint !== input.requestFingerprint) {
    fail(`Request key ${input.requestKey} was already used for different CO09 input.`, 'Reuse a key only for an exact retry. Use a new request key for a changed order, item, action, date, horizon, or reset reason.');
  }
  return existing.resultSnapshot as unknown as T;
}

async function lockRequest(tx: Tx, client: string, requestKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext(${`request/${requestKey}`}))`);
}

async function lockMaterial(tx: Tx, input: {
  client: string; materialNumber: string; plant: string;
}): Promise<void> {
  // Serialise checks that could claim the same plant/material supply. A hash collision
  // only serialises unrelated checks; it cannot let two requests over-commit the same pool.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`${input.plant}/${input.materialNumber}`}))`);
}

async function latestEvent(tx: Tx, input: {
  client: string; orderNumber: string; itemNumber: number;
}) {
  const [event] = await tx.select().from(productionOrderComponentCommitmentEvent).where(and(
    eq(productionOrderComponentCommitmentEvent.client, input.client),
    eq(productionOrderComponentCommitmentEvent.orderNumber, input.orderNumber),
    eq(productionOrderComponentCommitmentEvent.itemNumber, input.itemNumber),
  )).orderBy(desc(productionOrderComponentCommitmentEvent.eventNumber)).limit(1);
  return event ?? null;
}

function replayFingerprint(input: {
  action: 'COMMIT' | 'RESET';
  orderNumber: string;
  itemNumber: number;
  today?: string;
  horizonEnd?: string | null;
  reason?: string;
}): string {
  return fingerprint({
    action: input.action,
    orderNumber: input.orderNumber,
    itemNumber: input.itemNumber,
    today: input.today ?? null,
    horizonEnd: input.horizonEnd ?? null,
    reason: input.reason ?? null,
  });
}

function unavailableOutcome(row: ComponentAvailability): boolean {
  return row.outcome !== 'AVAILABLE' && row.outcome !== 'SHORT' && row.outcome !== 'NO_ELEMENTS';
}

/**
 * Check and commit one order component. A repeated request key returns the exact
 * stored result; a new request rechecks current availability and replaces the
 * component's latest commitment with the full requirement or zero.
 */
export async function commitOrderComponentAvailability(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  requestKey: string;
  orderNumber: string;
  itemNumber: string | number;
  today?: string;
  horizonEnd?: string | null;
}): Promise<OrderAvailabilityCommitmentResult> {
  if (!holdsOrderAvailabilityCommitAuthority(input.capabilities)) {
    fail(`The exact capability ${PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY} is required.`, 'Ask an administrator for this specific grant. A broader production or display grant is not enough.');
  }
  if (!holdsOrderAvailabilityAuthority(input.capabilities)) {
    fail('The order-display and stock/requirements capabilities are also required to run the CO09 check before committing.', 'Ask an administrator for the existing order and element-list grants as well as the exact commit grant.');
  }
  const requestKey = normalizedKey(input.requestKey);
  const orderNumber = input.orderNumber.trim().toUpperCase();
  const itemNumber = normalizedItem(input.itemNumber);
  if (!orderNumber) fail('An order number is required.');
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const horizonEnd = (input.horizonEnd ?? '').trim() || null;
  const requestFingerprint = replayFingerprint({ action: 'COMMIT', orderNumber, itemNumber, today, horizonEnd });

  return withTenant(input.client, async (tx) => {
    await lockRequest(tx, input.client, requestKey);
    const [component] = await tx.select().from(productionOrderComponent).where(and(
      eq(productionOrderComponent.client, input.client),
      eq(productionOrderComponent.orderNumber, orderNumber),
      eq(productionOrderComponent.itemNumber, itemNumber),
    )).for('update');
    if (!component) fail(`Order ${orderNumber} has no component item ${itemNumber}.`, 'Open an existing component row on the CO09 result.');
    await lockMaterial(tx, { client: input.client, materialNumber: component.materialNumber, plant: component.plant });

    const replay = await assertRequestReplay<OrderAvailabilityCommitmentResult>(tx, {
      client: input.client, requestKey, requestFingerprint,
    });
    if (replay) return replay;

    // The lock stays held while the availability service reads the stock/requirements
    // ledger in its own tenant transaction. Every other commit/reset for this
    // plant/material acquires the same lock before it can check or append an event.
    const availability = await checkOrderAvailability({
      client: input.client,
      orderNumber,
      itemNumber: String(itemNumber),
      today,
      horizonEnd,
    });
    const row = availability.components.find((candidate) => Number(candidate.itemNumber) === itemNumber);
    if (!row || unavailableOutcome(row)) {
      fail(row?.message ?? `Component item ${itemNumber} has no availability result.`, row?.remedy ?? 'Resolve the refusal and run CO09 again. No commitment was changed.');
    }

    const previous = await latestEvent(tx, { client: input.client, orderNumber, itemNumber });
    const isAvailable = row.outcome === 'AVAILABLE';
    const outcome: OrderAvailabilityCommitmentOutcome = isAvailable ? 'COMMITTED' : 'RELEASED';
    const committedQuantity = isAvailable ? row.requiredQuantity : 0;
    const reason = isAvailable ? null : `Not fully covered at requirement date ${row.requirementDate ?? 'unknown'}.`;
    const message = isAvailable
      ? `Committed the full ${row.requiredQuantity.toFixed(3)} ${row.unit} for component ${itemNumber}.`
      : `No quantity was committed for component ${itemNumber}; the previous commitment, if any, was released because the line is short.`;
    const result: OrderAvailabilityCommitmentResult = {
      action: 'COMMIT', outcome, orderNumber, itemNumber,
      materialNumber: component.materialNumber, plant: component.plant,
      committedQuantity, requirementDate: row.requirementDate,
      message, availability,
    };

    await tx.insert(productionOrderAvailabilityRun).values({
      client: input.client,
      requestKey,
      orderNumber,
      action: 'COMMIT',
      requestFingerprint,
      resultSnapshot: result as unknown as Record<string, unknown>,
      createdBy: input.changedBy,
    });
    await tx.insert(productionOrderComponentCommitmentEvent).values({
      client: input.client,
      requestKey,
      orderNumber,
      itemNumber,
      materialNumber: component.materialNumber,
      plant: component.plant,
      eventKind: isAvailable ? 'COMMITTED' : 'RELEASED',
      committedQuantity: committedQuantity.toFixed(3),
      requirementDate: row.requirementDate,
      checkingGroup: row.checkingGroup,
      checkingRule: row.checkingRule,
      scopeKey: row.scopeKey,
      supersedesEventNumber: previous?.eventNumber ?? null,
      reason,
      createdBy: input.changedBy,
    });
    const recorded = await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order_component_commitment',
      objectKey: `${orderNumber}/${itemNumber}`,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: 'CO09',
      reason: reason ?? `Availability committed for order ${orderNumber}, component ${itemNumber}`,
      before: previous ? {
        eventKind: previous.eventKind,
        committedQuantity: previous.committedQuantity,
        eventNumber: previous.eventNumber,
      } : {},
      after: {
        eventKind: isAvailable ? 'COMMITTED' : 'RELEASED',
        committedQuantity: committedQuantity.toFixed(3),
        requirementDate: row.requirementDate,
      },
      fieldLabels: {
        eventKind: 'Commitment state',
        committedQuantity: 'Committed quantity',
        requirementDate: 'Requirement date',
        eventNumber: 'Superseded event',
      },
    });
    if (!recorded) fail('The commitment change was not recorded. Nothing was saved.');
    return result;
  });
}

/** Append a reset event for one component. The reason and actor are retained even when it was already at zero. */
export async function resetOrderComponentAvailability(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  requestKey: string;
  orderNumber: string;
  itemNumber: string | number;
  reason: string;
}): Promise<OrderAvailabilityCommitmentResult> {
  if (!holdsOrderAvailabilityResetAuthority(input.capabilities)) {
    fail(`The exact capability ${PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY} is required.`, 'Ask an administrator for this specific grant. A broader production or display grant is not enough.');
  }
  if (!hasCapability([...input.capabilities], ORDER_AVAILABILITY_ORDER_CAPABILITY)) {
    fail(`The ${ORDER_AVAILABILITY_ORDER_CAPABILITY} capability is also required to identify the order component to reset.`, 'Ask an administrator for the order-display grant as well as the exact reset grant.');
  }
  const requestKey = normalizedKey(input.requestKey);
  const orderNumber = input.orderNumber.trim().toUpperCase();
  const itemNumber = normalizedItem(input.itemNumber);
  const reason = input.reason.trim();
  if (!orderNumber) fail('An order number is required.');
  if (!reason || reason.length > 200) fail('A reset reason of 1 to 200 characters is required.', 'Explain why this component commitment is being reset.');
  const requestFingerprint = replayFingerprint({ action: 'RESET', orderNumber, itemNumber, reason });

  return withTenant(input.client, async (tx) => {
    await lockRequest(tx, input.client, requestKey);
    const [component] = await tx.select().from(productionOrderComponent).where(and(
      eq(productionOrderComponent.client, input.client),
      eq(productionOrderComponent.orderNumber, orderNumber),
      eq(productionOrderComponent.itemNumber, itemNumber),
    )).for('update');
    if (!component) fail(`Order ${orderNumber} has no component item ${itemNumber}.`, 'Open an existing component row on the CO09 result.');
    await lockMaterial(tx, { client: input.client, materialNumber: component.materialNumber, plant: component.plant });

    const replay = await assertRequestReplay<OrderAvailabilityCommitmentResult>(tx, {
      client: input.client, requestKey, requestFingerprint,
    });
    if (replay) return replay;

    const previous = await latestEvent(tx, { client: input.client, orderNumber, itemNumber });
    const hadActive = previous?.eventKind === 'COMMITTED';
    const result: OrderAvailabilityCommitmentResult = {
      action: 'RESET',
      outcome: hadActive ? 'RESET' : 'NO_ACTIVE_COMMITMENT',
      orderNumber,
      itemNumber,
      materialNumber: component.materialNumber,
      plant: component.plant,
      committedQuantity: 0,
      requirementDate: previous?.requirementDate ?? component.requirementDate ?? null,
      message: hadActive
        ? `Reset the active commitment for order ${orderNumber}, component ${itemNumber}. The prior event remains in the audit history.`
        : `No active commitment stood for order ${orderNumber}, component ${itemNumber}; an audited zero-quantity reset event was still appended.`,
      availability: null,
    };
    await tx.insert(productionOrderAvailabilityRun).values({
      client: input.client,
      requestKey,
      orderNumber,
      action: 'RESET',
      requestFingerprint,
      resultSnapshot: result as unknown as Record<string, unknown>,
      createdBy: input.changedBy,
    });
    await tx.insert(productionOrderComponentCommitmentEvent).values({
      client: input.client,
      requestKey,
      orderNumber,
      itemNumber,
      materialNumber: component.materialNumber,
      plant: component.plant,
      eventKind: 'RESET',
      committedQuantity: '0.000',
      requirementDate: previous?.requirementDate ?? component.requirementDate ?? null,
      checkingGroup: previous?.checkingGroup ?? null,
      checkingRule: previous?.checkingRule ?? null,
      scopeKey: previous?.scopeKey ?? null,
      supersedesEventNumber: previous?.eventNumber ?? null,
      reason,
      createdBy: input.changedBy,
    });
    const recorded = await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order_component_commitment',
      objectKey: `${orderNumber}/${itemNumber}`,
      changeType: 'REVERSE',
      changedBy: input.changedBy,
      transactionCode: 'CO09',
      reason,
      before: previous ? {
        eventKind: previous.eventKind,
        committedQuantity: previous.committedQuantity,
        eventNumber: previous.eventNumber,
      } : {},
      after: {
        eventKind: 'RESET',
        committedQuantity: '0.000',
        reason,
      },
      fieldLabels: {
        eventKind: 'Commitment state',
        committedQuantity: 'Committed quantity',
        eventNumber: 'Superseded event',
        reason: 'Reset reason',
      },
    });
    if (!recorded) fail('The reset change was not recorded. Nothing was saved.');
    return result;
  });
}
