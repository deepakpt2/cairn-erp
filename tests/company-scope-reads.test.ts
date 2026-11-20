/**
 * Company-scope authorization of the ledger, document and subledger READS that were reachable by capability alone:
 * G/L balances (single and multi-company), line items, document display and number resolution, asset history,
 * subledger tie-out, vendor/customer balances and ageing, and the export adapter that re-uses them.
 *
 * Companies A (1000) and B (2000) in one tenant, a second tenant, real persisted sessions. A refusal must not
 * disclose the other company's figures, and a group/range request is refused as a whole, never trimmed.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry, type PostedJournal } from '../src/platform/posting';
import { getGlBalances, getGlBalanceReport } from '../src/modules/finance/gl-balances';
import { getJournalItems } from '../src/modules/finance/journal-items';
import { getJournalDocument, resolveDocumentNumber } from '../src/modules/finance/document-display';
import { getAssetHistorySheet } from '../src/modules/finance/asset-history';
import { calculateSubledgerTie } from '../src/modules/finance/subledger-tie-out';
import { getVendorBalances } from '../src/modules/finance/vendor-balances';
import { getCustomerBalances } from '../src/modules/finance/customer-balances';
import { getVendorAgeing } from '../src/modules/finance/vendor-ageing';
import { getCustomerAgeing } from '../src/modules/finance/customer-ageing';
import { glBalancesExport } from '../src/modules/finance/report-exports';
import { createFinanceActor, FINANCE_ACTOR_CAPABILITIES, type FinanceActor } from './helpers/finance-actor';
import { closeDb, createTenant, defineTestRanges, destroyTenant, seedAccounts, type TestTenant } from './helpers';

const ACTOR = 'SCOPE-READ';
const A = '1000';
const B = '2000';

let tenant: TestTenant;
let other: TestTenant;
let client = '';
let onlyA: FinanceActor;
let onlyB: FinanceActor;
let both: FinanceActor;
let noCapability: FinanceActor;
let noScope: FinanceActor;
let plantLimited: FinanceActor;
let otherTenantActor: FinanceActor;
let docA: PostedJournal;
let docB: PostedJournal;

async function postDoc(company: string, amount: string): Promise<PostedJournal> {
  return withTenant(client, (tx) => postJournalEntry(tx, {
    client, companyCode: company, documentType: 'SA', documentDate: '2026-10-01', postingDate: '2026-10-02',
    fiscalYear: 2026, postingPeriod: 10, currency: 'USD', localCurrency: 'USD', headerText: `B-SECRET ${company}`,
    postedBy: ACTOR,
    lines: [
      { glAccount: '100000', debitCredit: 'S', amount },
      { glAccount: '200000', debitCredit: 'H', amount },
    ],
  }));
}

/** The refusal is thrown, names no figure or text of the other company, and is not an existence message. */
async function refusal(p: Promise<unknown>, pattern: RegExp = /scope|Company Code|capabilit|authori|session|signed-in|no longer active|not hold|No company/i) {
  try { await p; } catch (error) {
    expect((error as Error).message).toMatch(pattern);
    expect((error as Error).message).not.toMatch(/B-SECRET|does not stand|not configured/);
    return error as Error;
  }
  throw new Error('Expected a refusal, nothing was thrown.');
}

const bal = (a: FinanceActor | undefined, company: string) =>
  getGlBalances(client, { authorization: a?.authorization, glAccount: '100000', companyCode: company, fiscalYear: 2026 });
const report = (a: FinanceActor | undefined, companies: string[]) => getGlBalanceReport(client, {
  authorization: a?.authorization, companyCodes: companies, accountFrom: '100000', accountTo: '200000', fiscalYear: 2026,
  periodFrom: 1, periodTo: 12, includeSpecialPeriods: false, ledger: '0L',
});
const items = (a: FinanceActor | undefined, companies: string[]) => getJournalItems(client, {
  authorization: a?.authorization, accountFrom: '100000', accountTo: '200000', companyCodes: companies, status: 'ALL',
});
const docOf = (a: FinanceActor | undefined, company: string, d: PostedJournal) => getJournalDocument(client, {
  authorization: a?.authorization, documentNumber: d.documentNumber, companyCode: company, fiscalYear: 2026,
});
const assets = (a: FinanceActor | undefined, from: string, to?: string) => getAssetHistorySheet(client, {
  authorization: a?.authorization, companyCodeFrom: from, companyCodeTo: to, fiscalYear: 2026, depreciationArea: '01',
});
const tie = (a: FinanceActor | undefined, company: string) => calculateSubledgerTie({
  client, authorization: a?.authorization,
  selection: { companyCode: company, fiscalYear: 2026, periodTo: 12, ledger: '0L' },
});
const vendorBal = (a: FinanceActor | undefined, company: string) => getVendorBalances(client, {
  authorization: a?.authorization, supplier: 'NOSUCH', companyCode: company, fiscalYear: 2026,
});
const customerBal = (a: FinanceActor | undefined, company: string) => getCustomerBalances(client, {
  authorization: a?.authorization, customer: 'NOSUCH', companyCode: company, fiscalYear: 2026,
});
const vendorAge = (a: FinanceActor | undefined, company: string) => getVendorAgeing(client, {
  authorization: a?.authorization, companyCode: company, keyDate: '2026-12-31',
});
const customerAge = (a: FinanceActor | undefined, company: string) => getCustomerAgeing(client, {
  authorization: a?.authorization, companyCode: company, keyDate: '2026-12-31',
});

beforeAll(async () => {
  tenant = await createTenant('scope-read');
  client = tenant.client;
  other = await createTenant('scope-read-2');
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await seedAccounts(tenant, ['100000', '200000']);
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by)
      select client, ${B}, 'B-SECRET company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${ACTOR}
        from company_code where client = ${client} and company_code = ${A} on conflict do nothing`);
    for (const account of ['100000', '200000']) {
      await tx.execute(sql`
        insert into gl_account_company (client, company_code, chart_of_accounts, gl_account, account_currency, created_by)
        select client, ${B}, chart_of_accounts, ${account}, 'USD', ${ACTOR}
          from company_code where client = ${client} and company_code = ${B} on conflict do nothing`);
    }
    await defineRange(tx, { client, objectCode: 'RF_BELEG', companyCode: B, subObject: 'GENERAL', fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999_999, createdBy: ACTOR });
    const country = ((await tx.execute(sql`select country from company_code where client = ${client} and company_code = ${A}`)) as unknown as Array<{ country: string }>)[0]!.country;
    await tx.execute(sql`
      insert into plant (client, plant, name, country, company_code, created_by)
      values (${client}, 'PLA1', 'Plant A1', ${country}, ${A}, ${ACTOR}), (${client}, 'PLA2', 'Plant A2', ${country}, ${A}, ${ACTOR}) on conflict do nothing`);
  });
  docA = await postDoc(A, '100.0000');
  docB = await postDoc(B, '9000.0000');
  const caps = FINANCE_ACTOR_CAPABILITIES;
  onlyA = await createFinanceActor(client, { capabilities: caps, companyScopes: [A] });
  onlyB = await createFinanceActor(client, { capabilities: caps, companyScopes: [B] });
  both = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B] });
  noCapability = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.POST'], companyScopes: [A, B] });
  noScope = await createFinanceActor(client, { capabilities: caps, companyScopes: [] });
  plantLimited = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B], plantScopes: ['PLA1'] });
  otherTenantActor = await createFinanceActor(other.client, { capabilities: caps });
}, 300_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 180_000);

describe('G/L balances', () => {
  it('reads the actor\'s own company and refuses the other company', async () => {
    expect((await bal(onlyA, A)).companyCode).toBe(A);
    expect((await bal(onlyB, B)).yearDebit).toBe(9000);
    await refusal(bal(onlyA, B), /does not cover company code 2000/);
    await refusal(bal(onlyB, A), /does not cover company code 1000/);
  });

  it('refuses a multi-company report as a whole, and serves it to a user covering every company', async () => {
    await refusal(report(onlyA, [A, B]), /does not cover company code 2000/);
    const ok = await report(both, [A, B]);
    expect(JSON.stringify(ok)).toContain('9000');
    expect(JSON.stringify(await report(onlyA, [A]))).not.toContain('9000');
  });

  it('refuses a missing authorization, capability, scope, a plant-limited user and another tenant\'s user', async () => {
    for (const actor of [undefined, noCapability, noScope, plantLimited, otherTenantActor]) {
      await refusal(bal(actor, A));
      await refusal(report(actor, [A]));
    }
  });
});

describe('G/L line items', () => {
  it('shows only the company the actor may read and refuses a request naming another', async () => {
    const ownA = await items(onlyA, [A]);
    expect(JSON.stringify(ownA)).not.toContain('9000');
    await refusal(items(onlyA, [A, B]), /does not cover company code 2000/);
    await refusal(items(onlyA, [B]));
    expect(JSON.stringify(await items(both, [A, B]))).toContain('9000');
  });

  it('refuses without authorization, capability, scope, with a plant limit, or from another tenant', async () => {
    for (const actor of [undefined, noCapability, noScope, plantLimited, otherTenantActor]) await refusal(items(actor, [A]));
  });
});

describe('document display', () => {
  it('shows an own-company document and hides the other company\'s as not found', async () => {
    expect((await docOf(onlyA, A, docA)).kind).toBe('FOUND');
    expect((await docOf(onlyA, B, docB)).kind).toBe('NOT_FOUND');
    expect((await docOf(onlyB, B, docB)).kind).toBe('FOUND');
  });

  it('does not reveal in which company a document stands unless both are in scope', async () => {
    // docB asked for under A: a user covering both is told where it stands; a user covering only A is not.
    expect((await docOf(both, A, docB)).kind).toBe('COMPANY_MISMATCH');
    expect((await docOf(onlyA, A, docB)).kind).toBe('NOT_FOUND');
  });

  it('resolves a bare number only among documents the actor may read', async () => {
    expect(await resolveDocumentNumber(client, docB.documentNumber, onlyA.authorization)).toBeNull();
    expect(await resolveDocumentNumber(client, docA.documentNumber, onlyA.authorization)).toEqual({ companyCode: A, fiscalYear: 2026 });
    expect(await resolveDocumentNumber(client, docB.documentNumber, onlyB.authorization)).toEqual({ companyCode: B, fiscalYear: 2026 });
  });

  it('refuses without authorization, capability, scope or from another tenant', async () => {
    for (const actor of [undefined, noCapability, noScope, otherTenantActor]) {
      await refusal(docOf(actor, A, docA));
      await refusal(resolveDocumentNumber(client, docA.documentNumber, actor?.authorization));
    }
  });
});

describe('asset history, subledger tie-out, balances and ageing', () => {
  it('refuses a company range as a whole when any company in it is out of scope', async () => {
    await refusal(assets(onlyA, A, B), /company code range|Company Code scope/i);
    await refusal(assets(onlyA, B));
    await expect(assets(both, A, B)).resolves.toBeTruthy();
  });

  it('refuses the other company for every subledger and ageing read', async () => {
    for (const call of [tie, vendorBal, customerBal, vendorAge, customerAge]) {
      await refusal(call(onlyA, B), /does not cover company code 2000/);
      await refusal(call(onlyB, A), /does not cover company code 1000/);
    }
  });

  it('refuses every one of them without authorization, capability, scope, with a plant limit, or from another tenant', async () => {
    for (const call of [tie, vendorBal, customerBal, vendorAge, customerAge]) {
      for (const actor of [undefined, noCapability, noScope, plantLimited, otherTenantActor]) await refusal(call(actor, A));
    }
    for (const actor of [undefined, noCapability, noScope, plantLimited, otherTenantActor]) await refusal(assets(actor, A));
  });
});

describe('export adapter', () => {
  it('judges the same scope as the screen', async () => {
    const q = new URLSearchParams({ reportCompanies: `${A},${B}`, accountFrom: '100000', accountTo: '200000', reportFiscalYear: '2026' });
    await refusal(glBalancesExport.build(client, q, onlyA.authorization), /does not cover company code 2000/);
    await refusal(glBalancesExport.build(client, q, undefined));
    await expect(glBalancesExport.build(client, q, both.authorization)).resolves.toBeTruthy();
  });
});
