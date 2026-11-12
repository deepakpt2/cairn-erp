import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { enqueue } from '../../platform/job/queue';
import { FANOUT_JOB } from '../../platform/notification/jobs/fanout';
import { acquireLock } from '../../platform/lock';
import { plant as plantTable } from '../foundation/schema';
import {
  GoodsIssueError,
  GOODS_ISSUE_SCENARIOS,
  postGoodsIssue,
  type GoodsIssueView,
  type PostGoodsIssueInput,
} from '../inventory/goods-issue';
import {
  postProductionReceipt,
  PRODUCTION_RECEIPT_SCENARIO,
  ProductionReceiptError,
  type PostProductionReceiptInput,
  type ProductionReceiptView,
} from '../inventory/production-receipt';
import { productionOrder } from '../inventory/schema';
import {
  CONFIRMATION_MOVEMENT_CODES,
  movementRequestKey,
  type MovementPlan,
} from './confirmation-movements';
import {
  productionConfirmationCancellation,
  productionGoodsMovementFailure,
  productionGoodsMovementFailureAttempt,
  productionGoodsMovementFailureLine,
  productionGoodsMovementFailureRevision,
} from './schema';
import {
  PRODUCTION_COGI_CAPABILITY,
  requireProductionCogiAuthorityInTx,
  requireProductionCogiFailureScopeInTx,
  type ProductionCogiAuthorizationContext,
} from './production-cogi-auth';

const SOURCE_TRANSACTION = 'CO11N';
const SOURCE_DOCUMENT_CLASS = 'production_confirmation';
const FAILURE_AUDIT_CLASS = 'production_goods_movement';
const DEFAULT_LEASE_MS = 5 * 60_000;
const MAX_PAGE_SIZE = 200;

export type ProductionGoodsMovementStatus = 'PENDING' | 'PROCESSING' | 'FAILED' | 'BLOCKED' | 'POSTED' | 'DISCARDED';
export type ProductionGoodsMovementKind = 'ISSUE' | 'RECEIPT';

export type StoredIssueLine = {
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  storageLocationMode: 'EXPLICIT';
  quantity: number;
  entryUnit: string | null;
  productionOrderNumber: string;
  productionOrderItem: number;
  batch: string | null;
  reservationNumber: string | null;
  reservationItem: number | null;
};

export type StoredIssuePayload = {
  schemaVersion: 1;
  movementTypeCode: string;
  postingDate: string;
  documentDate: string;
  headerText: string;
  requestKey: string;
  lines: StoredIssueLine[];
};

export type StoredReceiptLine = {
  quantity: number;
  entryUnit: string;
  storageLocation: string | null;
  storageLocationMode: 'EXPLICIT';
  batch: string | null;
};

export type StoredReceiptPayload = {
  schemaVersion: 1;
  postingDate: string;
  documentDate: string;
  headerText: string;
  requestKey: string;
  /** Snapshot of the order's batch at confirmation time; an empty value stays empty. */
  orderBatchNumber: string;
  lines: StoredReceiptLine[];
};

export type StoredPayload = StoredIssuePayload | StoredReceiptPayload;

export interface PersistConfirmationMovementsInput {
  client: string;
  changedBy: string;
  confirmationNumber: string;
  confirmationRequestKey: string;
  orderNumber: string;
  operationNumber: string;
  plant: string;
  postingDate: string;
  movementPlan: MovementPlan;
}

export interface ProductionGoodsMovementFailureSummary {
  id: string;
  movementKind: ProductionGoodsMovementKind;
  movementType: string;
  status: ProductionGoodsMovementStatus;
  attemptCount: number;
  failureCode: string | null;
  errorText: string | null;
  lastAttemptAt: Date | null;
  nextRetryAt: Date | null;
  materialDocumentNumber: string | null;
  documentYear: number | null;
}

export interface ProductionGoodsMovementFailureDetail {
  failure: typeof productionGoodsMovementFailure.$inferSelect;
  lines: Array<typeof productionGoodsMovementFailureLine.$inferSelect>;
  attempts: Array<typeof productionGoodsMovementFailureAttempt.$inferSelect>;
  revisions: Array<typeof productionGoodsMovementFailureRevision.$inferSelect>;
  currentRevision: number;
  effectivePayload: StoredPayload;
}

export interface ProductionGoodsMovementFailureSelection {
  status?: ProductionGoodsMovementStatus | ProductionGoodsMovementStatus[];
  orderNumber?: string;
  operationNumber?: string;
  plant?: string;
  movementKind?: ProductionGoodsMovementKind;
  materialNumber?: string;
  limit?: number;
}

export type ProductionGoodsMovementAttemptResult =
  | { outcome: 'POSTED'; failureId: string; materialDocumentNumber: string; documentYear: number }
  | { outcome: 'FAILED' | 'BLOCKED'; failureId: string; failureCode: string; errorText: string }
  | { outcome: 'BUSY' | 'ALREADY_POSTED' | 'NOT_ELIGIBLE' | 'LEASE_LOST'; failureId: string };

class SourceConfirmationCancelledError extends Error {
  constructor(readonly confirmationNumber: string) {
    super(`Confirmation ${confirmationNumber} was cancelled before its automatic movement could post.`);
    this.name = 'SourceConfirmationCancelledError';
  }
}

class LostMovementLeaseError extends Error {
  constructor() {
    super('This processing lease is no longer owned by this attempt.');
    this.name = 'LostMovementLeaseError';
  }
}

/** A movement nobody owns: the continuation carries no user, so nothing is posted. */
export class AutomaticMovementAuthorityError extends Error {
  constructor() {
    super(
      'This automatic movement has no user behind it, and a goods movement is posted by a person. Nothing was posted.',
    );
    this.name = 'AutomaticMovementAuthorityError';
  }
}

export class MovementFailurePersistenceError extends Error {
  constructor(readonly confirmationNumber: string, cause: unknown) {
    super(
      `Confirmation ${confirmationNumber} is saved, but its movement outcome could not be recorded. The durable movement intent remains available for recovery.`,
      { cause },
    );
    this.name = 'MovementFailurePersistenceError';
  }
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function safeError(error: unknown): { code: string; text: string } {
  let code = 'POSTING_ERROR';
  let message = error instanceof Error ? error.message : String(error ?? 'Unknown posting failure');
  let remedy: string | undefined;
  if (error instanceof GoodsIssueError) {
    code = 'GOODS_ISSUE_REFUSED';
    remedy = error.remedy;
  } else if (error instanceof ProductionReceiptError) {
    code = 'PRODUCTION_RECEIPT_REFUSED';
    remedy = error.remedy;
  } else if (error instanceof SourceConfirmationCancelledError) {
    code = 'SOURCE_CONFIRMATION_CANCELLED';
  }
  if (remedy) message += ` Remedy: ${remedy}`;
  // Persist a useful business error, not a stack trace, URL, token, or credential.
  message = message
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[connection URL withheld]')
    .replace(/\b(password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 8_000);
  return { code, text: message || 'The movement posting failed without a returned error message.' };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function fingerprintStoredMovementPayload(payload: StoredPayload): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

function fingerprint(payload: StoredPayload): string {
  return fingerprintStoredMovementPayload(payload);
}

function canonicalIssueMovementType(): string {
  return GOODS_ISSUE_SCENARIOS.find((scenario) => scenario.code === CONFIRMATION_MOVEMENT_CODES.issue)?.movementType
    ?? 'PROD_ISSUE_ORDER';
}

/**
 * Write exact movement intents beside the confirmation. No stock, valuation, material
 * document, journal, reservation, or output is written here. These rows survive any later
 * posting rollback and make the source request recoverable after a process crash.
 */
export async function persistConfirmationMovementIntents(
  tx: Tx,
  input: PersistConfirmationMovementsInput,
): Promise<string[]> {
  const ids: string[] = [];
  const postingDate = input.postingDate;
  const documentDate = input.postingDate;
  const headerText = `CO11N ${input.confirmationNumber}`.slice(0, 25);
  const plants = [...new Set([
    ...input.movementPlan.issues.map((line) => line.plant),
    ...(input.movementPlan.receipt ? [input.movementPlan.receipt.plant] : []),
  ])];
  const defaults = plants.length
    ? await tx.select({ plant: plantTable.plant, storageLocation: plantTable.defaultStorageLocation })
      .from(plantTable).where(and(eq(plantTable.client, input.client), inArray(plantTable.plant, plants)))
    : [];
  const defaultByPlant = new Map(defaults.map((row) => [row.plant, row.storageLocation]));

  if (input.movementPlan.issues.length > 0) {
    const requestKey = movementRequestKey(input.confirmationRequestKey, 'ISSUE');
    if (!requestKey) throw new Error('A confirmation movement requires its original request key.');
    const payload: StoredIssuePayload = {
      schemaVersion: 1,
      movementTypeCode: CONFIRMATION_MOVEMENT_CODES.issue,
      postingDate,
      documentDate,
      headerText,
      requestKey,
      lines: input.movementPlan.issues.map((line) => ({
        materialNumber: line.materialNumber,
        plant: line.plant,
        // Freeze the effective component/plant default at source time. Explicit mode prevents
        // recovery from silently substituting a later master-data default.
        storageLocation: line.storageLocation?.trim() ? line.storageLocation : defaultByPlant.get(line.plant) ?? null,
        storageLocationMode: 'EXPLICIT',
        quantity: Number(line.quantity),
        entryUnit: null,
        productionOrderNumber: input.orderNumber,
        productionOrderItem: line.itemNumber,
        batch: null,
        reservationNumber: null,
        reservationItem: null,
      })),
    };
    const id = await insertIntent(tx, input, {
      id: crypto.randomUUID(),
      kind: 'ISSUE',
      movementType: canonicalIssueMovementType(),
      requestKey,
      payload,
      lines: payload.lines.map((line, index) => ({
        lineNumber: index + 1,
        materialNumber: line.materialNumber,
        plant: line.plant,
        quantity: String(line.quantity),
        unit: input.movementPlan.issues[index]!.unit,
        storageLocation: line.storageLocation,
        batchNumber: line.batch ?? '',
        specialStockType: null,
        specialStockNumber: null,
        productionOrderItem: line.productionOrderItem,
        reservationNumber: line.reservationNumber,
        reservationItem: line.reservationItem,
        originalPayload: line as unknown as Record<string, unknown>,
      })),
    });
    ids.push(id);
  }

  if (input.movementPlan.receipt) {
    const requestKey = movementRequestKey(input.confirmationRequestKey, 'RECEIPT');
    if (!requestKey) throw new Error('A confirmation movement requires its original request key.');
    const [order] = await tx.select({ batchNumber: productionOrder.batchNumber }).from(productionOrder).where(and(
      eq(productionOrder.client, input.client), eq(productionOrder.orderNumber, input.orderNumber),
    ));
    if (!order) throw new Error(`Production order ${input.orderNumber} does not stand while saving its receipt intent.`);
    const receipt = input.movementPlan.receipt;
    const payload: StoredReceiptPayload = {
      schemaVersion: 1,
      postingDate,
      documentDate,
      headerText,
      requestKey,
      orderBatchNumber: order.batchNumber,
      lines: [{
        quantity: Number(receipt.quantity),
        entryUnit: receipt.unit,
        storageLocation: defaultByPlant.get(receipt.plant) ?? null,
        storageLocationMode: 'EXPLICIT',
        batch: null,
      }],
    };
    const id = await insertIntent(tx, input, {
      id: crypto.randomUUID(),
      kind: 'RECEIPT',
      movementType: PRODUCTION_RECEIPT_SCENARIO.movementType,
      requestKey,
      payload,
      lines: payload.lines.map((line, index) => ({
        lineNumber: index + 1,
        materialNumber: receipt.materialNumber,
        plant: receipt.plant,
        quantity: String(line.quantity),
        unit: line.entryUnit,
        storageLocation: line.storageLocation,
        batchNumber: order.batchNumber,
        specialStockType: null,
        specialStockNumber: null,
        productionOrderItem: null,
        reservationNumber: null,
        reservationItem: null,
        originalPayload: line as unknown as Record<string, unknown>,
      })),
    });
    ids.push(id);
  }
  return ids;
}

async function insertIntent(
  tx: Tx,
  input: PersistConfirmationMovementsInput,
  movement: {
    id: string;
    kind: ProductionGoodsMovementKind;
    movementType: string;
    requestKey: string;
    payload: StoredPayload;
    lines: Array<{
      lineNumber: number;
      materialNumber: string;
      plant: string;
      quantity: string;
      unit: string;
      storageLocation: string | null;
      batchNumber: string;
      specialStockType: string | null;
      specialStockNumber: string | null;
      productionOrderItem: number | null;
      reservationNumber: string | null;
      reservationItem: number | null;
      originalPayload: Record<string, unknown>;
    }>;
  },
): Promise<string> {
  const hash = fingerprint(movement.payload);
  await tx.insert(productionGoodsMovementFailure).values({
    id: movement.id,
    client: input.client,
    sourceTransaction: SOURCE_TRANSACTION,
    sourceDocumentClass: SOURCE_DOCUMENT_CLASS,
    sourceDocumentNumber: input.confirmationNumber,
    confirmationNumber: input.confirmationNumber,
    confirmationRequestKey: input.confirmationRequestKey,
    orderNumber: input.orderNumber,
    operationNumber: input.operationNumber,
    plant: input.plant,
    movementKind: movement.kind,
    movementType: movement.movementType,
    postingDate: movement.payload.postingDate,
    documentDate: movement.payload.documentDate,
    headerText: movement.payload.headerText,
    originalRequestKey: movement.requestKey,
    idempotencyFingerprint: hash,
    originalPayload: movement.payload as unknown as Record<string, unknown>,
    status: 'PENDING',
    createdBy: input.changedBy,
  });
  if (movement.lines.length) {
    await tx.insert(productionGoodsMovementFailureLine).values(movement.lines.map((line) => ({
      client: input.client,
      failureId: movement.id,
      ...line,
      createdBy: input.changedBy,
    })));
  }
  await recordChange(tx, {
    client: input.client,
    objectClass: FAILURE_AUDIT_CLASS,
    objectKey: movement.id,
    changeType: 'CREATE',
    changedBy: input.changedBy,
    transactionCode: SOURCE_TRANSACTION,
    reason: `Persisted automatic ${movement.kind.toLowerCase()} movement intent for confirmation ${input.confirmationNumber}`,
    after: {
      confirmationNumber: input.confirmationNumber,
      orderNumber: input.orderNumber,
      operationNumber: input.operationNumber,
      plant: input.plant,
      movementKind: movement.kind,
      movementType: movement.movementType,
      requestKey: movement.requestKey,
      status: 'PENDING',
      idempotencyFingerprint: hash,
    },
  });
  return movement.id;
}

/** Summary for the CO11N result and internal callers; never exposes another tenant's row. */
export async function confirmationMovementOutcomes(
  tx: Tx,
  client: string,
  confirmationNumber: string,
): Promise<ProductionGoodsMovementFailureSummary[]> {
  const rows = await tx.select().from(productionGoodsMovementFailure).where(and(
    eq(productionGoodsMovementFailure.client, client),
    eq(productionGoodsMovementFailure.confirmationNumber, confirmationNumber),
  )).orderBy(asc(productionGoodsMovementFailure.createdAt), asc(productionGoodsMovementFailure.movementKind));
  return rows.map((row) => summaryOf(row));
}

function summaryOf(row: typeof productionGoodsMovementFailure.$inferSelect): ProductionGoodsMovementFailureSummary {
  return {
    id: row.id,
    movementKind: row.movementKind as ProductionGoodsMovementKind,
    movementType: row.movementType,
    status: row.status as ProductionGoodsMovementStatus,
    attemptCount: row.attemptCount,
    failureCode: row.failureCode,
    errorText: row.errorText,
    lastAttemptAt: row.lastAttemptAt,
    nextRetryAt: row.nextRetryAt,
    materialDocumentNumber: row.materialDocumentNumber,
    documentYear: row.documentYear,
  };
}

/**
 * Internal tenant-scoped listing helper. The user-facing COGI screen uses the separately
 * authorised production-cogi service so every read is checked against live session scope.
 */
export async function listProductionGoodsMovementFailures(input: {
  client: string;
  selection?: ProductionGoodsMovementFailureSelection;
}): Promise<ProductionGoodsMovementFailureSummary[]> {
  const selection = input.selection ?? {};
  const clauses = [eq(productionGoodsMovementFailure.client, input.client)];
  if (selection.status) {
    clauses.push(Array.isArray(selection.status)
      ? inArray(productionGoodsMovementFailure.status, selection.status)
      : eq(productionGoodsMovementFailure.status, selection.status));
  }
  if (selection.orderNumber) clauses.push(eq(productionGoodsMovementFailure.orderNumber, selection.orderNumber.trim()));
  if (selection.operationNumber) clauses.push(eq(productionGoodsMovementFailure.operationNumber, selection.operationNumber.trim()));
  if (selection.plant) clauses.push(eq(productionGoodsMovementFailure.plant, selection.plant.trim()));
  if (selection.movementKind) clauses.push(eq(productionGoodsMovementFailure.movementKind, selection.movementKind));
  if (selection.materialNumber) {
    clauses.push(sql`exists (
      select 1 from production_goods_movement_failure_line l
       where l.client = ${input.client}
         and l.failure_id = ${productionGoodsMovementFailure.id}
         and l.material_number = ${selection.materialNumber.trim()}
    )`);
  }
  const limit = Math.min(Math.max(Math.trunc(selection.limit ?? 50), 1), MAX_PAGE_SIZE);
  const rows = await withTenant(input.client, (tx) => tx.select().from(productionGoodsMovementFailure)
    .where(and(...clauses))
    .orderBy(desc(productionGoodsMovementFailure.createdAt), asc(productionGoodsMovementFailure.id))
    .limit(limit));
  return rows.map(summaryOf);
}

export async function getProductionGoodsMovementFailure(
  client: string,
  failureId: string,
): Promise<ProductionGoodsMovementFailureDetail | null> {
  return withTenant(client, async (tx) => {
    const [failure] = await tx.select().from(productionGoodsMovementFailure).where(and(
      eq(productionGoodsMovementFailure.client, client),
      eq(productionGoodsMovementFailure.id, failureId),
    ));
    if (!failure) return null;
    const lines = await tx.select().from(productionGoodsMovementFailureLine).where(and(
      eq(productionGoodsMovementFailureLine.client, client),
      eq(productionGoodsMovementFailureLine.failureId, failureId),
    )).orderBy(asc(productionGoodsMovementFailureLine.lineNumber));
    const attempts = await tx.select().from(productionGoodsMovementFailureAttempt).where(and(
      eq(productionGoodsMovementFailureAttempt.client, client),
      eq(productionGoodsMovementFailureAttempt.failureId, failureId),
    )).orderBy(asc(productionGoodsMovementFailureAttempt.attemptNumber));
    const revisions = await tx.select().from(productionGoodsMovementFailureRevision).where(and(
      eq(productionGoodsMovementFailureRevision.client, client),
      eq(productionGoodsMovementFailureRevision.failureId, failureId),
    )).orderBy(asc(productionGoodsMovementFailureRevision.revisionNumber));
    const latest = revisions[revisions.length - 1];
    return {
      failure,
      lines,
      attempts,
      revisions,
      currentRevision: latest?.revisionNumber ?? 0,
      effectivePayload: (latest?.correctedPayload ?? failure.originalPayload) as StoredPayload,
    };
  });
}

interface ClaimedMovement {
  record: typeof productionGoodsMovementFailure.$inferSelect;
  attemptNumber: number;
  payloadRevision: number;
  leaseToken: string;
  attemptedBy: string;
  authorization?: ProductionCogiAuthorizationContext;
}

export interface ProductionGoodsMovementClaim {
  failureId: string;
  attemptNumber: number;
  payloadRevision: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

/**
 * POSTING.FAILED — tell whoever can reprocess. Phase 8.
 *
 * A confirmation posts its own goods movements, so when one of them fails the
 * person who entered the confirmation has already moved on: the movement lands
 * in COGI, and nothing opens COGI on its own until somebody goes looking. So
 * the queue has to speak.
 *
 * It speaks to the holders of PROD.GM.REPROCESS over the two places COGI
 * itself answers for — the plant and the company code — and the company code is
 * read from the plant rather than carried on the order, because the plant is
 * the one place it lives. Passing both is what keeps the resolver the inverse
 * of `can()`: a holder restricted at either level is correctly left out.
 *
 * Only the first failure of a record is news. Every later attempt is made by
 * somebody sitting in front of the record in COGI, and they are told how it
 * went on the screen; a second message would tell them what they just did.
 *
 * A movement whose plant carries no company code is not announced at all. COGI
 * refuses to act on it for the same reason, and an unscoped fan-out would reach
 * every holder of the capability in the tenant, which is worse than silence.
 */
const POSTING_ACTOR = 'POSTING';
const MOVEMENT_FAILURE_NOTIFICATION_CLASS = 'production_goods_movement';

async function enqueuePostingFailed(
  tx: Tx,
  row: typeof productionGoodsMovementFailure.$inferSelect,
): Promise<void> {
  if (row.attemptCount > 1) return;
  const movementPlant = row.plant.trim();
  if (!movementPlant) return;

  const [place] = await tx.execute(sql`
    select p.company_code as "companyCode"
      from production_order o
      join plant p on p.client = o.client and p.plant = o.plant
     where o.client = ${row.client}
       and o.order_number = ${row.orderNumber}
     limit 1
  `) as unknown as Array<{ companyCode: string | null }>;
  const companyCode = place?.companyCode?.trim() ?? '';
  if (!companyCode) return;

  await enqueue(tx, {
    client: row.client,
    jobCode: FANOUT_JOB,
    triggeredBy: POSTING_ACTOR,
    idempotencyKey: `posting-failed/${row.id}`.slice(0, 120),
    parameters: {
      capability: PRODUCTION_COGI_CAPABILITY,
      org: { plant: movementPlant, companyCode },
      kind: 'POSTING.FAILED',
      objectClass: MOVEMENT_FAILURE_NOTIFICATION_CLASS,
      objectKey: row.id,
      messageKey: 'notification.kind.POSTING.FAILED',
      messageParams: { order: row.orderNumber },
    },
  });
}

async function abandonExpiredLeaseInTx(
  tx: Tx,
  row: typeof productionGoodsMovementFailure.$inferSelect,
  changedBy: string,
  now: Date,
  transactionCode = SOURCE_TRANSACTION,
): Promise<void> {
  if (row.status !== 'PROCESSING' || !row.processingLeaseExpiresAt || row.processingLeaseExpiresAt > now) return;
  const token = row.processingToken;
  if (!token) throw new Error(`Processing movement ${row.id} has no lease token.`);
  const [abandoned] = await tx.update(productionGoodsMovementFailureAttempt).set({
    status: 'ABANDONED',
    finishedAt: now,
    failureCode: 'PROCESSING_LEASE_EXPIRED',
    errorText: 'The previous processing owner did not complete before its lease expired; the attempt is retained as abandoned.',
    changedBy,
    changedAt: now,
  }).where(and(
    eq(productionGoodsMovementFailureAttempt.client, row.client),
    eq(productionGoodsMovementFailureAttempt.failureId, row.id),
    eq(productionGoodsMovementFailureAttempt.leaseToken, token),
    eq(productionGoodsMovementFailureAttempt.status, 'PROCESSING'),
  )).returning();
  if (!abandoned) throw new LostMovementLeaseError();
  const [updated] = await tx.update(productionGoodsMovementFailure).set({
    status: 'FAILED',
    failureCode: 'PROCESSING_LEASE_EXPIRED',
    errorText: 'The previous processing owner did not complete before its lease expired; the movement remains available for recovery.',
    nextRetryAt: now,
    processingToken: null,
    processingLeaseExpiresAt: null,
    changedBy,
    changedAt: now,
  }).where(and(
    eq(productionGoodsMovementFailure.client, row.client),
    eq(productionGoodsMovementFailure.id, row.id),
    eq(productionGoodsMovementFailure.processingToken, token),
  )).returning();
  if (updated) {
    await recordChange(tx, {
      client: row.client,
      objectClass: FAILURE_AUDIT_CLASS,
      objectKey: row.id,
      changeType: 'CHANGE',
      changedBy,
      transactionCode,
      reason: 'Recovered abandoned movement processing ownership',
      before: { status: 'PROCESSING', processingLeaseExpiresAt: row.processingLeaseExpiresAt },
      after: { status: 'FAILED', failureCode: 'PROCESSING_LEASE_EXPIRED', attemptCount: row.attemptCount },
    });
    // The attempt never finished, so nobody was told it failed.
    await enqueuePostingFailed(tx, updated);
  }
}

/** Reclaim an expired processing owner without starting a new attempt. */
export async function recoverAbandonedProductionGoodsMovementFailure(input: {
  client: string;
  failureId: string;
  changedBy: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return withTenant(input.client, async (tx) => {
    const [row] = await tx.select().from(productionGoodsMovementFailure).where(and(
      eq(productionGoodsMovementFailure.client, input.client),
      eq(productionGoodsMovementFailure.id, input.failureId),
    )).for('update');
    if (!row || row.status !== 'PROCESSING' || !row.processingLeaseExpiresAt || row.processingLeaseExpiresAt > now) return false;
    await abandonExpiredLeaseInTx(tx, row, input.changedBy, now);
    return true;
  });
}

async function claimMovement(
  client: string,
  failureId: string,
  attemptedBy: string,
  options: { now?: Date; leaseMilliseconds?: number; authorization?: ProductionCogiAuthorizationContext } = {},
): Promise<ClaimedMovement | null> {
  const now = options.now ?? new Date();
  const leaseMilliseconds = Math.max(1_000, Math.trunc(options.leaseMilliseconds ?? DEFAULT_LEASE_MS));
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(productionGoodsMovementFailure).where(and(
      eq(productionGoodsMovementFailure.client, client),
      eq(productionGoodsMovementFailure.id, failureId),
    )).for('update');
    if (!row) return null;
    let actor = attemptedBy;
    if (options.authorization) {
      const authority = await requireProductionCogiAuthorityInTx(tx, client, options.authorization);
      await requireProductionCogiFailureScopeInTx(tx, client, row, authority.restrictions);
      actor = authority.username;
    }
    if (row.status === 'POSTED' || row.status === 'BLOCKED' || row.status === 'DISCARDED') return null;
    if (row.status === 'PROCESSING') {
      if (!row.processingLeaseExpiresAt || row.processingLeaseExpiresAt > now) return null;
      await abandonExpiredLeaseInTx(tx, row, actor, now, options.authorization ? 'COGI' : SOURCE_TRANSACTION);
    } else if (!options.authorization && row.nextRetryAt && row.nextRetryAt > now) {
      return null;
    }

    const [latestRevision] = await tx.select({ revisionNumber: productionGoodsMovementFailureRevision.revisionNumber })
      .from(productionGoodsMovementFailureRevision).where(and(
        eq(productionGoodsMovementFailureRevision.client, client),
        eq(productionGoodsMovementFailureRevision.failureId, failureId),
      )).orderBy(desc(productionGoodsMovementFailureRevision.revisionNumber)).limit(1);
    const payloadRevision = latestRevision?.revisionNumber ?? 0;
    const token = crypto.randomUUID();
    const attemptNumber = row.attemptCount + 1;
    const expiresAt = new Date(now.getTime() + leaseMilliseconds);
    const beforeStatus = row.status;
    await tx.update(productionGoodsMovementFailure).set({
      status: 'PROCESSING',
      attemptCount: attemptNumber,
      lastAttemptAt: now,
      nextRetryAt: null,
      processingToken: token,
      processingLeaseExpiresAt: expiresAt,
      changedBy: actor,
      changedAt: now,
    }).where(and(
      eq(productionGoodsMovementFailure.client, client),
      eq(productionGoodsMovementFailure.id, failureId),
    ));
    await tx.insert(productionGoodsMovementFailureAttempt).values({
      id: crypto.randomUUID(),
      client,
      failureId,
      attemptNumber,
      payloadRevision,
      leaseToken: token,
      attemptedBy: actor,
      status: 'PROCESSING',
      startedAt: now,
      createdBy: actor,
    });
    await recordChange(tx, {
      client,
      objectClass: FAILURE_AUDIT_CLASS,
      objectKey: failureId,
      changeType: 'CHANGE',
      changedBy: actor,
      transactionCode: options.authorization ? 'COGI' : SOURCE_TRANSACTION,
      reason: options.authorization ? 'User initiated COGI goods-movement reprocessing' : 'Acquired exclusive automatic movement processing ownership',
      before: { status: beforeStatus, attemptCount: row.attemptCount },
      after: { status: 'PROCESSING', attemptCount: attemptNumber, processingLeaseExpiresAt: expiresAt },
    });
    const [updated] = await tx.select().from(productionGoodsMovementFailure).where(and(
      eq(productionGoodsMovementFailure.client, client),
      eq(productionGoodsMovementFailure.id, failureId),
    ));
    if (!updated) throw new Error(`Movement failure ${failureId} disappeared during claim.`);
    return {
      record: updated,
      attemptNumber,
      payloadRevision,
      leaseToken: token,
      attemptedBy: actor,
      ...(options.authorization ? { authorization: options.authorization } : {}),
    };
  });
}

/** Claim one due intent without posting; the returned token is required to execute or release it. */
export async function claimProductionGoodsMovementFailure(input: {
  client: string;
  failureId: string;
  attemptedBy: string;
  now?: Date;
  leaseMilliseconds?: number;
}): Promise<ProductionGoodsMovementClaim | null> {
  const claim = await claimMovement(input.client, input.failureId, input.attemptedBy, {
    now: input.now,
    leaseMilliseconds: input.leaseMilliseconds,
  });
  if (!claim || !claim.record.processingLeaseExpiresAt) return null;
  return {
    failureId: claim.record.id,
    attemptNumber: claim.attemptNumber,
    payloadRevision: claim.payloadRevision,
    leaseToken: claim.leaseToken,
    leaseExpiresAt: claim.record.processingLeaseExpiresAt,
  };
}

/** Execute an already claimed intent. The tenant, status, and unguessable token are rechecked. */
export async function executeClaimedProductionGoodsMovementFailure(input: {
  client: string;
  failureId: string;
  leaseToken: string;
  attemptedBy: string;
}): Promise<ProductionGoodsMovementAttemptResult> {
  const claimed = await withTenant(input.client, async (tx) => {
    const [record] = await tx.select().from(productionGoodsMovementFailure).where(and(
      eq(productionGoodsMovementFailure.client, input.client),
      eq(productionGoodsMovementFailure.id, input.failureId),
      eq(productionGoodsMovementFailure.status, 'PROCESSING'),
      eq(productionGoodsMovementFailure.processingToken, input.leaseToken),
    ));
    const [attempt] = await tx.select().from(productionGoodsMovementFailureAttempt).where(and(
      eq(productionGoodsMovementFailureAttempt.client, input.client),
      eq(productionGoodsMovementFailureAttempt.failureId, input.failureId),
      eq(productionGoodsMovementFailureAttempt.leaseToken, input.leaseToken),
      eq(productionGoodsMovementFailureAttempt.status, 'PROCESSING'),
    ));
    return record && attempt ? { record, attempt } : null;
  });
  if (!claimed) return { outcome: 'LEASE_LOST', failureId: input.failureId };
  return executeClaimedMovement({
    record: claimed.record,
    attemptNumber: claimed.attempt.attemptNumber,
    payloadRevision: claimed.attempt.payloadRevision,
    leaseToken: input.leaseToken,
    attemptedBy: input.attemptedBy,
  }, input.attemptedBy);
}

/**
 * Explicit release for a worker that cannot proceed. It closes the attempt as FAILED and
 * releases the lease; no posting is attempted by this operation.
 */
export async function releaseProductionGoodsMovementFailure(input: {
  client: string;
  failureId: string;
  leaseToken: string;
  changedBy: string;
  failureCode: string;
  errorText: string;
}): Promise<boolean> {
  const now = new Date();
  const failureCode = clean(input.failureCode).slice(0, 64) || 'PROCESSING_RELEASED';
  const errorText = safeError(new Error(clean(input.errorText) || 'Processing was released before posting.')).text;
  return withTenant(input.client, async (tx) => {
    const [row] = await tx.select().from(productionGoodsMovementFailure).where(and(
      eq(productionGoodsMovementFailure.client, input.client),
      eq(productionGoodsMovementFailure.id, input.failureId),
    )).for('update');
    if (!row || row.status !== 'PROCESSING' || row.processingToken !== input.leaseToken) return false;
    await finishFailureInTx(tx, row, input.leaseToken, input.changedBy, now, { code: failureCode, text: errorText }, 'FAILED');
    return true;
  });
}

async function finishFailureInTx(
  tx: Tx,
  row: typeof productionGoodsMovementFailure.$inferSelect,
  leaseToken: string,
  changedBy: string,
  now: Date,
  failure: { code: string; text: string },
  state: 'FAILED' | 'BLOCKED',
  transactionCode = SOURCE_TRANSACTION,
): Promise<void> {
  const [attempt] = await tx.update(productionGoodsMovementFailureAttempt).set({
    status: state,
    finishedAt: now,
    failureCode: failure.code,
    errorText: failure.text,
    changedBy,
    changedAt: now,
  }).where(and(
    eq(productionGoodsMovementFailureAttempt.client, row.client),
    eq(productionGoodsMovementFailureAttempt.failureId, row.id),
    eq(productionGoodsMovementFailureAttempt.leaseToken, leaseToken),
    eq(productionGoodsMovementFailureAttempt.status, 'PROCESSING'),
  )).returning();
  if (!attempt) throw new LostMovementLeaseError();
  const retryDelayMs = Math.min(60 * 60_000, 15_000 * (2 ** Math.min(Math.max(row.attemptCount - 1, 0), 8)));
  const nextRetryAt = state === 'FAILED' ? new Date(now.getTime() + retryDelayMs) : null;
  const [updated] = await tx.update(productionGoodsMovementFailure).set({
    status: state,
    failureCode: failure.code,
    errorText: failure.text,
    nextRetryAt,
    processingToken: null,
    processingLeaseExpiresAt: null,
    changedBy,
    changedAt: now,
  }).where(and(
    eq(productionGoodsMovementFailure.client, row.client),
    eq(productionGoodsMovementFailure.id, row.id),
    eq(productionGoodsMovementFailure.processingToken, leaseToken),
  )).returning();
  if (!updated) throw new LostMovementLeaseError();
  await recordChange(tx, {
    client: row.client,
    objectClass: FAILURE_AUDIT_CLASS,
    objectKey: row.id,
    changeType: 'CHANGE',
    changedBy,
    transactionCode,
    reason: state === 'BLOCKED' ? 'Movement blocked because its source confirmation was cancelled' : 'Movement attempt failed after the posting transaction rolled back',
    before: { status: 'PROCESSING', attemptCount: row.attemptCount },
    after: { status: state, failureCode: failure.code, errorText: failure.text },
  });
  // A blocked movement is not a failed posting: its source confirmation was
  // cancelled, and cancelling is a decision somebody made rather than a posting
  // waiting to be done again.
  if (state === 'FAILED') await enqueuePostingFailed(tx, updated);
}

async function finishSuccessInTx(
  tx: Tx,
  row: typeof productionGoodsMovementFailure.$inferSelect,
  leaseToken: string,
  attemptedBy: string,
  now: Date,
  documentNumber: string,
  documentYear: number,
  transactionCode = SOURCE_TRANSACTION,
): Promise<void> {
  const [attempt] = await tx.update(productionGoodsMovementFailureAttempt).set({
    status: 'SUCCEEDED',
    finishedAt: now,
    materialDocumentNumber: documentNumber,
    documentYear,
    changedBy: attemptedBy,
    changedAt: now,
  }).where(and(
    eq(productionGoodsMovementFailureAttempt.client, row.client),
    eq(productionGoodsMovementFailureAttempt.failureId, row.id),
    eq(productionGoodsMovementFailureAttempt.leaseToken, leaseToken),
    eq(productionGoodsMovementFailureAttempt.status, 'PROCESSING'),
  )).returning();
  if (!attempt) throw new LostMovementLeaseError();
  const [updated] = await tx.update(productionGoodsMovementFailure).set({
    status: 'POSTED',
    failureCode: null,
    errorText: null,
    nextRetryAt: null,
    processingToken: null,
    processingLeaseExpiresAt: null,
    materialDocumentNumber: documentNumber,
    documentYear,
    changedBy: attemptedBy,
    changedAt: now,
  }).where(and(
    eq(productionGoodsMovementFailure.client, row.client),
    eq(productionGoodsMovementFailure.id, row.id),
    eq(productionGoodsMovementFailure.processingToken, leaseToken),
  )).returning();
  if (!updated) throw new LostMovementLeaseError();
  await recordChange(tx, {
    client: row.client,
    objectClass: FAILURE_AUDIT_CLASS,
    objectKey: row.id,
    changeType: 'CHANGE',
    changedBy: attemptedBy,
    transactionCode,
    reason: `Movement recovery posted material document ${documentNumber}`,
    before: { status: 'PROCESSING', attemptCount: row.attemptCount },
    after: {
      status: 'POSTED',
      materialDocumentNumber: documentNumber,
      documentYear,
      attemptCount: row.attemptCount,
    },
  });
}

function issueInput(
  row: typeof productionGoodsMovementFailure.$inferSelect,
  actor: string,
  currentPayload: StoredPayload = row.originalPayload as unknown as StoredPayload,
): PostGoodsIssueInput {
  const payload = currentPayload as StoredIssuePayload;
  return {
    client: row.client,
    changedBy: actor,
    movementTypeCode: payload.movementTypeCode,
    postingDate: payload.postingDate,
    documentDate: payload.documentDate,
    headerText: payload.headerText,
    requestKey: row.originalRequestKey,
    lines: payload.lines.map((line) => ({
      materialNumber: line.materialNumber,
      plant: line.plant,
      storageLocation: line.storageLocation ?? undefined,
      storageLocationMode: line.storageLocationMode,
      quantity: line.quantity,
      entryUnit: line.entryUnit ?? undefined,
      productionOrderNumber: line.productionOrderNumber,
      productionOrderItem: line.productionOrderItem,
      batch: line.batch ?? undefined,
      reservationNumber: line.reservationNumber ?? undefined,
      reservationItem: line.reservationItem ?? undefined,
    })),
  };
}

function receiptInput(
  row: typeof productionGoodsMovementFailure.$inferSelect,
  actor: string,
  currentPayload: StoredPayload = row.originalPayload as unknown as StoredPayload,
): PostProductionReceiptInput {
  const payload = currentPayload as StoredReceiptPayload;
  return {
    client: row.client,
    changedBy: actor,
    orderNumber: row.orderNumber,
    postingDate: payload.postingDate,
    documentDate: payload.documentDate,
    headerText: payload.headerText,
    requestKey: row.originalRequestKey,
    orderBatchNumber: payload.orderBatchNumber,
    lines: payload.lines.map((line) => ({
      quantity: line.quantity,
      entryUnit: line.entryUnit,
      storageLocation: line.storageLocation ?? undefined,
      storageLocationMode: line.storageLocationMode,
      batch: line.batch ?? undefined,
    })),
  };
}

async function executeClaimedMovement(
  claim: ClaimedMovement,
  attemptedBy: string,
): Promise<ProductionGoodsMovementAttemptResult> {
  const { record, attemptNumber, leaseToken } = claim;
  let actor = claim.attemptedBy || attemptedBy;
  try {
    const posted = await withTenant(record.client, async (tx) => {
      const liveAuthority = claim.authorization
        ? await requireProductionCogiAuthorityInTx(tx, record.client, claim.authorization)
        : null;
      if (liveAuthority) actor = liveAuthority.username;
      // Serialize against other CO11N entries and CO13 cancellation. If cancellation wins
      // this lock, the source is blocked; if this post wins, CO13 sees its standing document.
      await acquireLock(tx, { objectCode: 'PRODUCTION_ORDER', keys: [record.client, record.orderNumber] }, {
        client: record.client,
        requestedBy: actor,
        transactionCode: claim.authorization ? 'COGI' : SOURCE_TRANSACTION,
      });
      const [locked] = await tx.select().from(productionGoodsMovementFailure).where(and(
        eq(productionGoodsMovementFailure.client, record.client),
        eq(productionGoodsMovementFailure.id, record.id),
      )).for('update');
      if (!locked || locked.status !== 'PROCESSING' || locked.processingToken !== leaseToken) {
        throw new LostMovementLeaseError();
      }
      if (liveAuthority) {
        await requireProductionCogiFailureScopeInTx(tx, record.client, locked, liveAuthority.restrictions);
      }
      // A goods movement is posted by a person. This continuation carries the user the
      // movement belongs to — the confirming user, or the COGI recovery operator — and
      // a claim with nobody behind it posts nothing: the intent stays a failure for
      // COGI to recover rather than moving stock under no authority at all.
      const authority = claim.authorization;
      if (!authority) throw new AutomaticMovementAuthorityError();
      const [cancelled] = await tx.select({ cancellationNumber: productionConfirmationCancellation.cancellationNumber })
        .from(productionConfirmationCancellation).where(and(
          eq(productionConfirmationCancellation.client, record.client),
          eq(productionConfirmationCancellation.confirmationNumber, record.confirmationNumber),
        ));
      if (cancelled) throw new SourceConfirmationCancelledError(record.confirmationNumber);
      const [latestRevision] = await tx.select().from(productionGoodsMovementFailureRevision).where(and(
        eq(productionGoodsMovementFailureRevision.client, record.client),
        eq(productionGoodsMovementFailureRevision.failureId, record.id),
      )).orderBy(desc(productionGoodsMovementFailureRevision.revisionNumber)).limit(1);
      const currentRevision = latestRevision?.revisionNumber ?? 0;
      if (currentRevision !== claim.payloadRevision) {
        throw new Error('The corrected movement details changed after this retry was claimed. Retry the current revision.');
      }
      const effectivePayload = latestRevision?.correctedPayload as StoredPayload | undefined
        ?? locked.originalPayload as unknown as StoredPayload;

      let documentNumber: string;
      let documentYear: number;
      if (record.movementKind === 'ISSUE') {
        const document: GoodsIssueView = await postGoodsIssue(issueInput(locked, actor, effectivePayload), 'MIGO', {
          tx,
          authorization: authority,
        });
        documentNumber = document.materialDocumentNumber;
        documentYear = document.documentYear;
      } else {
        const document: ProductionReceiptView = await postProductionReceipt(receiptInput(locked, actor, effectivePayload), {
          tx,
          authorization: authority,
        });
        documentNumber = document.materialDocumentNumber;
        documentYear = document.documentYear;
      }
      // Posting, material document, journal, stock, valuation, reservation/output side effects,
      // success history, and the failure-record transition commit or roll back together.
      await finishSuccessInTx(tx, locked, leaseToken, actor, new Date(), documentNumber, documentYear, claim.authorization ? 'COGI' : SOURCE_TRANSACTION);
      return { documentNumber, documentYear };
    });
    return {
      outcome: 'POSTED',
      failureId: record.id,
      materialDocumentNumber: posted.documentNumber,
      documentYear: posted.documentYear,
    };
  } catch (error) {
    if (error instanceof LostMovementLeaseError) return { outcome: 'LEASE_LOST', failureId: record.id };
    const failure = safeError(error);
    const state = error instanceof SourceConfirmationCancelledError ? 'BLOCKED' : 'FAILED';
    try {
      // This transaction starts only after withTenant's posting transaction has rejected
      // and rolled back. It records the attempt; it never catches inside that posting unit.
      await withTenant(record.client, async (tx) => {
        const [locked] = await tx.select().from(productionGoodsMovementFailure).where(and(
          eq(productionGoodsMovementFailure.client, record.client),
          eq(productionGoodsMovementFailure.id, record.id),
        )).for('update');
        if (!locked || locked.status !== 'PROCESSING' || locked.processingToken !== leaseToken) {
          throw new LostMovementLeaseError();
        }
        await finishFailureInTx(tx, locked, leaseToken, actor, new Date(), failure, state, claim.authorization ? 'COGI' : SOURCE_TRANSACTION);
      });
    } catch (persistError) {
      if (persistError instanceof LostMovementLeaseError) return { outcome: 'LEASE_LOST', failureId: record.id };
      throw new MovementFailurePersistenceError(record.confirmationNumber, persistError);
    }
    return { outcome: state, failureId: record.id, failureCode: failure.code, errorText: failure.text };
  }
}

/** Attempt one item. A busy/posted/blocked record is never posted a second time. */
export async function attemptProductionGoodsMovementFailure(input: {
  client: string;
  failureId: string;
  attemptedBy: string;
  now?: Date;
  leaseMilliseconds?: number;
  authorization?: ProductionCogiAuthorizationContext;
}): Promise<ProductionGoodsMovementAttemptResult> {
  const claim = await claimMovement(input.client, input.failureId, input.attemptedBy, {
    now: input.now,
    leaseMilliseconds: input.leaseMilliseconds,
    authorization: input.authorization,
  });
  if (!claim) {
    const [row] = await withTenant(input.client, (tx) => tx.select().from(productionGoodsMovementFailure).where(and(
      eq(productionGoodsMovementFailure.client, input.client),
      eq(productionGoodsMovementFailure.id, input.failureId),
    )));
    if (!row) return { outcome: 'NOT_ELIGIBLE', failureId: input.failureId };
    if (row.status === 'POSTED') return { outcome: 'ALREADY_POSTED', failureId: input.failureId };
    if (row.status === 'PROCESSING') return { outcome: 'BUSY', failureId: input.failureId };
    return { outcome: 'NOT_ELIGIBLE', failureId: input.failureId };
  }
  return executeClaimedMovement(claim, input.attemptedBy);
}

/**
 * CO11N starts newly persisted PENDING intents after the confirmation transaction commits.
 * FAILED rows are deliberately not retried by replaying the confirmation request.
 */
export async function processPendingConfirmationMovements(input: {
  client: string;
  confirmationNumber: string;
  attemptedBy: string;
  /**
   * Who the movement is posted for. Carried from the confirmation that caused it: the
   * intents are posted in their own transactions after the confirmation commits, so the
   * only way a movement has an owner is for the confirmation to name one. Without it
   * the posting services refuse, and the intent stays a failure for COGI to recover.
   */
  authorization?: ProductionCogiAuthorizationContext;
}): Promise<ProductionGoodsMovementAttemptResult[]> {
  const pending = await withTenant(input.client, (tx) => tx.select({ id: productionGoodsMovementFailure.id })
    .from(productionGoodsMovementFailure)
    .where(and(
      eq(productionGoodsMovementFailure.client, input.client),
      eq(productionGoodsMovementFailure.confirmationNumber, input.confirmationNumber),
      inArray(productionGoodsMovementFailure.status, ['PENDING', 'PROCESSING']),
    ))
    .orderBy(asc(productionGoodsMovementFailure.createdAt), asc(productionGoodsMovementFailure.movementKind)));
  const results: ProductionGoodsMovementAttemptResult[] = [];
  for (const row of pending) {
    results.push(await attemptProductionGoodsMovementFailure({
      client: input.client,
      failureId: row.id,
      attemptedBy: input.attemptedBy,
      authorization: input.authorization,
    }));
  }
  return results;
}

/** Wait briefly for a concurrent replay to observe the owner's committed outcome. */
export async function waitForConfirmationMovementSettlement(input: {
  client: string;
  confirmationNumber: string;
  waitMilliseconds?: number;
}): Promise<void> {
  const deadline = Date.now() + Math.max(0, input.waitMilliseconds ?? 3_000);
  while (Date.now() < deadline) {
    const active = await withTenant(input.client, (tx) => tx.select({ id: productionGoodsMovementFailure.id })
      .from(productionGoodsMovementFailure).where(and(
        eq(productionGoodsMovementFailure.client, input.client),
        eq(productionGoodsMovementFailure.confirmationNumber, input.confirmationNumber),
        inArray(productionGoodsMovementFailure.status, ['PENDING', 'PROCESSING']),
      )));
    if (!active.length) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Newest-first filtered access for internal recovery tools; no COGI route is registered. */
export async function listProductionGoodsMovementFailureDetails(input: {
  client: string;
  selection?: ProductionGoodsMovementFailureSelection;
}): Promise<ProductionGoodsMovementFailureDetail[]> {
  const summaries = await listProductionGoodsMovementFailures(input);
  const rows: ProductionGoodsMovementFailureDetail[] = [];
  for (const summary of summaries) {
    const detail = await getProductionGoodsMovementFailure(input.client, summary.id);
    if (detail) rows.push(detail);
  }
  return rows;
}

/** Explicit read helper for future code that already holds a tenant transaction. */
export async function failuresForOrderInTx(tx: Tx, client: string, orderNumber: string) {
  return tx.select().from(productionGoodsMovementFailure).where(and(
    eq(productionGoodsMovementFailure.client, client),
    eq(productionGoodsMovementFailure.orderNumber, orderNumber),
  )).orderBy(desc(productionGoodsMovementFailure.createdAt));
}

/** Expose exact posting inputs for a future recovery workflow without rebuilding from masters. */
export function originalPostingInput(
  detail: ProductionGoodsMovementFailureDetail,
  attemptedBy: string,
): PostGoodsIssueInput | PostProductionReceiptInput {
  return detail.failure.movementKind === 'ISSUE'
    ? issueInput(detail.failure, attemptedBy)
    : receiptInput(detail.failure, attemptedBy);
}

/** Test-only deterministic status lookup that remains tenant-scoped. */
export async function productionMovementStatus(client: string, failureId: string) {
  const [row] = await withTenant(client, (tx) => tx.select({
    id: productionGoodsMovementFailure.id,
    status: productionGoodsMovementFailure.status,
    attemptCount: productionGoodsMovementFailure.attemptCount,
    leaseExpiresAt: productionGoodsMovementFailure.processingLeaseExpiresAt,
    requestKey: productionGoodsMovementFailure.originalRequestKey,
    fingerprint: productionGoodsMovementFailure.idempotencyFingerprint,
    materialDocumentNumber: productionGoodsMovementFailure.materialDocumentNumber,
    documentYear: productionGoodsMovementFailure.documentYear,
  }).from(productionGoodsMovementFailure).where(and(
    eq(productionGoodsMovementFailure.client, client),
    eq(productionGoodsMovementFailure.id, failureId),
  )));
  return row ?? null;
}
