/**
 * Activate batch status management. OMCS is a search alias only.
 *
 * Baseline: SAP S/4HANA on-premise batch status management, 2025 FPS02, and
 * the client indicator TCUCH-KZDZV. Blank means not active. The character 1
 * means active. The description is derived. The code is never a number.
 *
 * The batch level is read from OMCE. This screen does not store one.
 * At material level (1) or client level (2), an active indicator applies in
 * every plant. At plant level (0), SAP applies it only in a plant selected
 * by OMCU. This screen does not select a plant, so a plant-level indicator
 * is stored and is not effective in any plant.
 *
 * A change while a batch stands is refused. The SAP conversion, and the
 * status-change movements 341 and 342, are not available: stock and material
 * documents have no batch. OMAB, OMCU, OMCZ, OMAD, MSC1N, MSC2N, and MSC3N
 * are not this screen. A closed posting period is not consulted.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { BATCH_LEVELS, type BatchLevelCode } from './batch-level';
import { batch, batchLevelConfiguration, batchStatusManagement } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHSTATUS.DEFINE';
export const ROUTE = '/config/batch-status';
export const ALIASES = ['OMCS'] as const;
export const LOCK_OBJECT = 'BATCH_STATUS';

export class BatchStatusError extends Error {
  readonly code:
    | 'STATUS_UNKNOWN'
    | 'LEVEL_REQUIRED'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'CONVERSION_BLOCKED'
    | 'TRANSPORT_REFUSED'
    | 'APPROVAL_REFUSED'
    | 'PERIOD_REFUSED'
    | 'COMPANY_REFUSED'
    | 'LEVEL_REFUSED'
    | 'PLANT_REFUSED'
    | 'INITIAL_STATUS_REFUSED'
    | 'CLASSIFICATION_REFUSED'
    | 'NUMBERING_REFUSED'
    | 'RANGE_REFUSED'
    | 'REQUEST_REPLAY'
    | 'NOT_SET';

  constructor(
    message: string,
    code: BatchStatusError['code'],
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'BatchStatusError';
    this.code = code;
  }
}

export type StatusManagementCode = '1' | null;

export interface StatusScope {
  effective: boolean;
  scope: 'INACTIVE' | 'ALL_PLANTS' | 'PLANT' | 'PLANT_NOT_SELECTED' | 'LEVEL_MISSING';
  explanation: string;
}

export interface BatchStatusRow {
  statusManagement: StatusManagementCode;
  version: number;
  batchLevel: BatchLevelCode | null;
  scope: StatusScope;
  changedBy: string | null;
  changedAt: Date | null;
}

export interface SaveBatchStatusInput {
  client: string;
  changedBy: string;
  /** '1' active, or blank for not active. No other value is a status code. */
  statusManagement: string;
  version: number;
  reason?: string;
  requestKey?: string;
  transportRequest?: string;
  approval?: string;
  postingPeriod?: string;
  companyCode?: string;
  batchLevel?: string;
  plant?: string;
  initialStatus?: string;
  classification?: boolean;
  internalNumbering?: boolean;
  batchNumberRange?: string;
}

/**
 * SAP scope rule. A plant is selected only by OMCU. OMCS never passes one.
 */
export function batchStatusScope(input: {
  batchLevel: BatchLevelCode | null;
  active: boolean;
  plantSelected?: boolean;
}): StatusScope {
  if (!input.active) {
    return {
      effective: false,
      scope: 'INACTIVE',
      explanation: 'Batch status management is not active. A batch has no restricted-use status from this setting.',
    };
  }
  if (!input.batchLevel) {
    return {
      effective: false,
      scope: 'LEVEL_MISSING',
      explanation: 'No batch level stands. The indicator cannot apply.',
    };
  }
  if (input.batchLevel === '1' || input.batchLevel === '2') {
    return {
      effective: true,
      scope: 'ALL_PLANTS',
      explanation: `The batch level is ${BATCH_LEVELS[input.batchLevel].name} (${input.batchLevel}). An active indicator applies in every plant. OMCU is not used at this level.`,
    };
  }
  if (input.plantSelected) {
    return {
      effective: true,
      scope: 'PLANT',
      explanation: 'Batch status management applies in this plant because OMCU selected it.',
    };
  }
  return {
    effective: false,
    scope: 'PLANT_NOT_SELECTED',
    explanation: 'The batch level is plant (0). The indicator applies only in a plant OMCU selects. No plant is selected. It was not applied to every plant.',
  };
}

function statusCode(value: string): StatusManagementCode {
  const text = value.trim();
  if (text === '1') return '1';
  if (text === '') return null;
  throw new BatchStatusError(
    `Batch status management ${text} is not the indicator. Use 1 for active, or leave it blank.`,
    'STATUS_UNKNOWN',
    'The stored code is the character 1 or blank. It is not a label and not a number.',
  );
}

function storedCode(active: StatusManagementCode): '1' | ' ' {
  return active === '1' ? '1' : ' ';
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3) {
    throw new BatchStatusError('A reason is required.', 'REASON_REQUIRED', 'Say why the indicator is being set.');
  }
  if (text.length > 500) {
    throw new BatchStatusError('The reason is longer than 500 characters.', 'REASON_REQUIRED', 'Shorten the reason.');
  }
  return text;
}

function refuseExtras(input: SaveBatchStatusInput): void {
  if (input.transportRequest?.trim()) {
    throw new BatchStatusError(
      'A transport is refused. OMCS does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Save the indicator in this client. Do not send a transport.',
    );
  }
  if (input.approval?.trim()) {
    throw new BatchStatusError(
      'An approval is refused. OMCS does not route a workflow.',
      'APPROVAL_REFUSED',
      'Save the indicator. Do not send an approval.',
    );
  }
  if (input.postingPeriod?.trim()) {
    throw new BatchStatusError(
      'A posting period is refused. OB52 does not gate this screen.',
      'PERIOD_REFUSED',
      'Leave the posting period empty. A closed period does not block the indicator.',
    );
  }
  if (input.companyCode?.trim()) {
    throw new BatchStatusError(
      'A company code is refused. The indicator is one setting for the client, not a company.',
      'COMPANY_REFUSED',
      'Do not send a company code.',
    );
  }
  if (input.batchLevel?.trim()) {
    throw new BatchStatusError(
      'A batch level is refused. OMCE owns the level. OMCS does not store one.',
      'LEVEL_REFUSED',
      'Leave the batch level empty. Change it in OMCE.',
    );
  }
  if (input.plant?.trim()) {
    throw new BatchStatusError(
      'A plant is refused. OMCU selects the plants. OMCS does not.',
      'PLANT_REFUSED',
      'Do not send a plant. This screen has no plant selector.',
    );
  }
  if (input.initialStatus?.trim()) {
    throw new BatchStatusError(
      'An initial batch status is refused. OMAB is not this screen.',
      'INITIAL_STATUS_REFUSED',
      'Do not send an initial status. A new batch is not given one here.',
    );
  }
  if (input.classification) {
    throw new BatchStatusError(
      'Classification is refused. Saving the indicator does not classify a batch.',
      'CLASSIFICATION_REFUSED',
      'Leave classification off.',
    );
  }
  if (input.internalNumbering) {
    throw new BatchStatusError(
      'Internal batch numbering is refused. OMCZ is not this screen.',
      'NUMBERING_REFUSED',
      'Leave internal numbering off.',
    );
  }
  if (input.batchNumberRange?.trim()) {
    throw new BatchStatusError(
      'A batch number range is refused. OMAD is not this screen.',
      'RANGE_REFUSED',
      'Do not send a number range.',
    );
  }
}

async function lockRow(tx: Tx, client: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext('BATCH_STATUS'))`);
}

async function readLevel(tx: Tx, client: string): Promise<BatchLevelCode | null> {
  const rows = await tx
    .select({ batchLevel: batchLevelConfiguration.batchLevel })
    .from(batchLevelConfiguration)
    .where(eq(batchLevelConfiguration.client, client))
    .limit(1);
  const code = rows[0]?.batchLevel?.trim();
  if (code === '0' || code === '1' || code === '2') return code;
  return null;
}

async function readRow(tx: Tx, client: string) {
  const rows = await tx
    .select()
    .from(batchStatusManagement)
    .where(eq(batchStatusManagement.client, client))
    .limit(1);
  return rows[0] ?? null;
}

async function batchCount(tx: Tx, client: string): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(batch)
    .where(eq(batch.client, client));
  return Number(rows[0]?.n ?? 0);
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

function present(row: {
  statusManagement: string;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
} | null, level: BatchLevelCode | null): BatchStatusRow {
  const active = row ? statusCode(row.statusManagement.trim()) : null;
  return {
    statusManagement: active,
    version: row?.version ?? 0,
    batchLevel: level,
    scope: batchStatusScope({ batchLevel: level, active: active === '1', plantSelected: false }),
    changedBy: row?.changedBy ?? null,
    changedAt: row?.changedAt ?? null,
  };
}

export async function getBatchStatusManagement(client: string): Promise<BatchStatusRow> {
  return withTenant(client, async (tx) => {
    const [row, level] = await Promise.all([readRow(tx, client), readLevel(tx, client)]);
    return present(row, level);
  });
}

export async function saveBatchStatus(input: SaveBatchStatusInput): Promise<BatchStatusRow> {
  refuseExtras(input);
  const next = statusCode(input.statusManagement);
  const requestKey = input.requestKey?.trim() || null;
  return withTenant(input.client, async (tx) => {
    await lockRow(tx, input.client);
    const current = await readRow(tx, input.client);
    const level = await readLevel(tx, input.client);
    const currentCode = current ? statusCode(current.statusManagement.trim()) : null;
    if (current && requestKey && current.lastRequestKey === requestKey) {
      if (currentCode !== next) {
        throw new BatchStatusError(
          'This request key already saved a different indicator. The indicator was not changed.',
          'REQUEST_REPLAY',
          'Start a new save.',
        );
      }
      return present(current, level);
    }
    if (current && currentCode === next) return present(current, level);
    const reason = reasonOf(input.reason);
    if (!current) {
      if (input.version !== 0) {
        throw new BatchStatusError(
          'The indicator was not opened at this version. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again. The first save sends version 0.',
        );
      }
    } else if (current.version !== input.version) {
      throw new BatchStatusError(
        `The indicator was opened at version ${input.version}, and version ${current.version} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the screen again and send the version it shows.',
      );
    }
    if (next === '1' && !level) {
      throw new BatchStatusError(
        'No batch level stands. Batch status management was not activated.',
        'LEVEL_REQUIRED',
        'Set the batch level in OMCE first. An unset level is not plant level.',
      );
    }
    const batches = await batchCount(tx, input.client);
    if (batches > 0) {
      const stock = await columnPresent(tx, 'stock_quantity', 'batch_number');
      const documents = await columnPresent(tx, 'material_document_line', 'batch_number');
      throw new BatchStatusError(
        `${batches} batch${batches === 1 ? '' : 'es'} stand. The indicator was not changed. ` +
          `${stock ? 'Stock has a batch column.' : 'Stock has no batch column.'} ` +
          `${documents ? 'Material documents have a batch column.' : 'Material documents have no batch column.'} ` +
          'Live conversion is not available, and movements 341 and 342 were not posted.',
        'CONVERSION_BLOCKED',
        'Do not edit the indicator while a batch stands. MSC2N is not this screen.',
      );
    }
    const now = new Date();
    const afterCode = storedCode(next);
    if (!current) {
      await tx.insert(batchStatusManagement).values({
        client: input.client,
        statusManagement: afterCode,
        version: 1,
        lastRequestKey: requestKey,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        createdAt: now,
        changedAt: now,
      });
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_status_management',
        objectKey: input.client,
        changeType: 'CREATE',
        changedBy: input.changedBy,
        transactionCode: 'OMCS',
        reason,
        correlationId: requestKey ?? undefined,
        after: { statusManagement: next ?? ' ', version: 1, batchLevel: level },
      });
    } else {
      const saved = await tx
        .update(batchStatusManagement)
        .set({
          statusManagement: afterCode,
          version: current.version + 1,
          lastRequestKey: requestKey,
          changedBy: input.changedBy,
          changedAt: now,
        })
        .where(and(
          eq(batchStatusManagement.client, input.client),
          eq(batchStatusManagement.version, current.version),
        ))
        .returning();
      if (saved.length !== 1) {
        throw new BatchStatusError(
          'The indicator changed before this save. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again.',
        );
      }
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_status_management',
        objectKey: input.client,
        changeType: 'CHANGE',
        changedBy: input.changedBy,
        transactionCode: 'OMCS',
        reason,
        correlationId: requestKey ?? undefined,
        before: { statusManagement: current.statusManagement, version: current.version },
        after: { statusManagement: next ?? ' ', version: current.version + 1, batchLevel: level },
      });
    }
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    const saved = await readRow(tx, input.client);
    return present(saved, level);
  });
}

export async function executeBatchStatusConversion(): Promise<never> {
  throw new BatchStatusError(
    'Live conversion is not available. The indicator was not changed, and movements 341 and 342 were not posted.',
    'CONVERSION_BLOCKED',
    'Stock and material documents have no batch to rewrite. Do not treat a save as a conversion.',
  );
}
