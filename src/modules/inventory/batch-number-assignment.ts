/**
 * Activate internal batch number assignment. OMCZ is a search alias only.
 *
 * Baseline: SAP S/4HANA on-premise batch number assignment. The client flag
 * is TCUBN-AUTBN, historically TCUCH-AUTBN, data element AUTBN_CUS, domain
 * CHAR1. The screen is a radio. X means active. Blank means not active.
 * A missing row is not active. The flag is not a plant and not a material type.
 *
 * The plant flag is T159L-XCAUT, view V_159L_ICHNRKWE, domain XFELD. X permits
 * an internal number for an account-assigned goods receipt in that plant.
 * It does not create a batch for a stock receipt, a transfer, a return, or
 * a production order.
 *
 * The internal interval is BATCH_CLT / 01 on the existing number-range engine.
 * This screen does not create that interval. OMAD is not this screen.
 * OPKP, and the goods-movement batch-creation activity, are not this screen.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { allocateNumber, NumberRangeError } from '../../platform/numbering';
import { numberRange } from '../../platform/tables/numbering';
import { markActivityComplete } from '../../platform/tenancy';
import { plant } from '../foundation/schema';
import { batchAssignedReceipt, batchNumberAssignment } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHNUMBER.DEFINE';
export const ROUTE = '/config/batch-number-assignment';
export const ALIASES = ['OMCZ'] as const;
export const LOCK_OBJECT = 'BATCH_NUMBER_ASSIGNMENT';
export const PLANT_LOCK_OBJECT = 'BATCH_ASSIGNED_RECEIPT';
export const BATCH_NUMBER_OBJECT = 'BATCH_CLT';
export const BATCH_NUMBER_INTERVAL = '01';

export class BatchNumberAssignmentError extends Error {
  readonly code:
    | 'CODE_UNKNOWN'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'PLANT_REQUIRED'
    | 'PLANT_UNKNOWN'
    | 'TRANSPORT_REFUSED'
    | 'APPROVAL_REFUSED'
    | 'PERIOD_REFUSED'
    | 'COMPANY_REFUSED'
    | 'LEVEL_REFUSED'
    | 'MATERIAL_TYPE_REFUSED'
    | 'CLASSIFICATION_REFUSED'
    | 'MOVEMENT_REFUSED'
    | 'RANGE_REFUSED'
    | 'REQUEST_REPLAY'
    | 'NUMBERING_INACTIVE'
    | 'RANGE_UNAVAILABLE'
    | 'NUMBER_TOO_LONG';

  constructor(
    message: string,
    code: BatchNumberAssignmentError['code'],
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'BatchNumberAssignmentError';
    this.code = code;
  }
}

export type AssignmentCode = 'X' | null;

export interface RangeReadiness {
  defined: boolean;
  status: string | null;
  external: boolean;
  exhausted: boolean;
}

export interface InternalAssignmentRow {
  code: AssignmentCode;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
  range: RangeReadiness;
}

export interface AssignedReceiptRow {
  plant: string;
  name: string;
  code: AssignmentCode;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}

export interface SaveInternalAssignmentInput {
  client: string;
  changedBy: string;
  /** 'X' active, or blank for not active. */
  internalAssignment: string;
  version: number;
  reason?: string;
  requestKey?: string;
  transportRequest?: string;
  approval?: string;
  postingPeriod?: string;
  companyCode?: string;
  batchLevel?: string;
  plant?: string;
  materialType?: string;
  classification?: boolean;
  movementCreation?: boolean;
  batchNumberRange?: string;
}

export interface SaveAssignedReceiptInput {
  client: string;
  changedBy: string;
  plant: string;
  /** 'X' permitted, or blank for not permitted. */
  assignedReceipt: string;
  version: number;
  reason?: string;
  requestKey?: string;
  transportRequest?: string;
  companyCode?: string;
  materialType?: string;
  movementCreation?: boolean;
  batchNumberRange?: string;
}

export interface AssignedGoodsReceiptDecision {
  assign: boolean;
  reason: string;
}

export interface ProductionBatchAssignment {
  timing: 'NONE' | 'ORDER_CREATE' | 'ORDER_RELEASE';
  internalActive: boolean;
  reason: string;
}

function codeOf(value: string, label: string): AssignmentCode {
  const text = value.trim().toUpperCase();
  if (text === 'X') return 'X';
  if (text === '') return null;
  throw new BatchNumberAssignmentError(
    `${label} ${text} is not the indicator. Use X, or leave it blank.`,
    'CODE_UNKNOWN',
    'The stored code is the character X or blank. It is not 1, and it is not a label.',
  );
}

function stored(code: AssignmentCode): 'X' | ' ' {
  return code === 'X' ? 'X' : ' ';
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3) {
    throw new BatchNumberAssignmentError('A reason is required.', 'REASON_REQUIRED', 'Say why the setting is being saved.');
  }
  if (text.length > 500) {
    throw new BatchNumberAssignmentError('The reason is longer than 500 characters.', 'REASON_REQUIRED', 'Shorten the reason.');
  }
  return text;
}

function refuseShared(input: {
  transportRequest?: string;
  companyCode?: string;
  materialType?: string;
  movementCreation?: boolean;
  batchNumberRange?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchNumberAssignmentError(
      'A transport is refused. OMCZ does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Save the setting in this client. Do not send a transport.',
    );
  }
  if (input.companyCode?.trim()) {
    throw new BatchNumberAssignmentError(
      'A company code is refused. The setting is not a company setting.',
      'COMPANY_REFUSED',
      'Do not send a company code.',
    );
  }
  if (input.materialType?.trim()) {
    throw new BatchNumberAssignmentError(
      'A material type is refused. OMCZ does not store a material-type scope.',
      'MATERIAL_TYPE_REFUSED',
      'Do not send a material type.',
    );
  }
  if (input.movementCreation) {
    throw new BatchNumberAssignmentError(
      'Goods-movement batch creation is refused. That activity is not this screen.',
      'MOVEMENT_REFUSED',
      'Do not turn on batch creation for a goods movement here.',
    );
  }
  if (input.batchNumberRange?.trim()) {
    throw new BatchNumberAssignmentError(
      'A batch number range is refused. OMAD is not this screen, and activating OMCZ does not create interval 01.',
      'RANGE_REFUSED',
      'Maintain BATCH_CLT interval 01 in OMAD. This screen does not create it.',
    );
  }
}

async function lockClient(tx: Tx, client: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext('BATCH_NUMBER_ASSIGNMENT'))`);
}

async function lockPlant(tx: Tx, client: string, plantCode: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext(${`BATCH_ASSIGNED_RECEIPT/${plantCode}`}))`);
}

async function readAssignment(tx: Tx, client: string) {
  const rows = await tx.select().from(batchNumberAssignment).where(eq(batchNumberAssignment.client, client)).limit(1);
  return rows[0] ?? null;
}

async function readRange(tx: Tx, client: string): Promise<RangeReadiness> {
  const rows = await tx.select().from(numberRange).where(and(
    eq(numberRange.client, client),
    eq(numberRange.objectCode, BATCH_NUMBER_OBJECT),
    eq(numberRange.companyCode, '*'),
    eq(numberRange.subObject, BATCH_NUMBER_INTERVAL),
    eq(numberRange.fiscalYear, 0),
  )).limit(1);
  const range = rows[0];
  if (!range) return { defined: false, status: null, external: false, exhausted: false };
  return {
    defined: true,
    status: range.status,
    external: range.isExternal,
    exhausted: range.currentNumber >= range.toNumber,
  };
}

function presentAssignment(row: {
  internalAssignment: string;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
} | null, range: RangeReadiness): InternalAssignmentRow {
  const code = row ? codeOf(row.internalAssignment, 'Internal batch number assignment') : null;
  return {
    code,
    version: row?.version ?? 0,
    changedBy: row?.changedBy ?? null,
    changedAt: row?.changedAt ?? null,
    range,
  };
}

export async function internalAssignmentActive(tx: Tx, client: string): Promise<boolean> {
  const row = await readAssignment(tx, client);
  return row?.internalAssignment === 'X';
}

export async function getInternalBatchAssignment(client: string): Promise<InternalAssignmentRow> {
  return withTenant(client, async (tx) => presentAssignment(await readAssignment(tx, client), await readRange(tx, client)));
}

export async function saveInternalBatchAssignment(input: SaveInternalAssignmentInput): Promise<InternalAssignmentRow> {
  refuseShared(input);
  if (input.approval?.trim()) {
    throw new BatchNumberAssignmentError(
      'An approval is refused. OMCZ does not route a workflow.',
      'APPROVAL_REFUSED',
      'Save the setting. Do not send an approval.',
    );
  }
  if (input.postingPeriod?.trim()) {
    throw new BatchNumberAssignmentError(
      'A posting period is refused. A closed period does not block this screen.',
      'PERIOD_REFUSED',
      'Leave the posting period empty.',
    );
  }
  if (input.batchLevel?.trim()) {
    throw new BatchNumberAssignmentError(
      'A batch level is refused. OMCE owns the level. OMCZ does not store one.',
      'LEVEL_REFUSED',
      'Leave the batch level empty.',
    );
  }
  if (input.plant?.trim()) {
    throw new BatchNumberAssignmentError(
      'A plant is refused on the client setting. The plant flag is the other view.',
      'PLANT_UNKNOWN',
      'Do not send a plant with the client flag.',
    );
  }
  if (input.classification) {
    throw new BatchNumberAssignmentError(
      'Classification is refused. Saving the flag does not classify a batch.',
      'CLASSIFICATION_REFUSED',
      'Leave classification off.',
    );
  }
  const next = codeOf(input.internalAssignment, 'Internal batch number assignment');
  const requestKey = input.requestKey?.trim() || null;
  return withTenant(input.client, async (tx) => {
    await lockClient(tx, input.client);
    const current = await readAssignment(tx, input.client);
    const range = await readRange(tx, input.client);
    const currentCode = current ? codeOf(current.internalAssignment, 'Internal batch number assignment') : null;
    if (current && requestKey && current.lastRequestKey === requestKey) {
      if (currentCode !== next) {
        throw new BatchNumberAssignmentError(
          'This request key already saved a different setting. The setting was not changed.',
          'REQUEST_REPLAY',
          'Start a new save.',
        );
      }
      return presentAssignment(current, range);
    }
    if (!current) {
      if (input.version !== 0) {
        throw new BatchNumberAssignmentError(
          'The setting was not opened at this version. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again. The first save sends version 0.',
        );
      }
    } else if (current.version !== input.version) {
      throw new BatchNumberAssignmentError(
        `The setting was opened at version ${input.version}, and version ${current.version} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the screen again and send the version it shows.',
      );
    }
    if (current && currentCode === next) return presentAssignment(current, range);
    const reason = reasonOf(input.reason);
    const now = new Date();
    const after = stored(next);
    if (!current) {
      await tx.insert(batchNumberAssignment).values({
        client: input.client,
        internalAssignment: after,
        version: 1,
        lastRequestKey: requestKey,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        createdAt: now,
        changedAt: now,
      });
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_number_assignment',
        objectKey: input.client,
        changeType: 'CREATE',
        changedBy: input.changedBy,
        transactionCode: 'OMCZ',
        reason,
        correlationId: requestKey ?? undefined,
        after: { internalAssignment: next ?? ' ', version: 1 },
      });
    } else {
      const saved = await tx.update(batchNumberAssignment).set({
        internalAssignment: after,
        version: current.version + 1,
        lastRequestKey: requestKey,
        changedBy: input.changedBy,
        changedAt: now,
      }).where(and(
        eq(batchNumberAssignment.client, input.client),
        eq(batchNumberAssignment.version, current.version),
      )).returning();
      if (saved.length !== 1) {
        throw new BatchNumberAssignmentError(
          'The setting changed before this save. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again.',
        );
      }
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_number_assignment',
        objectKey: input.client,
        changeType: 'CHANGE',
        changedBy: input.changedBy,
        transactionCode: 'OMCZ',
        reason,
        correlationId: requestKey ?? undefined,
        before: { internalAssignment: current.internalAssignment, version: current.version },
        after: { internalAssignment: next ?? ' ', version: current.version + 1 },
      });
    }
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return presentAssignment(await readAssignment(tx, input.client), await readRange(tx, input.client));
  });
}

export async function listAssignedReceiptSettings(client: string): Promise<AssignedReceiptRow[]> {
  return withTenant(client, async (tx) => {
    const plants = await tx.select({ plant: plant.plant, name: plant.name })
      .from(plant)
      .where(eq(plant.client, client))
      .orderBy(plant.plant);
    const settings = await tx.select().from(batchAssignedReceipt).where(eq(batchAssignedReceipt.client, client));
    const byPlant = new Map(settings.map((row) => [row.plant, row]));
    return plants.map((row) => {
      const setting = byPlant.get(row.plant);
      return {
        plant: row.plant,
        name: row.name,
        code: setting ? codeOf(setting.assignedReceipt, 'Assigned goods receipt') : null,
        version: setting?.version ?? 0,
        changedBy: setting?.changedBy ?? null,
        changedAt: setting?.changedAt ?? null,
      };
    });
  });
}

export async function saveAssignedReceipt(input: SaveAssignedReceiptInput): Promise<AssignedReceiptRow> {
  refuseShared(input);
  const plantCode = input.plant.trim();
  if (!plantCode) {
    throw new BatchNumberAssignmentError('A plant is required.', 'PLANT_REQUIRED', 'Choose a plant in this client.');
  }
  const next = codeOf(input.assignedReceipt, 'Assigned goods receipt');
  const requestKey = input.requestKey?.trim() || null;
  return withTenant(input.client, async (tx) => {
    await lockPlant(tx, input.client, plantCode);
    const plants = await tx.select({ plant: plant.plant, name: plant.name })
      .from(plant)
      .where(and(eq(plant.client, input.client), eq(plant.plant, plantCode)))
      .limit(1);
    if (!plants[0]) {
      throw new BatchNumberAssignmentError(
        `Plant ${plantCode} does not stand in this client. Nothing was saved.`,
        'PLANT_UNKNOWN',
        'Choose a plant in this client. A plant from another client is not accepted.',
      );
    }
    const currentRows = await tx.select().from(batchAssignedReceipt).where(and(
      eq(batchAssignedReceipt.client, input.client),
      eq(batchAssignedReceipt.plant, plantCode),
    )).limit(1);
    const current = currentRows[0] ?? null;
    const currentCode = current ? codeOf(current.assignedReceipt, 'Assigned goods receipt') : null;
    if (current && requestKey && current.lastRequestKey === requestKey) {
      if (currentCode !== next) {
        throw new BatchNumberAssignmentError(
          'This request key already saved a different plant setting. The setting was not changed.',
          'REQUEST_REPLAY',
          'Start a new save.',
        );
      }
      return {
        plant: plantCode,
        name: plants[0].name,
        code: currentCode,
        version: current.version,
        changedBy: current.changedBy,
        changedAt: current.changedAt,
      };
    }
    if (!current) {
      if (input.version !== 0) {
        throw new BatchNumberAssignmentError(
          'The plant setting was not opened at this version. Nothing was saved.',
          'VERSION_STALE',
          'Open the plant again. The first save sends version 0.',
        );
      }
    } else if (current.version !== input.version) {
      throw new BatchNumberAssignmentError(
        `The plant setting was opened at version ${input.version}, and version ${current.version} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the plant again and send the version it shows.',
      );
    }
    if (current && currentCode === next) {
      return {
        plant: plantCode,
        name: plants[0].name,
        code: currentCode,
        version: current.version,
        changedBy: current.changedBy,
        changedAt: current.changedAt,
      };
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const after = stored(next);
    if (!current) {
      await tx.insert(batchAssignedReceipt).values({
        client: input.client,
        plant: plantCode,
        assignedReceipt: after,
        version: 1,
        lastRequestKey: requestKey,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        createdAt: now,
        changedAt: now,
      });
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_assigned_receipt',
        objectKey: plantCode,
        changeType: 'CREATE',
        changedBy: input.changedBy,
        transactionCode: 'OMCZ',
        reason,
        correlationId: requestKey ?? undefined,
        after: { plant: plantCode, assignedReceipt: next ?? ' ', version: 1 },
      });
    } else {
      const saved = await tx.update(batchAssignedReceipt).set({
        assignedReceipt: after,
        version: current.version + 1,
        lastRequestKey: requestKey,
        changedBy: input.changedBy,
        changedAt: now,
      }).where(and(
        eq(batchAssignedReceipt.client, input.client),
        eq(batchAssignedReceipt.plant, plantCode),
        eq(batchAssignedReceipt.version, current.version),
      )).returning();
      if (saved.length !== 1) {
        throw new BatchNumberAssignmentError(
          'The plant setting changed before this save. Nothing was saved.',
          'VERSION_STALE',
          'Open the plant again.',
        );
      }
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_assigned_receipt',
        objectKey: plantCode,
        changeType: 'CHANGE',
        changedBy: input.changedBy,
        transactionCode: 'OMCZ',
        reason,
        correlationId: requestKey ?? undefined,
        before: { assignedReceipt: current.assignedReceipt, version: current.version },
        after: { assignedReceipt: next ?? ' ', version: current.version + 1 },
      });
    }
    const saved = await tx.select().from(batchAssignedReceipt).where(and(
      eq(batchAssignedReceipt.client, input.client),
      eq(batchAssignedReceipt.plant, plantCode),
    )).limit(1);
    return {
      plant: plantCode,
      name: plants[0].name,
      code: next,
      version: saved[0]?.version ?? 1,
      changedBy: saved[0]?.changedBy ?? input.changedBy,
      changedAt: saved[0]?.changedAt ?? now,
    };
  });
}

/**
 * Account-assigned goods receipt only. A stock receipt is never assigned here.
 * The caller still does not post an account-assigned receipt.
 */
export function assignedGoodsReceiptDecision(input: {
  internalActive: boolean;
  plantPermitted: boolean;
  accountAssigned: boolean;
}): AssignedGoodsReceiptDecision {
  if (!input.accountAssigned) {
    return {
      assign: false,
      reason: 'A stock goods receipt is not an account-assigned receipt. OMCZ does not create a batch for it.',
    };
  }
  if (!input.internalActive) {
    return {
      assign: false,
      reason: 'Internal batch number assignment is not active. An account-assigned receipt does not receive a number.',
    };
  }
  if (!input.plantPermitted) {
    return {
      assign: false,
      reason: 'This plant does not permit an internal batch number for an account-assigned goods receipt.',
    };
  }
  return {
    assign: true,
    reason: 'The plant permits a number for an account-assigned goods receipt. That receipt is not posted on this screen.',
  };
}

export function assignedReceiptRefusal(decision: AssignedGoodsReceiptDecision): string {
  // The decision is evaluated so the plant flag is read. Neither result posts the receipt.
  void decision.assign;
  return 'Account-assigned items are received without stock; that movement is a later round.';
}

export async function readAssignedGoodsReceiptDecision(
  tx: Tx,
  client: string,
  plantCode: string,
  accountAssigned: boolean,
): Promise<AssignedGoodsReceiptDecision> {
  const active = await internalAssignmentActive(tx, client);
  const rows = await tx.select({ code: batchAssignedReceipt.assignedReceipt })
    .from(batchAssignedReceipt)
    .where(and(eq(batchAssignedReceipt.client, client), eq(batchAssignedReceipt.plant, plantCode)))
    .limit(1);
  return assignedGoodsReceiptDecision({
    internalActive: active,
    plantPermitted: rows[0]?.code === 'X',
    accountAssigned,
  });
}

/**
 * OMCZ does not create a batch on an order. This function reads no profile.
 * The order reads the profile snapshotted by OPKP.
 */
export async function productionBatchAssignment(tx: Tx, client: string): Promise<ProductionBatchAssignment> {
  const internalActive = await internalAssignmentActive(tx, client);
  return {
    timing: 'NONE',
    internalActive,
    reason: 'No scheduling profile is read here. OMCZ does not create an order batch. OPKP decides that on the order.',
  };
}

export async function allocateInternalBatchNumber(tx: Tx, client: string, allocatedBy: string): Promise<string> {
  if (!(await internalAssignmentActive(tx, client))) {
    throw new BatchNumberAssignmentError(
      'Automatic batch number allocation is inactive or not allowed. OMCZ is not active. No batch was created.',
      'NUMBERING_INACTIVE',
      'Activate internal batch number assignment in OMCZ, or type the batch number.',
    );
  }
  try {
    const drawn = await allocateNumber(tx, {
      client,
      objectCode: BATCH_NUMBER_OBJECT,
      companyCode: '*',
      subObject: BATCH_NUMBER_INTERVAL,
      fiscalYear: 0,
      allocatedBy,
      transactionCode: 'MSC1N',
    });
    if (drawn.display.length > 10) {
      throw new BatchNumberAssignmentError(
        `Internal batch number ${drawn.display} is longer than 10 characters. No batch was created.`,
        'NUMBER_TOO_LONG',
        'Maintain BATCH_CLT interval 01 as a 10-character number in OMAD. This screen is not OMAD.',
      );
    }
    return drawn.display;
  } catch (error) {
    if (error instanceof BatchNumberAssignmentError) throw error;
    if (error instanceof NumberRangeError) {
      throw new BatchNumberAssignmentError(
        `${error.message} No batch was created.`,
        'RANGE_UNAVAILABLE',
        'Maintain internal interval 01 for BATCH_CLT in OMAD. Activating OMCZ does not create the interval. This screen is not OMAD.',
      );
    }
    throw error;
  }
}
