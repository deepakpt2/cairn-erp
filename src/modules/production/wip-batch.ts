/**
 * Activate WIP batch. OMCWB is a search alias only.
 *
 * Verified field: TCUWIPB-WIPBATCH_ACTIVE, data element WIPBATCH_ACTIVE,
 * domain XFELD, length 1. X is active. Blank is not active. A missing row
 * is not active. The table key is the client, not a plant.
 *
 * Message COWIPB 261: once active, the function cannot be revoked.
 * This screen does not create a WIP batch. A confirmation, a goods movement,
 * and batch genealogy are not this screen.
 *
 * Program SAPMWIP_BATCH is the published program. A dynpro dump for screen
 * 0100 was not fetched, so no further screen field is stored.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { batchLevelConfiguration } from '../inventory/schema';
import { wipBatchActivation } from './schema';

export const ACTIVITY = 'CFG.PROD.WIPBATCH.DEFINE';
export const ROUTE = '/config/wip-batch';
export const ALIAS = 'OMCWB';
export const LOCK_OBJECT = 'WIP_BATCH';
const OBJECT_CLASS = 'wip_batch_activation';

export const NOT_EXECUTED = [
  {
    field: 'LOG_PP_WIP_BATCH',
    title: 'Business function',
    reason: 'There is no switch framework. This indicator does not activate LOG_PP_WIP_BATCH or LOG_PP_WIP_BATCH_02.',
  },
  {
    field: 'OMT0',
    title: 'Original batch reference material',
    reason: 'That setting is not this screen and is not stored here.',
  },
  {
    field: 'OPK0',
    title: 'Confirmation profile',
    reason: 'A confirmation profile is not created. No WIP batch is posted at confirmation.',
  },
  {
    field: 'WIP_BATCH',
    title: 'WIP batch record',
    reason: 'Activation does not create a batch, an order, or a material document.',
  },
] as const;

export class WipBatchError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(message: string, code: string, remedy: string) {
    super(message);
    this.name = 'WipBatchError';
    this.code = code;
    this.remedy = remedy;
  }
}

export type WipBatchCode = 'X' | null;

export interface WipBatchRow {
  code: WipBatchCode;
  version: number;
  batchLevel: '0' | '1' | '2' | null;
  changedBy: string | null;
  changedAt: Date | null;
  irreversible: boolean;
}

export interface SaveWipBatchInput {
  client: string;
  changedBy: string;
  wipBatchActive: string;
  version: number;
  reason: string;
  confirmed?: boolean;
  requestKey?: string;
  transportRequest?: string;
  postingPeriod?: string;
  companyCode?: string;
  plant?: string;
  orderNumber?: string;
}

function codeOf(raw: string): WipBatchCode {
  const text = raw.trim().toUpperCase();
  if (text === '' || text === 'BLANK') return null;
  if (text === 'X') return 'X';
  throw new WipBatchError(
    `WIP batch ${text} is refused. Active is X. Not active is blank.`,
    'CODE_UNKNOWN',
    'Do not store 1. The domain is XFELD.',
  );
}

function reasonOf(value: string): string {
  const text = value?.trim() ?? '';
  if (text.length < 3 || text.length > 500) {
    throw new WipBatchError('A reason is required.', 'REASON_REQUIRED', 'Say why the indicator is being saved.');
  }
  return text;
}

function refuseExtras(input: SaveWipBatchInput): void {
  if (input.transportRequest?.trim()) {
    throw new WipBatchError('A transport is refused. OMCWB does not write a transport request.', 'TRANSPORT_REFUSED', 'Save this client only.');
  }
  if (input.postingPeriod?.trim()) {
    throw new WipBatchError('A posting period is refused. A closed period does not block this screen.', 'PERIOD_REFUSED', 'Leave the period empty.');
  }
  if (input.companyCode?.trim()) {
    throw new WipBatchError('A company code is refused. The indicator is for this client.', 'COMPANY_REFUSED', 'Do not send a company code.');
  }
  if (input.plant?.trim()) {
    throw new WipBatchError('A plant is refused. WIP batch activation is not a plant setting.', 'PLANT_REFUSED', 'Leave the plant empty.');
  }
  if (input.orderNumber?.trim()) {
    throw new WipBatchError(
      'A production order is refused. OMCWB does not create a WIP batch for an order.',
      'ORDER_REFUSED',
      'Save the indicator only.',
    );
  }
}

function present(row: {
  wipBatchActive: string;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
} | null, batchLevel: '0' | '1' | '2' | null): WipBatchRow {
  const code: WipBatchCode = row?.wipBatchActive === 'X' ? 'X' : null;
  return {
    code,
    version: row?.version ?? 0,
    batchLevel,
    changedBy: row?.changedBy ?? null,
    changedAt: row?.changedAt ?? null,
    irreversible: code === 'X',
  };
}

async function lockRow(tx: Tx, client: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext('WIP_BATCH'))`);
}

async function readRow(tx: Tx, client: string) {
  const rows = await tx.select().from(wipBatchActivation)
    .where(eq(wipBatchActivation.client, client))
    .limit(1);
  return rows[0] ?? null;
}

async function readLevel(tx: Tx, client: string): Promise<'0' | '1' | '2' | null> {
  const rows = await tx.select({ batchLevel: batchLevelConfiguration.batchLevel })
    .from(batchLevelConfiguration)
    .where(eq(batchLevelConfiguration.client, client))
    .limit(1);
  const code = rows[0]?.batchLevel?.trim();
  if (code === '0' || code === '1' || code === '2') return code;
  return null;
}

export async function wipBatchActive(client: string): Promise<boolean> {
  const current = await getWipBatchActivation(client);
  return current.code === 'X';
}

export async function getWipBatchActivation(client: string): Promise<WipBatchRow> {
  const key = client?.trim() ?? '';
  if (!key) throw new WipBatchError('The tenant is missing.', 'CLIENT_REQUIRED', 'Sign in again.');
  return withTenant(key, async (tx) => present(await readRow(tx, key), await readLevel(tx, key)));
}

export async function saveWipBatchActivation(input: SaveWipBatchInput): Promise<WipBatchRow> {
  refuseExtras(input);
  const client = input.client?.trim() ?? '';
  const changedBy = input.changedBy?.trim() ?? '';
  if (!client || !changedBy) {
    throw new WipBatchError('The tenant or the acting user is missing.', 'CLIENT_REQUIRED', 'Sign in again.');
  }
  const next = codeOf(input.wipBatchActive);
  const requestKey = input.requestKey?.trim() || null;
  const reason = reasonOf(input.reason);
  return withTenant(client, async (tx) => {
    await lockRow(tx, client);
    const current = await readRow(tx, client);
    const level = await readLevel(tx, client);
    const currentCode: WipBatchCode = current?.wipBatchActive === 'X' ? 'X' : null;
    if (currentCode === 'X' && next === null) {
      throw new WipBatchError(
        'WIP batch is active and cannot be revoked. The indicator was not changed.',
        'IRREVERSIBLE',
        'Leave it active. This screen has no deactivation path.',
      );
    }
    if (currentCode === 'X' && next === 'X') return present(current, level);
    if (current && requestKey && current.lastRequestKey === requestKey) {
      if (currentCode !== next) {
        throw new WipBatchError(
          'This request key already saved a different indicator. The indicator was not changed.',
          'REQUEST_REPLAY',
          'Start a new save.',
        );
      }
      return present(current, level);
    }
    if (!current) {
      if (input.version !== 0) {
        throw new WipBatchError(
          'The indicator was not opened at this version. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again. The first save sends version 0.',
        );
      }
    } else if (current.version !== input.version) {
      throw new WipBatchError(
        'The indicator changed before this save. Nothing was saved.',
        'VERSION_STALE',
        'Open the screen again. No batch was created.',
      );
    }
    if (current && currentCode === next) return present(current, level);
    if (next === 'X' && !level) {
      throw new WipBatchError(
        'No batch level stands. WIP batch was not activated.',
        'PREREQUISITE_MISSING',
        'Save the batch level on OMCE first. OMCWB does not set it.',
      );
    }
    if (next === 'X' && input.confirmed !== true) {
      throw new WipBatchError(
        'Activation was not saved. Confirmation is required, and the change cannot be revoked.',
        'CONFIRM_REQUIRED',
        'Confirm the activation. It does not create a WIP batch.',
      );
    }
    const now = new Date();
    const after = next === 'X' ? 'X' : ' ';
    if (!current) {
      await tx.insert(wipBatchActivation).values({
        client,
        wipBatchActive: after,
        version: 1,
        lastRequestKey: requestKey,
        createdBy: changedBy,
        changedBy,
        createdAt: now,
        changedAt: now,
      });
    } else {
      const saved = await tx.update(wipBatchActivation).set({
        wipBatchActive: after,
        version: current.version + 1,
        lastRequestKey: requestKey,
        changedBy,
        changedAt: now,
      }).where(and(
        eq(wipBatchActivation.client, client),
        eq(wipBatchActivation.version, current.version),
      )).returning();
      if (saved.length !== 1) {
        throw new WipBatchError(
          'The indicator changed before this save. Nothing was saved.',
          'VERSION_STALE',
          'Open the screen again.',
        );
      }
    }
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: client,
      changeType: current ? 'CHANGE' : 'CREATE',
      changedBy,
      transactionCode: ALIAS,
      reason,
      correlationId: requestKey ?? undefined,
      before: current ? { wipBatchActive: currentCode ?? ' ', version: current.version } : undefined,
      after: {
        wipBatchActive: next ?? ' ',
        version: current ? current.version + 1 : 1,
        batchesCreated: false,
        documentsRewritten: false,
      },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return present(await readRow(tx, client), level);
  });
}

export function createWipBatch(): never {
  throw new WipBatchError(
    'A WIP batch was not created. OMCWB only stores the indicator.',
    'WIP_BATCH_NOT_CREATED',
    'Do not create a batch, post a confirmation, or rewrite a material document from this screen.',
  );
}
