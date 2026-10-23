/**
 * OMCG — Allocate an Inventory Management search procedure and record the check.
 *
 * The view is V_156B_SS. The key is the movement type and the special stock.
 * Blank special stock is own stock. It is not a plant, and it is not a
 * wildcard for another stock. Special-stock indicators do not stand in this
 * application, so only own stock can be allocated.
 *
 * The procedure must already stand on OMCY. The transfer-side procedure is
 * optional. The check indicator is X or blank. Setting X records the request.
 * Selection criteria do not stand, so the check is not performed and a batch
 * is not selected.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { batchSearchAllocation, batchSearchProcedure, movementType } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHALLOCATE.DEFINE';
export const ROUTE = '/config/batch-search-allocations';
export const ALIAS = 'OMCG';
export const LOCK_OBJECT = 'BATCH_SEARCH_ALLOCATION';
export const USAGE = 'H';
export const APPLICATION = 'ME';
export const OWN_STOCK = ' ';

export const NOT_EXECUTED = [
  {
    field: 'KZCHP',
    title: 'Check of the batch entered',
    reason: 'X records that a check was requested. Selection criteria do not stand, so no batch is accepted or rejected by this indicator.',
  },
  {
    field: 'WERKS',
    title: 'Plant',
    reason: 'A plant is not part of this key. Blank special stock is not a plant wildcard.',
  },
  {
    field: 'UMCHP',
    title: 'Transfer-side check',
    reason: 'The Inventory Management allocation view does not maintain this indicator.',
  },
  {
    field: 'MBC1',
    title: 'Search strategy',
    reason: 'No condition record is read. An allocated procedure does not select a batch.',
  },
] as const;

export class BatchSearchAllocationError extends Error {
  readonly code:
    | 'AUTHORITY_REQUIRED'
    | 'MOVEMENT_UNKNOWN'
    | 'PROCEDURE_UNKNOWN'
    | 'STOCK_UNKNOWN'
    | 'DUPLICATE'
    | 'ALLOCATION_UNKNOWN'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'CONFIRM_REQUIRED'
    | 'TRANSPORT_REFUSED'
    | 'PLANT_REFUSED'
    | 'SCOPE_REFUSED'
    | 'CHECK_UNKNOWN'
    | 'CHECK_NOT_EXECUTED'
    | 'CONTROL_REFUSED';

  constructor(message: string, code: BatchSearchAllocationError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchSearchAllocationError';
    this.code = code;
  }
}

export interface BatchSearchAllocationRow {
  movementType: string;
  specialStock: typeof OWN_STOCK;
  searchProcedure: string;
  transferProcedure: string;
  checkBatch: ' ' | 'X';
  usage: typeof USAGE;
  application: typeof APPLICATION;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchSearchAllocationError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMCG does not use a second permission code.',
    );
  }
}

function movementKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,20}$/.test(key)) {
    throw new BatchSearchAllocationError(
      `Movement type ${value.trim() || 'blank'} does not stand. Nothing was saved.`,
      'MOVEMENT_UNKNOWN',
      'Choose a movement type that already stands. OMCG does not create one.',
    );
  }
  return key;
}

function procedureKey(value: string, label: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(key)) {
    throw new BatchSearchAllocationError(
      `${label} ${value.trim() || 'blank'} does not stand. Nothing was saved.`,
      'PROCEDURE_UNKNOWN',
      'Name a search procedure that already stands on OMCY.',
    );
  }
  return key;
}

function stockOf(value: string | undefined): typeof OWN_STOCK {
  const text = value ?? '';
  if (text === '' || text === ' ') return OWN_STOCK;
  throw new BatchSearchAllocationError(
    `Special stock ${text.trim()} does not stand. Nothing was saved.`,
    'STOCK_UNKNOWN',
    'Own stock is the blank indicator. This application does not invent a special stock.',
  );
}

function checkOf(value: string | undefined): ' ' | 'X' {
  const text = (value ?? '').trim().toUpperCase();
  if (text === '' || text === ' ') return ' ';
  if (text === 'X') return 'X';
  throw new BatchSearchAllocationError(
    `Check indicator ${text} is not X or blank. Nothing was saved.`,
    'CHECK_UNKNOWN',
    'X records the request. Blank leaves it off. Neither selects a batch.',
  );
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new BatchSearchAllocationError('A reason is required.', 'REASON_REQUIRED', 'Say why this allocation is being saved.');
  }
  return text;
}

function refuseExtras(input: {
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  transferCheck?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchSearchAllocationError('A transport is refused. OMCG does not write a transport request.', 'TRANSPORT_REFUSED', 'Save the allocation in this client. No transport mechanism carries it.');
  }
  if (input.plant?.trim()) {
    throw new BatchSearchAllocationError(
      'A plant is refused. The allocation key is the movement type and the special stock.',
      'PLANT_REFUSED',
      'Do not send a plant. Blank special stock is not a plant wildcard.',
    );
  }
  const usage = (input.usage ?? '').trim().toUpperCase();
  const application = (input.application ?? '').trim().toUpperCase();
  if ((usage && usage !== USAGE) || (application && application !== APPLICATION)) {
    throw new BatchSearchAllocationError(
      `Usage ${usage || USAGE} and application ${application || APPLICATION} are refused. OMCG allocates usage H and application ME only.`,
      'SCOPE_REFUSED',
      'Production and sales allocations are not this screen.',
    );
  }
  if (input.transferCheck?.trim()) {
    throw new BatchSearchAllocationError(
      'The transfer-side check is not stored. The allocation view does not maintain it.',
      'CONTROL_REFUSED',
      'Leave it off. The stored check indicator does not select a batch.',
    );
  }
}

function rowOf(row: {
  movementType: string;
  searchProcedure: string;
  transferProcedure: string;
  checkBatch: string;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}): BatchSearchAllocationRow {
  return {
    movementType: row.movementType,
    specialStock: OWN_STOCK,
    searchProcedure: row.searchProcedure,
    transferProcedure: row.transferProcedure,
    checkBatch: row.checkBatch === 'X' ? 'X' : ' ',
    usage: USAGE,
    application: APPLICATION,
    version: row.version,
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

async function standingProcedure(tx: Parameters<Parameters<typeof withTenant>[1]>[0], client: string, key: string): Promise<void> {
  const [standing] = await tx.select({ searchProcedure: batchSearchProcedure.searchProcedure }).from(batchSearchProcedure).where(and(
    eq(batchSearchProcedure.client, client),
    eq(batchSearchProcedure.usage, USAGE),
    eq(batchSearchProcedure.application, APPLICATION),
    eq(batchSearchProcedure.searchProcedure, key),
  )).limit(1).for('update');
  if (!standing) {
    throw new BatchSearchAllocationError(
      `Search procedure ${key} does not stand. Nothing was saved.`,
      'PROCEDURE_UNKNOWN',
      'Create it on OMCY first. A procedure from another application is not allocated here, and naming one does not select a batch.',
    );
  }
}

export async function listBatchSearchAllocations(client: string): Promise<BatchSearchAllocationRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      movementType: batchSearchAllocation.movementType,
      searchProcedure: batchSearchAllocation.searchProcedure,
      transferProcedure: batchSearchAllocation.transferProcedure,
      checkBatch: batchSearchAllocation.checkBatch,
      version: batchSearchAllocation.version,
      changedBy: batchSearchAllocation.changedBy,
      changedAt: batchSearchAllocation.changedAt,
    }).from(batchSearchAllocation)
      .where(eq(batchSearchAllocation.client, client))
      .orderBy(asc(batchSearchAllocation.movementType));
    return rows.map(rowOf);
  });
}

export async function resolveBatchSearchAllocation(
  client: string,
  movementTypeKey: string,
  specialStock?: string,
): Promise<BatchSearchAllocationRow | null> {
  const key = movementTypeKey.trim().toUpperCase();
  if (!key) return null;
  let stock: string;
  try {
    stock = stockOf(specialStock);
  } catch {
    return null;
  }
  return withTenant(client, async (tx) => {
    const [row] = await tx.select({
      movementType: batchSearchAllocation.movementType,
      searchProcedure: batchSearchAllocation.searchProcedure,
      transferProcedure: batchSearchAllocation.transferProcedure,
      checkBatch: batchSearchAllocation.checkBatch,
      version: batchSearchAllocation.version,
      changedBy: batchSearchAllocation.changedBy,
      changedAt: batchSearchAllocation.changedAt,
    }).from(batchSearchAllocation).where(and(
      eq(batchSearchAllocation.client, client),
      eq(batchSearchAllocation.movementType, key),
      eq(batchSearchAllocation.specialStock, stock),
    )).limit(1);
    return row ? rowOf(row) : null;
  });
}

/**
 * A caller that asks for the check is told it cannot be performed.
 * Posting does not call this. No batch is accepted or rejected here.
 */
export async function checkEnteredBatch(input: {
  client: string;
  movementType: string;
  specialStock?: string;
  batch: string;
}): Promise<{ checked: false }> {
  const allocation = await resolveBatchSearchAllocation(input.client, input.movementType, input.specialStock);
  if (allocation?.checkBatch === 'X') {
    throw new BatchSearchAllocationError(
      `Movement type ${allocation.movementType} records a batch check. The check was not performed.`,
      'CHECK_NOT_EXECUTED',
      'Selection criteria do not stand. The indicator does not accept or reject a batch, and no stock was posted.',
    );
  }
  return { checked: false };
}

export async function saveBatchSearchAllocation(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  movementType: string;
  specialStock?: string;
  searchProcedure: string;
  transferProcedure?: string;
  checkBatch?: string;
  expectedVersion?: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  transferCheck?: string;
}): Promise<BatchSearchAllocationRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const movement = movementKey(input.movementType);
  const stock = stockOf(input.specialStock);
  const procedure = procedureKey(input.searchProcedure, 'Search procedure');
  const transfer = (input.transferProcedure ?? '').trim()
    ? procedureKey(input.transferProcedure ?? '', 'Transfer procedure')
    : '';
  const checkBatch = checkOf(input.checkBatch);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_SEARCH_ALLOCATION/${movement}/${stock}`}))`);
    const [standingMovement] = await tx.select({ movementType: movementType.movementType }).from(movementType).where(and(
      eq(movementType.client, input.client),
      eq(movementType.movementType, movement),
    )).limit(1).for('update');
    if (!standingMovement) {
      throw new BatchSearchAllocationError(
        `Movement type ${movement} does not stand. Nothing was saved.`,
        'MOVEMENT_UNKNOWN',
        'Create it on the movement-type screen first. OMCG does not invent a movement type.',
      );
    }
    await standingProcedure(tx, input.client, procedure);
    if (transfer) await standingProcedure(tx, input.client, transfer);
    const [existing] = await tx.select().from(batchSearchAllocation).where(and(
      eq(batchSearchAllocation.client, input.client),
      eq(batchSearchAllocation.movementType, movement),
      eq(batchSearchAllocation.specialStock, stock),
    )).for('update');
    if (input.mode === 'CREATE' && existing) {
      throw new BatchSearchAllocationError(
        `Movement type ${movement} already has an allocation for own stock. Nothing was saved.`,
        'DUPLICATE',
        'Change the standing allocation. Blank special stock is not a second row.',
      );
    }
    if (input.mode === 'CHANGE' && !existing) {
      throw new BatchSearchAllocationError(
        `Movement type ${movement} has no allocation. Nothing was saved.`,
        'ALLOCATION_UNKNOWN',
        'Create the allocation first. OMCG does not invent a standard assignment.',
      );
    }
    if (existing && existing.version !== input.expectedVersion) {
      throw new BatchSearchAllocationError(
        `The allocation was opened at version ${input.expectedVersion ?? 'blank'}, and version ${existing.version} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the allocation again.',
      );
    }
    if (existing && existing.searchProcedure === procedure && existing.transferProcedure === transfer && existing.checkBatch === checkBatch) {
      return rowOf(existing);
    }
    if (!input.confirmed) {
      throw new BatchSearchAllocationError('The change was not confirmed. Nothing was saved.', 'CONFIRM_REQUIRED', 'Confirm the save. No batch is selected and no stock is posted.');
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    if (!existing) {
      await tx.insert(batchSearchAllocation).values({
        client: input.client, movementType: movement, specialStock: stock, usage: USAGE, application: APPLICATION,
        searchProcedure: procedure, transferProcedure: transfer, checkBatch, version: 1,
        createdBy: input.changedBy, changedBy: input.changedBy, changedAt: now,
      });
      await recordChange(tx, {
        client: input.client, objectClass: 'batch_search_allocation', objectKey: movement,
        changeType: 'CREATE', changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
        after: { movementType: movement, specialStock: 'OWN', searchProcedure: procedure, transferProcedure: transfer, checkBatch },
      });
      await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
      return { movementType: movement, specialStock: stock, searchProcedure: procedure, transferProcedure: transfer, checkBatch, usage: USAGE, application: APPLICATION, version: 1, changedBy: input.changedBy, changedAt: now };
    }
    const version = existing.version + 1;
    await tx.update(batchSearchAllocation).set({
      searchProcedure: procedure, transferProcedure: transfer, checkBatch, version, changedBy: input.changedBy, changedAt: now,
    }).where(and(
      eq(batchSearchAllocation.client, input.client),
      eq(batchSearchAllocation.movementType, movement),
      eq(batchSearchAllocation.specialStock, stock),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: 'batch_search_allocation', objectKey: movement,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
      before: { searchProcedure: existing.searchProcedure, transferProcedure: existing.transferProcedure, checkBatch: existing.checkBatch, version: existing.version },
      after: { searchProcedure: procedure, transferProcedure: transfer, checkBatch, version },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return { movementType: movement, specialStock: stock, searchProcedure: procedure, transferProcedure: transfer, checkBatch, usage: USAGE, application: APPLICATION, version, changedBy: input.changedBy, changedAt: now };
  });
}

export async function deleteBatchSearchAllocation(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  movementType: string;
  specialStock?: string;
  expectedVersion: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
}): Promise<{ movementType: string }> {
  assertAuthority(input.capabilities);
  if (input.transportRequest?.trim()) {
    throw new BatchSearchAllocationError('A transport is refused. OMCG does not write a transport request.', 'TRANSPORT_REFUSED', 'Delete the allocation in this client.');
  }
  const movement = movementKey(input.movementType);
  const stock = stockOf(input.specialStock);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_SEARCH_ALLOCATION/${movement}/${stock}`}))`);
    const [existing] = await tx.select().from(batchSearchAllocation).where(and(
      eq(batchSearchAllocation.client, input.client),
      eq(batchSearchAllocation.movementType, movement),
      eq(batchSearchAllocation.specialStock, stock),
    )).for('update');
    if (!existing) {
      throw new BatchSearchAllocationError(`Movement type ${movement} has no allocation. Nothing was deleted.`, 'ALLOCATION_UNKNOWN', 'Choose an allocation from the list.');
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchSearchAllocationError(
        `The allocation was opened at version ${input.expectedVersion}, and version ${existing.version} now stands. Nothing was deleted.`,
        'VERSION_STALE',
        'Open the allocation again.',
      );
    }
    if (!input.confirmed) {
      throw new BatchSearchAllocationError('The deletion was not confirmed. Nothing was deleted.', 'CONFIRM_REQUIRED', 'Confirm the deletion. No posted movement is rewritten.');
    }
    const reason = reasonOf(input.reason);
    await tx.delete(batchSearchAllocation).where(and(
      eq(batchSearchAllocation.client, input.client),
      eq(batchSearchAllocation.movementType, movement),
      eq(batchSearchAllocation.specialStock, stock),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: 'batch_search_allocation', objectKey: movement,
      changeType: 'DELETE', changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
      before: { searchProcedure: existing.searchProcedure, transferProcedure: existing.transferProcedure, checkBatch: existing.checkBatch, version: existing.version },
    });
    return { movementType: movement };
  });
}
