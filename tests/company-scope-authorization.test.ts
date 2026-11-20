/**
 * Company-scope authorization of company-wide finance reads and cross-company postings.
 *
 * Two companies (A = 1000, B = 2000) in one tenant with distinct figures, and a second tenant. Every call goes through the
 * real service boundary with a real, persisted session; nothing mocks `can()` or hands over a capability array.
 * A denial must leak no figure of the other company and, for postings, leave no journal, intercompany header or
 * change document behind.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { reportAdapter } from '../src/modules/output/report-registry';
import { calculateTrialBalance } from '../src/modules/finance/trial-balance';
import { calculateBalanceSheet } from '../src/modules/finance/balance-sheet';
import { calculateProfitLoss } from '../src/modules/finance/profit-loss';
import { calculateCashflow } from '../src/modules/finance/cash-flow';
import { calculateConsolidatedStatements } from '../src/modules/finance/consolidated-statements';
import { executeTaxReport, listTaxReturnRuns } from '../src/modules/finance/tax-report';
import {
  deleteIntercompanyConfig, listCompanyChoices, listIntercompanyConfigs, postIntercompany, saveIntercompanyConfig,
} from '../src/modules/finance/intercompany';
import {
  activateArea, assignUnit, saveArea, saveDataBasis, saveGroup, saveGroupAccount, saveMapping, saveMethod, saveTask, saveUnit, saveVersion,
} from '../src/modules/finance/consolidation-workbench';
import { authorizedCompanyCodes } from '../src/platform/auth/company-scope';
import { createFinanceActor, FINANCE_REPORT_CAPABILITIES, type FinanceActor } from './helpers/finance-actor';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCOPE-TEST';
const A = '1000';
const B = '2000';
const REPORT_CAPS = FINANCE_REPORT_CAPABILITIES;

let tenant: TestTenant;
let other: TestTenant;
let client = '';
let currency = 'USD';
let onlyA: FinanceActor;
let onlyB: FinanceActor;
let both: FinanceActor;
let noCapability: FinanceActor;
let plantLimited: FinanceActor;
let outsiderTenantActor: FinanceActor;

const auth = (a: FinanceActor) => a.authorization;

async function expectScopeRefusal(promise: Promise<unknown>, pattern: RegExp = /scope|Company Code/i) {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).toMatch(pattern);
    expect((error as Error).message).not.toMatch(/9000|9,000|5000\.|B-SECRET/);
    expect(JSON.stringify(error)).not.toMatch(/9000/);
    return error as Error & { remedy?: string };
  }
  throw new Error('Expected a refusal, nothing was thrown.');
}

async function journal(company: string, doc: string, amount: number) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into journal_entry (client, document_number, fiscal_year, document_type, company_code, document_date,
        posting_date, posting_period, document_currency, local_currency, status, created_by)
      values (${client}, ${doc}, 2026, 'SA', ${company}, '2026-04-10', '2026-04-10', 4, ${currency}, ${currency}, 'POSTED', ${ACTOR})`);
    await tx.execute(sql`
      insert into journal_entry_line (client, document_number, fiscal_year, line_number, gl_account, company_code,
        debit_credit, amount_local, amount_document, currency)
      values (${client}, ${doc}, 2026, 1, '101000', ${company}, 'S', ${amount}, ${amount}, ${currency}),
             (${client}, ${doc}, 2026, 2, '300000', ${company}, 'H', ${amount}, ${amount}, ${currency})`);
  });
}

const selection = (companyCode: string) => ({
  companyCode, statementVersion: 'T01', fiscalYear: 2026, periodFrom: 1, periodTo: 12,
  includeSpecialPeriods: false, ledger: '0L',
});
const sheetSelection = (companyCode: string) => ({ ...selection(companyCode), calculationType: 'COMBINED' as const, summaryLevel: 9 });
const cashSelection = (companyCodes: string[]) => ({ companyCodes, fiscalYear: 2026, periodFrom: 1, periodTo: 12, method: 'INDIRECT' as const, ledger: '0L', comparative: false });
const consSelection = (group: string) => ({ area: 'C100', group, version: '100', fiscalYear: 2026, period: 12, view: 'BALANCE_SHEET' as const, unit: '', comparative: false });
const taxSelection = (extra: Record<string, unknown> = {}) => ({
  companyCode: A, postingDateFrom: '2026-01-01', postingDateTo: '2026-12-31', taxReturnCountry: '', testRun: true,
  doNotUpdateDocuments: false, electronicReturn: false, correctedReturn: false, ...extra,
});
let country = '';

const icInput = (a: FinanceActor | undefined, over: Record<string, unknown> = {}) => ({
  client, changedBy: ACTOR, authorization: a ? auth(a) : undefined,
  sendingCompanyCode: A, receivingCompanyCode: B, postingDate: '2026-05-10', documentDate: '2026-05-10',
  documentType: 'SA', currency, reference: 'SCOPE-IC', confirmed: true, requestKey: 'scope-ic-1',
  lines: [{ glAccount: '500000', debitCredit: 'S' as const, amount: '5000', costCenter: 'CC1000' }],
  ...over,
});

async function counts() {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select (select count(*)::int from journal_entry where client = ${client}) as journals,
             (select count(*)::int from intercompany_document_header where client = ${client}) as ic,
             (select count(*)::int from change_document where client = ${client}) as changes`)) as unknown as Array<{ journals: number; ic: number; changes: number }>;
    return rows[0]!;
  });
}

beforeAll(async () => {
  tenant = await createTenant('scope-auth');
  client = tenant.client;
  other = await createTenant('scope-auth-2');
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`select currency, country from company_code where client = ${client} and company_code = ${A}`)) as unknown as Array<{ currency: string; country: string }>;
    currency = rows[0]?.currency ?? 'USD';
    country = rows[0]?.country ?? '';
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by)
      select client, ${B}, 'B-SECRET company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${ACTOR}
        from company_code where client = ${client} and company_code = ${A} on conflict do nothing`);
    for (const company of [A, B]) {
      for (const account of ['500000', '110100', '101000', '300000']) {
        await tx.execute(sql`
          insert into gl_account_company (client, company_code, chart_of_accounts, gl_account, account_currency, created_by)
          select client, ${company}, chart_of_accounts, ${account}, ${currency}, ${ACTOR}
            from company_code where client = ${client} and company_code = ${company} on conflict do nothing`);
      }
    }
    await tx.execute(sql`update gl_account set is_open_item_managed = true where client = ${client} and account_number = '110100'`);
    await tx.execute(sql`update gl_account_company set is_open_item_managed = true where client = ${client} and gl_account = '110100'`);
    await defineRange(tx, { client, objectCode: 'RF_BELEG', companyCode: B, subObject: 'GENERAL', fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999_999, createdBy: ACTOR });
    // Two plants of company A, so a user can hold only one of them.
    await tx.execute(sql`
      insert into plant (client, plant, name, country, company_code, created_by)
      values (${client}, 'PLA1', 'Plant A1', ${country}, ${A}, ${ACTOR}), (${client}, 'PLA2', 'Plant A2', ${country}, ${A}, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into financial_statement_version (client, version, name, chart_of_accounts, created_by) values (${client}, 'T01', 'Test', 'CA01', ${ACTOR})`);
    await tx.execute(sql`
      insert into financial_statement_node (client, version, node, description, parent_node, sequence, created_by) values
        (${client}, 'T01', 'BS', 'Balance sheet', null, 10, ${ACTOR}), (${client}, 'T01', 'ASSETS', 'Assets', 'BS', 10, ${ACTOR}),
        (${client}, 'T01', 'PL', 'Profit and loss', null, 20, ${ACTOR}), (${client}, 'T01', 'REVENUE', 'Revenue', 'PL', 10, ${ACTOR})`);
    await tx.execute(sql`
      insert into financial_statement_assignment (client, version, node, account_from, account_to, presentation_sign, created_by) values
        (${client}, 'T01', 'ASSETS', '100000', '199999', 'NORMAL', ${ACTOR}), (${client}, 'T01', 'REVENUE', '300000', '399999', 'INVERTED', ${ACTOR})`);
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, account_key, created_by)
      values (${client}, ${country}, 'I1', 'Input', 'VST', 10, 'VST', ${ACTOR}) on conflict do nothing`);
  });
  await journal(A, 'SCOPE-A-1', 5000);
  await journal(B, 'SCOPE-B-1', 9000);

  // Consolidation: group GRPA holds only company A's unit; GRPAB resolves to A and B from STORED data.
  const meta = { changedBy: ACTOR, reason: 'scope test' };
  const variant = await withTenant(client, async (tx) => ((await tx.execute(sql`select fiscal_year_variant from company_code where client = ${client} and company_code = ${A}`)) as unknown as Array<{ fiscal_year_variant: string }>)[0]!.fiscal_year_variant);
  await saveDataBasis({ client, ...meta, basis: 'BASIS1', title: 'Journal basis', dimensions: [{ dimension: 'COMPANY_CODE' }] });
  await saveArea({ client, ...meta, area: 'C100', title: 'Consolidation', dataBasis: 'BASIS1', consChart: 'GC01', fiscalYearVariant: variant });
  await saveUnit({ client, ...meta, area: 'C100', unit: 'UA', title: 'Unit A', companyCode: A });
  await saveUnit({ client, ...meta, area: 'C100', unit: 'UA2', title: 'Unit A two', companyCode: A });
  await saveUnit({ client, ...meta, area: 'C100', unit: 'UB', title: 'Unit B', companyCode: B });
  for (const group of ['GRPA', 'GRPAB']) await saveGroup({ client, ...meta, area: 'C100', group, title: group });
  await assignUnit({ client, ...meta, area: 'C100', group: 'GRPA', unit: 'UA', validFrom: '2025-01-01', validTo: '2026-12-31' });
  await assignUnit({ client, ...meta, area: 'C100', group: 'GRPAB', unit: 'UA2', validFrom: '2025-01-01', validTo: '2026-12-31' });
  await assignUnit({ client, ...meta, area: 'C100', group: 'GRPAB', unit: 'UB', validFrom: '2025-01-01', validTo: '2026-12-31' });
  await saveGroupAccount({ client, ...meta, consChart: 'GC01', account: 'FS1000', title: 'Asset item' });
  await saveMapping({ client, ...meta, consChart: 'GC01', sourceChart: 'CA01', sourceFrom: '101000', sourceTo: '101000', groupAccount: 'FS1000' });
  await saveMethod({ client, ...meta, area: 'C100', method: 'MVAL', kind: 'OTHER', title: 'Collect' });
  await saveVersion({ client, ...meta, area: 'C100', version: '100', title: 'Actual' });
  await saveTask({ client, ...meta, area: 'C100', version: '100', task: 'T100', sequence: 10, taskType: 'DATA_COLLECTION', method: 'MVAL', unit: 'UA', group: 'GRPA', validFrom: '2025-01-01', validTo: '2026-12-31' });
  await saveTask({ client, ...meta, area: 'C100', version: '100', task: 'T200', sequence: 20, taskType: 'DATA_COLLECTION', method: 'MVAL', unit: 'UB', group: 'GRPAB', validFrom: '2025-01-01', validTo: '2026-12-31' });
  await activateArea({ client, ...meta, area: 'C100' });

  onlyA = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [A] });
  onlyB = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [B] });
  both = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [A, B] });
  noCapability = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
  plantLimited = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  outsiderTenantActor = await createFinanceActor(other.client, { capabilities: REPORT_CAPS });
}, 300_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 180_000);

describe('1. single-company statements', () => {
  it('an A-scoped user reads A and cannot read B by changing the company parameter', async () => {
    const tb = await calculateTrialBalance({ client, selection: selection(A), authorization: auth(onlyA) });
    expect(tb.companyCode).toBe(A);
    expect(JSON.stringify(tb)).toContain('5000');
    expect(JSON.stringify(tb)).not.toContain('9000');
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(B), authorization: auth(onlyA) }));
    await expectScopeRefusal(calculateBalanceSheet({ client, selection: { ...sheetSelection(B), calculationType: 'ACCUMULATED' }, authorization: auth(onlyA) }));
    await expectScopeRefusal(calculateProfitLoss({ client, selection: sheetSelection(B), authorization: auth(onlyA) }));
    const bs = await calculateBalanceSheet({ client, selection: { ...sheetSelection(A), calculationType: 'ACCUMULATED' }, authorization: auth(onlyA) });
    expect(bs.companyCode).toBe(A);
    const pl = await calculateProfitLoss({ client, selection: sheetSelection(A), authorization: auth(onlyA) });
    expect(pl.companyCode).toBe(A);
  });

  it('a B-scoped user is the mirror image; a user of both reads both with the same figures', async () => {
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(A), authorization: auth(onlyB) }));
    const b = await calculateTrialBalance({ client, selection: selection(B), authorization: auth(onlyB) });
    expect(JSON.stringify(b)).toContain('9000');
    const viaBoth = await calculateTrialBalance({ client, selection: selection(B), authorization: auth(both) });
    expect(viaBoth.nodes).toEqual(b.nodes);
  });

  it('scope without the report capability is denied; a non-existent company is judged by scope, not disclosed', async () => {
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(A), authorization: auth(noCapability) }), /authority FIN\.RPT\.TRIALBALANCE/);
    await expectScopeRefusal(calculateProfitLoss({ client, selection: sheetSelection(A), authorization: auth(noCapability) }), /authority FIN\.RPT\.PROFITLOSS/);
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection('9999'), authorization: auth(onlyA) }), /Company Code scope/);
  });

  it('profit and loss needs its own capability only — not the balance-sheet one', async () => {
    const plOnly = await createFinanceActor(client, { capabilities: ['FIN.RPT.PROFITLOSS'], companyScopes: [A] });
    expect((await calculateProfitLoss({ client, selection: sheetSelection(A), authorization: auth(plOnly) })).companyCode).toBe(A);
    await expectScopeRefusal(calculateBalanceSheet({ client, selection: { ...sheetSelection(A), calculationType: 'ACCUMULATED' }, authorization: auth(plOnly) }), /authority FIN\.RPT\.BALANCESHEET/);
  });

  it('exports are the same boundary: the adapter refuses B for an A-only session and hands A its file', async () => {
    const adapter = reportAdapter('trial-balance')!;
    const q = (company: string) => new URLSearchParams({ companyCode: company, statementVersion: 'T01', fiscalYear: '2026' });
    const doc = await adapter.build(client, q(A), auth(onlyA));
    expect(JSON.stringify(doc)).toContain('5000');
    await expectScopeRefusal(adapter.build(client, q(B), auth(onlyA)));
    await expectScopeRefusal(reportAdapter('balance-sheet')!.build(client, q(B), auth(onlyA)));
    await expectScopeRefusal(reportAdapter('profit-loss')!.build(client, q(B), auth(onlyA)));
    await expectScopeRefusal(adapter.build(client, q(A), undefined), /signed-in user/);
    await expectScopeRefusal(adapter.build(client, q(A), auth(noCapability)), /authority/);
  });
});

describe('2. group and derived scope', () => {
  it('cash flow: A+B is refused for A-only before data is read, A alone is allowed, both succeed', async () => {
    await expectScopeRefusal(calculateCashflow({ client, selection: cashSelection([A, B]), authorization: auth(onlyA) }));
    await expectScopeRefusal(calculateCashflow({ client, selection: cashSelection([B, A]), authorization: auth(onlyA) }));
    const a = await calculateCashflow({ client, selection: cashSelection([A]), authorization: auth(onlyA) }).catch((e: Error) => e);
    if (a instanceof Error) expect(a.message).not.toMatch(/scope|authority|signed-in/i); // any non-authority outcome proves A was admitted
    const ab = await calculateCashflow({ client, selection: cashSelection([A, B]), authorization: auth(both) }).catch((e: Error) => e);
    if (ab instanceof Error) expect(ab.message).not.toMatch(/scope|authority|signed-in/i);
    else expect(ab.companies.map((c) => c.companyCode).sort()).toEqual([A, B]);
    const csv = reportAdapter('cash-flow')!;
    await expectScopeRefusal(csv.build(client, new URLSearchParams({ companies: `${A},${B}`, fiscalYear: '2026' }), auth(onlyA)));
  });

  it('consolidated statements: a group whose stored units resolve to A+B is refused for A-only (B is not named); A-only group works', async () => {
    const refusal = await expectScopeRefusal(calculateConsolidatedStatements({ client, selection: consSelection('GRPAB'), authorization: auth(onlyA) }));
    expect(refusal.message).not.toContain(B);
    expect(refusal.message).not.toContain('UB');
    await expectScopeRefusal(calculateConsolidatedStatements({ client, selection: consSelection('GRPAB'), authorization: auth(onlyB) }));
    // a single unit of B inside the group is B's data too
    await expectScopeRefusal(calculateConsolidatedStatements({ client, selection: { ...consSelection('GRPAB'), unit: 'UB' }, authorization: auth(onlyA) }));
    const ok = await calculateConsolidatedStatements({ client, selection: consSelection('GRPA'), authorization: auth(onlyA) });
    expect(ok.units.map((u) => u.companyCode)).toEqual([A]);
    const full = await calculateConsolidatedStatements({ client, selection: consSelection('GRPAB'), authorization: auth(both) });
    expect(full.units.map((u) => u.companyCode).sort()).toEqual([A, B]);
    await expectScopeRefusal(reportAdapter('consolidated-statements')!.build(client, new URLSearchParams({ area: 'C100', group: 'GRPAB', version: '100', fiscalYear: '2026', period: '12' }), auth(onlyA)));
  });

  it('tax return: a tax group that expands to A+B is refused for A-only before any line is read or stamped; both succeed', async () => {
    const stamped = async () => withTenant(client, async (tx) => Number(((await tx.execute(sql`select count(*)::int as n from journal_entry_line where client = ${client} and tax_return_run_id is not null`)) as unknown as Array<{ n: number }>)[0]!.n));
    const runs = async () => withTenant(client, async (tx) => Number(((await tx.execute(sql`select count(*)::int as n from tax_return_run where client = ${client}`)) as unknown as Array<{ n: number }>)[0]!.n));
    const before = { stamped: await stamped(), runs: await runs() };
    const refusal = await executeTaxReport({ client, changedBy: ACTOR, selection: taxSelection({ taxReturnCountry: country, taxGroup: 'GRP', testRun: false }) }, { authorization: auth(onlyA) }).then(() => null, (e: Error) => e);
    expect(refusal?.message).toMatch(/Tax group GRP includes a company code outside your Company Code scope/);
    expect(refusal?.message).not.toContain(B);
    expect({ stamped: await stamped(), runs: await runs() }).toEqual(before);
    const direct = await executeTaxReport({ client, changedBy: ACTOR, selection: taxSelection({ taxReturnCountry: country, companyCode: B }) }, { authorization: auth(onlyA) }).then(() => null, (e: Error) => e);
    expect(direct?.message).toMatch(/does not cover company code 2000/);
    const single = await executeTaxReport({ client, changedBy: ACTOR, selection: taxSelection({ taxReturnCountry: country }) }, { authorization: auth(onlyA) });
    expect(single.companies).toEqual([A]);
    const group = await executeTaxReport({ client, changedBy: ACTOR, selection: taxSelection({ taxReturnCountry: country, taxGroup: 'GRP' }) }, { authorization: auth(both) });
    expect(group.companies.sort()).toEqual([A, B]);
    const none = await executeTaxReport({ client, changedBy: ACTOR, selection: taxSelection({ taxReturnCountry: country }) }, {}).then(() => null, (e: Error) => e);
    expect(none?.message).toMatch(/signed-in user/);
  });

  it('saved tax runs: a group run is listed only to users who cover every company it reported', async () => {
    const seen = await listTaxReturnRuns(client, auth(onlyA));
    expect(seen.every((r) => !r.taxGroup)).toBe(true);
    const all = await listTaxReturnRuns(client, auth(both));
    expect(all.some((r) => r.taxGroup === 'GRP')).toBe(true);
    await expect(listTaxReturnRuns(client, undefined)).rejects.toThrow(/signed-in user/);
    await expect(listTaxReturnRuns(client, auth(noCapability))).rejects.toThrow(/authority/);
  });

  it('selectors offer only authorised companies, and an empty scope offers none (never the first company)', async () => {
    expect(await authorizedCompanyCodes(client, auth(onlyA), 'FIN.RPT.TRIALBALANCE')).toEqual([A]);
    expect(await authorizedCompanyCodes(client, auth(both), 'FIN.RPT.TRIALBALANCE')).toEqual([A, B]);
    expect(await authorizedCompanyCodes(client, auth(noCapability), 'FIN.RPT.TRIALBALANCE')).toEqual([]);
    const noScope = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [] });
    expect(await authorizedCompanyCodes(client, auth(noScope), 'FIN.RPT.TRIALBALANCE')).toEqual([]);
  });
});

describe('3. intercompany', () => {
  const pairConfig = (a: FinanceActor) => ({ client, changedBy: ACTOR, sendingCompanyCode: A, receivingCompanyCode: B, authorization: auth(a) });

  it('A-only and B-only users cannot post A→B; a refusal leaves no journal, header or change document', async () => {
    const before = await counts();
    await expectScopeRefusal(postIntercompany(icInput(onlyA)));
    await expectScopeRefusal(postIntercompany(icInput(onlyB)));
    await expectScopeRefusal(postIntercompany(icInput(noCapability)), /authority FIN\.IC\.POST/);
    await expectScopeRefusal(postIntercompany(icInput(undefined)), /signed-in user/);
    expect(await counts()).toEqual(before);
  });

  it('tampered sender/receiver values and another tenant’s session are refused', async () => {
    const before = await counts();
    await expectScopeRefusal(postIntercompany(icInput(onlyA, { receivingCompanyCode: '9999' })));
    await expectScopeRefusal(postIntercompany(icInput(onlyA, { sendingCompanyCode: B, receivingCompanyCode: A })));
    await expectScopeRefusal(postIntercompany(icInput(outsiderTenantActor)), /no longer active|signed-in/);
    expect(await counts()).toEqual(before);
  });

  it('a user of both with the capability configures the pair and posts once; replay duplicates nothing', async () => {
    await saveIntercompanyConfig({ ...pairConfig(both), sendingClearingGl: '110100', receivingClearingGl: '110100' });
    const before = await counts();
    const first = await postIntercompany(icInput(both));
    const mid = await counts();
    expect(mid.journals).toBe(before.journals + 2);
    expect(mid.ic).toBe(before.ic + 1);
    const replay = await postIntercompany(icInput(both));
    expect(replay).toEqual(first);
    expect(await counts()).toEqual(mid);
  });

  it('a one-sided user cannot replay an existing key, nor learn the document numbers', async () => {
    const mid = await counts();
    for (const who of [onlyA, onlyB]) {
      const e = await expectScopeRefusal(postIntercompany(icInput(who)));
      expect(e.message).not.toMatch(/JE|\d{6,}/);
    }
    // an authorised user may not reuse the key for a different pair to read the stored pair back
    await withTenant(client, async (tx) => {
      await tx.execute(sql`insert into intercompany_clearing_config (client, sending_company_code, receiving_company_code, created_by) values (${client}, ${B}, ${A}, ${ACTOR}) on conflict do nothing`);
    });
    await expect(postIntercompany(icInput(both, { sendingCompanyCode: B, receivingCompanyCode: A }))).rejects.toThrow(/already been used for another posting/);
    expect(await counts()).toEqual(mid);
  });

  it('configuration and choices are scoped: one side sees neither the pair nor the other company', async () => {
    expect((await listIntercompanyConfigs(client, auth(both), ['FIN.IC.POST'])).some((p) => p.sendingCompanyCode === A && p.receivingCompanyCode === B)).toBe(true);
    expect((await listIntercompanyConfigs(client, auth(onlyA))).filter((p) => p.receivingCompanyCode === B || p.sendingCompanyCode === B)).toEqual([]);
    expect((await listCompanyChoices(client, auth(onlyA))).map((c) => c.companyCode)).toEqual([A]);
    expect((await listCompanyChoices(client, auth(onlyB))).map((c) => c.companyCode)).toEqual([B]);
    await expect(listCompanyChoices(client, auth(noCapability))).rejects.toThrow(/authority/);
    await expectScopeRefusal(saveIntercompanyConfig(pairConfig(onlyA)));
    await expectScopeRefusal(deleteIntercompanyConfig({ client, changedBy: ACTOR, sendingCompanyCode: A, receivingCompanyCode: B, authorization: auth(onlyB) }));
  });
});

describe('4. authority freshness', () => {
  it('no authorization, a revoked session, a revoked role and a narrowed scope are each refused by the service', async () => {
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(A), authorization: undefined }), /signed-in user/);
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(A), authorization: { userId: 'forged', sessionId: 'forged' } }), /no longer active/);

    const revoked = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [A] });
    expect((await calculateTrialBalance({ client, selection: selection(A), authorization: auth(revoked) })).companyCode).toBe(A);
    await withTenant(client, (tx) => tx.execute(sql`update user_session set revoked_at = now() where client = ${client} and id = ${revoked.sessionId}`));
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(A), authorization: auth(revoked) }), /no longer active/);

    const stripped = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [A] });
    await withTenant(client, (tx) => tx.execute(sql`delete from user_role where client = ${client} and user_id = ${stripped.userId}`));
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(A), authorization: auth(stripped) }), /authority/);

    const narrowed = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [A, B] });
    expect((await calculateCashflow({ client, selection: cashSelection([A, B]), authorization: auth(narrowed) }).catch((e: Error) => e))).not.toMatchObject({ message: expect.stringMatching(/scope/i) });
    await withTenant(client, (tx) => tx.execute(sql`delete from auth_org_restriction where client = ${client} and user_id = ${narrowed.userId} and scope_type = 'COMPANY_CODE' and scope_value = ${B}`));
    await expectScopeRefusal(calculateCashflow({ client, selection: cashSelection([A, B]), authorization: auth(narrowed) }));
    await expectScopeRefusal(postIntercompany(icInput(narrowed, { requestKey: 'scope-ic-narrowed' })));
  });

  it('a session cannot be pointed at another tenant', async () => {
    await expectScopeRefusal(calculateTrialBalance({ client: other.client, selection: selection(A), authorization: auth(onlyA) }), /no longer active/);
  });
});

describe('5. scope semantics', () => {
  it('missing scope is not unrestricted — even for a wildcard (administrator-style) capability', async () => {
    const wildcardNoScope = await createFinanceActor(client, { capabilities: ['*'], companyScopes: [] });
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(A), authorization: auth(wildcardNoScope) }), /explicit Company Code scope/);
    await expectScopeRefusal(postIntercompany(icInput(wildcardNoScope, { requestKey: 'scope-ic-wild' })), /explicit Company Code scope/);
    const noScope = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [] });
    await expectScopeRefusal(calculateConsolidatedStatements({ client, selection: consSelection('GRPA'), authorization: auth(noScope) }), /explicit Company Code scope/);
  });

  it('an explicit wildcard-capability grant with explicit company scope is honoured, and only for those companies', async () => {
    const admin = await createFinanceActor(client, { capabilities: ['*'], companyScopes: [A] });
    expect((await calculateTrialBalance({ client, selection: selection(A), authorization: auth(admin) })).companyCode).toBe(A);
    await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(B), authorization: auth(admin) }));
  });

  it('a partial plant scope may not read a company-wide aggregate or post for the company; a full plant list may', async () => {
    const e = await expectScopeRefusal(calculateTrialBalance({ client, selection: selection(A), authorization: auth(plantLimited) }), /Plant scope covers only some plants/);
    expect(e.remedy).toBeTruthy();
    await expectScopeRefusal(calculateBalanceSheet({ client, selection: { ...sheetSelection(A), calculationType: 'ACCUMULATED' }, authorization: auth(plantLimited) }), /Plant scope/);
    await expectScopeRefusal(postIntercompany(icInput(plantLimited, { requestKey: 'scope-ic-plant' })), /Plant scope/);
    // company B has no plants: a plant-limited user's Plant list leaves nothing of B uncovered, so B stays company-level
    expect((await calculateTrialBalance({ client, selection: selection(B), authorization: auth(plantLimited) })).companyCode).toBe(B);
    const plantsOfA = await withTenant(client, async (tx) => ((await tx.execute(sql`select plant from plant where client = ${client} and company_code = ${A}`)) as unknown as Array<{ plant: string }>).map((r) => r.plant));
    const everyPlant = await createFinanceActor(client, { capabilities: REPORT_CAPS, companyScopes: [A], plantScopes: plantsOfA });
    expect((await calculateTrialBalance({ client, selection: selection(A), authorization: auth(everyPlant) })).companyCode).toBe(A);
  });
});
