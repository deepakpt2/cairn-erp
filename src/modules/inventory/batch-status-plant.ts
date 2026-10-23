/**
 * Batch status management in plant. OMCU is a search alias only.
 *
 * SAP mapping: T001W-CHAZV, data element CHAZV, domain XFELD. The stored
 * code is X when the plant is selected and blank when it is not. It is not
 * the OMCS character 1, not a boolean, and not a batch status of 1 or 2.
 * Restricted use stays ZUSTD on the batch. Blocked stock and inspection
 * stock stay stock categories. This screen does not post them.
 *
 * The plant name is read from the plant master. It is not stored here.
 * The canonical plant key is reused. It is not cut to SAP's four characters.
 *
 * Plant selection applies only when the batch level is plant (0). At
 * material or client level, OMCS already applies in every plant. This
 * screen does not change OMCE, OMCS, OMAB, OMAD, or OMCZ.
 *
 * Movements 341 and 342 are not available. A change that would need them
 * is refused and recorded. Stock quantities are not rewritten.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { plant } from '../foundation/schema';
import { BATCH_LEVELS, type BatchLevelCode } from './batch-level';
import { batchStatusScope } from './batch-status';
import {
  batchStatusManagement,
  batchStatusPlant,
  batchStatusPlantConversion,
  batchLevelConfiguration,
} from './schema';

export const ACTIVITY = 'CFG.INV.BATCHSTATUSPLANT.DEFINE';
export const ROUTE = '/config/batch-status-plants';
export const ALIASES = ['OMCU'] as const;
export const LOCK_OBJECT = 'BATCH_STATUS_PLANT';

export class BatchStatusPlantError extends Error {
  readonly code:
    | 'AUTHORITY_REQUIRED'
    | 'PLANT_UNKNOWN'
    | 'PLANT_NAME_REFUSED'
    | 'LEVEL_INAPPLICABLE'
    | 'LEVEL_REQUIRED'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'CONFIRM_REQUIRED'
    | 'CONVERSION_BLOCKED'
    | 'TRANSPORT_REFUSED'
    | 'COMPANY_REFUSED'
    | 'LEVEL_REFUSED'
    | 'INITIAL_STATUS_REFUSED'
    | 'MOVEMENT_REFUSED'
    | 'STATUS_UNKNOWN'
    | 'REQUEST_REPLAY';

  constructor(message: string, code: BatchStatusPlantError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchStatusPlantError';
    this.code = code;
  }
}

export interface PlantStatusContext {
  batchLevel: BatchLevelCode | null;
  clientStatusActive: boolean;
  applicable: boolean;
  explanation: string;
}

export interface PlantBatchStatusRow {
  plant: string;
  plantName: string;
  statusActive: 'X' | null;
  version: number;
  effective: boolean;
  changedBy: string | null;
  changedAt: Date | null;
}

export interface PlantBatchStatusView {
  context: PlantStatusContext;
  plants: PlantBatchStatusRow[];
}

export interface PlantStatusDependency {
  batchCount: number;
  stockBatchCount: number;
  documentBatchCount: number;
  conversionRequired: boolean;
}

export interface PlantStatusConversionRow {
  conversionRunId: string;
  plant: string;
  priorActive: 'X' | ' ';
  requestedActive: 'X' | ' ';
  status: 'BLOCKED';
  batchCount: number;
  stockBatchCount: number;
  documentBatchCount: number;
  errorSummary: string;
  reason: string;
  startedBy: string;
  startedAt: Date | null;
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchStatusPlantError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMCU does not use a second permission code.',
    );
  }
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new BatchStatusPlantError('A reason is required.', 'REASON_REQUIRED', 'Say why this plant selection is being saved.');
  }
  return text;
}

function flagOf(value: string): 'X' | ' ' {
  const text = value.trim().toUpperCase();
  if (text === 'X') return 'X';
  if (text === '') return ' ';
  throw new BatchStatusPlantError(
    `Plant batch status ${text} is not the indicator. Use X, or leave it blank.`,
    'STATUS_UNKNOWN',
    'The stored code is the character X or blank. It is not 1, and it is not a label.',
  );
}

function refuseExtras(input: {
  transportRequest?: string;
  companyCode?: string;
  batchLevel?: string;
  plantName?: string;
  initialStatus?: string;
  movement?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchStatusPlantError('A transport is refused. OMCU does not write a transport request.', 'TRANSPORT_REFUSED', 'Save the plant in this client.');
  }
  if (input.companyCode?.trim()) {
    throw new BatchStatusPlantError('A company code is refused. The selection is the plant, not a company.', 'COMPANY_REFUSED', 'Do not send a company code.');
  }
  if (input.batchLevel?.trim()) {
    throw new BatchStatusPlantError('A batch level is refused. OMCE owns the level. OMCU does not store one.', 'LEVEL_REFUSED', 'Leave the batch level empty.');
  }
  if (input.plantName?.trim()) {
    throw new BatchStatusPlantError('The plant name is refused. It is read from the plant master.', 'PLANT_NAME_REFUSED', 'Do not send a plant name.');
  }
  if (input.initialStatus?.trim()) {
    throw new BatchStatusPlantError('An initial batch status is refused. OMAB is not this screen.', 'INITIAL_STATUS_REFUSED', 'Do not send an initial status.');
  }
  if (input.movement?.trim()) {
    throw new BatchStatusPlantError(
      `Movement ${input.movement.trim()} is refused. OMCU does not post stock.`,
      'MOVEMENT_REFUSED',
      'Do not send movement 341 or 342. This screen does not transfer stock.',
    );
  }
}

async function readContext(tx: Tx, client: string): Promise<PlantStatusContext> {
  const levels = await tx.select({ batchLevel: batchLevelConfiguration.batchLevel })
    .from(batchLevelConfiguration)
    .where(eq(batchLevelConfiguration.client, client))
    .limit(1);
  const code = levels[0]?.batchLevel?.trim();
  const batchLevel = code === '0' || code === '1' || code === '2' ? code : null;
  const status = await tx.select({ code: batchStatusManagement.statusManagement })
    .from(batchStatusManagement)
    .where(eq(batchStatusManagement.client, client))
    .limit(1);
  const clientStatusActive = status[0]?.code?.trim() === '1';
  if (!batchLevel) {
    return {
      batchLevel: null,
      clientStatusActive,
      applicable: false,
      explanation: 'No batch level stands. An unset level is not plant level. OMCU does not select a plant.',
    };
  }
  if (batchLevel !== '0') {
    return {
      batchLevel,
      clientStatusActive,
      applicable: false,
      explanation: `The batch level is ${BATCH_LEVELS[batchLevel].name} (${batchLevel}). An OMCS indicator applies in every plant. OMCU does not override it.`,
    };
  }
  return {
    batchLevel,
    clientStatusActive,
    applicable: true,
    explanation: clientStatusActive
      ? 'The batch level is plant (0), and OMCS is active. Status management applies only in a plant selected here.'
      : 'The batch level is plant (0). OMCS is not active, so a selected plant is stored and is not yet effective.',
  };
}

function presentRow(row: {
  plant: string;
  name: string;
  statusActive: string | null;
  version: number | null;
  changedBy: string | null;
  changedAt: Date | null;
}, context: PlantStatusContext): PlantBatchStatusRow {
  const selected = row.statusActive?.trim() === 'X';
  const scope = batchStatusScope({
    batchLevel: context.batchLevel,
    active: context.clientStatusActive,
    plantSelected: selected,
  });
  return {
    plant: row.plant,
    plantName: row.name,
    statusActive: selected ? 'X' : null,
    version: row.version ?? 0,
    effective: context.applicable && scope.effective,
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

export async function readPlantBatchStatusActive(tx: Tx, client: string, plantCode: string | null): Promise<boolean> {
  if (!plantCode) return false;
  const rows = await tx.select({ statusActive: batchStatusPlant.statusActive }).from(batchStatusPlant).where(and(
    eq(batchStatusPlant.client, client),
    eq(batchStatusPlant.plant, plantCode),
  )).limit(1);
  return rows[0]?.statusActive?.trim() === 'X';
}

export async function listPlantBatchStatus(client: string): Promise<PlantBatchStatusView> {
  return withTenant(client, async (tx) => {
    const context = await readContext(tx, client);
    const rows = await tx.execute(sql`
      select p.plant, p.name,
             s.status_active, s.version, s.changed_by, s.changed_at
      from plant p
      left join batch_status_plant s on s.client = p.client and s.plant = p.plant
      where p.client = ${client}
      order by p.plant
    `) as unknown as Array<{
      plant: string;
      name: string;
      status_active: string | null;
      version: number | null;
      changed_by: string | null;
      changed_at: Date | null;
    }>;
    return {
      context,
      plants: rows.map((row) => presentRow({
        plant: row.plant,
        name: row.name,
        statusActive: row.status_active,
        version: row.version,
        changedBy: row.changed_by,
        changedAt: row.changed_at,
      }, context)),
    };
  });
}

async function dependency(tx: Tx, client: string, plantCode: string): Promise<PlantStatusDependency> {
  const batches = await tx.execute(sql`
    select count(*)::int as n from batch
    where client = ${client} and plant = ${plantCode}
  `) as unknown as Array<{ n: number }>;
  const stock = await tx.execute(sql`
    select count(*)::int as n from stock_quantity
    where client = ${client} and plant = ${plantCode} and batch_number <> ''
  `) as unknown as Array<{ n: number }>;
  const documents = await tx.execute(sql`
    select count(*)::int as n from material_document_line
    where client = ${client} and plant = ${plantCode} and batch_number <> ''
  `) as unknown as Array<{ n: number }>;
  const batchCount = Number(batches[0]?.n ?? 0);
  const stockBatchCount = Number(stock[0]?.n ?? 0);
  const documentBatchCount = Number(documents[0]?.n ?? 0);
  return {
    batchCount,
    stockBatchCount,
    documentBatchCount,
    conversionRequired: batchCount > 0 || stockBatchCount > 0 || documentBatchCount > 0,
  };
}

/** Recorded conversion attempts. Live conversion is not executed, so every row is blocked. */
export async function listPlantStatusConversions(client: string, plantCode?: string): Promise<PlantStatusConversionRow[]> {
  const plantFilter = plantCode?.trim();
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(batchStatusPlantConversion)
      .where(plantFilter
        ? and(eq(batchStatusPlantConversion.client, client), eq(batchStatusPlantConversion.plant, plantFilter))
        : eq(batchStatusPlantConversion.client, client))
      .orderBy(desc(batchStatusPlantConversion.startedAt))
      .limit(20);
    return rows.map((row) => ({
      conversionRunId: row.conversionRunId,
      plant: row.plant,
      priorActive: row.priorActive.trim() === 'X' ? 'X' : ' ',
      requestedActive: row.requestedActive.trim() === 'X' ? 'X' : ' ',
      status: 'BLOCKED',
      batchCount: row.batchCount,
      stockBatchCount: row.stockBatchCount,
      documentBatchCount: row.documentBatchCount,
      errorSummary: row.errorSummary,
      reason: row.reason,
      startedBy: row.startedBy,
      startedAt: row.startedAt,
    }));
  });
}

export async function validatePlantBatchStatus(input: {
  client: string;
  plant: string;
  statusActive: string;
}): Promise<PlantStatusContext & PlantStatusDependency & { plantName: string; current: 'X' | null; version: number }> {
  return withTenant(input.client, async (tx) => {
    const context = await readContext(tx, input.client);
    const plants = await tx.select({ name: plant.name }).from(plant).where(and(
      eq(plant.client, input.client),
      eq(plant.plant, input.plant.trim()),
    )).limit(1);
    if (!plants[0]) {
      throw new BatchStatusPlantError(
        `Plant ${input.plant.trim() || 'blank'} does not stand. Nothing was saved.`,
        'PLANT_UNKNOWN',
        'Choose a plant from the plant master. OMCU does not create one.',
      );
    }
    const rows = await tx.select().from(batchStatusPlant).where(and(
      eq(batchStatusPlant.client, input.client),
      eq(batchStatusPlant.plant, input.plant.trim()),
    )).limit(1);
    const counts = context.applicable
      ? await dependency(tx, input.client, input.plant.trim())
      : { batchCount: 0, stockBatchCount: 0, documentBatchCount: 0, conversionRequired: false };
    return {
      ...context,
      ...counts,
      plantName: plants[0].name,
      current: rows[0]?.statusActive?.trim() === 'X' ? 'X' : null,
      version: rows[0]?.version ?? 0,
    };
  });
}

export async function savePlantBatchStatus(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  plant: string;
  statusActive: string;
  version: number;
  confirmed?: boolean;
  reason?: string;
  requestKey?: string;
  transportRequest?: string;
  companyCode?: string;
  batchLevel?: string;
  plantName?: string;
  initialStatus?: string;
  movement?: string;
}): Promise<PlantBatchStatusRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const plantCode = input.plant.trim();
  const next = flagOf(input.statusActive);
  const requestKey = input.requestKey?.trim() || null;
  const saved = await withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_STATUS_PLANT/${plantCode}`}))`);
    const context = await readContext(tx, input.client);
    if (!context.batchLevel) {
      throw new BatchStatusPlantError(context.explanation, 'LEVEL_REQUIRED', 'Set the batch level in OMCE first.');
    }
    if (!context.applicable) {
      throw new BatchStatusPlantError(context.explanation + ' Nothing was saved.', 'LEVEL_INAPPLICABLE', 'Do not select a plant at this batch level. OMCS was not changed.');
    }
    const plants = await tx.select({ name: plant.name }).from(plant).where(and(
      eq(plant.client, input.client),
      eq(plant.plant, plantCode),
    )).limit(1);
    if (!plants[0]) {
      throw new BatchStatusPlantError(`Plant ${plantCode || 'blank'} does not stand. Nothing was saved.`, 'PLANT_UNKNOWN', 'Choose a plant from the plant master.');
    }
    const currentRows = await tx.select().from(batchStatusPlant).where(and(
      eq(batchStatusPlant.client, input.client),
      eq(batchStatusPlant.plant, plantCode),
    )).for('update');
    const current = currentRows[0] ?? null;
    const currentFlag = current?.statusActive?.trim() === 'X' ? 'X' : ' ';
    if (current && requestKey && current.lastRequestKey === requestKey) {
      if (currentFlag !== next) {
        throw new BatchStatusPlantError('This request key already saved a different selection. Nothing was saved.', 'REQUEST_REPLAY', 'Start a new save.');
      }
      return presentRow({
        plant: plantCode, name: plants[0].name, statusActive: current.statusActive,
        version: current.version, changedBy: current.changedBy, changedAt: current.changedAt,
      }, context);
    }
    const opened = current?.version ?? 0;
    if (opened !== input.version) {
      throw new BatchStatusPlantError(
        `Plant ${plantCode} was opened at version ${input.version}, and version ${opened} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the plant again.',
      );
    }
    if (currentFlag === next) {
      return presentRow({
        plant: plantCode,
        name: plants[0].name,
        statusActive: current?.statusActive ?? null,
        version: opened,
        changedBy: current?.changedBy ?? null,
        changedAt: current?.changedAt ?? null,
      }, context);
    }
    if (!input.confirmed) {
      throw new BatchStatusPlantError(
        'The change was not confirmed. Nothing was saved.',
        'CONFIRM_REQUIRED',
        'Confirm the save. OMCU does not convert batches or post movement 341 or 342.',
      );
    }
    const reason = reasonOf(input.reason);
    const counts = await dependency(tx, input.client, plantCode);
    if (counts.conversionRequired) {
      const conversionRunId = crypto.randomUUID();
      const summary = `${counts.batchCount} batch${counts.batchCount === 1 ? '' : 'es'}, ${counts.stockBatchCount} stock row${counts.stockBatchCount === 1 ? '' : 's'}, and ${counts.documentBatchCount} material-document line${counts.documentBatchCount === 1 ? '' : 's'} stand in plant ${plantCode}. The selection was not changed. Movements 341 and 342 were not posted. Stock was not rewritten.`;
      await tx.insert(batchStatusPlantConversion).values({
        client: input.client,
        conversionRunId,
        plant: plantCode,
        priorActive: currentFlag,
        requestedActive: next,
        status: 'BLOCKED',
        batchCount: counts.batchCount,
        stockBatchCount: counts.stockBatchCount,
        documentBatchCount: counts.documentBatchCount,
        errorSummary: summary,
        reason,
        startedBy: input.changedBy,
      });
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_status_plant',
        objectKey: plantCode,
        changeType: 'BLOCK',
        changedBy: input.changedBy,
        transactionCode: ACTIVITY,
        reason,
        correlationId: requestKey ?? undefined,
        before: { statusActive: currentFlag.trim() || ' ', version: opened },
        after: { statusActive: currentFlag.trim() || ' ', version: opened, conversionRunId, conversionStatus: 'BLOCKED', requested: next.trim() || ' ' },
      });
      return { blocked: summary };
    }
    const now = new Date();
    if (!current) {
      await tx.insert(batchStatusPlant).values({
        client: input.client,
        plant: plantCode,
        statusActive: next,
        version: 1,
        lastRequestKey: requestKey,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        createdAt: now,
        changedAt: now,
      });
    } else {
      const updated = await tx.update(batchStatusPlant).set({
        statusActive: next,
        version: current.version + 1,
        lastRequestKey: requestKey,
        changedBy: input.changedBy,
        changedAt: now,
      }).where(and(
        eq(batchStatusPlant.client, input.client),
        eq(batchStatusPlant.plant, plantCode),
        eq(batchStatusPlant.version, current.version),
      )).returning();
      if (updated.length !== 1) {
        throw new BatchStatusPlantError('The plant changed before this save. Nothing was saved.', 'VERSION_STALE', 'Open the plant again.');
      }
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_status_plant',
      objectKey: plantCode,
      changeType: current ? 'CHANGE' : 'CREATE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      correlationId: requestKey ?? undefined,
      before: current ? { statusActive: currentFlag.trim() || ' ', version: current.version } : undefined,
      after: { statusActive: next.trim() || ' ', version: current ? current.version + 1 : 1 },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return presentRow({
      plant: plantCode,
      name: plants[0].name,
      statusActive: next,
      version: current ? current.version + 1 : 1,
      changedBy: input.changedBy,
      changedAt: now,
    }, context);
  });
  if ('blocked' in saved) {
    throw new BatchStatusPlantError(saved.blocked, 'CONVERSION_BLOCKED', 'Leave the selection as it stands. MSC2N is not this screen, and movement 341 was not posted.');
  }
  return saved;
}

/** Conversion is not executed. The call does not post movement 341 or 342. */
export async function executePlantStatusConversion(): Promise<never> {
  throw new BatchStatusPlantError(
    'Live conversion is not available. The plant selection was not changed, and movements 341 and 342 were not posted.',
    'CONVERSION_BLOCKED',
    'Do not transfer stock from this screen. Restricted use stays on the batch.',
  );
}

