/**
 * Batch-level and batch-status conversion check — OMCT.
 *
 * This is not OMCE and not OMCS. It does not select a batch level and it
 * does not turn status management on. A dry run writes nothing. A confirmed
 * check records the finding. Live conversion is not executed: no batch is
 * merged, no plant is assigned, and movements 341 and 342 are not posted.
 *
 * The level codes stay 0 plant, 1 material, and 2 client. Each tenant is
 * one logical client, so the check reads only that client.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { classificationClass } from '../foundation/characteristic-schema';
import { BATCH_LEVELS, dependentBatchData, type BatchLevelCode } from './batch-level';
import {
  batch,
  batchConversionCheck,
  batchConversionConflict,
  batchLevelConfiguration,
  batchStatusManagement,
  batchStatusPlant,
} from './schema';

export const ACTIVITY = 'CFG.INV.BATCHCONVERT.DEFINE';
export const ROUTE = '/config/batch-conversion';
export const ALIAS = 'OMCT';
export const LOCK_OBJECT = 'BATCH_CONVERSION';
const OBJECT_CLASS = 'batch_conversion_check';
const CONFLICT_CAP = 40;

export const NOT_EXECUTED = [
  {
    field: 'RM07CHDX',
    title: 'Conversion program',
    reason: 'No conversion program is run. The level and the status stay as they were.',
  },
  {
    field: 'MERGE',
    title: 'Batch merge',
    reason: 'Two batches with the same identifier are reported. They are not merged.',
  },
  {
    field: '341',
    title: 'Status movement',
    reason: 'Movements 341 and 342 are not posted. Restricted use is not rewritten.',
  },
] as const;

export class BatchConversionError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(message: string, code: string, remedy: string) {
    super(message);
    this.name = 'BatchConversionError';
    this.code = code;
    this.remedy = remedy;
  }
}

export interface ConversionConflict {
  position: number;
  conflictCode: string;
  objectKey: string;
  detail: string;
  blocks: boolean;
}

export interface ConversionCheck {
  checkId: string | null;
  persisted: boolean;
  proposal: 'LEVEL' | 'STATUS' | 'BOTH';
  sourceLevel: BatchLevelCode;
  targetLevel: BatchLevelCode;
  sourceStatus: '1' | ' ';
  targetStatus: '1' | ' ';
  result: 'BLOCKED' | 'NOT_REQUIRED';
  batchCount: number;
  stockBatchCount: number;
  documentBatchCount: number;
  conflictCount: number;
  summary: string;
  conflicts: ConversionConflict[];
  reason: string;
  startedBy: string;
  startedAt: Date | null;
}

export interface ConversionSnapshot {
  batchLevel: BatchLevelCode | null;
  levelName: string;
  levelVersion: number;
  statusManagement: '1' | ' ';
  statusVersion: number;
  checks: ConversionCheck[];
}

export interface ConversionCheckInput {
  client: string;
  changedBy: string;
  capabilities?: readonly string[];
  targetLevel?: string;
  targetStatus?: string;
  expectedLevelVersion: number;
  dryRun: boolean;
  confirmed: boolean;
  reason: string;
  transportRequest?: string;
  postingPeriod?: string;
  companyCode?: string;
  execute?: boolean;
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchConversionError(
      `The authority ${ACTIVITY} is required. Nothing was checked.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMCT does not use a second permission code.',
    );
  }
}

function levelOf(raw: string | undefined): BatchLevelCode | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  if (text !== '0' && text !== '1' && text !== '2') {
    throw new BatchConversionError(
      `Batch level ${text} is not a batch level. Use 0 for plant, 1 for material, or 2 for client.`,
      'LEVEL_UNKNOWN',
      'Do not use 1 for client or 3 for plant. The code is the character, not a number.',
    );
  }
  return text;
}

function statusOf(raw: string | undefined): '1' | ' ' | null {
  if (raw == null || raw === '') return null;
  const text = raw.trim();
  if (text === '1') return '1';
  if (text === ' ' || text.toUpperCase() === 'BLANK') return ' ';
  throw new BatchConversionError(
    `Status ${text} is refused. Active is the character 1. Inactive is blank.`,
    'STATUS_UNKNOWN',
    'Leave the status unchanged, or choose 1 or blank. This screen does not turn it on.',
  );
}

function reasonOf(value: string): string {
  const text = value?.trim() ?? '';
  if (text.length < 3 || text.length > 500) {
    throw new BatchConversionError('A reason is required.', 'REASON_REQUIRED', 'Say why this check is being run.');
  }
  return text;
}

async function lockConfig(tx: Tx, client: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext('BATCH_LEVEL'))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext('BATCH_STATUS'))`);
}

async function readConfig(tx: Tx, client: string) {
  const [level] = await tx.select().from(batchLevelConfiguration)
    .where(eq(batchLevelConfiguration.client, client)).limit(1);
  const [status] = await tx.select().from(batchStatusManagement)
    .where(eq(batchStatusManagement.client, client)).limit(1);
  return {
    level: level ? level.batchLevel as BatchLevelCode : null,
    levelVersion: level?.version ?? 0,
    status: (status?.statusManagement === '1' ? '1' : ' ') as '1' | ' ',
    statusVersion: status?.version ?? 0,
  };
}

async function identityConflicts(tx: Tx, client: string, target: BatchLevelCode): Promise<ConversionConflict[]> {
  const found: ConversionConflict[] = [];
  if (target === '0') {
    const rows = await tx.execute(sql`
      select material_number, batch_number
      from batch
      where client = ${client} and plant is null
      order by material_number, batch_number
      limit 80
    `) as unknown as Array<{ material_number: string; batch_number: string }>;
    for (const row of rows) {
      found.push({
        position: 0,
        conflictCode: 'PLANT_MISSING',
        objectKey: `${row.material_number}/${row.batch_number}`,
        detail: 'This batch has no plant. A plant was not assigned, and the batch was not rewritten.',
        blocks: true,
      });
    }
    return found;
  }
  const rows = target === '1'
    ? await tx.execute(sql`
        select material_number, batch_number, count(*)::int as n
        from batch
        where client = ${client}
        group by material_number, batch_number
        having count(*) > 1
        order by material_number, batch_number
        limit 80
      `) as unknown as Array<{ material_number: string; batch_number: string; n: number }>
    : await tx.execute(sql`
        select batch_number, count(*)::int as n, count(distinct material_number)::int as materials
        from batch
        where client = ${client}
        group by batch_number
        having count(*) > 1
        order by batch_number
        limit 80
      `) as unknown as Array<{ batch_number: string; n: number; materials: number; material_number?: string }>;
  for (const row of rows) {
    const key = target === '1' ? `${row.material_number}/${row.batch_number}` : row.batch_number;
    found.push({
      position: 0,
      conflictCode: 'IDENTITY_COLLISION',
      objectKey: key,
      detail: `This identifier stands ${row.n} times. The batches were not merged.`,
      blocks: true,
    });
  }
  return found;
}

async function referenceConflicts(
  tx: Tx,
  client: string,
  source: BatchLevelCode,
  target: BatchLevelCode,
  statusChanges: boolean,
): Promise<ConversionConflict[]> {
  const found: ConversionConflict[] = [];
  const unwantedType = target === '0' ? '023' : '022';
  if (source !== target) {
    const classes = await tx.select().from(classificationClass).where(and(
      eq(classificationClass.client, client),
      eq(classificationClass.classType, unwantedType),
    ));
    for (const row of classes) {
      found.push({
        position: 0,
        conflictCode: 'CLASS_TYPE',
        objectKey: `${row.classType}/${row.className}`,
        detail: 'This batch class is the other level. It was not converted.',
        blocks: false,
      });
    }
  }
  if (source === '0' && target !== '0') {
    const plants = await tx.select().from(batchStatusPlant).where(and(
      eq(batchStatusPlant.client, client),
      eq(batchStatusPlant.statusActive, 'X'),
    ));
    for (const row of plants) {
      found.push({
        position: 0,
        conflictCode: 'PLANT_STATUS',
        objectKey: row.plant,
        detail: 'This plant selection was not changed. OMCU is not this screen.',
        blocks: false,
      });
    }
  }
  if (statusChanges) {
    const restricted = await tx.select({
      materialNumber: batch.materialNumber,
      batchNumber: batch.batchNumber,
    }).from(batch).where(and(eq(batch.client, client), eq(batch.restrictedUse, 'X')));
    for (const row of restricted) {
      found.push({
        position: 0,
        conflictCode: 'RESTRICTED_BATCH',
        objectKey: `${row.materialNumber}/${row.batchNumber}`,
        detail: 'Restricted use was not changed. Movement 341 was not posted.',
        blocks: true,
      });
    }
  }
  return found;
}

function summarize(
  result: 'BLOCKED' | 'NOT_REQUIRED',
  source: BatchLevelCode,
  target: BatchLevelCode,
  sourceStatus: '1' | ' ',
  targetStatus: '1' | ' ',
  counts: { batchCount: number; stockBatchCount: number; documentBatchCount: number },
  conflictCount: number,
): string {
  const levelText = source === target
    ? `The level stays ${BATCH_LEVELS[source].name} (${source}).`
    : `The level ${BATCH_LEVELS[source].name} (${source}) was not changed to ${BATCH_LEVELS[target].name} (${target}).`;
  const statusText = sourceStatus === targetStatus
    ? `Status management stays ${sourceStatus === '1' ? 'active' : 'inactive'}.`
    : 'The status indicator was not changed.';
  if (result === 'NOT_REQUIRED') {
    return `${levelText} ${statusText} No batch, stock, or document stands in the way. Change the level on OMCE or the indicator on OMCS. This check did not save either.`;
  }
  return `${levelText} ${statusText} ${counts.batchCount} batches, ${counts.stockBatchCount} stock rows, and ${counts.documentBatchCount} document lines were read. ${conflictCount} conflicts were found. Nothing was merged and nothing was posted.`;
}

async function inspect(tx: Tx, client: string, input: {
  targetLevel: BatchLevelCode | null;
  targetStatus: '1' | ' ' | null;
}): Promise<Omit<ConversionCheck, 'checkId' | 'persisted' | 'reason' | 'startedBy' | 'startedAt'>> {
  const current = await readConfig(tx, client);
  if (!current.level) {
    throw new BatchConversionError(
      'No batch level stands. Nothing was converted.',
      'NOT_SET',
      'Save the initial level on OMCE. OMCT does not set it.',
    );
  }
  const targetLevel = input.targetLevel ?? current.level;
  const targetStatus = input.targetStatus ?? current.status;
  if (targetLevel === current.level && targetStatus === current.status) {
    throw new BatchConversionError(
      'The proposal is the level and status that already stand. Nothing was checked.',
      'NO_CHANGE',
      'Choose a different level or status. This screen does not save the current setting again.',
    );
  }
  const counts = await dependentBatchData(tx, client);
  const conflicts: ConversionConflict[] = [];
  if (targetLevel !== current.level) conflicts.push(...await identityConflicts(tx, client, targetLevel));
  conflicts.push(...await referenceConflicts(tx, client, current.level, targetLevel, targetStatus !== current.status));
  if (counts.stockBatchCount > 0) {
    conflicts.push({
      position: 0,
      conflictCode: 'STOCK_BATCH',
      objectKey: 'stock_quantity',
      detail: `${counts.stockBatchCount} stock rows carry a batch. They were not rewritten.`,
      blocks: true,
    });
  }
  if (counts.documentBatchCount > 0) {
    conflicts.push({
      position: 0,
      conflictCode: 'DOCUMENT_BATCH',
      objectKey: 'material_document_line',
      detail: `${counts.documentBatchCount} material-document lines carry a batch. They were not rewritten.`,
      blocks: true,
    });
  }
  if ((targetLevel !== current.level || targetStatus !== current.status) && counts.batchCount > 0) {
    conflicts.push({
      position: 0,
      conflictCode: 'BATCH_MASTER',
      objectKey: 'batch',
      detail: `${counts.batchCount} batches stand. Their identity and status were not rewritten.`,
      blocks: true,
    });
  }
  const numbered = conflicts.map((item, index) => ({ ...item, position: index + 1 }));
  const blocks = numbered.some((item) => item.blocks);
  const proposal: ConversionCheck['proposal'] = targetLevel !== current.level && targetStatus !== current.status
    ? 'BOTH'
    : targetLevel !== current.level ? 'LEVEL' : 'STATUS';
  const result: ConversionCheck['result'] = blocks ? 'BLOCKED' : 'NOT_REQUIRED';
  return {
    proposal,
    sourceLevel: current.level,
    targetLevel,
    sourceStatus: current.status,
    targetStatus,
    result,
    batchCount: counts.batchCount,
    stockBatchCount: counts.stockBatchCount,
    documentBatchCount: counts.documentBatchCount,
    conflictCount: numbered.length,
    summary: summarize(result, current.level, targetLevel, current.status, targetStatus, counts, numbered.length),
    conflicts: numbered,
  };
}

async function presentChecks(tx: Tx, client: string): Promise<ConversionCheck[]> {
  const headers = await tx.select().from(batchConversionCheck)
    .where(eq(batchConversionCheck.client, client))
    .orderBy(desc(batchConversionCheck.startedAt));
  if (headers.length === 0) return [];
  const conflicts = await tx.select().from(batchConversionConflict)
    .where(eq(batchConversionConflict.client, client));
  return headers.map((row) => ({
    checkId: row.checkId,
    persisted: true,
    proposal: row.proposal as ConversionCheck['proposal'],
    sourceLevel: row.sourceLevel as BatchLevelCode,
    targetLevel: row.targetLevel as BatchLevelCode,
    sourceStatus: row.sourceStatus === '1' ? '1' : ' ',
    targetStatus: row.targetStatus === '1' ? '1' : ' ',
    result: row.result as ConversionCheck['result'],
    batchCount: row.batchCount,
    stockBatchCount: row.stockBatchCount,
    documentBatchCount: row.documentBatchCount,
    conflictCount: row.conflictCount,
    summary: row.summary,
    conflicts: conflicts
      .filter((item) => item.checkId === row.checkId)
      .sort((left, right) => left.position - right.position)
      .map((item) => ({
        position: item.position,
        conflictCode: item.conflictCode,
        objectKey: item.objectKey,
        detail: item.detail,
        blocks: item.blocks,
      })),
    reason: row.reason,
    startedBy: row.startedBy,
    startedAt: row.startedAt,
  }));
}

export async function listConversionChecks(clientKey: string): Promise<ConversionSnapshot> {
  const client = clientKey?.trim() ?? '';
  if (!client) throw new BatchConversionError('The tenant is missing.', 'CLIENT_REQUIRED', 'Sign in again.');
  return withTenant(client, async (tx) => {
    const current = await readConfig(tx, client);
    return {
      batchLevel: current.level,
      levelName: current.level ? BATCH_LEVELS[current.level].name : '',
      levelVersion: current.levelVersion,
      statusManagement: current.status,
      statusVersion: current.statusVersion,
      checks: await presentChecks(tx, client),
    };
  });
}

export async function checkBatchConversion(input: ConversionCheckInput): Promise<ConversionCheck> {
  assertAuthority(input.capabilities);
  const client = input.client?.trim() ?? '';
  const changedBy = input.changedBy?.trim() ?? '';
  if (!client || !changedBy) {
    throw new BatchConversionError('The tenant or the acting user is missing.', 'CLIENT_REQUIRED', 'Sign in again.');
  }
  if (input.execute === true) {
    throw new BatchConversionError(
      'Execution was refused. The check does not convert.',
      'CONVERSION_NOT_EXECUTED',
      'Run the check only. Live conversion is not available.',
    );
  }
  if (input.transportRequest?.trim()) {
    throw new BatchConversionError('A transport is refused. OMCT does not write a transport request.', 'TRANSPORT_REFUSED', 'Check this client only.');
  }
  if (input.postingPeriod?.trim()) {
    throw new BatchConversionError('A posting period is refused. OB52 does not gate this check.', 'PERIOD_REFUSED', 'Leave the period empty.');
  }
  if (input.companyCode?.trim()) {
    throw new BatchConversionError('A company code is refused. The check is for this client.', 'COMPANY_REFUSED', 'Do not send a company code.');
  }
  const reason = reasonOf(input.reason);
  const targetLevel = levelOf(input.targetLevel);
  const targetStatus = statusOf(input.targetStatus);
  if (!targetLevel && !targetStatus) {
    throw new BatchConversionError(
      'Name a target level or a target status. Nothing was checked.',
      'PROPOSAL_REQUIRED',
      'This screen does not save the current setting.',
    );
  }
  if (!input.dryRun && input.confirmed !== true) {
    throw new BatchConversionError(
      'The check was not recorded. Confirmation is required.',
      'CONFIRM_REQUIRED',
      'Confirm the check, or run it as a dry run. Neither one converts.',
    );
  }

  return withTenant(client, async (tx) => {
    await lockConfig(tx, client);
    const current = await readConfig(tx, client);
    if (current.level && input.expectedLevelVersion !== current.levelVersion) {
      throw new BatchConversionError(
        'The batch level changed before this check. Nothing was recorded.',
        'VERSION_STALE',
        'Open the screen again. The level was not changed here.',
      );
    }
    const finding = await inspect(tx, client, { targetLevel, targetStatus });
    if (input.dryRun) {
      return { ...finding, checkId: null, persisted: false, reason, startedBy: changedBy, startedAt: null };
    }
    const checkId = crypto.randomUUID();
    await tx.insert(batchConversionCheck).values({
      client,
      checkId,
      proposal: finding.proposal,
      sourceLevel: finding.sourceLevel,
      targetLevel: finding.targetLevel,
      sourceStatus: finding.sourceStatus,
      targetStatus: finding.targetStatus,
      result: finding.result,
      batchCount: finding.batchCount,
      stockBatchCount: finding.stockBatchCount,
      documentBatchCount: finding.documentBatchCount,
      conflictCount: finding.conflictCount,
      summary: finding.summary,
      reason,
      startedBy: changedBy,
    });
    const stored = finding.conflicts.slice(0, CONFLICT_CAP);
    for (const conflict of stored) {
      await tx.insert(batchConversionConflict).values({
        client,
        checkId,
        position: conflict.position,
        conflictCode: conflict.conflictCode,
        objectKey: conflict.objectKey.slice(0, 80),
        detail: conflict.detail.slice(0, 240),
        blocks: conflict.blocks,
      });
    }
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: checkId,
      changeType: 'CREATE',
      changedBy,
      reason,
      transactionCode: ALIAS,
      after: {
        result: finding.result,
        sourceLevel: finding.sourceLevel,
        targetLevel: finding.targetLevel,
        sourceStatus: finding.sourceStatus,
        targetStatus: finding.targetStatus,
        conflictCount: finding.conflictCount,
        converted: false,
      },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    const [saved] = (await presentChecks(tx, client)).filter((row) => row.checkId === checkId);
    return saved!;
  });
}

export function executeBatchConversion(): never {
  throw new BatchConversionError(
    'Live conversion is not available. The batch level and the status indicator were not changed.',
    'CONVERSION_NOT_EXECUTED',
    'Use the check. Do not merge a batch, assign a plant, or post movement 341 or 342.',
  );
}
