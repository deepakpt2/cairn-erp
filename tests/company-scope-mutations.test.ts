/**
 * Company-scope authorization of the two company-posting mutations that were reachable by capability alone:
 * document reversal (FIN.DOCUMENT.REVERSE) and foreign-currency valuation (FIN.FX.VALUATE), plus the paths that
 * reach them (accrual reversal, close-cockpit handlers, FX protocol read).
 *
 * Companies A (1000) and B (2000) in one tenant, a second tenant, real persisted sessions. A refusal must leave
 * no journal, reversal link, valuation run or change behind, and must not disclose the other company's figures.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry, type PostedJournal } from '../src/platform/posting';
import { getDocumentForReversal, reverseDocument } from '../src/modules/finance/document-reversal';
import { executeFxValuation, getFxValuationRun } from '../src/modules/finance/fx-valuation';
import { executeAccrualReversal } from '../src/modules/finance/accrual';
import {
  createTaskListFromTemplate, executeTask, listExecutions, releaseTaskList, upsertTemplateTask,
} from '../src/modules/finance/close-cockpit';
import { createFinanceActor, FINANCE_ACTOR_CAPABILITIES, type FinanceActor } from './helpers/finance-actor';
import { closeDb, createTenant, defineTestRanges, destroyTenant, seedAccounts, type TestTenant } from './helpers';

const ACTOR = 'SCOPE-MUT';
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

async function state() {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select (select count(*)::int from journal_entry where client = ${client}) as journals,
             (select count(*)::int from accounting_reversal_link where client = ${client}) as links,
             (select count(*)::int from fx_valuation_run where client = ${client}) as runs,
             (select count(*)::int from change_document where client = ${client}) as changes`)) as unknown as Array<Record<string, number>>;
    return rows[0]!;
  });
}

async function statusOf(doc: string): Promise<string> {
  return withTenant(client, async (tx) => ((await tx.execute(sql`
    select status from journal_entry where client = ${client} and document_number = ${doc} and fiscal_year = 2026`)) as unknown as Array<{ status: string }>)[0]!.status);
}

const rev = (a: FinanceActor | undefined, company: string, doc: string, requestKey: string) => reverseDocument({
  client, authorization: a?.authorization, changedBy: ACTOR, companyCode: company, documentNumber: doc, fiscalYear: 2026,
  reasonCode: '01', documentDate: '2026-11-05', postingDate: '2026-11-05', confirmed: true, requestKey,
});

const fxSel = (companyCode: string, requestKey: string) => ({
  companyCode, valuationArea: 'STD', valuationKeyDate: '2026-04-30', postingDate: '2026-04-30', fiscalYear: 2026,
  valuationMethod: 'AVERAGE' as const, includeOpenItems: false, includeBalances: true, testRun: true,
  documentType: 'SA', requestKey,
});
const fx = (a: FinanceActor | undefined, company: string, requestKey: string) =>
  executeFxValuation({ client, changedBy: ACTOR, authorization: a?.authorization, selection: fxSel(company, requestKey) });

async function refusal(p: Promise<unknown>, pattern: RegExp = /scope|Company Code|capabilit|authori|session|signed-in|no longer active|not hold/i) {
  try { await p; } catch (error) {
    expect((error as Error).message).toMatch(pattern);
    expect((error as Error).message).not.toMatch(/B-SECRET/);
    return error as Error;
  }
  throw new Error('Expected a refusal, nothing was thrown.');
}

beforeAll(async () => {
  tenant = await createTenant('scope-mut');
  client = tenant.client;
  other = await createTenant('scope-mut-2');
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
  const caps = FINANCE_ACTOR_CAPABILITIES;
  onlyA = await createFinanceActor(client, { capabilities: caps, companyScopes: [A] });
  onlyB = await createFinanceActor(client, { capabilities: caps, companyScopes: [B] });
  both = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B] });
  noCapability = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
  noScope = await createFinanceActor(client, { capabilities: caps, companyScopes: [] });
  plantLimited = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B], plantScopes: ['PLA1'] });
  otherTenantActor = await createFinanceActor(other.client, { capabilities: caps });
}, 300_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 180_000);

describe('document reversal', () => {
  it('reverses a document of the actor\'s own company only', async () => {
    const a = await postDoc(A, '100.0000');
    const b = await postDoc(B, '9000.0000');
    const before = await state();
    await refusal(rev(onlyA, B, b.documentNumber, 'mut-b-by-a'), /does not cover company code 2000/);
    expect(await state()).toEqual(before);
    expect(await statusOf(b.documentNumber)).toBe('POSTED');
    const ok = await rev(onlyA, A, a.documentNumber, 'mut-a-by-a');
    expect(ok.reversalDocumentNumber).toBeTruthy();
    expect(await statusOf(a.documentNumber)).toBe('REVERSED');
    const okB = await rev(onlyB, B, b.documentNumber, 'mut-b-by-b');
    expect(okB.companyCode).toBe(B);
  });

  it('refuses a missing authorization, a missing capability, no Company Code scope, a plant-limited user and another tenant\'s user', async () => {
    const b = await postDoc(B, '77.0000');
    const before = await state();
    await refusal(rev(undefined, B, b.documentNumber, 'mut-none'));
    await refusal(rev(noCapability, B, b.documentNumber, 'mut-nocap'));
    await refusal(rev(noScope, B, b.documentNumber, 'mut-noscope'));
    await refusal(rev(plantLimited, A, (await postDoc(A, '5.0000')).documentNumber, 'mut-plant'), /Plant scope/);
    await refusal(rev(otherTenantActor, B, b.documentNumber, 'mut-tenant'));
    expect((await state()).journals).toBe(before.journals + 1); // only the A document posted for the plant test
    expect(await statusOf(b.documentNumber)).toBe('POSTED');
  });

  it('a replayed request key is not an oracle for another company\'s reversal', async () => {
    const a = await postDoc(A, '11.0000');
    const first = await rev(onlyA, A, a.documentNumber, 'mut-replay');
    // The same actor replays its own: idempotent.
    expect((await rev(onlyA, A, a.documentNumber, 'mut-replay')).reversalDocumentNumber).toBe(first.reversalDocumentNumber);
    // B's user replaying A's key against A's document: refused by scope, learns nothing.
    await refusal(rev(onlyB, A, a.documentNumber, 'mut-replay'), /does not cover company code 1000/);
    // B's user using A's key for a B document: the key stands against another reversal.
    const b = await postDoc(B, '12.0000');
    await refusal(rev(onlyB, B, b.documentNumber, 'mut-replay'), /request key already stands/);
    expect(await statusOf(b.documentNumber)).toBe('POSTED');
  });

  it('the reversal screen read is scoped too and leaks nothing', async () => {
    const b = await postDoc(B, '4321.0000');
    await refusal(getDocumentForReversal(client, { authorization: onlyA.authorization, companyCode: B, documentNumber: b.documentNumber, fiscalYear: 2026 }));
    await refusal(getDocumentForReversal(client, { authorization: undefined, companyCode: B, documentNumber: b.documentNumber, fiscalYear: 2026 }));
    const view = await getDocumentForReversal(client, { authorization: both.authorization, companyCode: B, documentNumber: b.documentNumber, fiscalYear: 2026 });
    expect(view.companyCode).toBe(B);
  });

  it('the actor recorded is the verified session user, not the typed name', async () => {
    const a = await postDoc(A, '3.0000');
    await rev(onlyA, A, a.documentNumber, 'mut-actor');
    const rows = await withTenant(client, async (tx) => (await tx.execute(sql`
      select reversed_by from accounting_reversal_link where client = ${client} and request_key = 'mut-actor'`)) as unknown as Array<{ reversed_by: string }>);
    expect(rows[0]!.reversed_by).toBe(onlyA.username);
  });
});

describe('foreign-currency valuation', () => {
  it('runs for an authorised company and refuses another, leaving no run behind', async () => {
    const before = await state();
    await refusal(fx(onlyA, B, 'mut-fx-b-by-a'), /does not cover company code 2000/);
    await refusal(fx(undefined, A, 'mut-fx-none'));
    await refusal(fx(noCapability, A, 'mut-fx-nocap'));
    await refusal(fx(noScope, A, 'mut-fx-noscope'));
    await refusal(fx(plantLimited, A, 'mut-fx-plant'), /Plant scope/);
    await refusal(fx(otherTenantActor, A, 'mut-fx-tenant'));
    expect(await state()).toEqual(before);
    const ok = await fx(onlyA, A, 'mut-fx-a');
    expect(ok.companyCode).toBe(A);
    expect((await state()).runs).toBe(before.runs + 1);
  });

  it('a replay of another company\'s request key reveals nothing and the protocol read is scoped', async () => {
    const run = await fx(onlyB, B, 'mut-fx-key');
    await refusal(fx(onlyA, A, 'mut-fx-key'), /request key already stands/);
    await refusal(fx(onlyA, B, 'mut-fx-key'), /does not cover company code 2000/);
    expect(await getFxValuationRun(client, run.runId, onlyA.authorization)).toBeNull();
    expect((await getFxValuationRun(client, run.runId, onlyB.authorization))?.companyCode).toBe(B);
    expect((await getFxValuationRun(client, run.runId, both.authorization))?.runId).toBe(run.runId);
    await refusal(getFxValuationRun(client, run.runId, noCapability.authorization));
    await refusal(getFxValuationRun(client, run.runId, undefined));
    expect(await getFxValuationRun(other.client, run.runId, otherTenantActor.authorization)).toBeNull();
  });
});

describe('paths that reach the mutations', () => {
  it('accrual reversal is judged before the document is read', async () => {
    const error = await refusal(executeAccrualReversal({
      client, changedBy: ACTOR, authorization: onlyA.authorization, companyCode: B, documentNumber: '9999999999', fiscalYear: 2026,
    }), /does not cover company code 2000/);
    expect(error.message).not.toMatch(/does not stand/);
    await refusal(executeAccrualReversal({
      client, changedBy: ACTOR, authorization: undefined, companyCode: A, documentNumber: '9999999999', fiscalYear: 2026,
    }));
  });

  it('a close-cockpit task for company B fails under an A-only actor, posts nothing, and succeeds for a B actor', async () => {
    const cycle = { companyCode: B, taskListId: 'MUT_CLOSE', fiscalYear: 2026, postingPeriod: 4 };
    await upsertTemplateTask({
      client, changedBy: ACTOR, templateCode: 'MUT_TPL',
      task: { taskId: 'F10', taskName: 'FX', handlerCode: 'FX_VALUATION', parameters: JSON.stringify({ includeBalances: 'true', includeOpenItems: 'false' }) } as never,
      predecessors: [],
    });
    await createTaskListFromTemplate({ client, changedBy: ACTOR, cycle, templateCode: 'MUT_TPL', description: 'scope' });
    await releaseTaskList({ client, changedBy: ACTOR, cycle });
    const before = await state();
    const denied = await executeTask({ client, changedBy: ACTOR, cycle, taskId: 'F10', mode: 'FOREGROUND', authorization: onlyA.authorization });
    expect(denied.status).toBe('ERROR');
    const log = (await listExecutions(client, cycle, 'F10'))[0] as unknown as { errorDetails?: string; error_details?: string };
    expect(`${log.errorDetails ?? log.error_details ?? ''}`).toMatch(/does not cover company code 2000/);
    expect(await state()).toEqual(before);
    const none = await executeTask({ client, changedBy: ACTOR, cycle, taskId: 'F10', mode: 'FOREGROUND', authorization: undefined });
    expect(none.status).toBe('ERROR');
    expect(await state()).toEqual(before);
    const ok = await executeTask({ client, changedBy: ACTOR, cycle, taskId: 'F10', mode: 'FOREGROUND', authorization: onlyB.authorization });
    expect(ok.status).toBe('COMPLETED');
    expect((await state()).runs).toBe(before.runs + 1);
  });
});
