/**
 * OMA1 — Inventory Management condition tables.
 *
 * Usage is H. Application is ME. The number is KOTABNR, three digits.
 * Customer tables are 501 to 999. The SAP key area, 001 to 500, is not
 * created here and is not seeded.
 *
 * The selectable key fields are the Inventory Management list. A field
 * outside that list is refused. OMA0 is not this screen.
 *
 * Saving records the number and the key fields. It does not generate a
 * physical table, store a condition record, or select a batch.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { batchAccessStep, batchConditionTable, batchConditionTableField, batchSearchStrategy } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHCONDTABLE.DEFINE';
export const ROUTE = '/config/batch-condition-tables';
export const ALIAS = 'OMA1';
export const LOCK_OBJECT = 'BATCH_CONDITION_TABLE';
export const USAGE = 'H';
export const APPLICATION = 'ME';

/** Selectable key fields for Inventory Management. Production and sales fields are not in this list. */
export const ALLOWED_FIELDS = [
  { field: 'BWART', title: 'Movement type' },
  { field: 'KUNNR', title: 'Customer' },
  { field: 'LGORT', title: 'Storage location' },
  { field: 'LIFNR', title: 'Supplier' },
  { field: 'MATKL', title: 'Material group' },
  { field: 'MATNR', title: 'Material' },
  { field: 'MTART', title: 'Material type' },
  { field: 'SOBKZ', title: 'Special stock' },
  { field: 'WERKS', title: 'Plant' },
] as const;

export const NOT_EXECUTED = [
  {
    field: 'KOTAB',
    title: 'Generated table',
    reason: 'No physical condition table is generated. A search strategy is stored on MBC1, not in a generated table.',
  },
  {
    field: 'GESTA',
    title: 'Generator status',
    reason: 'The generator does not run. A status of success is not stored.',
  },
  {
    field: 'KSDAT',
    title: 'Validity period',
    reason: 'This screen does not store a validity period. A search strategy is maintained on MBC1.',
  },
  {
    field: 'T682Z',
    title: 'Field mapping',
    reason: 'An access sequence does not map these fields, and no access runs.',
  },
] as const;

export class BatchConditionTableError extends Error {
  readonly code:
    | 'AUTHORITY_REQUIRED'
    | 'TABLE_UNKNOWN'
    | 'TABLE_RESERVED'
    | 'DUPLICATE'
    | 'TYPE_UNKNOWN'
    | 'FIELDS_REQUIRED'
    | 'FIELD_UNKNOWN'
    | 'FIELD_DUPLICATE'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'CONFIRM_REQUIRED'
    | 'TRANSPORT_REFUSED'
    | 'PLANT_REFUSED'
    | 'SCOPE_REFUSED'
    | 'GENERATION_REFUSED'
    | 'RECORD_REFUSED'
    | 'CITED';

  constructor(message: string, code: BatchConditionTableError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchConditionTableError';
    this.code = code;
  }
}

export interface BatchConditionTableRow {
  conditionTable: string;
  fields: string[];
  usage: typeof USAGE;
  application: typeof APPLICATION;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}

const ALLOWED = new Set<string>(ALLOWED_FIELDS.map((item) => item.field));

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchConditionTableError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMA1 does not use a second permission code.',
    );
  }
}

function tableOf(value: string): string {
  const text = value.trim();
  if (!/^\d{1,3}$/.test(text)) {
    throw new BatchConditionTableError(
      `Condition table ${text || 'blank'} is not a table number. Use three digits from 501 to 999.`,
      'TABLE_UNKNOWN',
      'The number is three digits. A strategy type is not a condition table.',
    );
  }
  const number = Number(text);
  const key = String(number).padStart(3, '0');
  if (number < 501 || number > 999) {
    throw new BatchConditionTableError(
      `Condition table ${key} is in the SAP key area. Nothing was saved.`,
      'TABLE_RESERVED',
      'Use a table from 501 to 999. Standard tables are not delivered here, and a physical table is not generated.',
    );
  }
  return key;
}

function fieldsOf(value: readonly string[] | undefined): string[] {
  const fields = (value ?? [])
    .flatMap((item) => item.split(/[,\s/]+/))
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (fields.length === 0) {
    throw new BatchConditionTableError(
      'At least one key field is required. Nothing was saved.',
      'FIELDS_REQUIRED',
      'Name one or more allowed fields, in key order. A table with no fields is not generated.',
    );
  }
  const seen = new Set<string>();
  for (const field of fields) {
    if (!ALLOWED.has(field)) {
      throw new BatchConditionTableError(
        `Field ${field} is not an Inventory Management key field. Nothing was saved.`,
        'FIELD_UNKNOWN',
        'Use a field from the allowed list. Production and sales fields are not this screen, and a field cannot be added here.',
      );
    }
    if (seen.has(field)) {
      throw new BatchConditionTableError(
        `Field ${field} is named twice. Nothing was saved.`,
        'FIELD_DUPLICATE',
        'Name each field once. The order is the key order.',
      );
    }
    seen.add(field);
  }
  return fields;
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new BatchConditionTableError('A reason is required.', 'REASON_REQUIRED', 'Say why this condition table is being saved.');
  }
  return text;
}

function refuseExtras(input: {
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  generate?: string;
  conditionRecord?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchConditionTableError(
      'A transport is refused. OMA1 does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Save the condition table in this client. No transport mechanism carries it.',
    );
  }
  if (input.plant?.trim()) {
    throw new BatchConditionTableError(
      'A plant is refused. A condition table is not a plant.',
      'PLANT_REFUSED',
      'Name plant as a key field if the table should include it. Do not send a plant value.',
    );
  }
  const usage = (input.usage ?? '').trim().toUpperCase();
  const application = (input.application ?? '').trim().toUpperCase();
  if ((usage && usage !== USAGE) || (application && application !== APPLICATION)) {
    throw new BatchConditionTableError(
      `Usage ${usage || USAGE} and application ${application || APPLICATION} are refused. OMA1 stores usage H and application ME only.`,
      'SCOPE_REFUSED',
      'Production and sales condition tables are not this screen.',
    );
  }
  if (input.generate?.trim()) {
    throw new BatchConditionTableError(
      'Generation is refused. No physical table is created.',
      'GENERATION_REFUSED',
      'Save the number and the key fields. A condition record is not stored.',
    );
  }
  if (input.conditionRecord?.trim()) {
    throw new BatchConditionTableError(
      'A condition record is refused. OMA1 does not store one.',
      'RECORD_REFUSED',
      'MBC1 is not this screen. No batch is selected.',
    );
  }
}

function sameFields(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}

async function fieldsFor(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  client: string,
  conditionTable: string,
): Promise<string[]> {
  const rows = await tx.select({ fieldName: batchConditionTableField.fieldName })
    .from(batchConditionTableField)
    .where(and(
      eq(batchConditionTableField.client, client),
      eq(batchConditionTableField.usage, USAGE),
      eq(batchConditionTableField.conditionTable, conditionTable),
    ))
    .orderBy(asc(batchConditionTableField.position));
  return rows.map((row) => row.fieldName);
}

async function writeFields(tx: Tx, client: string, conditionTable: string, fields: readonly string[]): Promise<void> {
  await tx.delete(batchConditionTableField).where(and(
    eq(batchConditionTableField.client, client),
    eq(batchConditionTableField.usage, USAGE),
    eq(batchConditionTableField.conditionTable, conditionTable),
  ));
  if (fields.length === 0) return;
  await tx.insert(batchConditionTableField).values(fields.map((fieldName, index) => ({
    client,
    usage: USAGE,
    conditionTable,
    position: index + 1,
    fieldName,
  })));
}

export async function listBatchConditionTables(client: string): Promise<BatchConditionTableRow[]> {
  return withTenant(client, async (tx) => {
    const headers = await tx.select({
      conditionTable: batchConditionTable.conditionTable,
      version: batchConditionTable.version,
      changedBy: batchConditionTable.changedBy,
      changedAt: batchConditionTable.changedAt,
    }).from(batchConditionTable)
      .where(and(eq(batchConditionTable.client, client), eq(batchConditionTable.usage, USAGE)))
      .orderBy(asc(batchConditionTable.conditionTable));
    const fields = await tx.select({
      conditionTable: batchConditionTableField.conditionTable,
      fieldName: batchConditionTableField.fieldName,
    }).from(batchConditionTableField)
      .where(and(eq(batchConditionTableField.client, client), eq(batchConditionTableField.usage, USAGE)))
      .orderBy(asc(batchConditionTableField.conditionTable), asc(batchConditionTableField.position));
    return headers.map((header) => ({
      conditionTable: header.conditionTable,
      fields: fields.filter((field) => field.conditionTable === header.conditionTable).map((field) => field.fieldName),
      usage: USAGE,
      application: APPLICATION,
      version: header.version,
      changedBy: header.changedBy,
      changedAt: header.changedAt,
    }));
  });
}

export async function saveBatchConditionTable(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  conditionTable: string;
  fields: readonly string[];
  expectedVersion?: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  generate?: string;
  conditionRecord?: string;
}): Promise<BatchConditionTableRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const key = tableOf(input.conditionTable);
  const fields = fieldsOf(input.fields);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_CONDITION_TABLE/${key}`}))`);
    const [existing] = await tx.select().from(batchConditionTable).where(and(
      eq(batchConditionTable.client, input.client),
      eq(batchConditionTable.usage, USAGE),
      eq(batchConditionTable.conditionTable, key),
    )).for('update');
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new BatchConditionTableError(
          `Condition table ${key} already stands. Nothing was saved.`,
          'DUPLICATE',
          'Change the standing table, or choose another number.',
        );
      }
      if (!input.confirmed) {
        throw new BatchConditionTableError(
          'The change was not confirmed. Nothing was saved.',
          'CONFIRM_REQUIRED',
          'Confirm the save. No table is generated and no stock is posted.',
        );
      }
      const reason = reasonOf(input.reason);
      const now = new Date();
      await tx.insert(batchConditionTable).values({
        client: input.client,
        usage: USAGE,
        application: APPLICATION,
        conditionTable: key,
        version: 1,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        changedAt: now,
      });
      await writeFields(tx, input.client, key, fields);
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_condition_table',
        objectKey: key,
        changeType: 'CREATE',
        changedBy: input.changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: { usage: USAGE, application: APPLICATION, conditionTable: key, fields },
      });
      await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
      return { conditionTable: key, fields, usage: USAGE, application: APPLICATION, version: 1, changedBy: input.changedBy, changedAt: now };
    }
    if (!existing) {
      throw new BatchConditionTableError(
        `Condition table ${key} does not stand. Nothing was saved.`,
        'TYPE_UNKNOWN',
        'Create it first. OMA1 does not invent a standard condition table.',
      );
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchConditionTableError(
        `Condition table ${key} was opened at version ${input.expectedVersion ?? 'blank'}, and version ${existing.version} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the condition table again.',
      );
    }
    const standing = await fieldsFor(tx, input.client, key);
    if (sameFields(standing, fields)) {
      return {
        conditionTable: key,
        fields: standing,
        usage: USAGE,
        application: APPLICATION,
        version: existing.version,
        changedBy: existing.changedBy,
        changedAt: existing.changedAt,
      };
    }
    if (!input.confirmed) {
      throw new BatchConditionTableError(
        'The change was not confirmed. Nothing was saved.',
        'CONFIRM_REQUIRED',
        'Confirm the save. A posted movement is not rewritten, and no access runs.',
      );
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const version = existing.version + 1;
    await tx.update(batchConditionTable).set({
      version,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(batchConditionTable.client, input.client),
      eq(batchConditionTable.usage, USAGE),
      eq(batchConditionTable.conditionTable, key),
    ));
    await writeFields(tx, input.client, key, fields);
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_condition_table',
      objectKey: key,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { fields: standing, version: existing.version },
      after: { fields, version },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return { conditionTable: key, fields, usage: USAGE, application: APPLICATION, version, changedBy: input.changedBy, changedAt: now };
  });
}

export async function deleteBatchConditionTable(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  conditionTable: string;
  expectedVersion: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
}): Promise<{ conditionTable: string }> {
  assertAuthority(input.capabilities);
  if (input.transportRequest?.trim()) {
    throw new BatchConditionTableError(
      'A transport is refused. OMA1 does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Delete the condition table in this client.',
    );
  }
  const key = tableOf(input.conditionTable);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_CONDITION_TABLE/${key}`}))`);
    const [existing] = await tx.select().from(batchConditionTable).where(and(
      eq(batchConditionTable.client, input.client),
      eq(batchConditionTable.usage, USAGE),
      eq(batchConditionTable.conditionTable, key),
    )).for('update');
    if (!existing) {
      throw new BatchConditionTableError(
        `Condition table ${key} does not stand. Nothing was deleted.`,
        'TYPE_UNKNOWN',
        'Choose a condition table from the list.',
      );
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchConditionTableError(
        `Condition table ${key} was opened at version ${input.expectedVersion}, and version ${existing.version} now stands. Nothing was deleted.`,
        'VERSION_STALE',
        'Open the condition table again.',
      );
    }
    const [cited] = await tx.select({
      accessSequence: batchAccessStep.accessSequence,
      accessNumber: batchAccessStep.accessNumber,
    }).from(batchAccessStep).where(and(
      eq(batchAccessStep.client, input.client),
      eq(batchAccessStep.usage, USAGE),
      eq(batchAccessStep.conditionTable, key),
    )).limit(1);
    if (cited) {
      throw new BatchConditionTableError(
        `Condition table ${key} is named by access ${cited.accessNumber} of sequence ${cited.accessSequence}. Nothing was deleted.`,
        'CITED',
        'Remove the access on OMCX first. The access sequence is not changed here.',
      );
    }
    const [strategy] = await tx.select({
      recordNumber: batchSearchStrategy.recordNumber,
    }).from(batchSearchStrategy).where(and(
      eq(batchSearchStrategy.client, input.client),
      eq(batchSearchStrategy.usage, USAGE),
      eq(batchSearchStrategy.conditionTable, key),
    )).limit(1);
    if (strategy) {
      throw new BatchConditionTableError(
        `Condition table ${key} is named by search strategy ${strategy.recordNumber}. Nothing was deleted.`,
        'CITED',
        'Delete the search strategy on MBC1 first. The strategy is not changed here.',
      );
    }
    if (!input.confirmed) {
      throw new BatchConditionTableError(
        'The deletion was not confirmed. Nothing was deleted.',
        'CONFIRM_REQUIRED',
        'Confirm the deletion. No posted movement is rewritten.',
      );
    }
    const reason = reasonOf(input.reason);
    const fields = await fieldsFor(tx, input.client, key);
    await tx.delete(batchConditionTableField).where(and(
      eq(batchConditionTableField.client, input.client),
      eq(batchConditionTableField.usage, USAGE),
      eq(batchConditionTableField.conditionTable, key),
    ));
    await tx.delete(batchConditionTable).where(and(
      eq(batchConditionTable.client, input.client),
      eq(batchConditionTable.usage, USAGE),
      eq(batchConditionTable.conditionTable, key),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_condition_table',
      objectKey: key,
      changeType: 'DELETE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { fields, version: existing.version },
    });
    return { conditionTable: key };
  });
}
