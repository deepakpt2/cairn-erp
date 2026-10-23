/**
 * Define batch level. OMCE is a search alias only.
 *
 * One row per client. The stored code is the SAP character, never a number:
 *   0 plant    — unique for one material in one plant
 *   1 material — unique for one material in the client
 *   2 client   — unique once in the client, across materials
 *
 * The description is derived. An unset level is not plant level. Setting the
 * level does not activate batch status, internal numbering, classification,
 * or a batch requirement on a movement. Goods movements still do not carry a
 * batch. OMCS, OMCZ, OMAD, MSC1N, MSC2N, and MSC3N are not this screen.
 *
 * A closed posting period is not consulted. The lock is the configuration
 * row, taken by the screen action. This service also takes a transaction
 * advisory lock so two saves of the same row cannot pass the version check
 * together.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { batch, batchLevelConfiguration, batchLevelConversion } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHLEVEL.DEFINE';
export const ROUTE = '/config/batch-level';
export const ALIASES = ['OMCE'] as const;
export const LOCK_OBJECT = 'BATCH_LEVEL';

export type BatchLevelCode = '0' | '1' | '2';

export class BatchLevelError extends Error {
  readonly code:
    | 'LEVEL_UNKNOWN'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'DEPENDENT_DATA'
    | 'CONVERSION_BLOCKED'
    | 'TRANSPORT_REFUSED'
    | 'APPROVAL_REFUSED'
    | 'PERIOD_REFUSED'
    | 'COMPANY_REFUSED'
    | 'STATUS_REFUSED'
    | 'NUMBERING_REFUSED'
    | 'RANGE_REFUSED'
    | 'REQUEST_REPLAY'
    | 'NOT_SET'
    | 'PLANT_REQUIRED'
    | 'PLANT_NOT_ALLOWED'
    | 'BATCH_REQUIRED'
    | 'BATCH_DUPLICATE'
    | 'MATERIAL_UNKNOWN'
    | 'PLANT_UNKNOWN';

  constructor(
    message: string,
    code: BatchLevelError['code'],
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'BatchLevelError';
    this.code = code;
  }
}

export interface BatchLevelMeaning {
  code: BatchLevelCode;
  name: string;
  uniqueness: string;
}

export const BATCH_LEVELS: Record<BatchLevelCode, BatchLevelMeaning> = {
  '0': {
    code: '0',
    name: 'Plant level',
    uniqueness: 'A batch number is unique for one material in one plant. The same number may identify a different batch of that material in another plant.',
  },
  '1': {
    code: '1',
    name: 'Material level',
    uniqueness: 'A batch number is unique for one material in the client. The same number may be used for a different material.',
  },
  '2': {
    code: '2',
    name: 'Client level',
    uniqueness: 'A batch number may be used once in the client. It cannot be used again for another material.',
  },
};

export interface BatchLevelRow {
  batchLevel: BatchLevelCode;
  name: string;
  uniqueness: string;
  version: number;
  changedBy: string;
  changedAt: Date;
}

export interface DependentBatchData {
  batchCount: number;
  stockBatchCount: number;
  documentBatchCount: number;
  stockColumnPresent: boolean;
  documentColumnPresent: boolean;
}

export interface ConversionAttempt {
  conversionRunId: string;
  sourceLevel: BatchLevelCode;
  targetLevel: BatchLevelCode;
  sourceVersion: number;
  status: 'BLOCKED' | 'NOT_REQUIRED';
  counts: DependentBatchData;
  errorSummary: string;
  reason: string;
  startedBy: string;
  startedAt: Date;
}

export interface SaveBatchLevelInput {
  client: string;
  changedBy: string;
  batchLevel: string;
  /** 0 when no row has been saved. Otherwise the version the screen opened. */
  version: number;
  reason?: string;
  requestKey?: string;
  transportRequest?: string;
  approval?: string;
  postingPeriod?: string;
  companyCode?: string;
  batchStatusManagement?: boolean;
  internalNumbering?: boolean;
  batchNumberRange?: string;
}

export interface PrepareConversionInput {
  client: string;
  changedBy: string;
  targetLevel: string;
  version: number;
  reason?: string;
}

export interface CreateBatchIdentityInput {
  client: string;
  changedBy: string;
  materialNumber: string;
  batchNumber: string;
  plant?: string;
}

function levelCode(value: string): BatchLevelCode {
  const text = value.trim();
  if (text !== '0' && text !== '1' && text !== '2') {
    throw new BatchLevelError(
      `Batch level ${text || '(blank)'} is not a batch level. Use 0 for plant, 1 for material, or 2 for client.`,
      'LEVEL_UNKNOWN',
      'Choose one of the three levels. The code is stored as the character written, not as a number.',
    );
  }
  return text;
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3) {
    throw new BatchLevelError(
      'A reason is required.',
      'REASON_REQUIRED',
      'Say why the batch level is being set.',
    );
  }
  if (text.length > 500) {
    throw new BatchLevelError('The reason is longer than 500 characters.', 'REASON_REQUIRED', 'Shorten the reason.');
  }
  return text;
}

function refuseExtras(input: SaveBatchLevelInput): void {
  if (input.transportRequest?.trim()) {
    throw new BatchLevelError(
      'A transport is refused. OMCE does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Save the level in this client. Do not send a transport.',
    );
  }
  if (input.approval?.trim()) {
    throw new BatchLevelError(
      'An approval is refused. OMCE does not route a workflow.',
      'APPROVAL_REFUSED',
      'Save the level. Do not send an approval.',
    );
  }
  if (input.postingPeriod?.trim()) {
    throw new BatchLevelError(
      'A posting period is refused. OB52 does not gate this screen.',
      'PERIOD_REFUSED',
      'Leave the posting period empty. A closed period does not block the batch level.',
    );
  }
  if (input.companyCode?.trim()) {
    throw new BatchLevelError(
      'A company code is refused. The batch level is one setting for the client, not a company.',
      'COMPANY_REFUSED',
      'Do not send a company code.',
    );
  }
  if (input.batchStatusManagement) {
    throw new BatchLevelError(
      'Batch status management is refused. OMCS is not this screen, and saving the level does not activate it.',
      'STATUS_REFUSED',
      'Leave batch status off. OMCS is not built.',
    );
  }
  if (input.internalNumbering) {
    throw new BatchLevelError(
      'Internal batch numbering is refused. OMCZ is not this screen, and saving the level does not activate it.',
      'NUMBERING_REFUSED',
      'Leave internal numbering off. OMCZ is not built.',
    );
  }
  if (input.batchNumberRange?.trim()) {
    throw new BatchLevelError(
      'A batch number range is refused. OMAD is not this screen, and saving the level does not create object BATCH.',
      'RANGE_REFUSED',
      'Do not send a number range.',
    );
  }
}

function meaning(code: BatchLevelCode): BatchLevelMeaning {
  return BATCH_LEVELS[code];
}

function present(row: {
  batchLevel: string;
  version: number;
  changedBy: string;
  changedAt: Date;
}): BatchLevelRow {
  const code = levelCode(row.batchLevel);
  const described = meaning(code);
  return {
    batchLevel: code,
    name: described.name,
    uniqueness: described.uniqueness,
    version: row.version,
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

async function lockRow(tx: Tx, client: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext('BATCH_LEVEL'))`);
}

async function columnPresent(tx: Tx, table: string, column: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    select 1 as present
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and column_name = ${column}
    limit 1
  `) as unknown as Array<{ present: number }>;
  return rows.length > 0;
}

async function countBatchColumn(tx: Tx, client: string, table: 'stock_quantity' | 'material_document_line'): Promise<number> {
  const rows = table === 'stock_quantity'
    ? await tx.execute(sql`
        select count(*)::int as n from stock_quantity
        where client = ${client} and batch_number is not null and btrim(batch_number::text) <> ''
      `)
    : await tx.execute(sql`
        select count(*)::int as n from material_document_line
        where client = ${client} and batch_number is not null and btrim(batch_number::text) <> ''
      `);
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

export async function dependentBatchData(tx: Tx, client: string): Promise<DependentBatchData> {
  const batches = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(batch)
    .where(eq(batch.client, client));
  const stockColumnPresent = await columnPresent(tx, 'stock_quantity', 'batch_number');
  const documentColumnPresent = await columnPresent(tx, 'material_document_line', 'batch_number');
  return {
    batchCount: Number(batches[0]?.n ?? 0),
    stockBatchCount: stockColumnPresent ? await countBatchColumn(tx, client, 'stock_quantity') : 0,
    documentBatchCount: documentColumnPresent ? await countBatchColumn(tx, client, 'material_document_line') : 0,
    stockColumnPresent,
    documentColumnPresent,
  };
}

function hasDependentData(counts: DependentBatchData): boolean {
  return counts.batchCount > 0 || counts.stockBatchCount > 0 || counts.documentBatchCount > 0;
}

function impactText(counts: DependentBatchData, source: BatchLevelCode, target: BatchLevelCode): string {
  const sourceName = meaning(source).name;
  const targetName = meaning(target).name;
  const stock = counts.stockColumnPresent
    ? `${counts.stockBatchCount} stock row${counts.stockBatchCount === 1 ? '' : 's'} with a batch`
    : 'stock has no batch column';
  const documents = counts.documentColumnPresent
    ? `${counts.documentBatchCount} material-document line${counts.documentBatchCount === 1 ? '' : 's'} with a batch`
    : 'material documents have no batch column';
  return `${counts.batchCount} batch${counts.batchCount === 1 ? '' : 'es'} stand at ${sourceName} (${source}). ${stock}. ${documents}. The target ${targetName} (${target}) was not applied.`;
}

async function readRow(tx: Tx, client: string) {
  const rows = await tx
    .select()
    .from(batchLevelConfiguration)
    .where(eq(batchLevelConfiguration.client, client))
    .limit(1);
  return rows[0] ?? null;
}

export async function getBatchLevel(client: string): Promise<BatchLevelRow | null> {
  return withTenant(client, async (tx) => {
    const row = await readRow(tx, client);
    return row ? present(row) : null;
  });
}

export async function latestConversion(client: string): Promise<ConversionAttempt | null> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(batchLevelConversion)
      .where(eq(batchLevelConversion.client, client))
      .orderBy(desc(batchLevelConversion.startedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      conversionRunId: row.conversionRunId,
      sourceLevel: levelCode(row.sourceLevel),
      targetLevel: levelCode(row.targetLevel),
      sourceVersion: row.sourceVersion,
      status: row.status === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : 'BLOCKED',
      counts: {
        batchCount: row.batchCount,
        stockBatchCount: row.stockBatchCount,
        documentBatchCount: row.documentBatchCount,
        stockColumnPresent: row.stockColumnPresent,
        documentColumnPresent: row.documentColumnPresent,
      },
      errorSummary: row.errorSummary,
      reason: row.reason,
      startedBy: row.startedBy,
      startedAt: row.startedAt,
    };
  });
}

export async function saveBatchLevel(input: SaveBatchLevelInput): Promise<BatchLevelRow> {
  refuseExtras(input);
  const next = levelCode(input.batchLevel);
  const requestKey = input.requestKey?.trim() || null;
  return withTenant(input.client, async (tx) => {
    await lockRow(tx, input.client);
    const current = await readRow(tx, input.client);
    if (current && requestKey && current.lastRequestKey === requestKey) {
      if (levelCode(current.batchLevel) !== next) {
        throw new BatchLevelError(
          'This request key already saved a different batch level. The level was not changed.',
          'REQUEST_REPLAY',
          'Start a new save.',
        );
      }
      return present(current);
    }
    if (current && levelCode(current.batchLevel) === next) return present(current);
    const reason = reasonOf(input.reason);
    if (!current) {
      if (input.version !== 0) {
        throw new BatchLevelError(
          'The batch level was not opened at this version. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again. The first save sends version 0.',
        );
      }
    } else if (current.version !== input.version) {
      throw new BatchLevelError(
        `The batch level was opened at version ${input.version}, and version ${current.version} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the screen again and send the version it shows.',
      );
    }
    const counts = await dependentBatchData(tx, input.client);
    if (current && hasDependentData(counts)) {
      throw new BatchLevelError(
        `${impactText(counts, levelCode(current.batchLevel), next)} This is not a conversion. Live conversion is not available.`,
        'DEPENDENT_DATA',
        'Prepare the impact report. Do not edit the row while a batch stands.',
      );
    }
    const now = new Date();
    if (!current) {
      await tx.insert(batchLevelConfiguration).values({
        client: input.client,
        batchLevel: next,
        version: 1,
        lastRequestKey: requestKey,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        createdAt: now,
        changedAt: now,
      });
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_level',
        objectKey: input.client,
        changeType: 'CREATE',
        changedBy: input.changedBy,
        transactionCode: 'OMCE',
        reason,
        correlationId: requestKey ?? undefined,
        after: { batchLevel: next, version: 1 },
      });
    } else {
      const saved = await tx
        .update(batchLevelConfiguration)
        .set({
          batchLevel: next,
          version: current.version + 1,
          lastRequestKey: requestKey,
          changedBy: input.changedBy,
          changedAt: now,
        })
        .where(and(
          eq(batchLevelConfiguration.client, input.client),
          eq(batchLevelConfiguration.version, current.version),
        ))
        .returning();
      if (saved.length !== 1) {
        throw new BatchLevelError(
          'The batch level changed before this save. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again.',
        );
      }
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_level',
        objectKey: input.client,
        changeType: 'CHANGE',
        changedBy: input.changedBy,
        transactionCode: 'OMCE',
        reason,
        correlationId: requestKey ?? undefined,
        before: { batchLevel: current.batchLevel, version: current.version },
        after: { batchLevel: next, version: current.version + 1 },
      });
    }
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    const saved = await readRow(tx, input.client);
    if (!saved) {
      throw new BatchLevelError('The batch level was not saved.', 'VERSION_STALE', 'Open the screen again.');
    }
    return present(saved);
  });
}

export async function prepareBatchLevelConversion(input: PrepareConversionInput): Promise<ConversionAttempt> {
  const target = levelCode(input.targetLevel);
  const reason = reasonOf(input.reason);
  return withTenant(input.client, async (tx) => {
    await lockRow(tx, input.client);
    const current = await readRow(tx, input.client);
    if (!current) {
      throw new BatchLevelError(
        'No batch level stands. Nothing was converted.',
        'NOT_SET',
        'Save the initial level. Do not prepare a conversion.',
      );
    }
    if (current.version !== input.version) {
      throw new BatchLevelError(
        `The batch level was opened at version ${input.version}, and version ${current.version} now stands. Nothing was converted.`,
        'VERSION_STALE',
        'Open the screen again.',
      );
    }
    const source = levelCode(current.batchLevel);
    const counts = await dependentBatchData(tx, input.client);
    const status = hasDependentData(counts) ? 'BLOCKED' : 'NOT_REQUIRED';
    const errorSummary = hasDependentData(counts)
      ? `${impactText(counts, source, target)} Live conversion is not available: stock and material documents cannot be rewritten, and a batch identity is not converted by editing this row.`
      : `No batch data stands. Save ${meaning(target).name} (${target}) directly. Nothing was converted.`;
    const conversionRunId = crypto.randomUUID();
    const startedAt = new Date();
    await tx.insert(batchLevelConversion).values({
      client: input.client,
      conversionRunId,
      sourceLevel: source,
      targetLevel: target,
      sourceVersion: current.version,
      status,
      batchCount: counts.batchCount,
      stockBatchCount: counts.stockBatchCount,
      documentBatchCount: counts.documentBatchCount,
      stockColumnPresent: counts.stockColumnPresent,
      documentColumnPresent: counts.documentColumnPresent,
      errorSummary,
      reason,
      startedBy: input.changedBy,
      startedAt,
    });
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_level',
      objectKey: input.client,
      changeType: 'BLOCK',
      changedBy: input.changedBy,
      transactionCode: 'OMCE',
      reason,
      before: { batchLevel: source, version: current.version },
      after: {
        batchLevel: source,
        version: current.version,
        conversionRunId,
        conversionStatus: status,
        targetLevel: target,
      },
    });
    return {
      conversionRunId,
      sourceLevel: source,
      targetLevel: target,
      sourceVersion: current.version,
      status,
      counts,
      errorSummary,
      reason,
      startedBy: input.changedBy,
      startedAt,
    };
  });
}

export async function executeBatchLevelConversion(): Promise<never> {
  throw new BatchLevelError(
    'Live conversion is not available. The batch level was not changed.',
    'CONVERSION_BLOCKED',
    'Stock and material documents have no batch to rewrite. Do not edit the row while a batch stands.',
  );
}

export async function createBatchIdentity(input: CreateBatchIdentityInput): Promise<{ id: string; batchNumber: string; batchLevel: BatchLevelCode }> {
  const batchNumber = input.batchNumber.trim();
  if (!batchNumber) {
    throw new BatchLevelError(
      'The batch number is required. No batch was created.',
      'BATCH_REQUIRED',
      'Type the batch number. Leading zeros are kept.',
    );
  }
  if (batchNumber.length > 40) {
    throw new BatchLevelError('The batch number is longer than 40 characters. No batch was created.', 'BATCH_REQUIRED', 'Shorten the batch number.');
  }
  const materialNumber = input.materialNumber.trim();
  const plant = input.plant?.trim() || null;
  return withTenant(input.client, async (tx) => {
    await lockRow(tx, input.client);
    const current = await readRow(tx, input.client);
    if (!current) {
      throw new BatchLevelError(
        'No batch level stands. No batch was created.',
        'NOT_SET',
        'Define the batch level in OMCE first. An unset level is not plant level.',
      );
    }
    const level = levelCode(current.batchLevel);
    if (level === '0' && !plant) {
      throw new BatchLevelError(
        'Plant level requires a plant. No batch was created.',
        'PLANT_REQUIRED',
        'Name the plant. The batch is unique for this material in that plant.',
      );
    }
    if (level !== '0' && plant) {
      throw new BatchLevelError(
        `A plant is not part of batch identity at ${meaning(level).name} (${level}). No batch was created.`,
        'PLANT_NOT_ALLOWED',
        'Leave the plant empty. Plant stock is not a second batch at this level.',
      );
    }
    const materials = await tx.execute(sql`
      select 1 as present from material
      where client = ${input.client} and material_number = ${materialNumber}
      limit 1
    `) as unknown as Array<{ present: number }>;
    if (materials.length === 0) {
      throw new BatchLevelError(
        `Material ${materialNumber} does not stand. No batch was created.`,
        'MATERIAL_UNKNOWN',
        'Create the material first.',
      );
    }
    if (plant) {
      const plants = await tx.execute(sql`
        select 1 as present from plant
        where client = ${input.client} and plant = ${plant}
        limit 1
      `) as unknown as Array<{ present: number }>;
      if (plants.length === 0) {
        throw new BatchLevelError(
          `Plant ${plant} does not stand. No batch was created.`,
          'PLANT_UNKNOWN',
          'Create the plant first.',
        );
      }
    }
    const id = crypto.randomUUID();
    const now = new Date();
    try {
      await tx.insert(batch).values({
        id,
        client: input.client,
        batchNumber,
        materialNumber,
        plant,
        batchLevelAtCreation: level,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        createdAt: now,
        changedAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BatchLevelError(
          duplicateMessage(level, batchNumber, materialNumber, plant),
          'BATCH_DUPLICATE',
          'Use a batch number that is free at the current level, or display the batch that already stands.',
        );
      }
      throw error;
    }
    return { id, batchNumber, batchLevel: level };
  });
}

function duplicateMessage(level: BatchLevelCode, batchNumber: string, materialNumber: string, plant: string | null): string {
  if (level === '0') {
    return `Batch ${batchNumber} already stands for material ${materialNumber} in plant ${plant}. No second batch was created.`;
  }
  if (level === '1') {
    return `Batch ${batchNumber} already stands for material ${materialNumber}. No second batch was created.`;
  }
  return `Batch ${batchNumber} already stands in this client. No second batch was created.`;
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && (current as { code?: string }).code === '23505') return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
