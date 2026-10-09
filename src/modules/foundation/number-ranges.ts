/** Number range maintenance — SCR-005, CAIRN.md §9.3, D-043/D-046. */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../../platform/db/client';
import { numberRange, numberRangeAllocation } from '../../platform/tables/numbering';
import { configActivityStatus } from '../../platform/tables/registry';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { companyCode, documentType } from './schema';
import { ConfigError } from './services';

export const NUMBER_OBJECTS = [
  'JOURNAL_ENTRY', 'MATERIAL_DOCUMENT', 'PURCHASE_ORDER', 'PURCHASE_REQUISITION',
  'SALES_ORDER', 'DELIVERY', 'BILLING_DOCUMENT', 'PRODUCTION_ORDER',
  'PRODUCTION_CONFIRMATION', 'PAYMENT_RUN', 'VENDOR_INVOICE', 'MATERIAL', 'BUSINESS_PARTNER',
] as const;
export const NUMBER_RANGE_ACTIVITY = 'CFG.PLT.NUMBERRANGE.DEFINE';

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
  const types = await tx.select().from(documentType).where(and(eq(documentType.isActive, true), eq(documentType.numberRangeObject, 'JOURNAL_ENTRY')));
  const ranges = await tx.select().from(numberRange).where(eq(numberRange.objectCode, 'JOURNAL_ENTRY'));
  const missing: Array<{ companyCode: string; subObject: string; state: string }> = [];
  for (const company of companies) {
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
  if ((input.objectCode === 'JOURNAL_ENTRY') === (input.companyCode === '*')) {
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
    if (before?.isExternal || before?.isBuffered) throw new ConfigError('External or buffered interval maintenance is not supported by this screen.', 'Use an internal, unbuffered interval.');
    if (before && input.toNumber < before.currentNumber) throw new ConfigError(`The upper limit cannot be below the last issued number ${before.currentNumber}.`, 'Extend the interval; issued numbers are never removed or reused.');
    if (before && (before.fromNumber !== input.fromNumber || before.prefix !== input.prefix || before.displayStyle !== input.displayStyle || before.numberLength !== input.numberLength)) {
      throw new ConfigError('The lower limit and display format of an existing interval are immutable.', 'Create a new, non-overlapping interval. You may extend the upper limit or change its status.');
    }
    const others = await tx.select().from(numberRange).where(and(eq(numberRange.objectCode, input.objectCode), eq(numberRange.companyCode, input.companyCode)));
    const overlap = others.find((r) => rangeKey(r) !== rangeKey(input)
      && (r.fiscalYear === input.fiscalYear || r.fiscalYear === 0 || input.fiscalYear === 0)
      && (input.objectCode === 'JOURNAL_ENTRY' || r.subObject === input.subObject || r.prefix === input.prefix || r.displayStyle === 'CLASSIC' || input.displayStyle === 'CLASSIC')
      && r.fromNumber <= input.toNumber && r.toNumber >= input.fromNumber);
    if (overlap) throw new ConfigError(`The interval overlaps ${rangeKey(overlap)} (${overlap.fromNumber}–${overlap.toNumber}).`, 'Use disjoint limits. Year-independent ranges also cover every fiscal year. Blocked ranges still reserve their numbers.');

    const values = {
      objectCode: input.objectCode, companyCode: input.companyCode, subObject: input.subObject,
      fiscalYear: input.fiscalYear, prefix: input.prefix, fromNumber: input.fromNumber,
      toNumber: input.toNumber, numberLength: input.numberLength, displayStyle: input.displayStyle,
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
      securityRelevantFields: ['fromNumber', 'toNumber', 'status'],
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
