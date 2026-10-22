/** Number range maintenance — SCR-005, CAIRN.md §9.3, D-043/D-046. */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../../platform/db/client';
import { numberRange, numberRangeAllocation, numberRangeObject } from '../../platform/tables/numbering';
import { configActivityStatus } from '../../platform/tables/registry';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { companyCode, documentType } from './schema';
import { hasCompanyCodeAssignments } from './company-code-assignments';
import { ConfigError } from './services';

export const NUMBER_OBJECTS = [
  'RF_BELEG', 'MATDOC', 'PURCHORD', 'PURCHREQ',
  'SALESORD', 'DELIVERY', 'BILLING', 'PRODORDER',
  'PRODCONF', 'PAYRUN', 'VENDINV', 'CUSTINV', 'CUSTDPREQ', 'VENDDPREQ', 'PARKDOC', 'ASSETNR', 'MATERIALNR', 'BUSPARTNR', 'PHYINV', 'INFOREC', 'SOURCELIST', 'QUOTAARR', 'RFQEVENT', 'RFQ', 'QUOTATION', 'PARKINV',
] as const;
export const NUMBER_RANGE_ACTIVITY = 'CFG.PLT.NUMBERRANGE.DEFINE';

/**
 * The standing objects and their provisioned registry facts (SCR-050).
 * Object names are application-owned; tenants maintain the facts and
 * the intervals, never the roster.
 */
export const NUMBER_OBJECT_DEFAULTS: ReadonlyArray<{
  objectCode: (typeof NUMBER_OBJECTS)[number];
  description: string;
  numberLength: number;
  yearRelevant: boolean;
  subobjectHint: string | null;
}> = [
  { objectCode: 'RF_BELEG', description: 'Accounting documents', numberLength: 10, yearRelevant: true, subobjectHint: 'Company code' },
  { objectCode: 'MATDOC', description: 'Material documents', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'MATERIALNR', description: 'Material master records', numberLength: 18, yearRelevant: false, subobjectHint: 'Number range group' },
  { objectCode: 'PURCHORD', description: 'Purchase orders', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'PURCHREQ', description: 'Purchase requisitions', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'SALESORD', description: 'Sales orders', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'DELIVERY', description: 'Deliveries', numberLength: 8, yearRelevant: false, subobjectHint: null },
  { objectCode: 'BILLING', description: 'Billing documents', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'PRODORDER', description: 'Production orders', numberLength: 12, yearRelevant: false, subobjectHint: null },
  { objectCode: 'PRODCONF', description: 'Production confirmations', numberLength: 12, yearRelevant: false, subobjectHint: null },
  { objectCode: 'PAYRUN', description: 'Payment runs', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'VENDINV', description: 'Vendor invoices', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'CUSTINV', description: 'Customer invoices', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'CUSTDPREQ', description: 'Customer down payment requests', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'VENDDPREQ', description: 'Vendor down payment requests', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'PARKDOC', description: 'Parked journal documents', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'ASSETNR', description: 'Fixed asset master numbers', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'BUSPARTNR', description: 'Business partners', numberLength: 10, yearRelevant: false, subobjectHint: null },
  { objectCode: 'PHYINV', description: 'Physical inventory documents', numberLength: 10, yearRelevant: true, subobjectHint: null },
  { objectCode: 'INFOREC', description: 'Purchasing info records', numberLength: 7, yearRelevant: false, subobjectHint: null },
  { objectCode: 'SOURCELIST', description: 'Purchasing source lists', numberLength: 7, yearRelevant: false, subobjectHint: null },
  { objectCode: 'QUOTAARR', description: 'Purchasing quota arrangements', numberLength: 7, yearRelevant: false, subobjectHint: null },
  { objectCode: 'RFQEVENT', description: 'Sourcing events', numberLength: 7, yearRelevant: false, subobjectHint: null },
  { objectCode: 'RFQ', description: 'Requests for quotation', numberLength: 7, yearRelevant: false, subobjectHint: null },
  { objectCode: 'QUOTATION', description: 'Supplier quotations', numberLength: 7, yearRelevant: false, subobjectHint: null },
  { objectCode: 'PARKINV', description: 'Parked supplier invoices', numberLength: 7, yearRelevant: false, subobjectHint: null },
];

/** Seed the object registry for a tenant being provisioned. */
export async function seedNumberRangeObjects(tx: Tx, client: string, createdBy: string) {
  const { numberRangeObject } = await import('../../platform/tables/numbering');
  for (const object of NUMBER_OBJECT_DEFAULTS) {
    await tx
      .insert(numberRangeObject)
      .values({ client, ...object, createdBy })
      .onConflictDoNothing();
  }
}

const maintenanceSchema = z.object({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  objectCode: z.enum(NUMBER_OBJECTS),
  companyCode: z.string().min(1).max(10),
  subObject: z.string().regex(/^[A-Z0-9_*.-]{1,24}$/),
  fiscalYear: z.number().int().refine((n) => n === 0 || (n >= 1900 && n <= 9999), 'Use 0 or a four-digit fiscal year.'),
  prefix: z.string().regex(/^[A-Z0-9-]{0,12}$/),
  fromNumber: z.number().int().safe().positive(),
  toNumber: z.number().int().safe().positive(),
  numberLength: z.number().int().min(1).max(16),
  displayStyle: z.enum(['READABLE', 'CLASSIC']),
  isExternal: z.boolean().default(false),
  isBuffered: z.boolean().default(false),
  bufferSize: z.number().int().min(0).max(100000).default(0),
  status: z.enum(['ACTIVE', 'BLOCKED']),
  mode: z.enum(['CREATE', 'CHANGE']),
  reason: z.string().trim().min(3).max(500),
  changedBy: z.string().min(1).max(60),
}).refine((i) => i.toNumber >= i.fromNumber, { message: 'The upper limit must not be below the lower limit.', path: ['toNumber'] })
  .refine((i) => String(i.toNumber).length <= i.numberLength, { message: 'The display width must fit the upper limit.', path: ['numberLength'] });

export type NumberRangeInput = z.input<typeof maintenanceSchema>;
export type NumberRangeRow = typeof numberRange.$inferSelect;
export function rangeKey(r: Pick<NumberRangeRow, 'objectCode' | 'companyCode' | 'subObject' | 'fiscalYear'>) {
  return `${r.objectCode}/${r.companyCode}/${r.subObject}/${r.fiscalYear}`;
}

function predicate(client: string, input: Pick<NumberRangeRow, 'objectCode' | 'companyCode' | 'subObject' | 'fiscalYear'>) {
  return and(eq(numberRange.client, client), eq(numberRange.objectCode, input.objectCode),
    eq(numberRange.companyCode, input.companyCode), eq(numberRange.subObject, input.subObject),
    eq(numberRange.fiscalYear, input.fiscalYear));
}

export async function listNumberRanges(client: string) {
  return withTenant(client, async (tx) => ({
    ranges: await tx.select().from(numberRange).orderBy(numberRange.objectCode, numberRange.companyCode, numberRange.subObject, numberRange.fiscalYear),
    companies: await tx.select().from(companyCode).orderBy(companyCode.companyCode),
    types: await tx.select().from(documentType).where(eq(documentType.isActive, true)).orderBy(documentType.documentType),
    readiness: await journalRangeReadiness(tx, client),
  }));
}

/** The same resolution rules as allocation; a blocked specific year never falls back. */
export async function journalRangeReadiness(tx: Tx, client: string, fiscalYear = new Date().getUTCFullYear()) {
  const companies = await tx.select().from(companyCode).where(eq(companyCode.isActive, true));
  const types = await tx.select().from(documentType).where(and(eq(documentType.isActive, true), eq(documentType.numberRangeObject, 'RF_BELEG')));
  const ranges = await tx.select().from(numberRange).where(eq(numberRange.objectCode, 'RF_BELEG'));
  const missing: Array<{ companyCode: string; subObject: string; state: string }> = [];
  for (const company of companies) {
    if (!hasCompanyCodeAssignments(company)) {
      missing.push({ companyCode: company.companyCode, subObject: 'ASSIGNMENTS', state: 'ASSIGNMENTS_INCOMPLETE' });
      continue;
    }
    for (const subObject of new Set(types.map((t) => t.numberRangeSubObject))) {
      const candidates = ranges.filter((r) => r.companyCode === company.companyCode && r.subObject === subObject);
      const range = candidates.find((r) => r.fiscalYear === fiscalYear) ?? candidates.find((r) => r.fiscalYear === 0);
      const state = !range ? 'MISSING' : range.status !== 'ACTIVE' ? 'BLOCKED'
        : range.isExternal ? 'EXTERNAL' : range.currentNumber >= range.toNumber ? 'EXHAUSTED' : 'READY';
      if (state !== 'READY') missing.push({ companyCode: company.companyCode, subObject, state });
    }
  }
  return { fiscalYear, ready: companies.length > 0 && types.length > 0 && missing.length === 0, missing };
}

export async function maintainNumberRange(raw: NumberRangeInput) {
  const parsed = maintenanceSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`${issue.path.join('.') || 'Interval'}: ${issue.message}`, 'Correct the indicated field and save again.');
  }
  const input = parsed.data;
  const { client, changedBy } = input;
  if ((input.objectCode === 'RF_BELEG') === (input.companyCode === '*')) {
    throw new ConfigError('Accounting intervals require a company code; operational intervals are tenant-wide (*).', 'Choose the correct scope for the object.');
  }

  return withTenant(client, async (tx) => {
    // Serialise ALL interval definitions within one object/scope, not only one
    // key. Otherwise concurrent creates for different keys can both pass overlap
    // validation. The row lock additionally serialises editing with allocation.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/range/${input.objectCode}/${input.companyCode}`}, 0))`);
    if (input.companyCode !== '*') {
      const company = await tx.select().from(companyCode).where(eq(companyCode.companyCode, input.companyCode));
      if (!company[0]?.isActive) throw new ConfigError(`Company code ${input.companyCode} is not active or does not exist.`, 'Define the company code before its accounting interval.');
    }
    const existing = await tx.select().from(numberRange).where(predicate(client, input)).for('update');
    const before = existing[0];
    if (input.mode === 'CREATE' && before) throw new ConfigError('This interval already exists.', 'Open its Change action. Creating it again will never reset its counter.');
    if (input.mode === 'CHANGE' && !before) throw new ConfigError('This interval no longer exists.', 'Refresh the monitor and select an existing interval.');
    if (input.isBuffered && input.bufferSize < 1) throw new ConfigError('A buffered interval needs a numbers-in-buffer quantity of at least 1.', 'Enter how many numbers each block reserves.');
    if (before && (input.isExternal !== before.isExternal || input.isBuffered !== before.isBuffered || (before.isBuffered && input.bufferSize !== before.bufferSize))) {
      throw new ConfigError('External assignment and buffering are set when an interval is created and never change under it.', 'Create a new interval with the assignment you need; issued numbers keep the behaviour they were given under.');
    }
    if (before && input.toNumber < before.currentNumber) throw new ConfigError(`The upper limit cannot be below the last issued number ${before.currentNumber}.`, 'Extend the interval; issued numbers are never removed or reused.');
    if (before && (before.fromNumber !== input.fromNumber || before.prefix !== input.prefix || before.displayStyle !== input.displayStyle || before.numberLength !== input.numberLength)) {
      throw new ConfigError('The lower limit and display format of an existing interval are immutable.', 'Create a new, non-overlapping interval. You may extend the upper limit or change its status.');
    }
    const others = await tx.select().from(numberRange).where(and(eq(numberRange.objectCode, input.objectCode), eq(numberRange.companyCode, input.companyCode)));
    const overlap = others.find((r) => rangeKey(r) !== rangeKey(input)
      && (r.fiscalYear === input.fiscalYear || r.fiscalYear === 0 || input.fiscalYear === 0)
      && (input.objectCode === 'RF_BELEG' || r.subObject === input.subObject || r.prefix === input.prefix || r.displayStyle === 'CLASSIC' || input.displayStyle === 'CLASSIC')
      && r.fromNumber <= input.toNumber && r.toNumber >= input.fromNumber);
    if (overlap) throw new ConfigError(`The interval overlaps ${rangeKey(overlap)} (${overlap.fromNumber}–${overlap.toNumber}).`, 'Use disjoint limits. Year-independent ranges also cover every fiscal year. Blocked ranges still reserve their numbers.');

    const values = {
      objectCode: input.objectCode, companyCode: input.companyCode, subObject: input.subObject,
      fiscalYear: input.fiscalYear, prefix: input.prefix, fromNumber: input.fromNumber,
      toNumber: input.toNumber, numberLength: input.numberLength, displayStyle: input.displayStyle,
      isExternal: input.isExternal, isBuffered: input.isBuffered,
      bufferSize: input.isBuffered ? input.bufferSize : 0,
      status: input.status,
    };
    if (before) {
      await tx.update(numberRange).set({ toNumber: input.toNumber, status: input.status, changedBy, changedAt: new Date() }).where(predicate(client, input));
    } else {
      await tx.insert(numberRange).values({ ...values, client, currentNumber: input.fromNumber - 1, createdBy: changedBy });
    }
    const snapshot = before ? Object.fromEntries(Object.keys(values).map((k) => [k, before[k as keyof NumberRangeRow]])) : undefined;
    await recordChange(tx, {
      client, objectClass: 'number_range', objectKey: rangeKey(input),
      changeType: !before ? 'CREATE' : before.status !== input.status ? input.status === 'BLOCKED' ? 'BLOCK' : 'UNBLOCK' : 'CHANGE',
      changedBy, transactionCode: NUMBER_RANGE_ACTIVITY, reason: input.reason,
      before: snapshot, after: values,
      securityRelevantFields: ['fromNumber', 'toNumber', 'status', 'isExternal', 'isBuffered', 'bufferSize'],
    });
    const readiness = await journalRangeReadiness(tx, client);
    if (readiness.ready) await markActivityComplete(tx, client, NUMBER_RANGE_ACTIVITY, changedBy);
    else await tx.update(configActivityStatus).set({ status: 'NOT_STARTED', changedBy, changedAt: new Date() }).where(and(eq(configActivityStatus.client, client), eq(configActivityStatus.activityCode, NUMBER_RANGE_ACTIVITY)));
    return { key: rangeKey(input), created: !before, readiness };
  });
}

export async function rangeAllocations(client: string, range: NumberRangeRow) {
  return withTenant(client, (tx) => tx.select().from(numberRangeAllocation).where(and(
    eq(numberRangeAllocation.objectCode, range.objectCode), eq(numberRangeAllocation.companyCode, range.companyCode),
    eq(numberRangeAllocation.subObject, range.subObject), eq(numberRangeAllocation.rangeFiscalYear, range.fiscalYear),
  )).orderBy(sql`${numberRangeAllocation.allocatedAt} desc`).limit(50));
}

// ── Object registry and the guarded current-number act (SCR-050) ──────

export interface NumberRangeObjectRow {
  objectCode: string;
  description: string;
  numberLength: number;
  warningPercent: string | null;
  yearRelevant: boolean;
  subobjectHint: string | null;
  intervalCount: number;
}

export async function listNumberRangeObjects(client: string): Promise<NumberRangeObjectRow[]> {
  return withTenant(client, async (tx) => {
    const objects = await tx
      .select()
      .from(numberRangeObject)
      .where(eq(numberRangeObject.client, client))
      .orderBy(numberRangeObject.objectCode);
    const out: NumberRangeObjectRow[] = [];
    for (const o of objects) {
      const intervals = await tx
        .select({ objectCode: numberRange.objectCode })
        .from(numberRange)
        .where(and(eq(numberRange.client, client), eq(numberRange.objectCode, o.objectCode)));
      out.push({
        objectCode: o.objectCode,
        description: o.description,
        numberLength: o.numberLength,
        warningPercent: o.warningPercent,
        yearRelevant: o.yearRelevant,
        subobjectHint: o.subobjectHint,
        intervalCount: intervals.length,
      });
    }
    return out;
  });
}

export interface NumberRangeObjectInput {
  client: string;
  changedBy: string;
  objectCode: string;
  description: string;
  numberLength: number;
  warningPercent: string;
  yearRelevant: boolean;
  subobjectHint: string;
  reason: string;
}

export async function saveNumberRangeObject(input: NumberRangeObjectInput) {
  const reason = input.reason?.trim() ?? '';
  if (!reason) throw new ConfigError('A reason is required for every number range object change.', 'State why this change is being made.');
  const description = input.description?.trim() ?? '';
  if (!description || description.length > 60) throw new ConfigError('The description is required and may be at most 60 characters.', 'Enter a description within the limit and save again.');
  if (!Number.isInteger(input.numberLength) || input.numberLength < 1 || input.numberLength > 40) throw new ConfigError('The number length is between 1 and 40.', 'Enter the length the object formats its numbers to.');
  const warningRaw = input.warningPercent?.trim() ?? '';
  let warningPercent: string | null = null;
  if (warningRaw) {
    const parsed = Number(warningRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) throw new ConfigError('The consumption warning is a percentage above 0 and below 100.', 'Enter the percentage of an interval that may be consumed before it is flagged.');
    warningPercent = parsed.toFixed(1);
  }
  const subobjectHint = input.subobjectHint?.trim() || null;
  if (subobjectHint && subobjectHint.length > 30) throw new ConfigError('The subobject hint may be at most 30 characters.', 'Shorten the hint and save again.');

  return withTenant(input.client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(numberRangeObject)
      .where(and(eq(numberRangeObject.client, input.client), eq(numberRangeObject.objectCode, input.objectCode)))
      .for('update');
    if (!existing) throw new ConfigError(`Number range object ${input.objectCode} does not stand.`, 'Object names belong to the application; the registry describes the objects it numbers from.');
    const values = { description, numberLength: input.numberLength, warningPercent, yearRelevant: input.yearRelevant, subobjectHint };
    const unchanged = existing.description === values.description
      && existing.numberLength === values.numberLength
      && existing.warningPercent === values.warningPercent
      && existing.yearRelevant === values.yearRelevant
      && existing.subobjectHint === values.subobjectHint;
    if (unchanged) return { objectCode: input.objectCode, changed: false };
    await tx.update(numberRangeObject).set({ ...values, changedBy: input.changedBy, changedAt: new Date() })
      .where(and(eq(numberRangeObject.client, input.client), eq(numberRangeObject.objectCode, input.objectCode)));
    await recordChange(tx, {
      client: input.client, objectClass: 'number_range_object', objectKey: input.objectCode,
      changeType: 'CHANGE', changedBy: input.changedBy, reason,
      transactionCode: NUMBER_RANGE_ACTIVITY,
      before: { ...existing }, after: { ...values },
      securityRelevantFields: ['numberLength', 'warningPercent', 'yearRelevant'],
    });
    const readiness = await journalRangeReadiness(tx, input.client);
    if (readiness.ready) await markActivityComplete(tx, input.client, NUMBER_RANGE_ACTIVITY, input.changedBy);
    return { objectCode: input.objectCode, changed: true };
  });
}

export interface AdjustCurrentInput {
  client: string;
  changedBy: string;
  objectCode: (typeof NUMBER_OBJECTS)[number];
  companyCode: string;
  subObject: string;
  fiscalYear: number;
  currentNumber: number;
  reason: string;
}

/**
 * The guarded NRLEVEL act (R-98): the current number may be set anywhere
 * within the interval's bounds, as its own act, with the repetition
 * warning when the target would re-issue numbers already given out.
 */
export async function adjustNumberRangeCurrent(input: AdjustCurrentInput) {
  const reason = input.reason?.trim() ?? '';
  if (!reason) throw new ConfigError('A reason is required to adjust a current number.', 'State why the counter is being set by hand.');
  if (!Number.isSafeInteger(input.currentNumber) || input.currentNumber < 0) throw new ConfigError('The current number is a whole number of 0 or more.', 'Enter the last number the interval should consider issued.');
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/range/${input.objectCode}/${input.companyCode}`}, 0))`);
    const [range] = await tx.select().from(numberRange).where(and(
      eq(numberRange.client, input.client), eq(numberRange.objectCode, input.objectCode),
      eq(numberRange.companyCode, input.companyCode), eq(numberRange.subObject, input.subObject),
      eq(numberRange.fiscalYear, input.fiscalYear),
    )).for('update');
    if (!range) throw new ConfigError('This interval no longer exists.', 'Refresh the monitor and select an existing interval.');
    if (input.currentNumber < range.fromNumber - 1 || input.currentNumber > range.toNumber) {
      throw new ConfigError(`The current number must stand between ${range.fromNumber - 1} (nothing issued) and ${range.toNumber} (the upper limit).`, 'Enter a value inside the interval.');
    }
    const allocations = await tx.select({ n: numberRangeAllocation.allocatedNumber }).from(numberRangeAllocation).where(and(
      eq(numberRangeAllocation.client, input.client), eq(numberRangeAllocation.objectCode, input.objectCode),
      eq(numberRangeAllocation.companyCode, input.companyCode), eq(numberRangeAllocation.subObject, input.subObject),
      eq(numberRangeAllocation.rangeFiscalYear, input.fiscalYear),
    ));
    const lastIssued = allocations.reduce((max, a) => Math.max(max, Number(a.n)), 0);
    const wouldRepeat = input.currentNumber < lastIssued;
    if (input.currentNumber === range.currentNumber) return { key: rangeKey(range), changed: false, wouldRepeat, lastIssued };
    await tx.update(numberRange).set({ currentNumber: input.currentNumber, changedBy: input.changedBy, changedAt: new Date() }).where(predicate(input.client, {
      objectCode: input.objectCode, companyCode: input.companyCode, subObject: input.subObject, fiscalYear: input.fiscalYear,
    }));
    await recordChange(tx, {
      client: input.client, objectClass: 'number_range', objectKey: rangeKey(range),
      changeType: 'CHANGE', changedBy: input.changedBy, reason,
      transactionCode: NUMBER_RANGE_ACTIVITY,
      before: { currentNumber: range.currentNumber }, after: { currentNumber: input.currentNumber },
      securityRelevantFields: ['currentNumber'],
    });
    const readiness = await journalRangeReadiness(tx, input.client);
    if (readiness.ready) await markActivityComplete(tx, input.client, NUMBER_RANGE_ACTIVITY, input.changedBy);
    return { key: rangeKey(range), changed: true, wouldRepeat, lastIssued };
  });
}
