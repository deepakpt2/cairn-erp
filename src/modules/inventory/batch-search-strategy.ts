/**
 * MBC1, MBC2, and MBC3 — Inventory Management batch search strategy.
 *
 * Usage is H. Application is ME. The strategy type must already stand on
 * OMCW and name an access sequence. The key combination is a condition
 * table named by that sequence. The key fields are that table's fields.
 * They are not hard-coded.
 *
 * The record number is KNUMH. Validity is DATAB and DATBI. A selection
 * class, a sort rule, and a quantity proposal are not stored. Naming a
 * key does not select a batch.
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { bpRole, businessPartner } from '../foundation/business-partner-schema';
import { plant, storageLocation } from '../foundation/schema';
import { ALLOWED_FIELDS } from './batch-condition-table';
import {
  batchAccessStep,
  batchConditionTableField,
  batchLevelConfiguration,
  batchSearchStrategy,
  batchSearchStrategyKey,
  batchStrategyType,
  material,
  materialGroup,
  materialPlant,
  materialType,
  movementType,
} from './schema';

export const ACTIVITY = 'INV.BATCHSTRATEGY.MAINTAIN';
export const ROUTE = '/inventory/batch-search-strategies';
export const ALIAS = 'MBC1';
export const CHANGE_ALIAS = 'MBC2';
export const DISPLAY_ALIAS = 'MBC3';
export const LOCK_OBJECT = 'BATCH_SEARCH_STRATEGY';
export const USAGE = 'H';
export const APPLICATION = 'ME';

const TITLES = new Map(ALLOWED_FIELDS.map((item) => [item.field, item.title]));

export const NOT_EXECUTED = [
  {
    field: 'CLINT',
    title: 'Selection class',
    reason: 'Class type 023 is not active. A selection class is not stored, and it does not filter a batch.',
  },
  {
    field: 'SRTSQ',
    title: 'Sort rule',
    reason: 'No sort rule stands. FEFO is not assumed, and this record does not rank a batch.',
  },
  {
    field: 'CHMVS',
    title: 'Quantity proposal',
    reason: 'No quantity proposal runs. A batch split is not stored.',
  },
  {
    field: 'DETERMINATION',
    title: 'Batch determination',
    reason: 'A standing record is not consumed by a goods movement. No batch is proposed.',
  },
] as const;

export class BatchSearchStrategyError extends Error {
  readonly code:
    | 'AUTHORITY_REQUIRED'
    | 'TYPE_UNKNOWN'
    | 'COMBINATION_UNKNOWN'
    | 'KEY_UNKNOWN'
    | 'KEY_REQUIRED'
    | 'KEY_REFUSED'
    | 'STOCK_UNKNOWN'
    | 'BATCH_REQUIRED'
    | 'PERIOD_UNKNOWN'
    | 'OVERLAP'
    | 'RECORD_UNKNOWN'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'CONFIRM_REQUIRED'
    | 'TRANSPORT_REFUSED'
    | 'SCOPE_REFUSED'
    | 'CONTROL_REFUSED'
    | 'DETERMINATION_NOT_EXECUTED';

  constructor(message: string, code: BatchSearchStrategyError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchSearchStrategyError';
    this.code = code;
  }
}

export interface StrategyKeyValue {
  field: string;
  title: string;
  value: string;
  position: number;
}

export interface BatchSearchStrategyRow {
  recordNumber: string;
  strategyType: string;
  conditionTable: string;
  validFrom: string;
  validTo: string;
  usage: typeof USAGE;
  application: typeof APPLICATION;
  version: number;
  keys: StrategyKeyValue[];
  changedBy: string | null;
  changedAt: Date | null;
}

export interface KeyCombination {
  strategyType: string;
  description: string;
  accessSequence: string;
  conditionTable: string;
  fields: Array<{ field: string; title: string; position: number }>;
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchSearchStrategyError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. MBC1 does not use a second permission code.',
    );
  }
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new BatchSearchStrategyError('A reason is required.', 'REASON_REQUIRED', 'Say why this search strategy is being saved.');
  }
  return text;
}

function dateOf(value: string | undefined, label: string): string {
  const text = (value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new BatchSearchStrategyError(
      `${label} ${text || 'blank'} is not a date. Nothing was saved.`,
      'PERIOD_UNKNOWN',
      'Use a date as YYYY-MM-DD. Valid from must not be later than valid to.',
    );
  }
  return text;
}

function periodOf(from: string | undefined, to: string | undefined): { validFrom: string; validTo: string } {
  const validFrom = dateOf(from, 'Valid from');
  const validTo = dateOf(to, 'Valid to');
  if (validFrom > validTo) {
    throw new BatchSearchStrategyError(
      `Valid from ${validFrom} is later than valid to ${validTo}. Nothing was saved.`,
      'PERIOD_UNKNOWN',
      'Enter a period that starts on or before it ends.',
    );
  }
  return { validFrom, validTo };
}

function refuseExtras(input: {
  transportRequest?: string;
  usage?: string;
  application?: string;
  selectionClass?: string;
  sortRule?: string;
  quantityProposal?: string;
  splits?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchSearchStrategyError('A transport is refused. MBC1 does not write a transport request.', 'TRANSPORT_REFUSED', 'Save the search strategy in this client.');
  }
  const usage = (input.usage ?? '').trim().toUpperCase();
  const application = (input.application ?? '').trim().toUpperCase();
  if ((usage && usage !== USAGE) || (application && application !== APPLICATION)) {
    throw new BatchSearchStrategyError(
      `Usage ${usage || USAGE} and application ${application || APPLICATION} are refused. MBC1 stores usage H and application ME only.`,
      'SCOPE_REFUSED',
      'Production and sales search strategies are not this screen.',
    );
  }
  const sent = [input.selectionClass, input.sortRule, input.quantityProposal, input.splits].find((value) => value?.trim());
  if (sent) {
    throw new BatchSearchStrategyError(
      `Control ${sent.trim()} is not stored. It does not select or sort a batch.`,
      'CONTROL_REFUSED',
      'Leave the selection class, sort rule, and quantity proposal unset. Class type 023 is not active.',
    );
  }
}

function overlaps(leftFrom: string, leftTo: string, rightFrom: string, rightTo: string): boolean {
  return leftFrom <= rightTo && rightFrom <= leftTo;
}

async function nextRecordNumber(tx: Tx, client: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext('BATCH_SEARCH_STRATEGY/NUMBER'))`);
  const [row] = await tx.select({
    recordNumber: sql<string>`coalesce(max(${batchSearchStrategy.recordNumber}), '0000000000')`,
  }).from(batchSearchStrategy).where(eq(batchSearchStrategy.client, client));
  const next = Number(row?.recordNumber ?? '0') + 1;
  if (!Number.isSafeInteger(next) || next > 9999999999) {
    throw new BatchSearchStrategyError('No further record number is available. Nothing was saved.', 'RECORD_UNKNOWN', 'The record number is ten digits.');
  }
  return String(next).padStart(10, '0');
}

async function combinationOf(tx: Tx, client: string, strategyType: string, conditionTable: string): Promise<Array<{ field: string; position: number }>> {
  const type = strategyType.trim().toUpperCase();
  const table = conditionTable.trim();
  const [standing] = await tx.select({
    accessSequence: batchStrategyType.accessSequence,
  }).from(batchStrategyType).where(and(
    eq(batchStrategyType.client, client),
    eq(batchStrategyType.usage, USAGE),
    eq(batchStrategyType.application, APPLICATION),
    eq(batchStrategyType.strategyType, type),
  )).limit(1).for('update');
  if (!standing) {
    throw new BatchSearchStrategyError(
      `Strategy type ${type || 'blank'} does not stand. Nothing was saved.`,
      'TYPE_UNKNOWN',
      'Create it on OMCW first. MBC1 does not invent a strategy type.',
    );
  }
  if (!standing.accessSequence) {
    throw new BatchSearchStrategyError(
      `Strategy type ${type} has no access sequence. Nothing was saved.`,
      'COMBINATION_UNKNOWN',
      'Name an access sequence on OMCW. A key combination is not hard-coded.',
    );
  }
  const [access] = await tx.select({
    accessNumber: batchAccessStep.accessNumber,
  }).from(batchAccessStep).where(and(
    eq(batchAccessStep.client, client),
    eq(batchAccessStep.usage, USAGE),
    eq(batchAccessStep.application, APPLICATION),
    eq(batchAccessStep.accessSequence, standing.accessSequence),
    eq(batchAccessStep.conditionTable, table),
  )).limit(1);
  if (!access) {
    throw new BatchSearchStrategyError(
      `Condition table ${table || 'blank'} is not a key combination of strategy type ${type}. Nothing was saved.`,
      'COMBINATION_UNKNOWN',
      'Choose a table named by the access sequence. MBC1 does not hard-code the keys.',
    );
  }
  const fields = await tx.select({
    field: batchConditionTableField.fieldName,
    position: batchConditionTableField.position,
  }).from(batchConditionTableField).where(and(
    eq(batchConditionTableField.client, client),
    eq(batchConditionTableField.usage, USAGE),
    eq(batchConditionTableField.conditionTable, table),
  )).orderBy(asc(batchConditionTableField.position));
  if (fields.length === 0) {
    throw new BatchSearchStrategyError(
      `Condition table ${table} has no key fields. Nothing was saved.`,
      'COMBINATION_UNKNOWN',
      'Maintain the key fields on OMA1 first.',
    );
  }
  return fields.map((row) => ({ field: row.field, position: row.position }));
}

async function assertValue(tx: Tx, client: string, field: string, value: string, keys: Map<string, string>): Promise<void> {
  const missing = (title: string) => new BatchSearchStrategyError(
    `${title} ${value} does not stand. Nothing was saved.`,
    'KEY_UNKNOWN',
    'Choose a value that already stands in this client.',
  );
  if (field === 'BWART') {
    const [row] = await tx.select({ movementType: movementType.movementType }).from(movementType).where(and(
      eq(movementType.client, client), eq(movementType.movementType, value),
    )).limit(1);
    if (!row) throw missing('Movement type');
    return;
  }
  if (field === 'WERKS') {
    const [row] = await tx.select({ isActive: plant.isActive }).from(plant).where(and(
      eq(plant.client, client), eq(plant.plant, value),
    )).limit(1);
    if (!row || !row.isActive) throw missing('Plant');
    return;
  }
  if (field === 'LGORT') {
    const plantKey = keys.get('WERKS');
    const rows = await tx.select({ isActive: storageLocation.isActive }).from(storageLocation).where(and(
      eq(storageLocation.client, client),
      eq(storageLocation.storageLocation, value),
      ...(plantKey ? [eq(storageLocation.plant, plantKey)] : []),
    )).limit(1);
    if (!rows[0]?.isActive) throw missing('Storage location');
    return;
  }
  if (field === 'MATNR') {
    const [row] = await tx.select({
      isBlocked: material.isBlocked,
      batchManaged: material.batchManaged,
    }).from(material).where(and(
      eq(material.client, client), eq(material.materialNumber, value),
    )).limit(1);
    if (!row || row.isBlocked) throw missing('Material');
    const [level] = await tx.select({ batchLevel: batchLevelConfiguration.batchLevel }).from(batchLevelConfiguration).where(
      eq(batchLevelConfiguration.client, client),
    ).limit(1);
    const plantKey = keys.get('WERKS');
    if (level?.batchLevel === '0') {
      const views = await tx.select({ batchManaged: materialPlant.batchManaged }).from(materialPlant).where(and(
        eq(materialPlant.client, client),
        eq(materialPlant.materialNumber, value),
        ...(plantKey ? [eq(materialPlant.plant, plantKey)] : []),
        eq(materialPlant.batchManaged, true),
      )).limit(1);
      if (!views[0]) {
        throw new BatchSearchStrategyError(
          `Material ${value} is not batch-managed. Nothing was saved.`,
          'BATCH_REQUIRED',
          'Set the batch-management indicator before using the material as a strategy key.',
        );
      }
      return;
    }
    if (!row.batchManaged) {
      throw new BatchSearchStrategyError(
        `Material ${value} is not batch-managed. Nothing was saved.`,
        'BATCH_REQUIRED',
        'Set the batch-management indicator before using the material as a strategy key.',
      );
    }
    return;
  }
  if (field === 'MTART') {
    const [row] = await tx.select({ isActive: materialType.isActive }).from(materialType).where(and(
      eq(materialType.client, client), eq(materialType.materialType, value),
    )).limit(1);
    if (!row?.isActive) throw missing('Material type');
    return;
  }
  if (field === 'MATKL') {
    const [row] = await tx.select({ isActive: materialGroup.isActive }).from(materialGroup).where(and(
      eq(materialGroup.client, client), eq(materialGroup.materialGroup, value),
    )).limit(1);
    if (!row?.isActive) throw missing('Material group');
    return;
  }
  if (field === 'KUNNR' || field === 'LIFNR') {
    const role = field === 'KUNNR' ? 'CUSTOMER' : 'SUPPLIER';
    const [row] = await tx.select({ isBlocked: businessPartner.isBlocked }).from(businessPartner).innerJoin(bpRole, and(
      eq(bpRole.client, businessPartner.client),
      eq(bpRole.partnerNumber, businessPartner.partnerNumber),
      eq(bpRole.roleCode, role),
      eq(bpRole.isActive, true),
    )).where(and(
      eq(businessPartner.client, client),
      eq(businessPartner.partnerNumber, value),
    )).limit(1);
    if (!row || row.isBlocked) throw missing(field === 'KUNNR' ? 'Customer' : 'Supplier');
    return;
  }
  if (field === 'SOBKZ') {
    throw new BatchSearchStrategyError(
      `Special stock ${value} does not stand. Nothing was saved.`,
      'STOCK_UNKNOWN',
      'This application does not invent a special stock. Choose another key combination.',
    );
  }
  throw new BatchSearchStrategyError(
    `Field ${field} is not a key of this condition table. Nothing was saved.`,
    'KEY_REFUSED',
    'Use only the fields of the selected key combination.',
  );
}

async function keysOf(tx: Tx, client: string, fields: Array<{ field: string; position: number }>, raw: Record<string, string>): Promise<StrategyKeyValue[]> {
  const allowed = new Set(fields.map((row) => row.field));
  const extra = Object.keys(raw).find((field) => raw[field]?.trim() && !allowed.has(field));
  if (extra) {
    throw new BatchSearchStrategyError(
      `Field ${extra} is not part of this key combination. Nothing was saved.`,
      'KEY_REFUSED',
      'Send only the fields of the selected condition table.',
    );
  }
  const values = new Map<string, string>();
  const built: StrategyKeyValue[] = [];
  for (const field of fields) {
    const value = (raw[field.field] ?? '').trim().toUpperCase();
    if (!value || value.length > 40 || value.includes('|') || value.includes('=')) {
      throw new BatchSearchStrategyError(
        `${TITLES.get(field.field) ?? field.field} is required. Nothing was saved.`,
        'KEY_REQUIRED',
        'Enter every field of the selected key combination. A field is mandatory only when the combination names it.',
      );
    }
    values.set(field.field, value);
    await assertValue(tx, client, field.field, value, values);
    built.push({ field: field.field, title: TITLES.get(field.field) ?? field.field, value, position: field.position });
  }
  return built;
}

function fingerprintOf(keys: StrategyKeyValue[]): string {
  return [...keys].sort((left, right) => left.position - right.position).map((key) => `${key.field}=${key.value}`).join('|');
}

async function assertNoOverlap(tx: Tx, client: string, strategyType: string, conditionTable: string, fingerprint: string, validFrom: string, validTo: string, except?: string): Promise<void> {
  const rows = await tx.select({
    recordNumber: batchSearchStrategy.recordNumber,
    validFrom: batchSearchStrategy.validFrom,
    validTo: batchSearchStrategy.validTo,
  }).from(batchSearchStrategy).where(and(
    eq(batchSearchStrategy.client, client),
    eq(batchSearchStrategy.strategyType, strategyType),
    eq(batchSearchStrategy.conditionTable, conditionTable),
    eq(batchSearchStrategy.keyFingerprint, fingerprint),
    ...(except ? [ne(batchSearchStrategy.recordNumber, except)] : []),
  ));
  const hit = rows.find((row) => overlaps(validFrom, validTo, row.validFrom, row.validTo));
  if (hit) {
    throw new BatchSearchStrategyError(
      `Search strategy ${hit.recordNumber} already covers ${hit.validFrom} to ${hit.validTo}. Nothing was saved.`,
      'OVERLAP',
      'Use a period that does not overlap. A second record for the same key is not guessed.',
    );
  }
}

async function keysFor(tx: Tx, client: string, recordNumber: string): Promise<StrategyKeyValue[]> {
  const rows = await tx.select({
    field: batchSearchStrategyKey.fieldName,
    value: batchSearchStrategyKey.fieldValue,
    position: batchSearchStrategyKey.position,
  }).from(batchSearchStrategyKey).where(and(
    eq(batchSearchStrategyKey.client, client),
    eq(batchSearchStrategyKey.recordNumber, recordNumber),
  )).orderBy(asc(batchSearchStrategyKey.position));
  return rows.map((row) => ({ field: row.field, title: TITLES.get(row.field) ?? row.field, value: row.value, position: row.position }));
}

function rowOf(row: {
  recordNumber: string;
  strategyType: string;
  conditionTable: string;
  validFrom: string;
  validTo: string;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}, keys: StrategyKeyValue[]): BatchSearchStrategyRow {
  return {
    recordNumber: row.recordNumber,
    strategyType: row.strategyType,
    conditionTable: row.conditionTable,
    validFrom: row.validFrom,
    validTo: row.validTo,
    usage: USAGE,
    application: APPLICATION,
    version: row.version,
    keys,
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

export async function listStrategyKeyCombinations(client: string): Promise<KeyCombination[]> {
  return withTenant(client, async (tx) => {
    const types = await tx.select({
      strategyType: batchStrategyType.strategyType,
      description: batchStrategyType.description,
      accessSequence: batchStrategyType.accessSequence,
    }).from(batchStrategyType).where(and(
      eq(batchStrategyType.client, client),
      eq(batchStrategyType.usage, USAGE),
      eq(batchStrategyType.application, APPLICATION),
    )).orderBy(asc(batchStrategyType.strategyType));
    const combinations: KeyCombination[] = [];
    for (const type of types) {
      if (!type.accessSequence) continue;
      const steps = await tx.select({
        conditionTable: batchAccessStep.conditionTable,
      }).from(batchAccessStep).where(and(
        eq(batchAccessStep.client, client),
        eq(batchAccessStep.usage, USAGE),
        eq(batchAccessStep.application, APPLICATION),
        eq(batchAccessStep.accessSequence, type.accessSequence),
      )).orderBy(asc(batchAccessStep.accessNumber));
      for (const step of steps) {
        const fields = await tx.select({
          field: batchConditionTableField.fieldName,
          position: batchConditionTableField.position,
        }).from(batchConditionTableField).where(and(
          eq(batchConditionTableField.client, client),
          eq(batchConditionTableField.usage, USAGE),
          eq(batchConditionTableField.conditionTable, step.conditionTable),
        )).orderBy(asc(batchConditionTableField.position));
        combinations.push({
          strategyType: type.strategyType,
          description: type.description,
          accessSequence: type.accessSequence,
          conditionTable: step.conditionTable,
          fields: fields.map((field) => ({ field: field.field, title: TITLES.get(field.field) ?? field.field, position: field.position })),
        });
      }
    }
    return combinations;
  });
}

export async function listBatchSearchStrategies(client: string): Promise<BatchSearchStrategyRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(batchSearchStrategy).where(eq(batchSearchStrategy.client, client)).orderBy(asc(batchSearchStrategy.recordNumber));
    const listed: BatchSearchStrategyRow[] = [];
    for (const row of rows) listed.push(rowOf(row, await keysFor(tx, client, row.recordNumber)));
    return listed;
  });
}

export async function resolveBatchSearchStrategy(input: {
  client: string;
  strategyType: string;
  conditionTable: string;
  keys: Record<string, string>;
  date: string;
}): Promise<BatchSearchStrategyRow | null> {
  const date = dateOf(input.date, 'Date');
  const type = input.strategyType.trim().toUpperCase();
  const table = input.conditionTable.trim();
  return withTenant(input.client, async (tx) => {
    let fields: Array<{ field: string; position: number }>;
    try {
      fields = await combinationOf(tx, input.client, type, table);
    } catch (error) {
      if (error instanceof BatchSearchStrategyError && (error.code === 'TYPE_UNKNOWN' || error.code === 'COMBINATION_UNKNOWN')) return null;
      throw error;
    }
    const fingerprint = fingerprintOf(fields.map((field) => ({
      field: field.field,
      title: field.field,
      value: (input.keys[field.field] ?? '').trim().toUpperCase(),
      position: field.position,
    })));
    const rows = await tx.select().from(batchSearchStrategy).where(and(
      eq(batchSearchStrategy.client, input.client),
      eq(batchSearchStrategy.strategyType, type),
      eq(batchSearchStrategy.conditionTable, table),
      eq(batchSearchStrategy.keyFingerprint, fingerprint),
    ));
    const hits = rows.filter((row) => row.validFrom <= date && date <= row.validTo);
    if (hits.length === 0) return null;
    if (hits.length > 1) {
      throw new BatchSearchStrategyError(
        `More than one search strategy covers ${date}. No record was chosen.`,
        'OVERLAP',
        'Keep one validity period for the key. Determination does not guess.',
      );
    }
    return rowOf(hits[0], await keysFor(tx, input.client, hits[0].recordNumber));
  });
}

/** A caller that asks for a batch is told that none is proposed. Posting does not call this. */
export async function determineBatch(input: {
  client: string;
  strategyType: string;
  conditionTable: string;
  keys: Record<string, string>;
  date: string;
}): Promise<never> {
  const found = await resolveBatchSearchStrategy(input);
  throw new BatchSearchStrategyError(
    found
      ? `Search strategy ${found.recordNumber} stands, and no batch was proposed.`
      : `No search strategy stands for ${input.strategyType.trim().toUpperCase() || 'blank'} on ${input.date}. No batch was proposed.`,
    'DETERMINATION_NOT_EXECUTED',
    'Selection criteria and a sort rule do not stand. Enter the batch on the goods movement. This record does not select one.',
  );
}

export async function saveBatchSearchStrategy(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  strategyType: string;
  conditionTable: string;
  keys?: Record<string, string>;
  validFrom: string;
  validTo: string;
  recordNumber?: string;
  expectedVersion?: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  usage?: string;
  application?: string;
  selectionClass?: string;
  sortRule?: string;
  quantityProposal?: string;
  splits?: string;
}): Promise<BatchSearchStrategyRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const type = input.strategyType.trim().toUpperCase();
  const table = input.conditionTable.trim();
  const period = periodOf(input.validFrom, input.validTo);
  return withTenant(input.client, async (tx) => {
    if (input.mode === 'CREATE') {
      const fields = await combinationOf(tx, input.client, type, table);
      const keys = await keysOf(tx, input.client, fields, input.keys ?? {});
      const fingerprint = fingerprintOf(keys);
      await assertNoOverlap(tx, input.client, type, table, fingerprint, period.validFrom, period.validTo);
      if (!input.confirmed) {
        throw new BatchSearchStrategyError('The change was not confirmed. Nothing was saved.', 'CONFIRM_REQUIRED', 'Confirm the save. No batch is selected and no stock is posted.');
      }
      const reason = reasonOf(input.reason);
      const recordNumber = await nextRecordNumber(tx, input.client);
      const now = new Date();
      await tx.insert(batchSearchStrategy).values({
        client: input.client, recordNumber, usage: USAGE, application: APPLICATION,
        strategyType: type, conditionTable: table, keyFingerprint: fingerprint,
        validFrom: period.validFrom, validTo: period.validTo, version: 1,
        createdBy: input.changedBy, changedBy: input.changedBy, changedAt: now,
      });
      for (const key of keys) {
        await tx.insert(batchSearchStrategyKey).values({
          client: input.client, recordNumber, fieldName: key.field, fieldValue: key.value, position: key.position,
        });
      }
      await recordChange(tx, {
        client: input.client, objectClass: 'batch_search_strategy', objectKey: recordNumber,
        changeType: 'CREATE', changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
        after: { strategyType: type, conditionTable: table, validFrom: period.validFrom, validTo: period.validTo, keys },
      });
      return { recordNumber, strategyType: type, conditionTable: table, ...period, usage: USAGE, application: APPLICATION, version: 1, keys, changedBy: input.changedBy, changedAt: now };
    }
    const recordNumber = (input.recordNumber ?? '').trim();
    const [existing] = await tx.select().from(batchSearchStrategy).where(and(
      eq(batchSearchStrategy.client, input.client),
      eq(batchSearchStrategy.recordNumber, recordNumber),
    )).for('update');
    if (!existing) {
      throw new BatchSearchStrategyError(`Search strategy ${recordNumber || 'blank'} does not stand. Nothing was saved.`, 'RECORD_UNKNOWN', 'Choose a record from the list. MBC2 does not invent one.');
    }
    if (existing.strategyType !== type || existing.conditionTable !== table) {
      throw new BatchSearchStrategyError('The strategy type and key combination cannot be changed. Nothing was saved.', 'KEY_REFUSED', 'Delete the record and create another. The key is not rewritten.');
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchSearchStrategyError(
        `Search strategy ${recordNumber} was opened at version ${input.expectedVersion ?? 'blank'}, and version ${existing.version} now stands. Nothing was saved.`,
        'VERSION_STALE', 'Open the search strategy again.',
      );
    }
    const keys = await keysFor(tx, input.client, recordNumber);
    if (existing.validFrom === period.validFrom && existing.validTo === period.validTo) return rowOf(existing, keys);
    await assertNoOverlap(tx, input.client, type, table, existing.keyFingerprint, period.validFrom, period.validTo, recordNumber);
    if (!input.confirmed) {
      throw new BatchSearchStrategyError('The change was not confirmed. Nothing was saved.', 'CONFIRM_REQUIRED', 'Confirm the save. No batch is selected and no stock is posted.');
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const version = existing.version + 1;
    await tx.update(batchSearchStrategy).set({
      validFrom: period.validFrom, validTo: period.validTo, version, changedBy: input.changedBy, changedAt: now,
    }).where(and(eq(batchSearchStrategy.client, input.client), eq(batchSearchStrategy.recordNumber, recordNumber)));
    await recordChange(tx, {
      client: input.client, objectClass: 'batch_search_strategy', objectKey: recordNumber,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
      before: { validFrom: existing.validFrom, validTo: existing.validTo, version: existing.version },
      after: { validFrom: period.validFrom, validTo: period.validTo, version },
    });
    return { recordNumber, strategyType: type, conditionTable: table, ...period, usage: USAGE, application: APPLICATION, version, keys, changedBy: input.changedBy, changedAt: now };
  });
}

export async function deleteBatchSearchStrategy(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  recordNumber: string;
  expectedVersion: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
}): Promise<{ recordNumber: string }> {
  assertAuthority(input.capabilities);
  if (input.transportRequest?.trim()) {
    throw new BatchSearchStrategyError('A transport is refused. MBC1 does not write a transport request.', 'TRANSPORT_REFUSED', 'Delete the search strategy in this client.');
  }
  const recordNumber = input.recordNumber.trim();
  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(batchSearchStrategy).where(and(
      eq(batchSearchStrategy.client, input.client),
      eq(batchSearchStrategy.recordNumber, recordNumber),
    )).for('update');
    if (!existing) {
      throw new BatchSearchStrategyError(`Search strategy ${recordNumber || 'blank'} does not stand. Nothing was deleted.`, 'RECORD_UNKNOWN', 'Choose a record from the list.');
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchSearchStrategyError(
        `Search strategy ${recordNumber} was opened at version ${input.expectedVersion}, and version ${existing.version} now stands. Nothing was deleted.`,
        'VERSION_STALE', 'Open the search strategy again.',
      );
    }
    if (!input.confirmed) {
      throw new BatchSearchStrategyError('The deletion was not confirmed. Nothing was deleted.', 'CONFIRM_REQUIRED', 'Confirm the deletion. No posted movement is rewritten.');
    }
    const reason = reasonOf(input.reason);
    const keys = await keysFor(tx, input.client, recordNumber);
    await tx.delete(batchSearchStrategyKey).where(and(
      eq(batchSearchStrategyKey.client, input.client),
      eq(batchSearchStrategyKey.recordNumber, recordNumber),
    ));
    await tx.delete(batchSearchStrategy).where(and(
      eq(batchSearchStrategy.client, input.client),
      eq(batchSearchStrategy.recordNumber, recordNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: 'batch_search_strategy', objectKey: recordNumber,
      changeType: 'DELETE', changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
      before: { strategyType: existing.strategyType, conditionTable: existing.conditionTable, validFrom: existing.validFrom, validTo: existing.validTo, keys },
    });
    return { recordNumber };
  });
}
