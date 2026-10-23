/**
 * OMCX — Inventory Management access sequences. View VV_T682_ME.
 *
 * Usage is H. Application is ME. The key is KOZGF, one to four uppercase
 * letters or digits. The description is VTXTM, at most thirty characters.
 * This application keeps one description, not a language table.
 *
 * An access step names a standing condition table. The number is KOLNR,
 * two digits, and it need not be gap-free. Exclusive access, a requirement,
 * and field mapping are not stored. Naming a table does not search it and
 * does not select a batch.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { batchAccessSequence, batchAccessStep, batchConditionTable, batchSearchStrategy, batchStrategyType } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHACCESS.DEFINE';
export const ROUTE = '/config/batch-access-sequences';
export const ALIAS = 'OMCX';
export const LOCK_OBJECT = 'BATCH_ACCESS_SEQUENCE';
export const USAGE = 'H';
export const APPLICATION = 'ME';

export const NOT_EXECUTED = [
  {
    field: 'KZEXL',
    title: 'Exclusive indicator',
    reason: 'No access runs, so a later access is neither stopped nor continued. The indicator is not stored.',
  },
  {
    field: 'KOBED',
    title: 'Requirement',
    reason: 'No requirement routine is implemented. User-supplied code is not executed.',
  },
  {
    field: 'T682Z',
    title: 'Field mapping',
    reason: 'No condition-table key is mapped, and no communication field is read.',
  },
] as const;

export class BatchAccessSequenceError extends Error {
  readonly code:
    | 'AUTHORITY_REQUIRED'
    | 'KEY_UNKNOWN'
    | 'TYPE_UNKNOWN'
    | 'DUPLICATE'
    | 'DESCRIPTION_REQUIRED'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'CONFIRM_REQUIRED'
    | 'TRANSPORT_REFUSED'
    | 'PLANT_REFUSED'
    | 'SCOPE_REFUSED'
    | 'STEP_REFUSED'
    | 'STEP_UNKNOWN'
    | 'STEP_DUPLICATE'
    | 'TABLE_UNKNOWN'
    | 'CITED';

  constructor(message: string, code: BatchAccessSequenceError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchAccessSequenceError';
    this.code = code;
  }
}

export interface BatchAccessSequenceRow {
  accessSequence: string;
  description: string;
  usage: typeof USAGE;
  application: typeof APPLICATION;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchAccessSequenceError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMCX does not use a second permission code.',
    );
  }
}

function keyOf(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(key)) {
    throw new BatchAccessSequenceError(
      `Access sequence ${value.trim() || 'blank'} is not a key. Use one to four uppercase letters or digits.`,
      'KEY_UNKNOWN',
      'The key is four characters at most. A strategy type is not an access sequence.',
    );
  }
  return key;
}

function descriptionOf(value: string): string {
  const text = value.trim();
  if (!text || text.length > 30) {
    throw new BatchAccessSequenceError(
      'The description is required and may be at most 30 characters.',
      'DESCRIPTION_REQUIRED',
      'Enter a name of at most 30 characters. A language table is not stored.',
    );
  }
  return text;
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new BatchAccessSequenceError('A reason is required.', 'REASON_REQUIRED', 'Say why this access sequence is being saved.');
  }
  return text;
}

function refuseExtras(input: {
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  conditionTable?: string;
  accessNumber?: string;
  exclusive?: string;
  requirement?: string;
  fieldMapping?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchAccessSequenceError(
      'A transport is refused. OMCX does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Save the access sequence in this client. No transport mechanism carries it.',
    );
  }
  if (input.plant?.trim()) {
    throw new BatchAccessSequenceError(
      'A plant is refused. An Inventory Management access sequence is not a plant.',
      'PLANT_REFUSED',
      'Do not send a plant.',
    );
  }
  const usage = (input.usage ?? '').trim().toUpperCase();
  const application = (input.application ?? '').trim().toUpperCase();
  if ((usage && usage !== USAGE) || (application && application !== APPLICATION)) {
    throw new BatchAccessSequenceError(
      `Usage ${usage || USAGE} and application ${application || APPLICATION} are refused. OMCX stores usage H and application ME only.`,
      'SCOPE_REFUSED',
      'Production and sales access sequences are not this screen.',
    );
  }
  const sent = [input.conditionTable, input.accessNumber, input.exclusive, input.requirement, input.fieldMapping]
    .find((value) => value?.trim());
  if (sent) {
    throw new BatchAccessSequenceError(
      `Access ${sent.trim()} is not stored. No condition table stands, and no access runs.`,
      'STEP_REFUSED',
      'Leave the condition table, access number, exclusive indicator, and requirement unset. OMA1 is not this screen.',
    );
  }
}

function rowOf(row: {
  accessSequence: string;
  description: string;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}): BatchAccessSequenceRow {
  return {
    accessSequence: row.accessSequence,
    description: row.description,
    usage: USAGE,
    application: APPLICATION,
    version: row.version,
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

export async function listBatchAccessSequences(client: string): Promise<BatchAccessSequenceRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      accessSequence: batchAccessSequence.accessSequence,
      description: batchAccessSequence.description,
      version: batchAccessSequence.version,
      changedBy: batchAccessSequence.changedBy,
      changedAt: batchAccessSequence.changedAt,
    }).from(batchAccessSequence)
      .where(and(
        eq(batchAccessSequence.client, client),
        eq(batchAccessSequence.usage, USAGE),
        eq(batchAccessSequence.application, APPLICATION),
      ))
      .orderBy(asc(batchAccessSequence.accessSequence));
    return rows.map(rowOf);
  });
}

export async function saveBatchAccessSequence(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  accessSequence: string;
  description: string;
  expectedVersion?: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  conditionTable?: string;
  accessNumber?: string;
  exclusive?: string;
  requirement?: string;
  fieldMapping?: string;
}): Promise<BatchAccessSequenceRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const key = keyOf(input.accessSequence);
  const description = descriptionOf(input.description);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_ACCESS_SEQUENCE/${key}`}))`);
    const [existing] = await tx.select().from(batchAccessSequence).where(and(
      eq(batchAccessSequence.client, input.client),
      eq(batchAccessSequence.usage, USAGE),
      eq(batchAccessSequence.application, APPLICATION),
      eq(batchAccessSequence.accessSequence, key),
    )).for('update');
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new BatchAccessSequenceError(
          `Access sequence ${key} already stands. Nothing was saved.`,
          'DUPLICATE',
          'Change the standing sequence, or choose another key.',
        );
      }
      if (!input.confirmed) {
        throw new BatchAccessSequenceError(
          'The change was not confirmed. Nothing was saved.',
          'CONFIRM_REQUIRED',
          'Confirm the save. No access runs and no stock is posted.',
        );
      }
      const reason = reasonOf(input.reason);
      const now = new Date();
      await tx.insert(batchAccessSequence).values({
        client: input.client,
        usage: USAGE,
        application: APPLICATION,
        accessSequence: key,
        description,
        version: 1,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        changedAt: now,
      });
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_access_sequence',
        objectKey: key,
        changeType: 'CREATE',
        changedBy: input.changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: { usage: USAGE, application: APPLICATION, accessSequence: key, description },
      });
      await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
      return { accessSequence: key, description, usage: USAGE, application: APPLICATION, version: 1, changedBy: input.changedBy, changedAt: now };
    }
    if (!existing) {
      throw new BatchAccessSequenceError(
        `Access sequence ${key} does not stand. Nothing was saved.`,
        'TYPE_UNKNOWN',
        'Create it first. OMCX does not invent a standard access sequence.',
      );
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchAccessSequenceError(
        `Access sequence ${key} was opened at version ${input.expectedVersion ?? 'blank'}, and version ${existing.version} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the access sequence again.',
      );
    }
    if (existing.description === description) {
      return rowOf(existing);
    }
    if (!input.confirmed) {
      throw new BatchAccessSequenceError(
        'The change was not confirmed. Nothing was saved.',
        'CONFIRM_REQUIRED',
        'Confirm the save. A posted movement is not rewritten, and no access runs.',
      );
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const version = existing.version + 1;
    await tx.update(batchAccessSequence).set({
      description,
      version,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(batchAccessSequence.client, input.client),
      eq(batchAccessSequence.usage, USAGE),
      eq(batchAccessSequence.application, APPLICATION),
      eq(batchAccessSequence.accessSequence, key),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_access_sequence',
      objectKey: key,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { description: existing.description, version: existing.version },
      after: { description, version },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return { accessSequence: key, description, usage: USAGE, application: APPLICATION, version, changedBy: input.changedBy, changedAt: now };
  });
}

export async function deleteBatchAccessSequence(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  accessSequence: string;
  expectedVersion: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
}): Promise<{ accessSequence: string }> {
  assertAuthority(input.capabilities);
  if (input.transportRequest?.trim()) {
    throw new BatchAccessSequenceError(
      'A transport is refused. OMCX does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Delete the access sequence in this client.',
    );
  }
  const key = keyOf(input.accessSequence);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_ACCESS_SEQUENCE/${key}`}))`);
    const [existing] = await tx.select().from(batchAccessSequence).where(and(
      eq(batchAccessSequence.client, input.client),
      eq(batchAccessSequence.usage, USAGE),
      eq(batchAccessSequence.application, APPLICATION),
      eq(batchAccessSequence.accessSequence, key),
    )).for('update');
    if (!existing) {
      throw new BatchAccessSequenceError(
        `Access sequence ${key} does not stand. Nothing was deleted.`,
        'TYPE_UNKNOWN',
        'Choose an access sequence from the list.',
      );
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchAccessSequenceError(
        `Access sequence ${key} was opened at version ${input.expectedVersion}, and version ${existing.version} now stands. Nothing was deleted.`,
        'VERSION_STALE',
        'Open the access sequence again.',
      );
    }
    const [cited] = await tx.select({ strategyType: batchStrategyType.strategyType }).from(batchStrategyType).where(and(
      eq(batchStrategyType.client, input.client),
      eq(batchStrategyType.usage, USAGE),
      eq(batchStrategyType.application, APPLICATION),
      eq(batchStrategyType.accessSequence, key),
    )).limit(1);
    if (cited) {
      throw new BatchAccessSequenceError(
        `Access sequence ${key} is named by strategy type ${cited.strategyType}. Nothing was deleted.`,
        'CITED',
        'Clear the reference on the strategy type first. The strategy type is not changed here.',
      );
    }
    if (!input.confirmed) {
      throw new BatchAccessSequenceError(
        'The deletion was not confirmed. Nothing was deleted.',
        'CONFIRM_REQUIRED',
        'Confirm the deletion. No posted movement is rewritten.',
      );
    }
    const reason = reasonOf(input.reason);
    const steps = await tx.select({
      accessNumber: batchAccessStep.accessNumber,
      conditionTable: batchAccessStep.conditionTable,
    }).from(batchAccessStep).where(and(
      eq(batchAccessStep.client, input.client),
      eq(batchAccessStep.usage, USAGE),
      eq(batchAccessStep.application, APPLICATION),
      eq(batchAccessStep.accessSequence, key),
    ));
    await tx.delete(batchAccessStep).where(and(
      eq(batchAccessStep.client, input.client),
      eq(batchAccessStep.usage, USAGE),
      eq(batchAccessStep.application, APPLICATION),
      eq(batchAccessStep.accessSequence, key),
    ));
    await tx.delete(batchAccessSequence).where(and(
      eq(batchAccessSequence.client, input.client),
      eq(batchAccessSequence.usage, USAGE),
      eq(batchAccessSequence.application, APPLICATION),
      eq(batchAccessSequence.accessSequence, key),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_access_sequence',
      objectKey: key,
      changeType: 'DELETE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { description: existing.description, version: existing.version, steps },
    });
    return { accessSequence: key };
  });
}

export interface BatchAccessStepRow {
  accessSequence: string;
  accessNumber: string;
  conditionTable: string;
  version: number;
}

function accessNumberOf(value: string): string {
  const text = value.trim();
  if (!/^\d{1,2}$/.test(text)) {
    throw new BatchAccessSequenceError(
      `Access number ${text || 'blank'} is not two digits. Nothing was saved.`,
      'STEP_UNKNOWN',
      'Use 00 to 99. The number need not follow the previous one, and 01 is not required.',
    );
  }
  return text.padStart(2, '0');
}

function conditionTableKey(value: string): string {
  const text = value.trim();
  if (!/^\d{1,3}$/.test(text)) {
    throw new BatchAccessSequenceError(
      `Condition table ${text || 'blank'} is not a table number. Nothing was saved.`,
      'TABLE_UNKNOWN',
      'Name a condition table that already stands on OMA1.',
    );
  }
  return text.padStart(3, '0');
}

function refuseStepExtras(input: {
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  exclusive?: string;
  requirement?: string;
  fieldMapping?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchAccessSequenceError(
      'A transport is refused. OMCX does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Save the access in this client.',
    );
  }
  if (input.plant?.trim()) {
    throw new BatchAccessSequenceError(
      'A plant is refused. An access is not a plant.',
      'PLANT_REFUSED',
      'Do not send a plant.',
    );
  }
  const usage = (input.usage ?? '').trim().toUpperCase();
  const application = (input.application ?? '').trim().toUpperCase();
  if ((usage && usage !== USAGE) || (application && application !== APPLICATION)) {
    throw new BatchAccessSequenceError(
      `Usage ${usage || USAGE} and application ${application || APPLICATION} are refused. OMCX stores usage H and application ME only.`,
      'SCOPE_REFUSED',
      'Production and sales accesses are not this screen.',
    );
  }
  const sent = [input.exclusive, input.requirement, input.fieldMapping].find((value) => value?.trim());
  if (sent) {
    throw new BatchAccessSequenceError(
      `Access ${sent.trim()} is not stored. No access runs.`,
      'STEP_REFUSED',
      'Leave the exclusive indicator, requirement, and field mapping unset. Naming a condition table does not search it.',
    );
  }
}

export async function listBatchAccessSteps(client: string, accessSequence: string): Promise<BatchAccessStepRow[]> {
  const key = accessSequence.trim().toUpperCase();
  if (!key) return [];
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      accessSequence: batchAccessStep.accessSequence,
      accessNumber: batchAccessStep.accessNumber,
      conditionTable: batchAccessStep.conditionTable,
      version: batchAccessStep.version,
    }).from(batchAccessStep)
      .where(and(
        eq(batchAccessStep.client, client),
        eq(batchAccessStep.usage, USAGE),
        eq(batchAccessStep.application, APPLICATION),
        eq(batchAccessStep.accessSequence, key),
      ))
      .orderBy(asc(batchAccessStep.accessNumber));
    return rows;
  });
}

export async function saveBatchAccessStep(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  accessSequence: string;
  accessNumber: string;
  conditionTable: string;
  expectedVersion?: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  exclusive?: string;
  requirement?: string;
  fieldMapping?: string;
}): Promise<BatchAccessStepRow & { sequenceVersion: number }> {
  assertAuthority(input.capabilities);
  refuseStepExtras(input);
  const sequence = keyOf(input.accessSequence);
  const number = accessNumberOf(input.accessNumber);
  const table = conditionTableKey(input.conditionTable);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_ACCESS_SEQUENCE/${sequence}`}))`);
    const [header] = await tx.select().from(batchAccessSequence).where(and(
      eq(batchAccessSequence.client, input.client),
      eq(batchAccessSequence.usage, USAGE),
      eq(batchAccessSequence.application, APPLICATION),
      eq(batchAccessSequence.accessSequence, sequence),
    )).for('update');
    if (!header) {
      throw new BatchAccessSequenceError(
        `Access sequence ${sequence} does not stand. Nothing was saved.`,
        'TYPE_UNKNOWN',
        'Create the access sequence first. A step does not invent one.',
      );
    }
    if (header.version !== input.expectedVersion) {
      throw new BatchAccessSequenceError(
        `Access sequence ${sequence} was opened at version ${input.expectedVersion ?? 'blank'}, and version ${header.version} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the access sequence again.',
      );
    }
    const [standing] = await tx.select({ conditionTable: batchConditionTable.conditionTable })
      .from(batchConditionTable)
      .where(and(
        eq(batchConditionTable.client, input.client),
        eq(batchConditionTable.usage, USAGE),
        eq(batchConditionTable.conditionTable, table),
      ))
      .limit(1)
      .for('update');
    if (!standing) {
      throw new BatchAccessSequenceError(
        `Condition table ${table} does not stand. Nothing was saved.`,
        'TABLE_UNKNOWN',
        'Create it on OMA1 first. A step does not invent a table, and naming one does not search it.',
      );
    }
    const [existing] = await tx.select().from(batchAccessStep).where(and(
      eq(batchAccessStep.client, input.client),
      eq(batchAccessStep.usage, USAGE),
      eq(batchAccessStep.application, APPLICATION),
      eq(batchAccessStep.accessSequence, sequence),
      eq(batchAccessStep.accessNumber, number),
    )).for('update');
    if (input.mode === 'CREATE' && existing) {
      throw new BatchAccessSequenceError(
        `Access ${number} already stands on ${sequence}. Nothing was saved.`,
        'STEP_DUPLICATE',
        'Change the standing access, or choose another number. The numbers need not be gap-free.',
      );
    }
    if (input.mode === 'CHANGE' && !existing) {
      throw new BatchAccessSequenceError(
        `Access ${number} does not stand on ${sequence}. Nothing was saved.`,
        'STEP_UNKNOWN',
        'Create the access first.',
      );
    }
    if (existing && existing.conditionTable === table) {
      return { accessSequence: sequence, accessNumber: number, conditionTable: table, version: existing.version, sequenceVersion: header.version };
    }
    if (!input.confirmed) {
      throw new BatchAccessSequenceError(
        'The change was not confirmed. Nothing was saved.',
        'CONFIRM_REQUIRED',
        'Confirm the save. No access runs and no stock is posted.',
      );
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const sequenceVersion = header.version + 1;
    await tx.update(batchAccessSequence).set({
      version: sequenceVersion,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(batchAccessSequence.client, input.client),
      eq(batchAccessSequence.usage, USAGE),
      eq(batchAccessSequence.application, APPLICATION),
      eq(batchAccessSequence.accessSequence, sequence),
    ));
    if (!existing) {
      await tx.insert(batchAccessStep).values({
        client: input.client,
        usage: USAGE,
        application: APPLICATION,
        accessSequence: sequence,
        accessNumber: number,
        conditionTable: table,
        version: 1,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        changedAt: now,
      });
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_access_step',
        objectKey: `${sequence}/${number}`,
        changeType: 'CREATE',
        changedBy: input.changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: { accessSequence: sequence, accessNumber: number, conditionTable: table },
      });
      return { accessSequence: sequence, accessNumber: number, conditionTable: table, version: 1, sequenceVersion };
    }
    const version = existing.version + 1;
    await tx.update(batchAccessStep).set({
      conditionTable: table,
      version,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(batchAccessStep.client, input.client),
      eq(batchAccessStep.usage, USAGE),
      eq(batchAccessStep.application, APPLICATION),
      eq(batchAccessStep.accessSequence, sequence),
      eq(batchAccessStep.accessNumber, number),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_access_step',
      objectKey: `${sequence}/${number}`,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { conditionTable: existing.conditionTable, version: existing.version },
      after: { conditionTable: table, version },
    });
    return { accessSequence: sequence, accessNumber: number, conditionTable: table, version, sequenceVersion };
  });
}

export async function deleteBatchAccessStep(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  accessSequence: string;
  accessNumber: string;
  expectedVersion: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
}): Promise<{ accessSequence: string; accessNumber: string; sequenceVersion: number }> {
  assertAuthority(input.capabilities);
  if (input.transportRequest?.trim()) {
    throw new BatchAccessSequenceError(
      'A transport is refused. OMCX does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Delete the access in this client.',
    );
  }
  const sequence = keyOf(input.accessSequence);
  const number = accessNumberOf(input.accessNumber);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_ACCESS_SEQUENCE/${sequence}`}))`);
    const [header] = await tx.select().from(batchAccessSequence).where(and(
      eq(batchAccessSequence.client, input.client),
      eq(batchAccessSequence.usage, USAGE),
      eq(batchAccessSequence.application, APPLICATION),
      eq(batchAccessSequence.accessSequence, sequence),
    )).for('update');
    if (!header) {
      throw new BatchAccessSequenceError(
        `Access sequence ${sequence} does not stand. Nothing was deleted.`,
        'TYPE_UNKNOWN',
        'Choose an access sequence from the list.',
      );
    }
    if (header.version !== input.expectedVersion) {
      throw new BatchAccessSequenceError(
        `Access sequence ${sequence} was opened at version ${input.expectedVersion}, and version ${header.version} now stands. Nothing was deleted.`,
        'VERSION_STALE',
        'Open the access sequence again.',
      );
    }
    const [existing] = await tx.select().from(batchAccessStep).where(and(
      eq(batchAccessStep.client, input.client),
      eq(batchAccessStep.usage, USAGE),
      eq(batchAccessStep.application, APPLICATION),
      eq(batchAccessStep.accessSequence, sequence),
      eq(batchAccessStep.accessNumber, number),
    )).for('update');
    if (!existing) {
      throw new BatchAccessSequenceError(
        `Access ${number} does not stand on ${sequence}. Nothing was deleted.`,
        'STEP_UNKNOWN',
        'Choose an access from the list.',
      );
    }
    const [cited] = await tx.select({
      recordNumber: batchSearchStrategy.recordNumber,
    }).from(batchSearchStrategy).innerJoin(batchStrategyType, and(
      eq(batchStrategyType.client, batchSearchStrategy.client),
      eq(batchStrategyType.usage, batchSearchStrategy.usage),
      eq(batchStrategyType.application, batchSearchStrategy.application),
      eq(batchStrategyType.strategyType, batchSearchStrategy.strategyType),
    )).where(and(
      eq(batchSearchStrategy.client, input.client),
      eq(batchSearchStrategy.conditionTable, existing.conditionTable),
      eq(batchStrategyType.accessSequence, sequence),
    )).limit(1);
    if (cited) {
      throw new BatchAccessSequenceError(
        `Access ${number} is used by search strategy ${cited.recordNumber}. Nothing was deleted.`,
        'CITED',
        'Delete the search strategy on MBC1 first. The record is not changed here.',
      );
    }
    if (!input.confirmed) {
      throw new BatchAccessSequenceError(
        'The deletion was not confirmed. Nothing was deleted.',
        'CONFIRM_REQUIRED',
        'Confirm the deletion. No posted movement is rewritten.',
      );
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const sequenceVersion = header.version + 1;
    await tx.delete(batchAccessStep).where(and(
      eq(batchAccessStep.client, input.client),
      eq(batchAccessStep.usage, USAGE),
      eq(batchAccessStep.application, APPLICATION),
      eq(batchAccessStep.accessSequence, sequence),
      eq(batchAccessStep.accessNumber, number),
    ));
    await tx.update(batchAccessSequence).set({
      version: sequenceVersion,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(batchAccessSequence.client, input.client),
      eq(batchAccessSequence.usage, USAGE),
      eq(batchAccessSequence.application, APPLICATION),
      eq(batchAccessSequence.accessSequence, sequence),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_access_step',
      objectKey: `${sequence}/${number}`,
      changeType: 'DELETE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { conditionTable: existing.conditionTable, version: existing.version },
    });
    return { accessSequence: sequence, accessNumber: number, sequenceVersion };
  });
}
