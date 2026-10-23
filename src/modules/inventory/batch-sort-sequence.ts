/**
 * Sort sequence — CU70 create, CU71 change, CU72 display.
 *
 * The name is RCUD5-SRTSQ, domain KLASSE, 18 characters. The description
 * is one 40-character text. Status is the class-status code: 0 in
 * preparation, 1 released, 2 locked. Each criterion sorts ascending or
 * descending. There is no weighting factor.
 *
 * LOBM_LGORT and LOBM_MENGE are stock exceptions. They need not stand in
 * the characteristic master, and they must not stand in a batch class.
 * Every other characteristic must already stand. This screen does not
 * create one.
 *
 * Ranking a supplied list is not batch determination. No batch is read,
 * selected, or posted. A search strategy does not store this sequence.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { characteristic, classAssignment } from '../foundation/characteristic-schema';
import { BATCH_CLASS_TYPES } from './batch-class';
import { batchSortSequence, batchSortSequenceCriterion } from './schema';

export const ACTIVITY = 'INV.BATCHSORT.MAINTAIN';
export const ROUTE = '/inventory/batch-sort-sequences';
export const ALIAS = 'CU70';
export const CHANGE_ALIAS = 'CU71';
export const DISPLAY_ALIAS = 'CU72';
export const LOCK_OBJECT = 'BATCH_SORT_SEQUENCE';
const OBJECT_CLASS = 'batch_sort_sequence';
const PRODUCTION = process.env.NODE_ENV === 'production';

export const SORT_STATUS = [
  { code: '0', title: 'In preparation' },
  { code: '1', title: 'Released' },
  { code: '2', title: 'Locked' },
] as const;

const STOCK_EXCEPTIONS: Record<string, { dataFormat: 'CHAR' | 'NUM'; description: string }> = {
  LOBM_LGORT: { dataFormat: 'CHAR', description: 'Storage location' },
  LOBM_MENGE: { dataFormat: 'NUM', description: 'Available quantity of the batch' },
};

export const NOT_EXECUTED = [
  {
    field: 'SRTSQ',
    title: 'Strategy reference',
    reason: 'A search strategy does not store this sequence. Naming it here does not assign it.',
  },
  {
    field: 'AUSP',
    title: 'Characteristic value',
    reason: 'A batch value is not read. Ranking a supplied list is not a selection.',
  },
  {
    field: 'GEWIC',
    title: 'Weighting factor',
    reason: 'No weighting factor is stored. The order is the criterion order, not a score.',
  },
  {
    field: 'LANGUAGE',
    title: 'Language-dependent description',
    reason: 'One description is stored. A language table is not stored.',
  },
  {
    field: 'DETERMINATION',
    title: 'Batch determination',
    reason: 'A standing sequence does not select a batch. Availability, shelf life, and status are not checked here.',
  },
] as const;

export class BatchSortError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(message: string, code: string, remedy: string) {
    super(message);
    this.name = 'BatchSortError';
    this.code = code;
    this.remedy = remedy;
  }
}

export interface SortCriterion {
  position: number;
  characteristicName: string;
  description: string;
  dataFormat: string;
  direction: 'A' | 'D';
  stockException: boolean;
}

export interface SortSequenceRow {
  sortSequence: string;
  description: string;
  status: string;
  statusTitle: string;
  version: number;
  criteria: SortCriterion[];
}

export interface SortSequenceChoices {
  characteristics: Array<{
    characteristicName: string;
    description: string;
    dataFormat: string;
    lifecycleStatus: string;
    stockException: boolean;
    batchClassAssigned: boolean;
  }>;
  sequences: SortSequenceRow[];
}

export interface SortCriterionInput {
  characteristicName: string;
  direction: string;
}

export interface SortSequenceInput {
  client: string;
  changedBy: string;
  capabilities?: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  sortSequence: string;
  description: string;
  status: string;
  criteria: SortCriterionInput[];
  expectedVersion: number | null;
  confirmed: boolean;
  reason: string;
  language?: string;
  weight?: string;
  materialNumber?: string;
  batchNumber?: string;
  transportRequest?: string;
}

export interface RankCandidate {
  key: string;
  values: Record<string, string | null | undefined>;
}

function requireText(value: string, code: string, message: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new BatchSortError(message, code, 'Sign in again.');
  return PRODUCTION ? trimmed : trimmed.toUpperCase();
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchSortError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. CU70 does not use a second permission code.',
    );
  }
}

function sequenceName(raw: string): string {
  const name = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,18}$/.test(name)) {
    throw new BatchSortError(
      'The sort sequence is at most 18 characters of uppercase letters, digits and underscores.',
      'SEQUENCE_NAME',
      'Correct the name and save again. A hyphen is not stored.',
    );
  }
  return name;
}

function statusOf(raw: string): string {
  const status = (raw ?? '').trim();
  if (!SORT_STATUS.some((item) => item.code === status)) {
    throw new BatchSortError(
      `Status ${status || 'blank'} is refused. The status is 0, 1, or 2.`,
      'STATUS_REFUSED',
      '0 is in preparation, 1 is released, and 2 is locked. No other status is stored.',
    );
  }
  return status;
}

function statusTitle(status: string): string {
  return SORT_STATUS.find((item) => item.code === status)?.title ?? status;
}

function criteriaOf(input: SortCriterionInput[]): Array<{ characteristicName: string; direction: 'A' | 'D' }> {
  const seen = new Set<string>();
  const wanted: Array<{ characteristicName: string; direction: 'A' | 'D' }> = [];
  for (const item of input ?? []) {
    const name = (item.characteristicName ?? '').trim().toUpperCase();
    if (!name) continue;
    if (seen.has(name)) {
      throw new BatchSortError(
        `Characteristic ${name} stands twice in this sequence.`,
        'DUPLICATE_CHARACTERISTIC',
        'Name each characteristic once. The row order is the sort priority.',
      );
    }
    const direction = (item.direction ?? '').trim().toUpperCase();
    if (direction !== 'A' && direction !== 'D') {
      throw new BatchSortError(
        `Characteristic ${name} needs ascending or descending, not both and not neither.`,
        'DIRECTION_REQUIRED',
        'Choose A or D for that characteristic.',
      );
    }
    seen.add(name);
    wanted.push({ characteristicName: name, direction });
  }
  if (wanted.length === 0) {
    throw new BatchSortError(
      'A sort sequence needs at least one characteristic.',
      'CHARACTERISTIC_REQUIRED',
      'Choose a standing characteristic, or the stock exception LOBM_LGORT or LOBM_MENGE.',
    );
  }
  return wanted;
}

async function present(tx: Tx, client: string, name?: string): Promise<SortSequenceRow[]> {
  const headers = await tx.select().from(batchSortSequence).where(name
    ? and(eq(batchSortSequence.client, client), eq(batchSortSequence.sortSequence, name))
    : eq(batchSortSequence.client, client),
  ).orderBy(asc(batchSortSequence.sortSequence));
  if (headers.length === 0) return [];
  const names = headers.map((row) => row.sortSequence);
  const criteria = await tx.select().from(batchSortSequenceCriterion).where(and(
    eq(batchSortSequenceCriterion.client, client),
    inArray(batchSortSequenceCriterion.sortSequence, names),
  )).orderBy(asc(batchSortSequenceCriterion.sortSequence), asc(batchSortSequenceCriterion.position));
  const chars = await tx.select().from(characteristic).where(eq(characteristic.client, client));
  return headers.map((row) => ({
    sortSequence: row.sortSequence,
    description: row.description,
    status: row.status,
    statusTitle: statusTitle(row.status),
    version: row.version,
    criteria: criteria.filter((item) => item.sortSequence === row.sortSequence).map((item) => {
      const char = chars.find((entry) => entry.characteristicName === item.characteristicName);
      const exception = STOCK_EXCEPTIONS[item.characteristicName];
      return {
        position: item.position,
        characteristicName: item.characteristicName,
        description: char?.description ?? exception?.description ?? '',
        dataFormat: char?.dataFormat ?? exception?.dataFormat ?? '',
        direction: item.direction as 'A' | 'D',
        stockException: Boolean(exception),
      };
    }),
  }));
}

export async function listSortSequences(clientKey: string): Promise<SortSequenceChoices> {
  const client = requireText(clientKey, 'CLIENT_REQUIRED', 'The tenant is missing.');
  return withTenant(client, async (tx) => {
    const chars = await tx.select().from(characteristic)
      .where(eq(characteristic.client, client)).orderBy(asc(characteristic.characteristicName));
    const assigned = await tx.select().from(classAssignment).where(and(
      eq(classAssignment.client, client),
      inArray(classAssignment.classType, [...BATCH_CLASS_TYPES]),
    ));
    const assignedNames = new Set(assigned.map((row) => row.characteristicName));
    const known = new Set(chars.map((row) => row.characteristicName));
    const characteristics = chars.map((row) => ({
      characteristicName: row.characteristicName,
      description: row.description,
      dataFormat: row.dataFormat,
      lifecycleStatus: row.lifecycleStatus,
      stockException: Boolean(STOCK_EXCEPTIONS[row.characteristicName]),
      batchClassAssigned: assignedNames.has(row.characteristicName),
    }));
    for (const [name, exception] of Object.entries(STOCK_EXCEPTIONS)) {
      if (known.has(name)) continue;
      characteristics.push({
        characteristicName: name,
        description: exception.description,
        dataFormat: exception.dataFormat,
        lifecycleStatus: '',
        stockException: true,
        batchClassAssigned: false,
      });
    }
    characteristics.sort((left, right) => left.characteristicName.localeCompare(right.characteristicName));
    return { characteristics, sequences: await present(tx, client) };
  });
}

export async function saveSortSequence(input: SortSequenceInput): Promise<SortSequenceRow> {
  assertAuthority(input.capabilities);
  const client = requireText(input.client, 'CLIENT_REQUIRED', 'The tenant is missing.');
  const changedBy = requireText(input.changedBy, 'ACTOR_REQUIRED', 'The acting user is missing.');
  if (input.confirmed !== true) {
    throw new BatchSortError(
      'The sort sequence was not saved. Confirmation is required.',
      'CONFIRM_REQUIRED',
      'Confirm that this saves the sequence only. It does not select a batch.',
    );
  }
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 500) {
    throw new BatchSortError('A reason is required for every sort sequence change.', 'REASON_REQUIRED', 'State why this change is being made.');
  }
  if ((input.language ?? '').trim()) {
    throw new BatchSortError('A language is refused. One description is stored.', 'LANGUAGE_REFUSED', 'Leave the language blank.');
  }
  if ((input.weight ?? '').trim()) {
    throw new BatchSortError(
      'A weighting factor is refused. Nothing was saved.',
      'WEIGHT_REFUSED',
      'Order the characteristics. Do not score them.',
    );
  }
  if ((input.materialNumber ?? '').trim() || (input.batchNumber ?? '').trim()) {
    throw new BatchSortError(
      'A material or a batch cannot be named here. Nothing was saved.',
      'ASSIGNMENT_REFUSED',
      'The sequence does not assign itself to a batch.',
    );
  }
  if ((input.transportRequest ?? '').trim()) {
    throw new BatchSortError('A transport is refused. CU70 does not write a transport request.', 'TRANSPORT_REFUSED', 'Save the sequence in this client.');
  }
  const name = sequenceName(input.sortSequence);
  const description = (input.description ?? '').trim();
  if (!description || description.length > 40) {
    throw new BatchSortError(
      'The description is required and may be at most 40 characters.',
      'DESCRIPTION',
      'Enter one description. A language table is not stored.',
    );
  }
  const status = statusOf(input.status);
  const wanted = criteriaOf(input.criteria);

  return withTenant(client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext(${`${LOCK_OBJECT}/${name}`}))`);
    const assigned = await tx.select().from(classAssignment).where(and(
      eq(classAssignment.client, client),
      inArray(classAssignment.classType, [...BATCH_CLASS_TYPES]),
    ));
    const assignedNames = new Set(assigned.map((row) => row.characteristicName));
    for (const item of wanted) {
      const [char] = await tx.select().from(characteristic).where(and(
        eq(characteristic.client, client),
        eq(characteristic.characteristicName, item.characteristicName),
      )).limit(1);
      const exception = STOCK_EXCEPTIONS[item.characteristicName];
      if (!char && !exception) {
        throw new BatchSortError(
          `Characteristic ${item.characteristicName} does not stand for this tenant.`,
          'CHARACTERISTIC_UNKNOWN',
          'Define it on the characteristics screen. A characteristic from another tenant is not visible.',
        );
      }
      if (char?.lifecycleStatus === 'BLOCKED') {
        throw new BatchSortError(
          `Characteristic ${item.characteristicName} is blocked and cannot be newly assigned.`,
          'CHARACTERISTIC_BLOCKED',
          'Reactivate the characteristic, or leave it out of this sequence.',
        );
      }
      if (exception && assignedNames.has(item.characteristicName)) {
        throw new BatchSortError(
          `${item.characteristicName} stands in a batch class. It cannot sort while it is classified.`,
          'EXCEPTION_IN_CLASS',
          'Remove it from the batch class. LOBM_LGORT and LOBM_MENGE are stock exceptions, not class characteristics.',
        );
      }
    }
    const [existing] = await tx.select().from(batchSortSequence).where(and(
      eq(batchSortSequence.client, client),
      eq(batchSortSequence.sortSequence, name),
    )).for('update');
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new BatchSortError(
          `Sort sequence ${name} already stands.`,
          'SEQUENCE_EXISTS',
          'Change the standing sequence, or choose a new name.',
        );
      }
      await tx.insert(batchSortSequence).values({
        client, sortSequence: name, description, status, version: 1, createdBy: changedBy,
      });
    } else {
      if (!existing) {
        throw new BatchSortError(
          `Sort sequence ${name} does not stand.`,
          'SEQUENCE_MISSING',
          'Create it first. The name cannot be changed by typing another code.',
        );
      }
      if (input.expectedVersion !== existing.version) {
        throw new BatchSortError(
          'This sequence was saved by someone else. Reload it and enter the change again.',
          'STALE_VERSION',
          'The name stays as it was saved.',
        );
      }
      await tx.update(batchSortSequence).set({
        description, status, version: existing.version + 1, changedBy, changedAt: new Date(),
      }).where(and(eq(batchSortSequence.client, client), eq(batchSortSequence.sortSequence, name)));
      await tx.delete(batchSortSequenceCriterion).where(and(
        eq(batchSortSequenceCriterion.client, client),
        eq(batchSortSequenceCriterion.sortSequence, name),
      ));
    }
    let position = 0;
    for (const item of wanted) {
      position += 1;
      await tx.insert(batchSortSequenceCriterion).values({
        client,
        sortSequence: name,
        position,
        characteristicName: item.characteristicName,
        direction: item.direction,
        createdBy: changedBy,
      });
    }
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: name,
      changeType: input.mode,
      changedBy,
      reason,
      transactionCode: input.mode === 'CREATE' ? ALIAS : CHANGE_ALIAS,
      after: {
        sortSequence: name,
        description,
        status,
        criteria: wanted.map((item) => `${item.characteristicName}:${item.direction}`),
        determination: 'NOT_EXECUTED',
      },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    const [saved] = await present(tx, client, name);
    return saved!;
  });
}

export async function deleteSortSequence(input: {
  client: string;
  changedBy: string;
  capabilities?: readonly string[];
  sortSequence: string;
  expectedVersion: number;
  confirmed: boolean;
  reason: string;
}): Promise<{ sortSequence: string; changed: boolean }> {
  assertAuthority(input.capabilities);
  const client = requireText(input.client, 'CLIENT_REQUIRED', 'The tenant is missing.');
  const changedBy = requireText(input.changedBy, 'ACTOR_REQUIRED', 'The acting user is missing.');
  if (input.confirmed !== true) {
    throw new BatchSortError('The sequence was not deleted. Confirmation is required.', 'CONFIRM_REQUIRED', 'Confirm the deletion.');
  }
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3) {
    throw new BatchSortError('A reason is required.', 'REASON_REQUIRED', 'State why this sequence is being deleted.');
  }
  const name = sequenceName(input.sortSequence);
  return withTenant(client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext(${`${LOCK_OBJECT}/${name}`}))`);
    const [existing] = await tx.select().from(batchSortSequence).where(and(
      eq(batchSortSequence.client, client),
      eq(batchSortSequence.sortSequence, name),
    )).for('update');
    if (!existing) throw new BatchSortError(`Sort sequence ${name} does not stand.`, 'SEQUENCE_MISSING', 'Refresh the list.');
    if (input.expectedVersion !== existing.version) {
      throw new BatchSortError('This sequence was saved by someone else. Reload it before deleting.', 'STALE_VERSION', 'The sequence was not deleted.');
    }
    const referenced = await tx.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'batch_search_strategy' and column_name in ('sort_sequence', 'srtsq')
    `) as unknown as Array<{ column_name: string }>;
    if (referenced.length > 0) {
      throw new BatchSortError(
        'A search strategy can name this sequence. It was not deleted.',
        'SEQUENCE_REFERENCED',
        'Remove the strategy reference first. This delete does not change a strategy.',
      );
    }
    await tx.delete(batchSortSequence).where(and(
      eq(batchSortSequence.client, client),
      eq(batchSortSequence.sortSequence, name),
    ));
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: name, changeType: 'DELETE', changedBy, reason,
      transactionCode: CHANGE_ALIAS, before: { sortSequence: name, status: existing.status },
    });
    return { sortSequence: name, changed: true };
  });
}

interface CriterionFormat {
  characteristicName: string;
  direction: 'A' | 'D';
  dataFormat: string;
  caseSensitive: boolean;
}

function comparable(value: string, format: CriterionFormat): number | string {
  const text = value.trim();
  if (format.dataFormat === 'NUM' || format.dataFormat === 'CURR') {
    if (!/^-?\d+(\.\d+)?$/.test(text)) {
      throw new BatchSortError(
        `${format.characteristicName} value ${text} is not a number. The list was not ranked.`,
        'INCOMPATIBLE_VALUE',
        'Correct the supplied value. A bad value is not sorted as text.',
      );
    }
    return Number(text);
  }
  if (format.dataFormat === 'DATE') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
      throw new BatchSortError(
        `${format.characteristicName} value ${text} is not a date. The list was not ranked.`,
        'INCOMPATIBLE_VALUE',
        'Use a date. A bad value is not sorted as text.',
      );
    }
    return text;
  }
  if (format.dataFormat === 'TIME') {
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text)) {
      throw new BatchSortError(
        `${format.characteristicName} value ${text} is not a time. The list was not ranked.`,
        'INCOMPATIBLE_VALUE',
        'Use a time. A bad value is not sorted as text.',
      );
    }
    return text;
  }
  return format.caseSensitive ? text : text.toUpperCase();
}

export async function rankSuppliedCandidates(input: {
  client: string;
  sortSequence: string;
  candidates: RankCandidate[];
}): Promise<{
  sortSequence: string;
  keys: string[];
  chronological: boolean;
  convention: string;
}> {
  const client = requireText(input.client, 'CLIENT_REQUIRED', 'The tenant is missing.');
  const name = sequenceName(input.sortSequence);
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(batchSortSequence).where(and(
      eq(batchSortSequence.client, client),
      eq(batchSortSequence.sortSequence, name),
    )).limit(1);
    if (!header) {
      throw new BatchSortError(`Sort sequence ${name} does not stand.`, 'SEQUENCE_MISSING', 'Create it before ranking a supplied list.');
    }
    if (header.status !== '1') {
      throw new BatchSortError(
        `Sort sequence ${name} is ${statusTitle(header.status)}. A list is ranked only when the status is released.`,
        'STATUS_NOT_RELEASED',
        'Release the sequence, or do not rank with it. This still does not select a batch.',
      );
    }
    const criteria = await tx.select().from(batchSortSequenceCriterion).where(and(
      eq(batchSortSequenceCriterion.client, client),
      eq(batchSortSequenceCriterion.sortSequence, name),
    )).orderBy(asc(batchSortSequenceCriterion.position));
    const chars = await tx.select().from(characteristic).where(eq(characteristic.client, client));
    const formats: CriterionFormat[] = criteria.map((item) => {
      const char = chars.find((entry) => entry.characteristicName === item.characteristicName);
      const exception = STOCK_EXCEPTIONS[item.characteristicName];
      return {
        characteristicName: item.characteristicName,
        direction: item.direction as 'A' | 'D',
        dataFormat: char?.dataFormat ?? exception?.dataFormat ?? 'CHAR',
        caseSensitive: char?.caseSensitive === true,
      };
    });
    for (const candidate of input.candidates) {
      for (const format of formats) {
        const raw = candidate.values[format.characteristicName];
        if (raw == null || String(raw).trim() === '') continue;
        comparable(String(raw), format);
      }
    }
    const ranked = [...input.candidates].sort((left, right) => {
      for (const format of formats) {
        const leftRaw = left.values[format.characteristicName];
        const rightRaw = right.values[format.characteristicName];
        const leftMissing = leftRaw == null || String(leftRaw).trim() === '';
        const rightMissing = rightRaw == null || String(rightRaw).trim() === '';
        if (leftMissing && rightMissing) continue;
        if (leftMissing || rightMissing) {
          const missingFirst = format.direction === 'A';
          if (leftMissing) return missingFirst ? -1 : 1;
          return missingFirst ? 1 : -1;
        }
        const leftValue = comparable(String(leftRaw), format);
        const rightValue = comparable(String(rightRaw), format);
        if (leftValue === rightValue) continue;
        const ascending = leftValue < rightValue ? -1 : 1;
        return format.direction === 'A' ? ascending : -ascending;
      }
      return 0;
    });
    const first = formats[0];
    const chronological = first?.dataFormat === 'DATE' || first?.dataFormat === 'TIME';
    let convention = '';
    if (first?.characteristicName === 'LOBM_VFDAT' && first.direction === 'A' && first.dataFormat === 'DATE') convention = 'FEFO';
    if (first?.characteristicName === 'LOBM_MENGE' && first.direction === 'D') convention = 'QUANTITY_DESC';
    return { sortSequence: name, keys: ranked.map((item) => item.key), chronological, convention };
  });
}

export function determineBatches(): never {
  throw new BatchSortError(
    'A sort sequence does not select a batch. Selection, availability, shelf life, and quantity proposal are not executed.',
    'DETERMINATION_NOT_EXECUTED',
    'Rank a list only after some other step has already found the eligible batches. That step does not stand.',
  );
}
