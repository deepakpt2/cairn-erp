/**
 * OMAB — initial status of a new batch. The attribute is T134-IZUST.
 *
 * It is stored on the material type. Checked is restricted use for a batch
 * created later. Blank is unrestricted. The application stores that as a
 * boolean: true is X, false is blank. It is not an arbitrary string, and it
 * is not T136M or T138.
 *
 * The key is the material type, not a plant. OMCS and OMCU are not changed.
 * An existing batch is not rewritten. Stock is not posted.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { batchLevelConfiguration, batchStatusManagement, batchStatusPlant, materialType } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHINITIAL.DEFINE';
export const ROUTE = '/config/batch-initial-status';
export const ALIAS = 'OMAB';
export const LOCK_OBJECT = 'BATCH_INITIAL_STATUS';

export class InitialBatchStatusError extends Error {
  readonly code:
    | 'AUTHORITY_REQUIRED'
    | 'TYPE_UNKNOWN'
    | 'STATUS_UNKNOWN'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'CONFIRM_REQUIRED'
    | 'TRANSPORT_REFUSED'
    | 'PLANT_REFUSED'
    | 'LEVEL_REFUSED'
    | 'MOVEMENT_REFUSED'
    | 'TYPE_MISSING';

  constructor(message: string, code: InitialBatchStatusError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'InitialBatchStatusError';
    this.code = code;
  }
}

export interface InitialStatusContext {
  batchLevel: '0' | '1' | '2' | null;
  clientStatusActive: boolean;
  /** Plants OMCU has selected. Display only. Not part of the material-type key. */
  selectedPlants: string[];
  explanation: string;
}

export interface InitialStatusRow {
  materialType: string;
  name: string;
  initialStatus: 'X' | null;
  active: boolean;
  changedBy: string | null;
  changedAt: Date | null;
}

export interface InitialStatusDecision {
  restrictedUse: 'X' | ' ' | null;
  effective: boolean;
  explanation: string;
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new InitialBatchStatusError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMAB does not use a second permission code.',
    );
  }
}

function flagOf(value: string): 'X' | ' ' {
  const text = value.trim().toUpperCase();
  if (text === 'X') return 'X';
  if (text === '') return ' ';
  throw new InitialBatchStatusError(
    `Initial status ${text} is not the indicator. Use X, or leave it blank.`,
    'STATUS_UNKNOWN',
    'Checked is X, restricted for a new batch. Blank is unrestricted. It is not 1 or 2.',
  );
}

function refuseExtras(input: { transportRequest?: string; plant?: string; batchLevel?: string; movement?: string }): void {
  if (input.transportRequest?.trim()) {
    throw new InitialBatchStatusError('A transport is refused. OMAB does not write a transport request.', 'TRANSPORT_REFUSED', 'Save the material type in this client.');
  }
  if (input.plant?.trim()) {
    throw new InitialBatchStatusError('A plant is refused. The initial status is the material type, not a plant.', 'PLANT_REFUSED', 'Do not send a plant. OMCU is not this screen.');
  }
  if (input.batchLevel?.trim()) {
    throw new InitialBatchStatusError('A batch level is refused. OMCE owns the level. OMAB does not store one.', 'LEVEL_REFUSED', 'Leave the batch level empty.');
  }
  if (input.movement?.trim()) {
    throw new InitialBatchStatusError(
      `Movement ${input.movement.trim()} is refused. OMAB does not post stock.`,
      'MOVEMENT_REFUSED',
      'Do not send movement 341 or 342. Restricted use is not blocked stock.',
    );
  }
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new InitialBatchStatusError('A reason is required.', 'REASON_REQUIRED', 'Say why this initial status is being saved.');
  }
  return text;
}

async function readContext(tx: Tx, client: string): Promise<InitialStatusContext> {
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
  const selected = await tx.select({ plant: batchStatusPlant.plant }).from(batchStatusPlant)
    .where(and(eq(batchStatusPlant.client, client), eq(batchStatusPlant.statusActive, 'X')))
    .orderBy(asc(batchStatusPlant.plant));
  const selectedPlants = selected.map((row) => row.plant);
  if (!batchLevel) {
    return {
      batchLevel: null,
      clientStatusActive,
      selectedPlants,
      explanation: 'No batch level stands. The initial status is stored and is not applied to a new batch.',
    };
  }
  if (!clientStatusActive) {
    return {
      batchLevel,
      clientStatusActive,
      selectedPlants,
      explanation: 'Status management is not active. The initial status is stored and is not applied to a new batch. This indicator was not changed.',
    };
  }
  if (batchLevel === '0') {
    return {
      batchLevel,
      clientStatusActive,
      selectedPlants,
      explanation: selectedPlants.length
        ? `Status management applies only in the selected plants. It is not the initial-status flag.`
        : 'Status management applies only in a selected plant. No plant is selected. This is not the initial-status flag.',
    };
  }
  return {
    batchLevel,
    clientStatusActive,
    selectedPlants,
    explanation: `Status management applies in every plant at this batch level. A plant selection is not used. This is not the initial-status flag.`,
  };
}

/**
 * The status a genuinely new batch receives. Null means status management
 * does not apply, so no indicator is stored. An existing batch is not read.
 */
export async function decideInitialRestrictedUse(tx: Tx, input: {
  client: string;
  materialType: string;
  batchLevel: '0' | '1' | '2';
  plant: string | null;
}): Promise<InitialStatusDecision> {
  const status = await tx.select({ code: batchStatusManagement.statusManagement })
    .from(batchStatusManagement)
    .where(eq(batchStatusManagement.client, input.client))
    .limit(1);
  const active = status[0]?.code?.trim() === '1';
  let plantSelected = false;
  if (input.batchLevel === '0' && input.plant) {
    const rows = await tx.select({ statusActive: batchStatusPlant.statusActive }).from(batchStatusPlant).where(and(
      eq(batchStatusPlant.client, input.client),
      eq(batchStatusPlant.plant, input.plant),
    )).limit(1);
    plantSelected = rows[0]?.statusActive?.trim() === 'X';
  }
  const effective = active && (input.batchLevel !== '0' || plantSelected);
  if (!effective) {
    return {
      restrictedUse: null,
      effective: false,
      explanation: !active
        ? 'OMCS is not active. No restricted-use indicator is stored.'
        : 'The batch level is plant, and OMCU has not selected this plant. No restricted-use indicator is stored.',
    };
  }
  const [type] = await tx.select({ initial: materialType.initialBatchRestricted }).from(materialType).where(and(
    eq(materialType.client, input.client),
    eq(materialType.materialType, input.materialType),
  )).limit(1);
  if (!type) {
    throw new InitialBatchStatusError(
      `Material type ${input.materialType} does not stand. No batch status was decided.`,
      'TYPE_MISSING',
      'Use a material type from the material-type master.',
    );
  }
  return {
    restrictedUse: type.initial ? 'X' : ' ',
    effective: true,
    explanation: type.initial
      ? 'The material type initial status is X. A new batch is restricted.'
      : 'The material type initial status is blank. A new batch is unrestricted.',
  };
}

export async function listInitialBatchStatus(client: string): Promise<{
  context: InitialStatusContext;
  types: InitialStatusRow[];
}> {
  return withTenant(client, async (tx) => {
    const context = await readContext(tx, client);
    const rows = await tx.select({
      materialType: materialType.materialType,
      name: materialType.name,
      initial: materialType.initialBatchRestricted,
      active: materialType.isActive,
      changedBy: materialType.changedBy,
      changedAt: materialType.changedAt,
    }).from(materialType)
      .where(eq(materialType.client, client))
      .orderBy(asc(materialType.materialType));
    return {
      context,
      types: rows.map((row) => ({
        materialType: row.materialType,
        name: row.name,
        initialStatus: row.initial ? 'X' : null,
        active: row.active,
        changedBy: row.changedBy,
        changedAt: row.changedAt,
      })),
    };
  });
}

export async function saveInitialBatchStatus(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  materialType: string;
  initialStatus: string;
  expectedStatus: string;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  plant?: string;
  batchLevel?: string;
  movement?: string;
}): Promise<InitialStatusRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const key = input.materialType.trim();
  const next = flagOf(input.initialStatus);
  const expected = flagOf(input.expectedStatus);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_INITIAL_STATUS/${key}`}))`);
    const [existing] = await tx.select().from(materialType).where(and(
      eq(materialType.client, input.client),
      eq(materialType.materialType, key),
    )).for('update');
    if (!existing) {
      throw new InitialBatchStatusError(
        `Material type ${key || 'blank'} does not stand. Nothing was saved.`,
        'TYPE_UNKNOWN',
        'Choose a material type from the list. OMAB does not create one.',
      );
    }
    const current = existing.initialBatchRestricted ? 'X' : ' ';
    if (current !== expected) {
      throw new InitialBatchStatusError(
        `Material type ${key} was opened as ${expected.trim() || 'blank'}, and ${current.trim() || 'blank'} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the material type again.',
      );
    }
    if (current === next) {
      return {
        materialType: key,
        name: existing.name,
        initialStatus: current === 'X' ? 'X' : null,
        active: existing.isActive,
        changedBy: existing.changedBy,
        changedAt: existing.changedAt,
      };
    }
    if (!input.confirmed) {
      throw new InitialBatchStatusError(
        'The change was not confirmed. Nothing was saved.',
        'CONFIRM_REQUIRED',
        'Confirm the save. Existing batches are not rewritten, and no stock is posted.',
      );
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    await tx.update(materialType).set({
      initialBatchRestricted: next === 'X',
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(eq(materialType.client, input.client), eq(materialType.materialType, key)));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'material_type',
      objectKey: key,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { initialBatchRestricted: current },
      after: { initialBatchRestricted: next },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return {
      materialType: key,
      name: existing.name,
      initialStatus: next === 'X' ? 'X' : null,
      active: existing.isActive,
      changedBy: input.changedBy,
      changedAt: now,
    };
  });
}
