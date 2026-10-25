/**
 * Cancel production order confirmation — CO13.
 *
 * One posted confirmation is cancelled as a whole. The original row and its
 * activities are not updated and are not deleted. The cancellation is a
 * linked record, not a negative quantity to be summed with the original.
 *
 * This is not an SAP table copy. No goods movement is created or reversed:
 * a confirmation in this ERP has no material document, and a document posted
 * separately is not touched here. The order status, reservations, and
 * planning records are not changed. CO14 is not this screen.
 */
import { sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { parseProductionOrderStatus, type ProductionOrderStatus } from './production-order-status';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { acquireLock } from '../../platform/lock';
import { allocateNumber } from '../../platform/numbering';
import { TIME_TICKET_LOCK, rows } from './time-ticket';

export const CONFIRMATION_CANCEL_CAPABILITY = 'PROD.CONFIRM.CANCEL';
export const CONFIRMATION_CANCEL_ROUTE = '/production/confirmation-cancel';
export const CONFIRMATION_CANCEL_ALIAS = 'CO13';

const MOVEMENT_NOTE = 'No goods movement was posted. A material document posted separately is not a confirmation record and was not reversed.';

export class ConfirmationCancelError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'ConfirmationCancelError';
  }
}

export interface ConfirmationCancelActivity {
  parameter: string;
  quantity: string;
  unit: string;
  suggested: string | null;
}

export interface ConfirmationCancelEffect {
  operationNumber: string;
  confirmationType: string;
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  unit: string;
}

export interface ConfirmationCancelDetail {
  confirmationNumber: string;
  confirmationLevel: 'OPERATION' | 'HEADER';
  confirmationType: 'PARTIAL' | 'FINAL';
  orderNumber: string;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  operationNumber: string | null;
  postingDate: string;
  createdBy: string;
  createdAt: string;
  yieldQuantity: string;
  scrapQuantity: string;
  reworkQuantity: string;
  unit: string;
  orderStatus: ProductionOrderStatus;
  activities: ConfirmationCancelActivity[];
  effects: ConfirmationCancelEffect[];
  cancelled: boolean;
  cancellationNumber: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  eligible: boolean;
}

export interface ConfirmationCancelListRow {
  confirmationNumber: string;
  confirmationLevel: 'OPERATION' | 'HEADER';
  confirmationType: string;
  operationNumber: string | null;
  postingDate: string;
  yieldQuantity: string;
  unit: string;
  cancelled: boolean;
  cancellationNumber: string | null;
}

export interface ConfirmationCancelLoad {
  detail: ConfirmationCancelDetail | null;
  matches: ConfirmationCancelListRow[];
  warning: string | null;
}

export interface ConfirmationCancelResult {
  cancellationNumber: string;
  confirmationNumber: string;
  orderNumber: string;
  reason: string | null;
  requestKey: string;
  orderStatus: ProductionOrderStatus;
  written: boolean;
  replayed: boolean;
  movementsPosted: 0;
  movementNote: string;
}

function fail(message: string, remedy?: string): never {
  throw new ConfirmationCancelError(message, remedy);
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function stamp(value: unknown): string {
  if (value == null) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function levelOf(value: unknown): 'OPERATION' | 'HEADER' {
  return String(value) === 'HEADER' ? 'HEADER' : 'OPERATION';
}

function typeOf(value: unknown): 'PARTIAL' | 'FINAL' {
  return String(value) === 'FINAL' ? 'FINAL' : 'PARTIAL';
}

function statusOf(value: unknown): ProductionOrderStatus {
  const status = parseProductionOrderStatus(value);
  if (!status) {
    fail(
      `Status ${String(value ?? '')} is not a production-order status.`,
      'The stored status is unsupported. It was not treated as created.',
    );
  }
  return status;
}

export function holdsConfirmationCancelAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], CONFIRMATION_CANCEL_CAPABILITY);
}

function assertAuthority(held: readonly string[] | undefined): void {
  if (!holdsConfirmationCancelAuthority(held ?? [])) {
    fail(
      `You do not hold the authority ${CONFIRMATION_CANCEL_CAPABILITY}.`,
      'Ask an administrator to add that authority to one of your roles. Hiding the button is not the check.',
    );
  }
}

function confirmationNumberOf(value: string): string {
  const number = clean(value).toUpperCase();
  if (!number) fail('A confirmation number is required.', 'Enter the confirmation number, or choose one from the order list.');
  if (number.length > 12) fail('The confirmation number is too long.', 'Use the number as it stands.');
  return number;
}

function reasonOf(value: string | null | undefined): string | null {
  const reason = clean(value);
  if (!reason) return null;
  if (reason.length > 200) fail('The cancellation reason is too long.', 'Use at most 200 characters. The reason is optional.');
  return reason;
}

function sameReason(stored: string | null, requested: string | null): boolean {
  return (stored ?? '') === (requested ?? '');
}

function isUniqueViolation(error: unknown): boolean {
  const current = error as { code?: string; cause?: { code?: string } };
  return current.code === '23505' || current.cause?.code === '23505';
}

async function detailOf(tx: Tx, client: string, confirmationNumber: string): Promise<ConfirmationCancelDetail | null> {
  const found = await rows(tx, sql`
    select c.confirmation_number, c.confirmation_level, c.confirmation_type, c.order_number, c.operation_number,
           c.yield_quantity::text as yield, c.scrap_quantity::text as scrap, c.rework_quantity::text as rework,
           c.unit, c.posting_date::text as posting_date, c.created_by, c.created_at,
           o.material_number, o.plant, o.status, coalesce(m.description, '') as material_description,
           x.cancellation_number, x.created_by as cancelled_by, x.created_at as cancelled_at, x.reason as cancellation_reason
      from production_confirmation c
      join production_order o on o.client = c.client and o.order_number = c.order_number
      join material m on m.client = o.client and m.material_number = o.material_number
      left join production_confirmation_cancellation x
        on x.client = c.client and x.confirmation_number = c.confirmation_number
     where c.client = ${client} and c.confirmation_number = ${confirmationNumber}
  `);
  const header = found[0];
  if (!header) return null;
  const activities = await rows(tx, sql`
    select parameter, quantity::text as quantity, unit, suggested_quantity::text as suggested
      from production_confirmation_activity
     where client = ${client} and confirmation_number = ${confirmationNumber}
     order by parameter
  `);
  const effects = await rows(tx, sql`
    select e.operation_number, e.confirmation_type, e.yield_quantity::text as yield, e.scrap_quantity::text as scrap,
           e.rework_quantity::text as rework, e.unit
      from production_confirmation_operation e
      left join production_order_operation op
        on op.client = e.client and op.order_number = e.order_number and op.operation_number = e.operation_number
     where e.client = ${client} and e.confirmation_number = ${confirmationNumber}
     order by op.execution_order nulls last, e.operation_number
  `);
  const cancellationNumber = header.cancellation_number == null ? null : String(header.cancellation_number);
  return {
    confirmationNumber: String(header.confirmation_number),
    confirmationLevel: levelOf(header.confirmation_level),
    confirmationType: typeOf(header.confirmation_type),
    orderNumber: String(header.order_number),
    materialNumber: String(header.material_number),
    materialDescription: String(header.material_description ?? ''),
    plant: String(header.plant),
    operationNumber: header.operation_number == null ? null : String(header.operation_number),
    postingDate: String(header.posting_date),
    createdBy: String(header.created_by),
    createdAt: stamp(header.created_at),
    yieldQuantity: String(header.yield),
    scrapQuantity: String(header.scrap),
    reworkQuantity: String(header.rework),
    unit: String(header.unit),
    orderStatus: statusOf(header.status),
    activities: activities.map((row) => ({
      parameter: String(row.parameter),
      quantity: String(row.quantity),
      unit: String(row.unit),
      suggested: row.suggested == null ? null : String(row.suggested),
    })),
    effects: effects.map((row) => ({
      operationNumber: String(row.operation_number),
      confirmationType: String(row.confirmation_type),
      yieldQuantity: String(row.yield),
      scrapQuantity: String(row.scrap),
      reworkQuantity: String(row.rework),
      unit: String(row.unit),
    })),
    cancelled: cancellationNumber != null,
    cancellationNumber,
    cancelledBy: header.cancelled_by == null ? null : String(header.cancelled_by),
    cancelledAt: header.cancelled_at == null ? null : stamp(header.cancelled_at),
    cancellationReason: header.cancellation_reason == null ? null : String(header.cancellation_reason),
    eligible: cancellationNumber == null,
  };
}

async function listOf(tx: Tx, client: string, orderNumber: string): Promise<ConfirmationCancelListRow[]> {
  const found = await rows(tx, sql`
    select c.confirmation_number, c.confirmation_level, c.confirmation_type, c.operation_number,
           c.posting_date::text as posting_date, c.yield_quantity::text as yield, c.unit,
           x.cancellation_number
      from production_confirmation c
      left join production_confirmation_cancellation x
        on x.client = c.client and x.confirmation_number = c.confirmation_number
     where c.client = ${client} and c.order_number = ${orderNumber}
     order by c.confirmation_number
  `);
  return found.map((row) => ({
    confirmationNumber: String(row.confirmation_number),
    confirmationLevel: levelOf(row.confirmation_level),
    confirmationType: String(row.confirmation_type),
    operationNumber: row.operation_number == null ? null : String(row.operation_number),
    postingDate: String(row.posting_date),
    yieldQuantity: String(row.yield),
    unit: String(row.unit),
    cancelled: row.cancellation_number != null,
    cancellationNumber: row.cancellation_number == null ? null : String(row.cancellation_number),
  }));
}

function resultOf(detail: ConfirmationCancelDetail, requestKey: string, replayed: boolean): ConfirmationCancelResult {
  if (!detail.cancellationNumber) fail('The cancellation was not saved.');
  return {
    cancellationNumber: detail.cancellationNumber,
    confirmationNumber: detail.confirmationNumber,
    orderNumber: detail.orderNumber,
    reason: detail.cancellationReason,
    requestKey,
    orderStatus: detail.orderStatus,
    written: true,
    replayed,
    movementsPosted: 0,
    movementNote: MOVEMENT_NOTE,
  };
}

export async function loadConfirmationCancellation(client: string, input: {
  confirmationNumber?: string | null;
  orderNumber?: string | null;
  capabilities: readonly string[];
}): Promise<ConfirmationCancelLoad> {
  assertAuthority(input.capabilities);
  const confirmationNumber = clean(input.confirmationNumber).toUpperCase();
  const orderNumber = clean(input.orderNumber).toUpperCase();
  if (!confirmationNumber && !orderNumber) {
    fail('A confirmation number is required.', 'Enter the confirmation number, or an order number to list its confirmations.');
  }
  if (confirmationNumber.length > 12) fail('The confirmation number is too long.', 'Use the number as it stands.');
  if (orderNumber.length > 12) fail('The production order number is too long.', 'Use the number as it stands.');
  return withTenant(client, async (tx) => {
    if (!confirmationNumber) {
      const order = await rows(tx, sql`
        select order_number from production_order
         where client = ${client} and order_number = ${orderNumber}
      `);
      if (!order[0]) fail(`Production order ${orderNumber} does not stand.`, 'Choose an order that stands in this tenant.');
      return { detail: null, matches: await listOf(tx, client, orderNumber), warning: null };
    }
    const detail = await detailOf(tx, client, confirmationNumber);
    if (!detail) {
      fail(`Confirmation ${confirmationNumber} does not stand.`, 'Choose a confirmation that stands in this tenant. Nothing was cancelled.');
    }
    const warning = orderNumber && orderNumber !== detail.orderNumber
      ? `Confirmation ${confirmationNumber} stands on order ${detail.orderNumber}, not ${orderNumber}.`
      : null;
    return { detail, matches: [], warning };
  });
}

export async function cancelConfirmation(client: string, input: {
  requestedBy: string;
  requestKey: string;
  confirmationNumber: string;
  reason?: string | null;
  confirmed: boolean;
  capabilities: readonly string[];
}): Promise<ConfirmationCancelResult> {
  assertAuthority(input.capabilities);
  const requestKey = clean(input.requestKey);
  if (!requestKey || requestKey.length > 64) fail('A request key is required.');
  const confirmationNumber = confirmationNumberOf(input.confirmationNumber);
  const reason = reasonOf(input.reason);
  const requestedBy = clean(input.requestedBy);
  if (!requestedBy) fail('The user is required.');
  return withTenant(client, async (tx) => {
    const standing = await rows(tx, sql`
      select order_number from production_confirmation
       where client = ${client} and confirmation_number = ${confirmationNumber}
    `);
    if (!standing[0]) {
      fail(`Confirmation ${confirmationNumber} does not stand.`, 'Choose a confirmation that stands in this tenant. Nothing was cancelled.');
    }
    const orderNumber = String(standing[0].order_number);
    await acquireLock(tx, { objectCode: TIME_TICKET_LOCK, keys: [client, orderNumber] }, {
      client, requestedBy, transactionCode: CONFIRMATION_CANCEL_ALIAS,
    });
    const byRequest = await rows(tx, sql`
      select cancellation_number, confirmation_number, reason
        from production_confirmation_cancellation
       where client = ${client} and request_key = ${requestKey}
    `);
    if (byRequest[0]) {
      if (String(byRequest[0].confirmation_number) !== confirmationNumber || !sameReason(byRequest[0].reason == null ? null : String(byRequest[0].reason), reason)) {
        fail('This request was already saved with different details. The cancellation was not changed.', 'Use a new request. A confirmation is cancelled once.');
      }
      const stored = await detailOf(tx, client, confirmationNumber);
      if (!stored) fail('The earlier cancellation could not be read.');
      return resultOf(stored, requestKey, true);
    }
    const existing = await rows(tx, sql`
      select cancellation_number from production_confirmation_cancellation
       where client = ${client} and confirmation_number = ${confirmationNumber}
    `);
    if (existing[0]) {
      fail(
        `Confirmation ${confirmationNumber} is already cancelled by ${String(existing[0].cancellation_number)}. It was not cancelled again.`,
        'Open the confirmation to see the cancellation. A second cancellation was not written.',
      );
    }
    if (input.confirmed !== true) {
      fail('Cancellation was not confirmed. Nothing was saved.', 'Confirm the cancellation. The original confirmation was not changed.');
    }
    const allocated = await allocateNumber(tx, { client, objectCode: 'PRODCONF', allocatedBy: requestedBy });
    const cancellationNumber = allocated.display;
    try {
      await tx.execute(sql`
        insert into production_confirmation_cancellation (
          client, cancellation_number, confirmation_number, order_number, reason, request_key, created_by
        ) values (
          ${client}, ${cancellationNumber}, ${confirmationNumber}, ${orderNumber}, ${reason}, ${requestKey}, ${requestedBy}
        )
      `);
    } catch (error) {
      if (isUniqueViolation(error)) {
        fail(`Confirmation ${confirmationNumber} is already cancelled. It was not cancelled again.`);
      }
      throw error;
    }
    const recorded = await recordChange(tx, {
      client,
      objectClass: 'production_confirmation_cancellation',
      objectKey: cancellationNumber,
      changeType: 'REVERSE',
      changedBy: requestedBy,
      transactionCode: CONFIRMATION_CANCEL_ALIAS,
      reason: reason ?? `Cancellation ${cancellationNumber} of confirmation ${confirmationNumber}`,
      after: {
        cancellationNumber,
        confirmationNumber,
        orderNumber,
        reason,
      },
    });
    if (!recorded) fail('The cancellation was not recorded.');
    const stored = await detailOf(tx, client, confirmationNumber);
    if (!stored?.cancellationNumber) fail('The cancellation was not saved.');
    return resultOf(stored, requestKey, false);
  });
}
