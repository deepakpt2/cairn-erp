/**
 * COGI works one durable CO11N issue/receipt intent at a time. An ISSUE intent may
 * contain several component lines because Cairn posts the issue atomically as one
 * material document; correction remains line-level without splitting or changing
 * that original idempotent posting request.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { acquireLock } from '../../platform/lock';
import { toScaled } from '../../platform/posting/decimal';
import { PRODUCTION_RECEIPT_SCENARIO } from '../inventory/production-receipt';
import {
  attemptProductionGoodsMovementFailure,
  fingerprintStoredMovementPayload,
  type ProductionGoodsMovementAttemptResult,
  type ProductionGoodsMovementKind,
  type ProductionGoodsMovementStatus,
  type StoredPayload,
} from './production-goods-movement-failures';
import {
  PRODUCTION_COGI_ALIAS,
  PRODUCTION_COGI_CAPABILITY,
  PRODUCTION_COGI_ROUTE,
  ProductionCogiAuthorizationError,
  requireProductionCogiAuthorityInTx,
  requireProductionCogiFailureScopeInTx,
  type ProductionCogiAuthorizationContext,
} from './production-cogi-auth';
import {
  productionGoodsMovementFailure,
  productionGoodsMovementFailureAttempt,
  productionGoodsMovementFailureLine,
  productionGoodsMovementFailureRevision,
} from './schema';

export { PRODUCTION_COGI_ALIAS, PRODUCTION_COGI_CAPABILITY, PRODUCTION_COGI_ROUTE };

const COGI_AUDIT_CLASS = 'production_goods_movement';
const MAX_PAGE_SIZE = 100;
const ISSUE_QUANTITY_SCALE = 3;

export class ProductionCogiError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ProductionCogiError';
    this.remedy = remedy;
  }
}

export type ProductionCogiStatusFilter = 'OPEN' | ProductionGoodsMovementStatus | 'ALL';

export interface ProductionCogiSelection {
  status?: ProductionCogiStatusFilter;
  orderNumber?: string;
  operationNumber?: string;
  plant?: string;
  movementKind?: ProductionGoodsMovementKind;
  materialNumber?: string;
  limit?: number;
}

export interface ProductionCogiQueueRow {
  id: string;
  confirmationNumber: string;
  orderNumber: string;
  operationNumber: string;
  plant: string;
  movementKind: ProductionGoodsMovementKind;
  movementType: string;
  sapMovementType: string;
  postingDate: string;
  status: ProductionGoodsMovementStatus;
  attemptCount: number;
  failureCode: string | null;
  errorText: string | null;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  materialDocumentNumber: string | null;
  documentYear: number | null;
  createdAt: Date;
  lineCount: number;
  firstLine: {
    materialNumber: string;
    quantity: string;
    unit: string;
    storageLocation: string | null;
    batchNumber: string;
  } | null;
}

export interface ProductionCogiDetail {
  failure: typeof productionGoodsMovementFailure.$inferSelect;
  lines: Array<typeof productionGoodsMovementFailureLine.$inferSelect>;
  attempts: Array<typeof productionGoodsMovementFailureAttempt.$inferSelect>;
  revisions: Array<typeof productionGoodsMovementFailureRevision.$inferSelect>;
  currentRevision: number;
  sapMovementType: string;
  effectivePayload: StoredPayload;
}

export interface ProductionCogiCorrectionChange {
  lineNumber: number;
  quantity?: string;
  storageLocation?: string | null;
  batch?: string | null;
}

export interface ProductionCogiCorrectionInput {
  client: string;
  failureId: string;
  expectedRevision: number;
  reason: string;
  changes: ProductionCogiCorrectionChange[];
  authorization: ProductionCogiAuthorizationContext;
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function textField(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ProductionCogiError(`${label} must be text.`);
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new ProductionCogiError(`${label} must contain 1 to ${maxLength} characters.`);
  }
  return result;
}

function correctionReason(value: string): string {
  return textField(value, 'The correction reason', 200);
}

function sapMovementTypeOf(payload: StoredPayload): string {
  return 'movementTypeCode' in payload ? payload.movementTypeCode : PRODUCTION_RECEIPT_SCENARIO.code;
}

function correctionQuantity(value: string): string {
  const cleaned = value.trim();
  if (!/^(?:0|[1-9]\d{0,19})(?:\.\d{1,3})?$/.test(cleaned)) {
    throw new ProductionCogiError('A corrected quantity must be a positive decimal with at most three fractional digits.');
  }
  const scaled = toScaled(cleaned, ISSUE_QUANTITY_SCALE);
  if (scaled <= 0n) throw new ProductionCogiError('A corrected quantity must be greater than zero.');
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric) || toScaled(String(numeric), ISSUE_QUANTITY_SCALE) !== scaled) {
    throw new ProductionCogiError('This quantity cannot be represented exactly by the movement posting service.');
  }
  return cleaned;
}

function correctedLocation(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.trim().toUpperCase();
  if (!cleaned) throw new ProductionCogiError('Enter a storage location or leave the field unchanged.');
  if (cleaned.length > 10 || !/^[A-Z0-9_-]+$/.test(cleaned)) {
    throw new ProductionCogiError('A storage location may contain at most 10 letters, digits, underscores, or hyphens.');
  }
  return cleaned;
}

function correctedBatch(value: string | null): string | null {
  if (value === null || !value.trim()) return null;
  const cleaned = value.trim().toUpperCase();
  if (cleaned.length > 40) throw new ProductionCogiError('A batch number may contain at most 40 characters.');
  return cleaned;
}

function filtersFor(input: ProductionCogiSelection, client: string) {
  const conditions = [eq(productionGoodsMovementFailure.client, client)];
  if (input.status && input.status !== 'ALL') {
    const statuses: ProductionGoodsMovementStatus[] = input.status === 'OPEN'
      ? ['PENDING', 'FAILED', 'PROCESSING']
      : [input.status];
    conditions.push(inArray(productionGoodsMovementFailure.status, statuses));
  }
  const order = clean(input.orderNumber);
  const operation = clean(input.operationNumber);
  const plant = clean(input.plant);
  const material = clean(input.materialNumber);
  if (order) conditions.push(eq(productionGoodsMovementFailure.orderNumber, order));
  if (operation) conditions.push(eq(productionGoodsMovementFailure.operationNumber, operation));
  if (plant) conditions.push(eq(productionGoodsMovementFailure.plant, plant));
  if (input.movementKind) conditions.push(eq(productionGoodsMovementFailure.movementKind, input.movementKind));
  if (material) conditions.push(sql`exists (
    select 1 from production_goods_movement_failure_line l
     where l.client = ${client}
       and l.failure_id = ${productionGoodsMovementFailure.id}
       and l.material_number = ${material}
  )`);
  return conditions;
}

async function failureScopeOrNull(
  tx: Tx,
  client: string,
  failure: { orderNumber: string; plant: string },
  restrictions: Parameters<typeof requireProductionCogiFailureScopeInTx>[3],
): Promise<boolean> {
  try {
    await requireProductionCogiFailureScopeInTx(tx, client, failure, restrictions);
    return true;
  } catch (error) {
    if (error instanceof ProductionCogiAuthorizationError) return false;
    throw error;
  }
}

export async function listProductionCogiFailures(input: {
  client: string;
  authorization: ProductionCogiAuthorizationContext;
  selection?: ProductionCogiSelection;
}): Promise<ProductionCogiQueueRow[]> {
  return withTenant(input.client, async (tx) => {
    const authority = await requireProductionCogiAuthorityInTx(tx, input.client, input.authorization);
    const limit = Math.min(Math.max(Math.trunc(input.selection?.limit ?? 50), 1), MAX_PAGE_SIZE);
    const filters = filtersFor(input.selection ?? {}, input.client);
    const allowedPlants = authority.restrictions.filter((scope) => scope.scopeType === 'PLANT').map((scope) => scope.scopeValue);
    const allowedCompanies = authority.restrictions.filter((scope) => scope.scopeType === 'COMPANY_CODE').map((scope) => scope.scopeValue);
    filters.push(inArray(productionGoodsMovementFailure.plant, allowedPlants));
    filters.push(sql`exists (
      select 1 from production_order o
      join plant p on p.client = o.client and p.plant = o.plant
      where o.client = ${input.client}
        and o.order_number = ${productionGoodsMovementFailure.orderNumber}
        and p.plant = ${productionGoodsMovementFailure.plant}
        and p.company_code in (${sql.join(allowedCompanies.map((companyCode) => sql`${companyCode}`), sql`, `)})
    )`);
    const records = await tx.select().from(productionGoodsMovementFailure)
      .where(and(...filters))
      .orderBy(desc(productionGoodsMovementFailure.createdAt), asc(productionGoodsMovementFailure.id))
      .limit(limit);
    if (!records.length) return [];
    const allowed = [] as typeof records;
    for (const row of records) {
      if (await failureScopeOrNull(tx, input.client, row, authority.restrictions)) allowed.push(row);
    }
    if (!allowed.length) return [];
    const lines = await tx.select().from(productionGoodsMovementFailureLine).where(and(
      eq(productionGoodsMovementFailureLine.client, input.client),
      inArray(productionGoodsMovementFailureLine.failureId, allowed.map((row) => row.id)),
    )).orderBy(asc(productionGoodsMovementFailureLine.lineNumber));
    const linesByFailure = new Map<string, typeof lines>();
    for (const line of lines) {
      const group = linesByFailure.get(line.failureId) ?? [];
      group.push(line);
      linesByFailure.set(line.failureId, group);
    }
    return allowed.map((row) => {
      const recordLines = linesByFailure.get(row.id) ?? [];
      const first = recordLines[0];
      return {
        id: row.id,
        confirmationNumber: row.confirmationNumber,
        orderNumber: row.orderNumber,
        operationNumber: row.operationNumber,
        plant: row.plant,
        movementKind: row.movementKind as ProductionGoodsMovementKind,
        movementType: row.movementType,
        sapMovementType: sapMovementTypeOf(row.originalPayload as StoredPayload),
        postingDate: row.postingDate,
        status: row.status as ProductionGoodsMovementStatus,
        attemptCount: row.attemptCount,
        failureCode: row.failureCode,
        errorText: row.errorText,
        lastAttemptAt: row.lastAttemptAt,
        nextRetryAt: row.nextRetryAt,
        materialDocumentNumber: row.materialDocumentNumber,
        documentYear: row.documentYear,
        createdAt: row.createdAt,
        lineCount: recordLines.length,
        firstLine: first ? {
          materialNumber: first.materialNumber,
          quantity: String(first.quantity),
          unit: first.unit,
          storageLocation: first.storageLocation,
          batchNumber: first.batchNumber,
        } : null,
      };
    });
  });
}

export async function getProductionCogiFailure(input: {
  client: string;
  failureId: string;
  authorization: ProductionCogiAuthorizationContext;
}): Promise<ProductionCogiDetail | null> {
  return withTenant(input.client, async (tx) => {
    const authority = await requireProductionCogiAuthorityInTx(tx, input.client, input.authorization);
    const [failure] = await tx.select().from(productionGoodsMovementFailure).where(and(
      eq(productionGoodsMovementFailure.client, input.client),
      eq(productionGoodsMovementFailure.id, input.failureId),
    ));
    if (!failure) return null;
    await requireProductionCogiFailureScopeInTx(tx, input.client, failure, authority.restrictions);
    const lines = await tx.select().from(productionGoodsMovementFailureLine).where(and(
      eq(productionGoodsMovementFailureLine.client, input.client),
      eq(productionGoodsMovementFailureLine.failureId, input.failureId),
    )).orderBy(asc(productionGoodsMovementFailureLine.lineNumber));
    const attempts = await tx.select().from(productionGoodsMovementFailureAttempt).where(and(
      eq(productionGoodsMovementFailureAttempt.client, input.client),
      eq(productionGoodsMovementFailureAttempt.failureId, input.failureId),
    )).orderBy(asc(productionGoodsMovementFailureAttempt.attemptNumber));
    const revisions = await tx.select().from(productionGoodsMovementFailureRevision).where(and(
      eq(productionGoodsMovementFailureRevision.client, input.client),
      eq(productionGoodsMovementFailureRevision.failureId, input.failureId),
    )).orderBy(asc(productionGoodsMovementFailureRevision.revisionNumber));
    const latest = revisions[revisions.length - 1];
    const effectivePayload = (latest?.correctedPayload ?? failure.originalPayload) as StoredPayload;
    return {
      failure,
      lines,
      attempts,
      revisions,
      currentRevision: latest?.revisionNumber ?? 0,
      sapMovementType: sapMovementTypeOf(effectivePayload),
      effectivePayload,
    };
  });
}

async function lockedFailureForAction(
  tx: Tx,
  client: string,
  failureId: string,
  authorization: ProductionCogiAuthorizationContext,
) {
  const authority = await requireProductionCogiAuthorityInTx(tx, client, authorization);
  const [observed] = await tx.select().from(productionGoodsMovementFailure).where(and(
    eq(productionGoodsMovementFailure.client, client),
    eq(productionGoodsMovementFailure.id, failureId),
  ));
  if (!observed) throw new ProductionCogiError('That failed goods movement is no longer available.');
  await acquireLock(tx, { objectCode: 'PRODUCTION_ORDER', keys: [client, observed.orderNumber] }, {
    client,
    requestedBy: authority.username,
    transactionCode: PRODUCTION_COGI_ALIAS,
  });
  const [failure] = await tx.select().from(productionGoodsMovementFailure).where(and(
    eq(productionGoodsMovementFailure.client, client),
    eq(productionGoodsMovementFailure.id, failureId),
  )).for('update');
  if (!failure) throw new ProductionCogiError('That failed goods movement is no longer available.');
  await requireProductionCogiFailureScopeInTx(tx, client, failure, authority.restrictions);
  return { authority, failure };
}

export function applyProductionCogiCorrections(
  original: StoredPayload,
  lines: Array<typeof productionGoodsMovementFailureLine.$inferSelect>,
  changes: ProductionCogiCorrectionChange[],
): StoredPayload {
  const byNumber = new Map(changes.map((change) => [change.lineNumber, change]));
  if (changes.length === 0 || byNumber.size !== changes.length) {
    throw new ProductionCogiError('Choose at least one movement line to correct; each line may appear only once.');
  }
  const allowedFields = new Set(['lineNumber', 'quantity', 'storageLocation', 'batch']);
  if (changes.some((change) => Object.keys(change).some((key) => !allowedFields.has(key)))) {
    throw new ProductionCogiError('COGI accepts quantity, storage location, and batch corrections only.');
  }
  if (changes.some((change) => !Number.isInteger(change.lineNumber) || change.lineNumber < 1 || change.lineNumber > lines.length)) {
    throw new ProductionCogiError('A correction refers to a movement line that does not exist.');
  }
  if (original.lines.length !== lines.length) {
    throw new ProductionCogiError('The stored movement details do not match the original line snapshot. Ask an administrator to review this record.');
  }
  let changed = false;
  const newLines = original.lines.map((line, index) => {
    const lineNumber = index + 1;
    const normalized = lines.find((entry) => entry.lineNumber === lineNumber);
    if (!normalized) throw new ProductionCogiError('The stored movement lines are incomplete. Ask an administrator to review this record.');
    const change = byNumber.get(lineNumber);
    if (!change) return { ...line };
    const next = { ...line };
    if (change.quantity !== undefined) {
      const quantity = correctionQuantity(change.quantity);
      const requested = toScaled(quantity, ISSUE_QUANTITY_SCALE);
      const originalRequested = toScaled(String(line.quantity), ISSUE_QUANTITY_SCALE);
      if (requested > originalRequested) {
        throw new ProductionCogiError(`Line ${lineNumber}: the corrected quantity cannot exceed the confirmed quantity.`);
      }
      if (requested !== originalRequested) {
        const numeric = Number(quantity);
        if (!Number.isFinite(numeric) || toScaled(String(numeric), ISSUE_QUANTITY_SCALE) !== requested) {
          throw new ProductionCogiError(`Line ${lineNumber}: the corrected quantity cannot be represented exactly.`);
        }
        (next as { quantity: number }).quantity = numeric;
        changed = true;
      }
    }
    if (change.storageLocation !== undefined) {
      const location = correctedLocation(change.storageLocation);
      if (location !== line.storageLocation) {
        (next as { storageLocation: string | null }).storageLocation = location;
        changed = true;
      }
    }
    if (change.batch !== undefined) {
      const batch = correctedBatch(change.batch);
      if (batch !== line.batch) {
        (next as { batch: string | null }).batch = batch;
        changed = true;
      }
    }
    if ('materialNumber' in change || 'plant' in change || 'requestKey' in change) {
      throw new ProductionCogiError('Material, plant, and idempotency identity are immutable in COGI.');
    }
    return next;
  });
  if (!changed) throw new ProductionCogiError('No movement details changed.');
  return { ...original, lines: newLines } as StoredPayload;
}

export async function correctProductionCogiFailure(input: ProductionCogiCorrectionInput): Promise<{
  failureId: string;
  revisionNumber: number;
  payloadFingerprint: string;
}> {
  const reason = correctionReason(input.reason);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new ProductionCogiError('The displayed correction version is invalid. Refresh the COGI record and try again.');
  }
  return withTenant(input.client, async (tx) => {
    const { authority, failure } = await lockedFailureForAction(tx, input.client, input.failureId, input.authorization);
    if (failure.status !== 'FAILED' && failure.status !== 'PENDING') {
      throw new ProductionCogiError('Only pending or failed movements can be corrected.', 'Wait for active processing to finish, or discard a blocked movement.');
    }
    const [latest] = await tx.select().from(productionGoodsMovementFailureRevision).where(and(
      eq(productionGoodsMovementFailureRevision.client, input.client),
      eq(productionGoodsMovementFailureRevision.failureId, failure.id),
    )).orderBy(desc(productionGoodsMovementFailureRevision.revisionNumber)).limit(1);
    const currentRevision = latest?.revisionNumber ?? 0;
    if (currentRevision !== input.expectedRevision) {
      throw new ProductionCogiError('This movement was corrected by another user. Refresh it before making another correction.');
    }
    const [lineCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(productionGoodsMovementFailureLine).where(and(
      eq(productionGoodsMovementFailureLine.client, input.client),
      eq(productionGoodsMovementFailureLine.failureId, failure.id),
    ));
    const lines = lineCount?.count
      ? await tx.select().from(productionGoodsMovementFailureLine).where(and(
        eq(productionGoodsMovementFailureLine.client, input.client),
        eq(productionGoodsMovementFailureLine.failureId, failure.id),
      )).orderBy(asc(productionGoodsMovementFailureLine.lineNumber))
      : [];
    const currentPayload = (latest?.correctedPayload ?? failure.originalPayload) as unknown as StoredPayload;
    const correctedPayload = applyProductionCogiCorrections(currentPayload, lines, input.changes);
    const revisionNumber = currentRevision + 1;
    const payloadFingerprint = fingerprintStoredMovementPayload(correctedPayload);
    await tx.insert(productionGoodsMovementFailureRevision).values({
      client: input.client,
      failureId: failure.id,
      revisionNumber,
      correctedPayload: correctedPayload as unknown as Record<string, unknown>,
      payloadFingerprint,
      changeReason: reason,
      createdBy: authority.username,
    });
    const now = new Date();
    await tx.update(productionGoodsMovementFailure).set({
      status: 'FAILED',
      failureCode: 'DETAILS_CORRECTED',
      errorText: `Movement details corrected in COGI (revision ${revisionNumber}); retry is required.`,
      nextRetryAt: null,
      changedBy: authority.username,
      changedAt: now,
    }).where(and(
      eq(productionGoodsMovementFailure.client, input.client),
      eq(productionGoodsMovementFailure.id, failure.id),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: COGI_AUDIT_CLASS,
      objectKey: failure.id,
      changeType: 'CHANGE',
      changedBy: authority.username,
      transactionCode: PRODUCTION_COGI_ALIAS,
      reason,
      before: { status: failure.status, revision: currentRevision, payloadFingerprint: latest?.payloadFingerprint ?? failure.idempotencyFingerprint },
      after: { status: 'FAILED', revision: revisionNumber, payloadFingerprint },
    });
    return { failureId: failure.id, revisionNumber, payloadFingerprint };
  });
}

export async function retryProductionCogiFailure(input: {
  client: string;
  failureId: string;
  authorization: ProductionCogiAuthorizationContext;
}): Promise<ProductionGoodsMovementAttemptResult> {
  return attemptProductionGoodsMovementFailure({
    client: input.client,
    failureId: input.failureId,
    attemptedBy: 'COGI',
    authorization: input.authorization,
  });
}

export async function discardProductionCogiFailure(input: {
  client: string;
  failureId: string;
  reason: string;
  authorization: ProductionCogiAuthorizationContext;
}): Promise<{ failureId: string; alreadyDiscarded: boolean }> {
  const reason = correctionReason(input.reason);
  return withTenant(input.client, async (tx) => {
    const { authority, failure } = await lockedFailureForAction(tx, input.client, input.failureId, input.authorization);
    if (failure.status === 'DISCARDED') {
      if ((failure.dispositionReason ?? '') === reason) return { failureId: failure.id, alreadyDiscarded: true };
      throw new ProductionCogiError('This movement was already discarded with a different reason.');
    }
    if (failure.status === 'POSTED') {
      throw new ProductionCogiError('A posted movement cannot be discarded.', 'Reverse its material document using the authorised material-document reversal process.');
    }
    if (failure.status === 'PROCESSING') {
      throw new ProductionCogiError('This movement is currently being processed.', 'Wait for the active posting attempt to finish, then refresh COGI.');
    }
    const now = new Date();
    await tx.update(productionGoodsMovementFailure).set({
      status: 'DISCARDED',
      discardedAt: now,
      discardedBy: authority.username,
      dispositionReason: reason,
      nextRetryAt: null,
      processingToken: null,
      processingLeaseExpiresAt: null,
      changedBy: authority.username,
      changedAt: now,
    }).where(and(
      eq(productionGoodsMovementFailure.client, input.client),
      eq(productionGoodsMovementFailure.id, failure.id),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: COGI_AUDIT_CLASS,
      objectKey: failure.id,
      changeType: 'CHANGE',
      changedBy: authority.username,
      transactionCode: PRODUCTION_COGI_ALIAS,
      reason,
      before: { status: failure.status, attemptCount: failure.attemptCount },
      after: { status: 'DISCARDED', discardedAt: now, dispositionReason: reason },
    });
    return { failureId: failure.id, alreadyDiscarded: false };
  });
}
