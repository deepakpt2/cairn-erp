/**
 * Number ranges for batch numbers. OMAD is a search alias only.
 *
 * The object is BATCH_CLT. Intervals live on the existing number-range
 * engine. This screen does not create a second table or a second allocator.
 *
 * SAP mapping:
 * - OBJECT is number_range.object_code, fixed BATCH_CLT.
 * - NRRANGENR is number_range.sub_object, exactly two digits, leading zeros kept.
 * - FROMNUMBER and TONUMBER are bigint. The screen shows them padded to 10.
 *   A 10-digit batch number fits in a safe integer. Alphanumeric bounds are
 *   not stored. Leading zeros are display, not a second stored string.
 * - NRLEVEL is current_number, the last issued number. The next number is
 *   current + 1 and is not reserved by being shown.
 * - EXTERNIND X is is_external. Blank is internal.
 * - No company and no year. company_code is * and fiscal_year is 0.
 *
 * Interval 01 is the internal interval MSC1N draws. Interval 02, when it
 * stands and is external, is the check for a typed number. Opening this
 * screen does not create either interval. Buffering is refused: the shared
 * buffer is process-local, and a batch number must not come from it.
 */
import { and, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { numberRange, numberRangeAllocation, numberRangeObject } from '../../platform/tables/numbering';
import { markActivityComplete } from '../../platform/tenancy';
import {
  adjustNumberRangeCurrent,
  maintainNumberRange,
  rangeKey,
} from '../foundation/number-ranges';
import { ConfigError } from '../foundation/services';

export const ACTIVITY = 'CFG.INV.BATCHRANGE.DEFINE';
export const ROUTE = '/config/batch-number-ranges';
export const ALIASES = ['OMAD'] as const;
export const LOCK_OBJECT = 'BATCH_NUMBER_RANGE';
export const BATCH_NUMBER_OBJECT = 'BATCH_CLT';
export const INTERNAL_INTERVAL = '01';
export const EXTERNAL_INTERVAL = '02';
export const BATCH_NUMBER_LENGTH = 10;

export class BatchNumberRangeError extends Error {
  readonly code:
    | 'OBJECT_REFUSED'
    | 'INTERVAL_UNKNOWN'
    | 'BOUNDS_INVALID'
    | 'ASSIGNMENT_REFUSED'
    | 'BUFFER_REFUSED'
    | 'OVERLAP'
    | 'UNSAFE_DELETE'
    | 'STATUS_BACKWARDS'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'TRANSPORT_REFUSED'
    | 'COMPANY_REFUSED'
    | 'YEAR_REFUSED'
    | 'EXTERNAL_OUTSIDE'
    | 'EXTERNAL_NOT_NUMERIC'
    | 'NOT_FOUND'
    | 'AUTHORITY_REQUIRED';

  constructor(message: string, code: BatchNumberRangeError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchNumberRangeError';
    this.code = code;
  }
}

export interface BatchIntervalRow {
  interval: string;
  fromNumber: string;
  toNumber: string;
  fromValue: number;
  toValue: number;
  currentValue: number;
  currentDisplay: string | null;
  nextDisplay: string | null;
  external: boolean;
  status: string;
  exhausted: boolean;
  changedBy: string | null;
  changedAt: Date | null;
}

export interface BatchRangeObjectView {
  objectCode: string;
  description: string;
  intervals: BatchIntervalRow[];
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchNumberRangeError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMAD does not use a second permission code.',
    );
  }
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new BatchNumberRangeError('A reason is required.', 'REASON_REQUIRED', 'Say why this interval is being saved.');
  }
  return text;
}

function intervalOf(value: string): string {
  const text = value.trim();
  if (!/^[0-9]{2}$/.test(text)) {
    throw new BatchNumberRangeError(
      `Interval ${text || 'blank'} is not a two-digit interval number.`,
      'INTERVAL_UNKNOWN',
      'Use two digits. Leading zeros are kept. 01 is the internal interval.',
    );
  }
  return text;
}

function boundOf(value: string, label: string): number {
  const text = value.trim();
  if (!/^[0-9]{1,10}$/.test(text)) {
    throw new BatchNumberRangeError(
      `${label} ${text || 'blank'} is not a batch number of at most 10 digits.`,
      'BOUNDS_INVALID',
      'Enter digits only. Leading zeros are kept on the screen. Do not use a letter.',
    );
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new BatchNumberRangeError(
      `${label} ${text} is not a positive whole number.`,
      'BOUNDS_INVALID',
      'Enter a number from 1 to 9999999999.',
    );
  }
  return number;
}

export function displayBatchNumber(value: number): string {
  return String(value).padStart(BATCH_NUMBER_LENGTH, '0');
}

function presentInterval(row: {
  subObject: string;
  fromNumber: number;
  toNumber: number;
  currentNumber: number;
  isExternal: boolean;
  status: string;
  changedBy: string | null;
  changedAt: Date | null;
}): BatchIntervalRow {
  const next = row.currentNumber + 1;
  // External interval 02 checks a typed number. It does not allocate, so it has no next number.
  const nextDisplay = row.isExternal
    ? null
    : next >= row.fromNumber && next <= row.toNumber ? displayBatchNumber(next) : null;
  return {
    interval: row.subObject,
    fromNumber: displayBatchNumber(row.fromNumber),
    toNumber: displayBatchNumber(row.toNumber),
    fromValue: row.fromNumber,
    toValue: row.toNumber,
    currentValue: row.currentNumber,
    currentDisplay: row.currentNumber >= row.fromNumber ? displayBatchNumber(row.currentNumber) : null,
    nextDisplay,
    external: row.isExternal,
    status: row.status,
    exhausted: row.currentNumber >= row.toNumber,
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

function refuseExtras(input: { transportRequest?: string; companyCode?: string; fiscalYear?: string; objectCode?: string; buffered?: boolean }): void {
  if (input.transportRequest?.trim()) {
    throw new BatchNumberRangeError('A transport is refused. OMAD does not write a transport request.', 'TRANSPORT_REFUSED', 'Save the interval in this client.');
  }
  if (input.companyCode?.trim()) {
    throw new BatchNumberRangeError('A company code is refused. BATCH_CLT is not a company range.', 'COMPANY_REFUSED', 'Do not send a company code.');
  }
  if (input.fiscalYear?.trim()) {
    throw new BatchNumberRangeError('A fiscal year is refused. BATCH_CLT is not year-dependent.', 'YEAR_REFUSED', 'Do not send a year.');
  }
  if (input.objectCode?.trim() && input.objectCode.trim() !== BATCH_NUMBER_OBJECT) {
    throw new BatchNumberRangeError(
      `Object ${input.objectCode.trim()} is refused. OMAD maintains ${BATCH_NUMBER_OBJECT} only.`,
      'OBJECT_REFUSED',
      'Do not send another number-range object.',
    );
  }
  if (input.buffered) {
    throw new BatchNumberRangeError(
      'Buffering is refused. A batch number is not taken from a process-local buffer.',
      'BUFFER_REFUSED',
      'Leave buffering off.',
    );
  }
}

function assignmentFor(interval: string, external: boolean): boolean {
  if (interval === INTERNAL_INTERVAL && external) {
    throw new BatchNumberRangeError(
      'Interval 01 is the internal interval. It cannot be external.',
      'ASSIGNMENT_REFUSED',
      'Leave external off for 01. Use 02 for an external check.',
    );
  }
  if (interval === EXTERNAL_INTERVAL && !external) {
    throw new BatchNumberRangeError(
      'Interval 02 is the external check. It cannot be internal.',
      'ASSIGNMENT_REFUSED',
      'Mark 02 external. Internal assignment reads 01 only.',
    );
  }
  return external;
}

async function mark(client: string, changedBy: string) {
  await withTenant(client, (tx) => markActivityComplete(tx, client, ACTIVITY, changedBy));
}

export async function getBatchNumberRanges(client: string): Promise<BatchRangeObjectView> {
  return withTenant(client, async (tx) => {
    const objects = await tx.select().from(numberRangeObject).where(and(
      eq(numberRangeObject.client, client),
      eq(numberRangeObject.objectCode, BATCH_NUMBER_OBJECT),
    )).limit(1);
    const rows = await tx.select().from(numberRange).where(and(
      eq(numberRange.client, client),
      eq(numberRange.objectCode, BATCH_NUMBER_OBJECT),
    )).orderBy(numberRange.subObject);
    return {
      objectCode: BATCH_NUMBER_OBJECT,
      description: objects[0]?.description ?? 'Internal batch numbers',
      intervals: rows.map(presentInterval),
    };
  });
}

export async function saveBatchNumberInterval(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  interval: string;
  fromNumber: string;
  toNumber: string;
  external: boolean;
  status?: string;
  mode: 'CREATE' | 'CHANGE';
  expectedTo?: string;
  expectedCurrent?: string;
  reason?: string;
  transportRequest?: string;
  companyCode?: string;
  fiscalYear?: string;
  objectCode?: string;
  buffered?: boolean;
}): Promise<BatchIntervalRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const interval = intervalOf(input.interval);
  const external = assignmentFor(interval, input.external);
  const fromValue = boundOf(input.fromNumber, 'From number');
  const toValue = boundOf(input.toNumber, 'To number');
  if (toValue < fromValue) {
    throw new BatchNumberRangeError('The to number is below the from number.', 'BOUNDS_INVALID', 'Enter an upper bound at or above the lower bound.');
  }
  const status = input.status === 'BLOCKED' ? 'BLOCKED' : 'ACTIVE';
  const reason = reasonOf(input.reason);
  if (input.mode === 'CHANGE' && (input.expectedTo === undefined || input.expectedTo === '' || input.expectedCurrent === undefined || input.expectedCurrent === '')) {
    throw new BatchNumberRangeError(
      'The interval changed before this save. Nothing was saved.',
      'VERSION_STALE',
      'Open the interval again and send the values it shows.',
    );
  }
  try {
    await maintainNumberRange({
      client: input.client,
      changedBy: input.changedBy,
      objectCode: BATCH_NUMBER_OBJECT,
      companyCode: '*',
      subObject: interval,
      fiscalYear: 0,
      prefix: '',
      fromNumber: fromValue,
      toNumber: toValue,
      numberLength: BATCH_NUMBER_LENGTH,
      displayStyle: 'CLASSIC',
      isExternal: external,
      isBuffered: false,
      bufferSize: 0,
      status,
      mode: input.mode,
      reason,
      expectedToNumber: input.mode === 'CHANGE' && input.expectedTo ? boundOf(input.expectedTo, 'Opened to number') : undefined,
      expectedCurrentNumber: input.mode === 'CHANGE' && input.expectedCurrent !== undefined && input.expectedCurrent !== ''
        ? Number(input.expectedCurrent)
        : undefined,
    });
  } catch (error) {
    if (error instanceof ConfigError && /changed before this save/i.test(error.message)) {
      throw new BatchNumberRangeError(error.message, 'VERSION_STALE', error.remedy);
    }
    if (error instanceof ConfigError && /overlap/i.test(error.message)) {
      throw new BatchNumberRangeError(error.message, 'OVERLAP', error.remedy);
    }
    if (error instanceof ConfigError) throw new BatchNumberRangeError(error.message, 'BOUNDS_INVALID', error.remedy);
    throw error;
  }
  await mark(input.client, input.changedBy);
  const view = await getBatchNumberRanges(input.client);
  const saved = view.intervals.find((row) => row.interval === interval);
  if (!saved) throw new BatchNumberRangeError('The interval was not saved.', 'NOT_FOUND', 'Open the screen again.');
  return saved;
}

export async function deleteBatchNumberInterval(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  interval: string;
  reason?: string;
  transportRequest?: string;
}): Promise<void> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const interval = intervalOf(input.interval);
  const reason = reasonOf(input.reason);
  await withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/range/${BATCH_NUMBER_OBJECT}/*`}, 0))`);
    const rows = await tx.select().from(numberRange).where(and(
      eq(numberRange.client, input.client),
      eq(numberRange.objectCode, BATCH_NUMBER_OBJECT),
      eq(numberRange.companyCode, '*'),
      eq(numberRange.subObject, interval),
      eq(numberRange.fiscalYear, 0),
    )).for('update');
    const row = rows[0];
    if (!row) {
      throw new BatchNumberRangeError(`Interval ${interval} does not stand.`, 'NOT_FOUND', 'Refresh the screen.');
    }
    if (row.currentNumber >= row.fromNumber) {
      throw new BatchNumberRangeError(
        `Interval ${interval} has issued numbers. It was not deleted.`,
        'UNSAFE_DELETE',
        'Block the interval. Issued numbers are not removed.',
      );
    }
    const allocations = await tx.select({ id: numberRangeAllocation.id }).from(numberRangeAllocation).where(and(
      eq(numberRangeAllocation.client, input.client),
      eq(numberRangeAllocation.objectCode, BATCH_NUMBER_OBJECT),
      eq(numberRangeAllocation.subObject, interval),
    )).limit(1);
    if (allocations.length > 0) {
      throw new BatchNumberRangeError(
        `Interval ${interval} has an allocation record. It was not deleted.`,
        'UNSAFE_DELETE',
        'Block the interval. Issued numbers are not removed.',
      );
    }
    const used = await tx.execute(sql`
      select batch_number from batch
      where client = ${input.client}
        and batch_number ~ '^[0-9]+$'
        and batch_number::numeric between ${row.fromNumber} and ${row.toNumber}
      limit 1
    `) as unknown as Array<{ batch_number: string }>;
    if (used.length > 0) {
      throw new BatchNumberRangeError(
        `Batch ${used[0]?.batch_number} stands inside interval ${interval}. It was not deleted.`,
        'UNSAFE_DELETE',
        'A standing batch keeps the interval. Block it instead.',
      );
    }
    await tx.delete(numberRange).where(and(
      eq(numberRange.client, input.client),
      eq(numberRange.objectCode, BATCH_NUMBER_OBJECT),
      eq(numberRange.companyCode, '*'),
      eq(numberRange.subObject, interval),
      eq(numberRange.fiscalYear, 0),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'number_range',
      objectKey: rangeKey({ objectCode: BATCH_NUMBER_OBJECT, companyCode: '*', subObject: interval, fiscalYear: 0 }),
      changeType: 'DELETE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { interval, fromNumber: row.fromNumber, toNumber: row.toNumber, external: row.isExternal },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
  });
}

export async function adjustBatchNumberStatus(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  interval: string;
  currentNumber: string;
  expectedCurrent?: string;
  reason?: string;
  transportRequest?: string;
}): Promise<{ changed: boolean; currentDisplay: string | null }> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const interval = intervalOf(input.interval);
  const reason = reasonOf(input.reason);
  const text = input.currentNumber.trim();
  if (!/^[0-9]{1,10}$/.test(text)) {
    throw new BatchNumberRangeError(
      `Current number ${text || 'blank'} is not a batch number of at most 10 digits.`,
      'BOUNDS_INVALID',
      'Enter the last issued number, or 0 when nothing has been issued.',
    );
  }
  const current = Number(text);
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new BatchNumberRangeError('The current number is not a whole number.', 'BOUNDS_INVALID', 'Enter digits only.');
  }
  const opened = await withTenant(input.client, async (tx) => {
    const rows = await tx.select({ currentNumber: numberRange.currentNumber }).from(numberRange).where(and(
      eq(numberRange.client, input.client),
      eq(numberRange.objectCode, BATCH_NUMBER_OBJECT),
      eq(numberRange.subObject, interval),
      eq(numberRange.fiscalYear, 0),
    )).limit(1);
    return rows[0]?.currentNumber;
  });
  if (opened === undefined) {
    throw new BatchNumberRangeError(`Interval ${interval} does not stand.`, 'NOT_FOUND', 'Refresh the screen.');
  }
  if (input.expectedCurrent === undefined || input.expectedCurrent === '' || Number(input.expectedCurrent) !== opened) {
    throw new BatchNumberRangeError('The interval changed before this save. Nothing was saved.', 'VERSION_STALE', 'Open the interval again.');
  }
  if (current < opened) {
    throw new BatchNumberRangeError(
      'The current number cannot move backwards. Issued numbers would be given out again.',
      'STATUS_BACKWARDS',
      'Set a current number at or above the number that stands.',
    );
  }
  try {
    const saved = await adjustNumberRangeCurrent({
      client: input.client,
      changedBy: input.changedBy,
      objectCode: BATCH_NUMBER_OBJECT,
      companyCode: '*',
      subObject: interval,
      fiscalYear: 0,
      currentNumber: current,
      reason,
      forbidRepeat: true,
      expectedCurrent: Number(input.expectedCurrent),
    });
    await mark(input.client, input.changedBy);
    return { changed: saved.changed, currentDisplay: current >= 1 ? displayBatchNumber(current) : null };
  } catch (error) {
    if (error instanceof ConfigError && /backwards|given out again/i.test(error.message)) {
      throw new BatchNumberRangeError(error.message, 'STATUS_BACKWARDS', error.remedy);
    }
    if (error instanceof ConfigError && /changed before this save/i.test(error.message)) {
      throw new BatchNumberRangeError(error.message, 'VERSION_STALE', error.remedy);
    }
    if (error instanceof ConfigError) throw new BatchNumberRangeError(error.message, 'BOUNDS_INVALID', error.remedy);
    throw error;
  }
}

/**
 * A typed batch number does not consume interval 01. Interval 02 is the
 * external check only when it stands and is external. A missing 02 does not
 * reject a typed number. An alphanumeric number is not compared as a number.
 */
export async function assertExternalBatchNumber(tx: Tx, client: string, batchNumber: string): Promise<void> {
  const rows = await tx.select().from(numberRange).where(and(
    eq(numberRange.client, client),
    eq(numberRange.objectCode, BATCH_NUMBER_OBJECT),
    eq(numberRange.companyCode, '*'),
    eq(numberRange.subObject, EXTERNAL_INTERVAL),
    eq(numberRange.fiscalYear, 0),
  )).limit(1);
  const range = rows[0];
  if (!range || !range.isExternal) return;
  if (!/^[0-9]{1,10}$/.test(batchNumber)) {
    throw new BatchNumberRangeError(
      `Batch ${batchNumber} is not a number in external interval 02. No batch was created.`,
      'EXTERNAL_NOT_NUMERIC',
      'Type a numeric batch number inside interval 02, or remove that interval. The internal counter was not moved.',
    );
  }
  const value = Number(batchNumber);
  if (value < range.fromNumber || value > range.toNumber) {
    throw new BatchNumberRangeError(
      `Batch ${batchNumber} is outside external interval 02 (${displayBatchNumber(range.fromNumber)}–${displayBatchNumber(range.toNumber)}). No batch was created.`,
      'EXTERNAL_OUTSIDE',
      'Type a number inside interval 02. The internal counter was not moved.',
    );
  }
}

