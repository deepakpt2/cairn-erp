/** SCR-005: assert counters, company identity, change evidence and refusal state. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTenant, destroyTenant, withTenant, closeDb, type TestTenant } from './helpers';
import { maintainNumberRange, listNumberRanges, type NumberRangeInput } from '@/modules/foundation/number-ranges';
import { upsertCompanyCode } from '@/modules/foundation/services';
import { allocateNumber, defineRange } from '@/platform/numbering';
import { postJournalEntry } from '@/platform/posting';

let tenant: TestTenant;
let serial = 0;
const year = new Date().getUTCFullYear();
beforeEach(async () => { tenant = await createTenant(`range-maintenance-${++serial}`); });
afterEach(async () => { await destroyTenant(tenant.client); });
afterAll(closeDb);

function input(patch: Partial<NumberRangeInput> = {}): NumberRangeInput {
  return { client: tenant.client, objectCode: 'JOURNAL_ENTRY', companyCode: '1000', subObject: 'GENERAL', fiscalYear: 0,
    prefix: 'JE', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE',
    mode: 'CREATE', reason: 'Initial setup for test', changedBy: 'RANGE_ADMIN', ...patch };
}
function allocate(fiscalYear = year) {
  return withTenant(tenant.client, (tx) => allocateNumber(tx, { client: tenant.client, objectCode: 'JOURNAL_ENTRY', companyCode: '1000', subObject: 'GENERAL', fiscalYear, allocatedBy: 'TEST' }));
}
function post(companyCode = '1000', documentType = 'SA') {
  return withTenant(tenant.client, (tx) => postJournalEntry(tx, {
    client: tenant.client, companyCode, documentType,
    documentDate: `${year}-04-15`, postingDate: `${year}-04-15`, fiscalYear: year, postingPeriod: 4,
    currency: 'USD', localCurrency: 'USD', reference: 'RANGE-TEST', postedBy: 'TEST',
    lines: [{ glAccount: '100000', debitCredit: 'S', amount: '100.0000' }, { glAccount: '200000', debitCredit: 'H', amount: '100.0000' }],
  }));
}

async function range(fiscalYear = 0) {
  return (await listNumberRanges(tenant.client)).ranges.find((r) => r.objectCode === 'JOURNAL_ENTRY' && r.companyCode === '1000' && r.subObject === 'GENERAL' && r.fiscalYear === fiscalYear)!;
}

describe('number range maintenance', () => {
  it('makes missing accounting setup ready without consuming a number', async () => {
    const before = await listNumberRanges(tenant.client);
    expect(before.readiness.ready).toBe(false);
    expect(before.readiness.missing[0]).toEqual({ companyCode: '1000', subObject: 'GENERAL', state: 'MISSING' });
    const saved = await maintainNumberRange(input());
    expect(saved.readiness.ready).toBe(true);
    expect((await range()).currentNumber).toBe(0);
  });

  it('shares an assigned interval across accounting document types', async () => {
    await maintainNumberRange(input());
    const first = await post('1000', 'SA');
    const second = await post('1000', 'KR');
    expect(first.displayNumber).toBe(`JE-${year}-000001`);
    expect(second.displayNumber).toBe(`JE-${year}-000002`);
    expect(first.documentNumber).toBe(`1000/${year}/1`);
    const evidence = await withTenant(tenant.client, (tx) => tx.execute(sql`select document_id, range_fiscal_year from number_range_allocation order by allocated_number`));
    expect((evidence as unknown as Array<{ document_id: string; range_fiscal_year: number }>)[0]).toEqual({ document_id: first.documentNumber, range_fiscal_year: 0 });
  });

  it('issues the same display number in different companies without identity collisions', async () => {
    await upsertCompanyCode({ client: tenant.client, companyCode: '2000', name: 'Second company', chartOfAccounts: 'CAIRN', fiscalYearVariant: 'K4', postingPeriodVariant: 'C001', currency: 'USD', country: 'KW', changedBy: 'TEST' });
    await maintainNumberRange(input());
    await maintainNumberRange(input({ companyCode: '2000' }));
    const first = await post('1000'); const second = await post('2000');
    expect(first.displayNumber).toBe(second.displayNumber);
    expect(first.documentNumber).not.toBe(second.documentNumber);
    const docs = await withTenant(tenant.client, (tx) => tx.execute(sql`select company_code, document_key from document_index order by company_code`));
    expect((docs as unknown as unknown[]).length).toBe(2);
  });

  it('records actor, reason, before/after values and control-change flags', async () => {
    await maintainNumberRange(input());
    await maintainNumberRange(input({ mode: 'CHANGE', status: 'BLOCKED', reason: 'Suspend posting for investigation' }));
    const docs = await withTenant(tenant.client, (tx) => tx.execute(sql`select d.changed_by, d.reason, i.old_value, i.new_value, i.is_security_relevant from change_document d join change_document_item i on i.change_document_id = d.id where d.change_type = 'BLOCK' and i.field_name = 'status'`));
    expect((docs as unknown as Array<Record<string, string>>)[0]).toEqual({ changed_by: 'RANGE_ADMIN', reason: 'Suspend posting for investigation', old_value: 'ACTIVE', new_value: 'BLOCKED', is_security_relevant: 'true' });
    expect((await listNumberRanges(tenant.client)).readiness.ready).toBe(false);
  });

  it('extends an exhausted interval without resetting its counter', async () => {
    await maintainNumberRange(input({ toNumber: 2 }));
    await allocate(); await allocate();
    await expect(allocate()).rejects.toThrow('exhausted');
    await maintainNumberRange(input({ mode: 'CHANGE', toNumber: 3 }));
    expect((await allocate()).value).toBe(3);
  });

  it('rejects shrinking below a number already issued', async () => {
    await maintainNumberRange(input()); await allocate(); await allocate();
    await expect(maintainNumberRange(input({ mode: 'CHANGE', toNumber: 1 }))).rejects.toThrow('last issued number 2');
    expect((await range()).toNumber).toBe(999999);
  });

  it('never resets a counter on a duplicate create or forged counter field', async () => {
    await maintainNumberRange(input()); await allocate();
    await expect(maintainNumberRange(input())).rejects.toThrow('already exists');
    await maintainNumberRange({ ...input({ mode: 'CHANGE' }), currentNumber: 0 } as NumberRangeInput);
    expect((await range()).currentNumber).toBe(1);
  });

  it.each([
    { fromNumber: 2 }, { prefix: 'OTHER' }, { numberLength: 7 }, { displayStyle: 'CLASSIC' as const },
  ])('keeps existing lower limits and presentation immutable: %j', async (patch) => {
    await maintainNumberRange(input()); await allocate();
    await expect(maintainNumberRange(input({ mode: 'CHANGE', ...patch }))).rejects.toThrow('immutable');
    expect((await range()).currentNumber).toBe(1);
  });

  it.each([
    { fromNumber: 0 }, { fromNumber: 10, toNumber: 9 }, { toNumber: Number.MAX_SAFE_INTEGER + 1 },
    { fromNumber: Number.NaN }, { fiscalYear: 1.5 }, { numberLength: 5 }, { reason: '' },
  ])('rejects malformed intervals before writing: %j', async (patch) => {
    await expect(maintainNumberRange(input(patch))).rejects.toThrow();
    expect((await listNumberRanges(tenant.client)).ranges).toHaveLength(0);
  });

  it('reserves blocked intervals and refuses overlapping range keys', async () => {
    await maintainNumberRange(input({ status: 'BLOCKED' }));
    await expect(maintainNumberRange(input({ subObject: 'OTHER' }))).rejects.toThrow('overlaps');
    await expect(allocate()).rejects.toThrow('BLOCKED');
    expect((await range()).currentNumber).toBe(0);
  });

  it('serialises concurrent creates across different keys before overlap validation', async () => {
    const outcomes = await Promise.allSettled([
      maintainNumberRange(input({ subObject: 'ONE' })), maintainNumberRange(input({ subObject: 'TWO' })),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect((await listNumberRanges(tenant.client)).ranges).toHaveLength(1);
  });

  it('refuses a blocked specific year instead of bypassing it via a fallback', async () => {
    await maintainNumberRange(input({ toNumber: 2 }));
    await maintainNumberRange(input({ fiscalYear: year, fromNumber: 3, toNumber: 4, status: 'BLOCKED' }));
    await expect(allocate()).rejects.toThrow('BLOCKED');
    expect((await range()).currentNumber).toBe(0);
  });

  it('refuses an exhausted specific year without consuming fallback numbers', async () => {
    await maintainNumberRange(input({ toNumber: 2 }));
    await maintainNumberRange(input({ fiscalYear: year, fromNumber: 3, toNumber: 4 }));
    expect((await allocate()).value).toBe(3);
    expect((await allocate()).value).toBe(4);
    await expect(allocate()).rejects.toThrow('exhausted');
    expect((await range()).currentNumber).toBe(0);
  });

  it('cannot automatically allocate from an external interval', async () => {
    await withTenant(tenant.client, (tx) => defineRange(tx, { client: tenant.client, objectCode: 'JOURNAL_ENTRY', companyCode: '1000', subObject: 'GENERAL', isExternal: true, createdBy: 'TEST' }));
    await expect(allocate()).rejects.toThrow('externally supplied');
    expect((await range()).currentNumber).toBe(0);
  });

  it('requires a real company for accounting ranges and tenant-wide scope for operations', async () => {
    await expect(maintainNumberRange(input({ companyCode: '*' }))).rejects.toThrow('require a company');
    await expect(maintainNumberRange(input({ companyCode: '9999' }))).rejects.toThrow('does not exist');
    await expect(maintainNumberRange(input({ objectCode: 'PURCHASE_ORDER' }))).rejects.toThrow('tenant-wide');
  });

  it('keeps classic presentation separate from immutable identity', async () => {
    await maintainNumberRange(input({ displayStyle: 'CLASSIC' }));
    const doc = await post();
    expect(doc.displayNumber).toBe('000001');
    expect(doc.documentNumber).toBe(`1000/${year}/1`);
  });
});
