/**
 * Cancel production order confirmation — CO13.
 *
 * One posted confirmation is cancelled as a whole. The original row and its
 * activities are not updated and are not deleted. The cancellation is a
 * linked record, not a negative quantity to be summed with the original.
 *
 * This is not an SAP table copy. No goods movement is reversed here. A
 * confirmation that caused one cannot be cancelled while that document still
 * stands, and the material-document screen is named as the way to reverse it;
 * once the document no longer stands, the cancellation is allowed and the
 * confirmation stays as posted. A document posted separately on MIGO is not
 * touched here. The order status, reservations, and planning records are not
 * changed. CO14 is not this screen.
 */
import { sql } from 'drizzle-orm';

import {
  hasCapability,
  hasOrgAccess,
  loadCapabilities,
  loadOrgRestrictions,
} from '../../platform/auth/session';
import { parseProductionOrderStatus, type ProductionOrderStatus } from './production-order-status';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { acquireLock } from '../../platform/lock';
import { allocateNumber } from '../../platform/numbering';
import { TIME_TICKET_LOCK, rows } from './time-ticket';
import { movementStands } from './confirmation-movements';

export const CONFIRMATION_CANCEL_CAPABILITY = 'PROD.CONFIRM.CANCEL';
export const CONFIRMATION_CANCEL_ROUTE = '/production/confirmation-cancel';
export const CONFIRMATION_CANCEL_ALIAS = 'CO13';

export interface ConfirmationCancelAuthorizationContext {
  /** IDs resolved by requireSession; never accepted from form fields. */
  userId: string;
  sessionId: string;
}

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

async function requireCancellationAuthorityInTx(
  tx: Tx,
  client: string,
  authorization: ConfirmationCancelAuthorizationContext | undefined,
) {
  if (!authorization?.userId || !authorization.sessionId) {
    fail('You are not authorised to cancel this production confirmation.', 'Sign in again with an active account.');
  }

  const sessions = await rows(tx, sql`
    select u.username
      from user_session s
      join app_user u on u.client = s.client and u.id = s.user_id
     where s.client = ${client}
       and s.id = ${authorization.sessionId}
       and s.user_id = ${authorization.userId}
       and s.revoked_at is null
       and s.expires_at > now()
       and u.is_active = true
       and u.is_locked = false
     for share of s, u
  `);
  const actor = sessions[0];
  if (!actor) {
    fail('You are not authorised to cancel this production confirmation.', 'Your session or account is no longer active. Sign in again.');
  }

  await tx.execute(sql`
    select code from capability where code = ${CONFIRMATION_CANCEL_CAPABILITY} for share
  `);
  await tx.execute(sql`
    select ur.role_code, rc.capability_code
      from user_role ur
      join role r on r.client = ur.client and r.code = ur.role_code and r.is_active = true
      join role_capability rc on rc.client = ur.client and rc.role_code = ur.role_code
     where ur.client = ${client}
       and ur.user_id = ${authorization.userId}
       and (ur.valid_from is null or ur.valid_from <= now())
       and (ur.valid_to is null or ur.valid_to >= now())
     for share of ur, r, rc
  `);
  const capabilities = await loadCapabilities(tx, client, authorization.userId);
  if (!hasCapability(capabilities, CONFIRMATION_CANCEL_CAPABILITY)) {
    fail(
      `You do not hold the authority ${CONFIRMATION_CANCEL_CAPABILITY}.`,
      'Ask an administrator to add that authority to one of your roles.',
    );
  }

  await tx.execute(sql`
    select id from auth_org_restriction
     where client = ${client} and user_id = ${authorization.userId}
     for share
  `);
  const restrictions = await loadOrgRestrictions(tx, client, authorization.userId);
  const hasCompanyScope = restrictions.some((scope) => scope.scopeType === 'COMPANY_CODE' && scope.scopeValue.trim());
  const hasPlantScope = restrictions.some((scope) => scope.scopeType === 'PLANT' && scope.scopeValue.trim());
  if (!hasCompanyScope || !hasPlantScope) {
    fail(
      'You are not authorised to cancel this production confirmation.',
      'An explicit Company Code and Plant scope are required.',
    );
  }
  return { username: String(actor.username), restrictions };
}

async function requireConfirmationOrderScopeInTx(
  tx: Tx,
  client: string,
  orderNumber: string,
  restrictions: Awaited<ReturnType<typeof loadOrgRestrictions>>,
) {
  const orders = await rows(tx, sql`
    select plant, company_code as company_code
      from production_order
     where client = ${client} and order_number = ${orderNumber}
     for share
  `);
  const order = orders[0];
  if (!order) fail(`Production order ${orderNumber} does not stand.`, 'Choose an order in this tenant.');

  const plants = await rows(tx, sql`
    select plant, company_code as company_code
      from plant
     where client = ${client} and plant = ${String(order.plant)}
     for share
  `);
  const plant = plants[0];
  const companyCode = plant?.company_code == null ? '' : String(plant.company_code).trim();
  const storedCompany = order.company_code == null ? '' : String(order.company_code).trim();
  if (!plant || !companyCode || (storedCompany && storedCompany !== companyCode)) {
    fail('The production order has no consistent Company Code and Plant assignment.', 'Ask an administrator to review the order and plant configuration.');
  }
  if (!hasOrgAccess(restrictions, 'COMPANY_CODE', companyCode)
    || !hasOrgAccess(restrictions, 'PLANT', String(plant.plant))) {
    fail(
      'You are not authorised to access this production order.',
      'Your Company Code or Plant scope does not cover this order.',
    );
  }
  return { plant: String(plant.plant), companyCode };
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
  if (reason.length > 200) fail('The cancellation reason is too long.', 'Use at most 200 characters.');
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
  authorization: ConfirmationCancelAuthorizationContext;
}): Promise<ConfirmationCancelLoad> {
  const confirmationNumber = clean(input.confirmationNumber).toUpperCase();
  const orderNumber = clean(input.orderNumber).toUpperCase();
  if (!confirmationNumber && !orderNumber) {
    fail('A confirmation number is required.', 'Enter the confirmation number, or an order number to list its confirmations.');
  }
  if (confirmationNumber.length > 12) fail('The confirmation number is too long.', 'Use the number as it stands.');
  if (orderNumber.length > 12) fail('The production order number is too long.', 'Use the number as it stands.');
  return withTenant(client, async (tx) => {
    const authority = await requireCancellationAuthorityInTx(tx, client, input.authorization);
    if (!confirmationNumber) {
      await requireConfirmationOrderScopeInTx(tx, client, orderNumber, authority.restrictions);
      return { detail: null, matches: await listOf(tx, client, orderNumber), warning: null };
    }
    const detail = await detailOf(tx, client, confirmationNumber);
    if (!detail) {
      fail(`Confirmation ${confirmationNumber} does not stand.`, 'Choose a confirmation that stands in this tenant. Nothing was cancelled.');
    }
    await requireConfirmationOrderScopeInTx(tx, client, detail.orderNumber, authority.restrictions);
    const warning = orderNumber && orderNumber !== detail.orderNumber
      ? `Confirmation ${confirmationNumber} stands on order ${detail.orderNumber}, not ${orderNumber}.`
      : null;
    return { detail, matches: [], warning };
  });
}

export async function cancelConfirmation(client: string, input: {
  requestKey: string;
  confirmationNumber: string;
  reason?: string | null;
  confirmed: boolean;
  authorization: ConfirmationCancelAuthorizationContext;
}): Promise<ConfirmationCancelResult> {
  const requestKey = clean(input.requestKey);
  if (!requestKey || requestKey.length > 64) fail('A request key is required.');
  const confirmationNumber = confirmationNumberOf(input.confirmationNumber);
  const reason = reasonOf(input.reason);
  return withTenant(client, async (tx) => {
    const authority = await requireCancellationAuthorityInTx(tx, client, input.authorization);
    // Confirmation records are immutable for the runtime role. The per-order
    // TIME_TICKET_LOCK acquired below serializes posting/cancellation decisions,
    // so this identity read needs no row lock (which would require UPDATE on
    // this insert-only audit table).
    const standing = await rows(tx, sql`
      select order_number, request_key from production_confirmation
       where client = ${client} and confirmation_number = ${confirmationNumber}
    `);
    if (!standing[0]) {
      fail(`Confirmation ${confirmationNumber} does not stand.`, 'Choose a confirmation that stands in this tenant. Nothing was cancelled.');
    }
    const orderNumber = String(standing[0].order_number);
    await requireConfirmationOrderScopeInTx(tx, client, orderNumber, authority.restrictions);
    await acquireLock(tx, { objectCode: TIME_TICKET_LOCK, keys: [client, orderNumber] }, {
      client, requestedBy: authority.username, transactionCode: CONFIRMATION_CANCEL_ALIAS,
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
    // Legacy NULL reasons are accepted only by the matching request-key replay above.
    if (!reason) fail('A cancellation reason is required.', 'Enter why this confirmation is being cancelled.');
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
    // A confirmation that moved stock cannot be cancelled out from under the movement.
    // CO13 holds no reversal of its own, and none is attempted here: the material-document
    // screen reverses the movement, and once no document of this confirmation stands, the
    // cancellation is allowed and the original confirmation stays exactly as posted.
    const caused = await movementStands(
      tx, client, standing[0].request_key == null ? '' : String(standing[0].request_key),
    );
    if (caused.length) {
      fail(
        `Confirmation ${confirmationNumber} posted material document ${caused.map((d) => d.materialDocumentNumber).join(' and ')}, and it still stands. Nothing was cancelled.`,
        'Reverse the goods movement on the material-document screen. A cancellation is then allowed. The original confirmation was not changed.',
      );
    }
    if (input.confirmed !== true) {
      fail('Cancellation was not confirmed. Nothing was saved.', 'Confirm the cancellation. The original confirmation was not changed.');
    }
    const allocated = await allocateNumber(tx, { client, objectCode: 'PRODCONF', allocatedBy: authority.username });
    const cancellationNumber = allocated.display;
    try {
      await tx.execute(sql`
        insert into production_confirmation_cancellation (
          client, cancellation_number, confirmation_number, order_number, reason, request_key, created_by
        ) values (
          ${client}, ${cancellationNumber}, ${confirmationNumber}, ${orderNumber}, ${reason}, ${requestKey}, ${authority.username}
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
      changedBy: authority.username,
      transactionCode: CONFIRMATION_CANCEL_ALIAS,
      reason,
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
