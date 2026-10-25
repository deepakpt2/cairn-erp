/**
 * OMCV — batch classification for goods movements. The attribute is KZCLA.
 *
 * It is stored on the standing movement type. Blank is no branching. 1 is
 * background for all batches. 2 is foreground for mandatory characteristics,
 * all batches. 3 is always foreground, all batches. 4 is foreground for new
 * batches only. The catalogue key is the standing movement type, not a second
 * three-character key.
 *
 * Characteristic copying, WIP-batch adoption, and extended CFC are not stored.
 * Class type 023 is not active. A non-blank code cannot classify, so a goods
 * movement that names it is refused before stock or a journal. A later change
 * does not rewrite a posted document. A reversal reads the movement it posts,
 * and does not copy characteristics as a new receipt.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import {
  CLASSIFICATION_MEANING,
  type BatchClassificationRow,
  type ClassificationCode,
} from './batch-classification-vocabulary';
import { movementType } from './schema';

// The words the screen shows live in the vocabulary module, so the client
// bundle never reaches this file. Re-exported here because the goods-movement
// writers, the action, and the service tests all read them from this module.
export { CLASSIFICATION_CODES, CLASSIFICATION_MEANING } from './batch-classification-vocabulary';
export type { BatchClassificationRow, ClassificationCode } from './batch-classification-vocabulary';

export const ACTIVITY = 'CFG.INV.BATCHCLASSIFY.DEFINE';
export const ROUTE = '/config/batch-classification';
export const ALIAS = 'OMCV';
export const LOCK_OBJECT = 'BATCH_CLASSIFICATION';

/** Named, not stored, and not offered as a working control. */
export const NOT_EXECUTED = [
  {
    field: 'MILL_CPCONF',
    title: 'Characteristic copying',
    reason: 'Class type 023 is not active. There is no batch classification and no configuration characteristic to copy.',
  },
  {
    field: 'CO_WIPB_CPCONF',
    title: 'WIP batch characteristic adoption',
    reason: 'There is no WIP batch. This is not the goods-movement copy field, and it is not stored.',
  },
  {
    field: 'XKCFC',
    title: 'Extended classification via CFC',
    reason: 'The domain is not verified here, and the control is not stored.',
  },
  {
    field: '023',
    title: 'Class type 023',
    reason: 'Batch classification is not active. OMCV does not activate it and does not create a value store.',
  },
] as const;

export class BatchClassificationError extends Error {
  readonly code:
    | 'AUTHORITY_REQUIRED'
    | 'TYPE_UNKNOWN'
    | 'CODE_UNKNOWN'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'CONFIRM_REQUIRED'
    | 'TRANSPORT_REFUSED'
    | 'PLANT_REFUSED'
    | 'COPY_REFUSED'
    | 'CLASS_REFUSED';

  constructor(message: string, code: BatchClassificationError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchClassificationError';
    this.code = code;
  }
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchClassificationError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMCV does not use a second permission code.',
    );
  }
}

export function classificationOf(value: string | null | undefined): ClassificationCode {
  if (value == null) return ' ';
  const text = value === ' ' ? ' ' : value.trim();
  if (text === '' || text === ' ') return ' ';
  if (text === '1' || text === '2' || text === '3' || text === '4') return text;
  throw new BatchClassificationError(
    `Classification ${text} is not a KZCLA value. Use blank, 1, 2, 3, or 4.`,
    'CODE_UNKNOWN',
    'Blank is no branching. 1 is background. 2 is foreground for mandatory characteristics. 3 is always foreground. 4 is foreground for new batches only. It is not a boolean.',
  );
}

function refuseExtras(input: {
  transportRequest?: string;
  plant?: string;
  copyRule?: string;
  wipCopy?: string;
  extendedCfc?: string;
  classType?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchClassificationError(
      'A transport is refused. OMCV does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Save the movement type in this client.',
    );
  }
  if (input.plant?.trim()) {
    throw new BatchClassificationError(
      'A plant is refused. Batch classification is the movement type, not a plant.',
      'PLANT_REFUSED',
      'Do not send a plant.',
    );
  }
  if (input.copyRule?.trim() || input.wipCopy?.trim() || input.extendedCfc?.trim()) {
    throw new BatchClassificationError(
      'Characteristic copying is not available. The copy, WIP, and CFC controls are not stored.',
      'COPY_REFUSED',
      'Leave those controls unset. Class type 023 is not active, and there is no configuration or WIP batch to copy from.',
    );
  }
  if (input.classType?.trim()) {
    throw new BatchClassificationError(
      `Class type ${input.classType.trim()} is refused. OMCV does not activate class type 023.`,
      'CLASS_REFUSED',
      'Do not send a class type. No classification store is created.',
    );
  }
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new BatchClassificationError('A reason is required.', 'REASON_REQUIRED', 'Say why this classification control is being saved.');
  }
  return text;
}

function rowOf(row: {
  movementType: string;
  description: string;
  batchClassification: string;
  changedBy: string | null;
  changedAt: Date | null;
}): BatchClassificationRow {
  return {
    movementType: row.movementType,
    description: row.description,
    classification: classificationOf(row.batchClassification),
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

export async function listBatchClassification(client: string): Promise<BatchClassificationRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      movementType: movementType.movementType,
      description: movementType.description,
      batchClassification: movementType.batchClassification,
      changedBy: movementType.changedBy,
      changedAt: movementType.changedAt,
    }).from(movementType)
      .where(eq(movementType.client, client))
      .orderBy(asc(movementType.movementType));
    return rows.map(rowOf);
  });
}

export async function saveBatchClassification(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  movementType: string;
  classification: string;
  expectedClassification: string;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  plant?: string;
  copyRule?: string;
  wipCopy?: string;
  extendedCfc?: string;
  classType?: string;
}): Promise<BatchClassificationRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const key = input.movementType.trim();
  const next = classificationOf(input.classification);
  const expected = classificationOf(input.expectedClassification);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_CLASSIFICATION/${key}`}))`);
    const [existing] = await tx.select().from(movementType).where(and(
      eq(movementType.client, input.client),
      eq(movementType.movementType, key),
    )).for('update');
    if (!existing) {
      throw new BatchClassificationError(
        `Movement type ${key || 'blank'} does not stand. Nothing was saved.`,
        'TYPE_UNKNOWN',
        'Choose a movement type from the list. OMCV does not create one and does not change its posting rules.',
      );
    }
    const current = classificationOf(existing.batchClassification);
    if (current !== expected) {
      throw new BatchClassificationError(
        `Movement type ${key} was opened as ${expected.trim() || 'blank'}, and ${current.trim() || 'blank'} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the movement type again.',
      );
    }
    if (current === next) {
      return rowOf(existing);
    }
    if (!input.confirmed) {
      throw new BatchClassificationError(
        'The change was not confirmed. Nothing was saved.',
        'CONFIRM_REQUIRED',
        'Confirm the save. A posted movement is not rewritten, and no stock is posted.',
      );
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    await tx.update(movementType).set({
      batchClassification: next,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(eq(movementType.client, input.client), eq(movementType.movementType, key)));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'movement_type',
      objectKey: key,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { batchClassification: current },
      after: { batchClassification: next },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return {
      movementType: key,
      description: existing.description,
      classification: next,
      changedBy: input.changedBy,
      changedAt: now,
    };
  });
}

/**
 * Read by every goods-movement writer. Blank does not branch. A non-blank code
 * cannot be performed, so the caller rejects before stock or a journal.
 * A missing movement type is the poster's own error, not a classification.
 */
export async function batchClassificationRefusal(
  tx: Tx,
  client: string,
  movementTypeCode: string,
): Promise<{ message: string; remedy: string } | null> {
  const key = movementTypeCode.trim();
  if (!key) return null;
  const [row] = await tx.select({ code: movementType.batchClassification }).from(movementType).where(and(
    eq(movementType.client, client),
    eq(movementType.movementType, key),
  )).limit(1);
  if (!row) return null;
  const code = classificationOf(row.code);
  if (code === ' ') return null;
  return {
    message: `Movement ${key} asks for batch classification ${code} (${CLASSIFICATION_MEANING[code]}). Class type 023 is not active, and no batch classification was written. Nothing was posted.`,
    remedy: 'Leave the classification control blank on this movement type, then post again. Characteristic copying is not available.',
  };
}
