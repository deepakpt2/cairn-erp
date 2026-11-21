/**
 * Background payment run (F110): PAYMENT.RUN.PROPOSAL and PAYMENT.RUN.EXECUTE on the INTENSIVE queue.
 *
 * Real database effects: crash windows are produced by reaping a live lease between the business commit
 * and the job's own write, and the stale owner is a real second claim of the same run.
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { claimNext, runClaimed } from '../src/platform/job/execute';
import { reapOrphans, requestCancel, retryRun } from '../src/platform/job/queue';
import { clearJobRegistry, registerJob } from '../src/platform/job/registry';
import { defineRange } from '../src/platform/numbering';
import { appUser } from '../src/platform/tables/security';
import { createOrderForProvisioning as createOrder } from '../src/modules/purchasing/orders';
import { postSupplierInvoice as postSupplierInvoiceRaw } from '../src/modules/purchasing/invoice-verification';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { cancelDocumentReleaseForProvisioning as cancelDocumentRelease } from '../src/modules/purchasing/release';
import {
  PAYMENT_RUN_CAPABILITY, cancelPaymentRun, createPaymentRun, executePaymentRun, generateProposal, getPaymentRun, PaymentRunError,
} from '../src/modules/finance/payment-run';
import { cancelPaymentRunReleaseForProvisioning as cancelPaymentRunRelease, getPaymentRunRelease, releasePaymentRunForProvisioning as releasePaymentRun } from '../src/modules/finance/payment-run-release';
import {
  PAYMENT_EXECUTE_JOB, PAYMENT_PROPOSAL_JOB, cancelPaymentOperation, getPaymentOperation, runPaymentExecuteChunk,
  runPaymentProposalChunk, submitPaymentExecution, submitPaymentProposal,
} from '../src/modules/finance/payment-run-background';
import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { createFinanceActor, type FinanceActor, withFinanceAuth } from './helpers/finance-actor';
import { defineReleaseStrategy } from './helpers/release-config';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';

const postSupplierInvoice = withFinanceAuth(postSupplierInvoiceRaw);

const ACTOR = 'PAYRUN_BG_TEST';
const APPROVER = 'RUN-APPROVER';
const RUN_DATE = '2026-10-18';

let client = '';
let planner: FinanceActor;
let seq = 0;
const runIds: string[] = [];

type Ctx = Parameters<typeof runPaymentProposalChunk>[0];
type Wrap = (ctx: Ctx, real: () => ReturnType<typeof runPaymentProposalChunk>, call: number) => ReturnType<typeof runPaymentProposalChunk>;
function useHandlers(proposal?: Wrap, execute?: Wrap) {
  clearJobRegistry();
  let p = 0;
  let e = 0;
  registerJob({ code: PAYMENT_PROPOSAL_JOB, chunk: (ctx) => { p += 1; return proposal ? proposal(ctx, () => runPaymentProposalChunk(ctx), p) : runPaymentProposalChunk(ctx); } });
  registerJob({ code: PAYMENT_EXECUTE_JOB, chunk: (ctx) => { e += 1; return execute ? execute(ctx, () => runPaymentExecuteChunk(ctx), e) : runPaymentExecuteChunk(ctx); } });
}

async function drive(options: { heartbeatMs?: number } = {}): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const claimed = await claimNext('worker-intensive', ['INTENSIVE']);
    if (!claimed) break;
    out.push(await runClaimed('worker-intensive', claimed, options));
  }
  return out;
}

async function dieAfterCommit(ctx: Ctx) {
  await withTenant(client, (tx) => tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${ctx.runId}`));
  expect(await withTenant(client, (tx) => reapOrphans(tx, client, 1000))).toContain(ctx.runId);
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  return withTenant(client, async (tx) => Number(((await tx.execute(query)) as unknown as Array<{ n: number }>)[0]!.n));
}
async function opRow(operationId: string) {
  const v = await withTenant(client, (tx) => tx.execute(sql`select o.*, j.status as job_status, j.parameters, j.error_text as job_error, j.progress_text, j.id as jid from payment_run_operation o join job_run j on j.client = o.client and j.id = o.job_run_id where o.client = ${client} and o.operation_id = ${operationId}`));
  return (v as unknown as Array<Record<string, unknown>>)[0]!;
}
const payments = (runId: string) => count(sql`select count(*)::int as n from payment_document where client = ${client} and run_date = ${RUN_DATE} and run_id = ${runId}`);
const journals = () => count(sql`select count(*)::int as n from journal_entry where client = ${client} and origin_class = 'payment_run'`);
const stageRows = () => count(sql`select count(*)::int as n from payment_proposal_stage where client = ${client}`);
async function expectRefusal(promise: Promise<unknown>, text: RegExp) {
  await expect(promise).rejects.toThrow(text);
}

/** A standing payable of 550 for V10000, through the real purchasing flow. */
async function addPayable(): Promise<void> {
  const tag = ++seq;
  const order = await createOrder({
    client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
    items: [{
      materialNumber: 'MAT-10001', shortText: 'Industrial steel plate', quantity: 5, unit: 'PC', netPrice: 100, priceUnit: 1, taxCode: '',
      plant: '1000', storageLocation: '', markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }], assignments: [],
    }],
  });
  await postGoodsReceipt({ client, changedBy: ACTOR, orderNumber: order.orderNumber, documentDate: '2026-10-18', postingDate: '2026-10-18', requestKey: `bg-gr-${tag}`, lines: [{ itemNumber: 10, quantity: 5 }] });
  await postSupplierInvoice({
    client, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: `BG-INV-${tag}`, invoiceDate: '2026-10-16', postingDate: '2026-10-18',
    grossAmount: 550, requestKey: `bg-iv-${tag}`, lines: [{ itemNumber: 10, quantity: 5, netAmount: 550 }],
  });
}

async function newRun(extra: Partial<Parameters<typeof createPaymentRun>[0]> = {}): Promise<string> {
  const runId = `B${String(++seq).padStart(3, '0')}`;
  runIds.push(runId);
  await createPaymentRun({
    client, changedBy: ACTOR, runDate: RUN_DATE, runId, postingDate: '2026-11-16', documentCutoffDate: '2026-10-18', nextPaymentDate: '2026-11-16',
    companies: [{ companyCode: '1000', payingCompanyCode: '1000' }], methods: ['T'], ...extra,
  });
  return runId;
}
const propose = (runId: string, who: FinanceActor = planner) => submitPaymentProposal({ client, changedBy: who.username, actorUserId: who.userId, runDate: RUN_DATE, runId });
const execute = (runId: string, who: FinanceActor = planner, bank = { houseBankKey: 'HB01', bankAccountId: 'MAIN' }) =>
  submitPaymentExecution({ client, changedBy: who.username, actorUserId: who.userId, runDate: RUN_DATE, runId, ...bank });
const approve = (runId: string) => releasePaymentRun({ client, changedBy: APPROVER, runDate: RUN_DATE, runId, releaseCode: 'TRS' });

/** A run with a released proposal, ready to execute. */
async function releasedRun(): Promise<string> {
  await addPayable();
  const runId = await newRun();
  useHandlers();
  await propose(runId);
  expect(await drive()).toEqual(['SUCCEEDED']);
  await approve(runId);
  return runId;
}

beforeAll(async () => {
  const tenant = await createTenant('payrun-bg');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, company_code, created_by) values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into business_partner (client, partner_number, category, name, created_by) values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into bp_role (client, partner_number, role_code, created_by) values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by) values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by) values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into supplier_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, payment_methods, created_by) values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', 'T', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into payment_method (client, country, method_code, description, allowed_direction, created_by) values (${client}, 'KW', 'T', 'Bank transfer', 'OUTGOING', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into bank_master (bank_country, bank_key, name, created_by) values ('KW', 'NBK001', 'Test National Bank', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by) values (${client}, '1000', 'HB01', 'KW', 'NBK001', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by) values (${client}, '1000', 'HB01', 'MAIN', '12345678', 'USD', '101000', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into material (client, material_number, description, material_type, base_unit, created_by) values (${client}, 'MAT-10001', 'Industrial steel plate', 'RAW', 'PC', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by) values (${client}, 'MAT-10001', '1000', 0, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control, standard_price, moving_average_price, price_unit, currency, created_by) values (${client}, 'MAT-10001', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by) values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}), (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}), (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`update job_definition set chunk_size = 1 where code = ${PAYMENT_PROPOSAL_JOB}`);
  });
  await initializeMaterialPeriodControl({ client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'payment run background' });
  await defineReleaseStrategy({ client, actor: ACTOR, category: 'PAYMENT_RUN', group: 'RN', codes: ['TRS'], strategy: 'RUN_STD', from: '100', steps: ['TRS'] });
  planner = await createFinanceActor(client, { capabilities: [PAYMENT_RUN_CAPABILITY] });
}, 240_000);

afterEach(async () => {
  clearJobRegistry();
  await withTenant(client, async (tx) => {
    await tx.execute(sql`update payment_run_operation set status = 'CANCELLED' where client = ${client} and status in ('QUEUED','RUNNING')`);
    await tx.execute(sql`delete from job_run where client = ${client} and job_code in (${PAYMENT_PROPOSAL_JOB}, ${PAYMENT_EXECUTE_JOB}) and status in ('QUEUED','RUNNING','BLOCKED')`);
  });
});

afterAll(async () => {
  await withTenant(client, (tx) => tx.execute(sql`update job_definition set chunk_size = 100 where code = ${PAYMENT_PROPOSAL_JOB}`)).catch(() => undefined);
  if (client) await destroyTenant(client);
  await closeDb();
});

describe('proposal', () => {
  it('queues at once with only the operation id, publishes the proposal atomically with a restarted release', async () => {
    await addPayable();
    await addPayable();
    const runId = await newRun();
    const op = await propose(runId);
    expect(op.status).toBe('QUEUED');
    const row = await opRow(op.operationId);
    expect(row.parameters).toEqual({ operationId: op.operationId });
    expect((await getPaymentRun(client, RUN_DATE, runId))!.proposal).toHaveLength(0);
    // It sits on the INTENSIVE queue, which the regular worker's filter does not include.
    expect(await count(sql`select count(*)::int as n from job_run j join job_definition d on d.code = j.job_code where j.id = ${String(row.jid)} and d.queue = 'INTENSIVE'`)).toBe(1);
    expect((await propose(runId)).operationId).toBe(op.operationId); // duplicate click
    // Nothing that changes the proposal or its approval can run underneath the job.
    await expectRefusal(generateProposal({ client, changedBy: ACTOR, runDate: RUN_DATE, runId }), /cannot be regenerated while a background proposal is queued/);
    await expectRefusal(cancelPaymentRun({ client, changedBy: ACTOR, runDate: RUN_DATE, runId }), /cannot be cancelled while a background proposal/);
    await expectRefusal(execute(runId), /Create the proposal before executing/);

    const seen: Array<{ items: number; stage: number }> = [];
    useHandlers(async (ctx, real) => {
      const result = await real();
      // Between chunks the run still shows its previous (empty) proposal; the stage holds the new one.
      if (result.cursor !== null) seen.push({ items: (await getPaymentRun(client, RUN_DATE, runId))!.proposal.length, stage: await stageRows() });
      return result;
    });
    expect(await drive()).toEqual(['SUCCEEDED']);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.items === 0 && s.stage > 0)).toBe(true);
    const run = (await getPaymentRun(client, RUN_DATE, runId))!;
    expect(run.status).toBe('PROPOSAL');
    expect(run.proposal.filter((p) => !p.exceptionCode).length).toBeGreaterThanOrEqual(2);
    expect(await stageRows()).toBe(0);
    expect(await getPaymentRunRelease(client, RUN_DATE, runId)).toMatchObject({ status: 'PENDING', currentStep: 0 });
    expect((await getPaymentOperation(client, op.operationId))!.status).toBe('SUCCEEDED');
  });

  it('regenerating invalidates the release, in the same transaction as the new proposal', async () => {
    const runId = await releasedRun();
    expect(await getPaymentRunRelease(client, RUN_DATE, runId)).toMatchObject({ status: 'RELEASED' });
    await propose(runId);
    const during: string[] = [];
    useHandlers(async (ctx, real) => {
      const result = await real();
      if (result.cursor !== null) during.push((await getPaymentRunRelease(client, RUN_DATE, runId)).status);
      return result;
    });
    await drive();
    // While the new proposal was being prepared the old approval still belonged to the old proposal...
    expect(during.length === 0 || during.every((s) => s === 'RELEASED')).toBe(true);
    // ...and once published, the run is back at step one.
    expect(await getPaymentRunRelease(client, RUN_DATE, runId)).toMatchObject({ status: 'PENDING', currentStep: 0 });
    await expectRefusal(execute(runId), /waiting for release/);
  });

  it('a failed proposal leaves the previous proposal and release untouched, and a monitor retry is refused', async () => {
    const runId = await releasedRun();
    const before = (await getPaymentRun(client, RUN_DATE, runId))!.proposal.length;
    const op = await propose(runId);
    useHandlers(async (ctx, real, call) => {
      if (call === 2) throw new Error('forced failure');
      return real();
    });
    expect(await drive()).toEqual(['FAILED']);
    expect((await getPaymentOperation(client, op.operationId))!.status).toBe('FAILED');
    expect((await getPaymentRun(client, RUN_DATE, runId))!.proposal).toHaveLength(before);
    expect(await getPaymentRunRelease(client, RUN_DATE, runId)).toMatchObject({ status: 'RELEASED' });
    expect(await stageRows()).toBe(0);
    useHandlers();
    const row = await opRow(op.operationId);
    await withTenant(client, (tx) => retryRun(tx, client, String(row.jid)));
    expect(await drive()).toEqual(['FAILED']);
    expect(String((await opRow(op.operationId)).error_text)).toBeTruthy();
    expect((await getPaymentRun(client, RUN_DATE, runId))!.proposal).toHaveLength(before);
  });

  it('cancelling mid-proposal stops at a chunk boundary and leaves the previous proposal', async () => {
    const runId = await releasedRun();
    const before = (await getPaymentRun(client, RUN_DATE, runId))!.proposal.length;
    const op = await propose(runId);
    useHandlers(async (ctx, real, call) => {
      const result = await real();
      if (call === 1) await cancelPaymentOperation({ client, operationId: op.operationId, changedBy: planner.username, actorUserId: planner.userId });
      return result;
    });
    expect(await drive()).toEqual(['CANCELLED']);
    expect((await getPaymentOperation(client, op.operationId))!.status).toBe('CANCELLED');
    expect(await stageRows()).toBe(0);
    expect((await getPaymentRun(client, RUN_DATE, runId))!.proposal).toHaveLength(before);
  });
});

describe('execution', () => {
  it('needs the release; once released it queues, blocks competing actions, and posts atomically once', async () => {
    await addPayable();
    const runId = await newRun();
    useHandlers();
    await propose(runId);
    await drive();
    await expectRefusal(execute(runId), /waiting for release/);
    await approve(runId);

    const before = await journals();
    const op = await execute(runId);
    expect(op.status).toBe('QUEUED');
    expect((await opRow(op.operationId)).parameters).toEqual({ operationId: op.operationId });
    expect((await execute(runId)).operationId).toBe(op.operationId); // duplicate click
    expect(await payments(runId)).toBe(0);
    await expectRefusal(generateProposal({ client, changedBy: ACTOR, runDate: RUN_DATE, runId }), /cannot be regenerated while a background execute/);
    await expectRefusal(cancelPaymentRun({ client, changedBy: ACTOR, runDate: RUN_DATE, runId }), /cannot be cancelled while a background execute/);
    await expectRefusal(cancelPaymentRunRelease({ client, changedBy: APPROVER, runDate: RUN_DATE, runId }), /while a background execute/);
    await expectRefusal(executePaymentRun({ client, changedBy: ACTOR, runDate: RUN_DATE, runId, houseBankKey: 'HB01', bankAccountId: 'MAIN' }), /cannot be executed while a background execute/);

    useHandlers();
    expect(await drive()).toEqual(['SUCCEEDED']);
    const run = (await getPaymentRun(client, RUN_DATE, runId))!;
    expect(run.status).toBe('EXECUTED');
    expect(run.payments.length).toBeGreaterThanOrEqual(1);
    expect(await journals()).toBe(before + 1); // one journal per supplier and bank
    const doc = run.payments[0]!.journalDocumentNumber;
    const lines = (await withTenant(client, (tx) => tx.execute(sql`
      select sum(case when debit_credit = 'S' then amount_local else 0 end)::text as d, sum(case when debit_credit = 'H' then amount_local else 0 end)::text as c
        from journal_entry_line where client = ${client} and document_number = ${doc}`))) as unknown as Array<{ d: string; c: string }>;
    expect(lines[0]!.d).toBe(lines[0]!.c);
    expect(await count(sql`select count(*)::int as n from journal_entry_line where client = ${client} and document_number = ${doc} and clearing_document is not null`)).toBeGreaterThan(0);
    expect((await getPaymentOperation(client, op.operationId))!.status).toBe('SUCCEEDED');
    await expectRefusal(execute(runId), /already been executed/);
  });

  it('refuses at the posting boundary when the approval went stale, the item was cleared, or the bank changed', async () => {
    // Stale approval.
    let runId = await releasedRun();
    let op = await execute(runId);
    await cancelDocumentRelease({ client, changedBy: APPROVER, documentCategory: 'PAYMENT_RUN', documentNumber: `${RUN_DATE}/${runId}`, objectKey: `${RUN_DATE}/${runId}` });
    useHandlers();
    expect(await drive()).toEqual(['FAILED']);
    expect((await getPaymentOperation(client, op.operationId))!.errorText).toMatch(/waiting for release/);
    expect((await getPaymentRun(client, RUN_DATE, runId))!.status).toBe('PROPOSAL');
    expect(await payments(runId)).toBe(0);

    // An item cleared by something else after the proposal.
    runId = await releasedRun();
    op = await execute(runId);
    const first = (await getPaymentRun(client, RUN_DATE, runId))!.proposal.find((p) => !p.exceptionCode)!;
    await withTenant(client, (tx) => tx.execute(sql`update journal_entry_line set clearing_document = 'X-CLEARED' where client = ${client} and document_number = ${first.journalDocumentNumber} and fiscal_year = ${first.journalFiscalYear} and line_number = ${first.journalLineNumber}`));
    expect(await drive()).toEqual(['FAILED']);
    expect((await getPaymentOperation(client, op.operationId))!.errorText).toMatch(/no longer stands open/);
    expect(await payments(runId)).toBe(0);
    await withTenant(client, (tx) => tx.execute(sql`update journal_entry_line set clearing_document = null where client = ${client} and document_number = ${first.journalDocumentNumber} and fiscal_year = ${first.journalFiscalYear} and line_number = ${first.journalLineNumber}`));

    // A bank that does not stand is refused at submission, and again if it changes afterwards.
    runId = await releasedRun();
    await expect(execute(runId, planner, { houseBankKey: 'NOPE', bankAccountId: 'MAIN' })).rejects.toThrow(/does not stand/);
    op = await execute(runId);
    await withTenant(client, (tx) => tx.execute(sql`update payment_run_operation set bank_account_id = 'GONE' where client = ${client} and operation_id = ${op.operationId}`));
    expect(await drive()).toEqual(['FAILED']);
    expect((await getPaymentOperation(client, op.operationId))!.errorText).toMatch(/does not stand/);
    expect(await payments(runId)).toBe(0);
  });

  it('fails closed when the submitter loses the capability or is deactivated, and posts nothing', async () => {
    const lost = await createFinanceActor(client, { capabilities: [PAYMENT_RUN_CAPABILITY] });
    const runId = await releasedRun();
    const op = await execute(runId, lost);
    await withTenant(client, (tx) => tx.execute(sql`delete from role_capability rc using user_role ur where ur.client = ${client} and ur.user_id = ${lost.userId} and rc.client = ur.client and rc.role_code = ur.role_code`));
    useHandlers();
    expect(await drive()).toEqual(['FAILED']);
    expect((await getPaymentOperation(client, op.operationId))!.errorText).toMatch(/no longer holds/);
    expect(await payments(runId)).toBe(0);
    expect((await getPaymentRun(client, RUN_DATE, runId))!.status).toBe('PROPOSAL');

    const gone = await createFinanceActor(client, { capabilities: [PAYMENT_RUN_CAPABILITY] });
    const op2 = await execute(runId, gone);
    await withTenant(client, (tx) => tx.update(appUser).set({ isActive: false }).where(eq(appUser.id, gone.userId)));
    expect(await drive()).toEqual(['FAILED']);
    expect((await getPaymentOperation(client, op2.operationId))!.errorText).toMatch(/no longer active/);
    expect(await payments(runId)).toBe(0);

    // Refused at submission: no capability, and out of company scope.
    const nobody = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.POST'] });
    await expect(propose(runId, nobody)).rejects.toThrow(/no longer holds|does not hold/);
    const outside = await createFinanceActor(client, { capabilities: [PAYMENT_RUN_CAPABILITY], companyScopes: ['ZZZ9'] });
    await expect(propose(runId, outside)).rejects.toThrow(/no longer holds/);
  });

  it('cancelling a queued execution, or ending it from the monitor, posts nothing and frees the run', async () => {
    const runId = await releasedRun();
    const op = await execute(runId);
    const cancelled = await cancelPaymentOperation({ client, operationId: op.operationId, changedBy: planner.username, actorUserId: planner.userId });
    expect(cancelled.status).toBe('CANCELLED');
    const op2 = await execute(runId);
    const row = await opRow(op2.operationId);
    await withTenant(client, (tx) => requestCancel(tx, client, String(row.jid)));
    expect((await getPaymentOperation(client, op2.operationId))!.status).toBe('CANCELLED');
    expect(await payments(runId)).toBe(0);
    expect((await propose(runId)).status).toBe('QUEUED');
  });

  it('a forced failure before the posting commits changes nothing; a monitor retry is refused and pays nothing', async () => {
    const runId = await releasedRun();
    const op = await execute(runId);
    useHandlers(undefined, async (ctx, real, call) => {
      if (call === 1) throw new Error('forced failure');
      return real();
    });
    expect(await drive()).toEqual(['FAILED']);
    expect(await payments(runId)).toBe(0);
    useHandlers();
    const row = await opRow(op.operationId);
    await withTenant(client, (tx) => retryRun(tx, client, String(row.jid)));
    expect(await drive()).toEqual(['FAILED']);
    expect(await payments(runId)).toBe(0);
    expect((await getPaymentRun(client, RUN_DATE, runId))!.status).toBe('PROPOSAL');
    // The business retry: execute again.
    const again = await execute(runId);
    expect(again.operationId).not.toBe(op.operationId);
    expect(await drive()).toEqual(['SUCCEEDED']);
    expect(await payments(runId)).toBeGreaterThanOrEqual(1);
  });
});

describe('crash windows and leases', () => {
  it('worker dies after the payments committed but before the job is marked SUCCEEDED: the replay pays nothing again', async () => {
    const runId = await releasedRun();
    const op = await execute(runId);
    let died = false;
    useHandlers(undefined, async (ctx, real) => {
      const result = await real();
      if (!died) { died = true; await dieAfterCommit(ctx); }
      return result;
    });
    const before = await journals();
    expect(await drive()).toEqual(['LEASE_LOST', 'SUCCEEDED']);
    expect(await journals()).toBe(before + 1);
    const run = (await getPaymentRun(client, RUN_DATE, runId))!;
    expect(run.status).toBe('EXECUTED');
    expect(new Set(run.payments.map((p) => `${p.journalDocumentNumber}/${p.journalLineNumber}`)).size).toBe(run.payments.length);
    expect((await getPaymentOperation(client, op.operationId))!.status).toBe('SUCCEEDED');
  });

  it('worker dies after the proposal was published but before the job is marked SUCCEEDED: the replay changes nothing', async () => {
    await addPayable();
    const runId = await newRun();
    const op = await propose(runId);
    let published = 0;
    useHandlers(async (ctx, real) => {
      const result = await real();
      if (result.cursor === null && published === 0) { published += 1; await dieAfterCommit(ctx); }
      return result;
    });
    expect(await drive()).toEqual(['LEASE_LOST', 'SUCCEEDED']);
    const run = (await getPaymentRun(client, RUN_DATE, runId))!;
    expect(run.status).toBe('PROPOSAL');
    expect(new Set(run.proposal.map((p) => p.itemNumber)).size).toBe(run.proposal.length);
    expect((await getPaymentOperation(client, op.operationId))!.status).toBe('SUCCEEDED');
  });

  it('a stale owner cannot post after its lease is lost; the new owner pays once', async () => {
    const runId = await releasedRun();
    const op = await execute(runId);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let started = false;
    useHandlers(undefined, async (ctx, real, call) => {
      if (call === 1) { started = true; await held; }
      return real();
    });
    const a = await claimNext('worker-a', ['INTENSIVE']);
    const aDone = runClaimed('worker-a', a!, { heartbeatMs: 600_000 });
    while (!started) await new Promise((r) => setTimeout(r, 20));
    await withTenant(client, (tx) => tx.execute(sql`update job_run set heartbeat_at = now() - interval '5 minutes' where id = ${a!.runId}`));
    await withTenant(client, (tx) => reapOrphans(tx, client, 1000));
    const b = await claimNext('worker-b', ['INTENSIVE']);
    expect(await runClaimed('worker-b', b!)).toBe('SUCCEEDED');
    const paid = await payments(runId);
    release();
    expect(await aDone).toBe('LEASE_LOST');
    expect(await payments(runId)).toBe(paid);
    expect((await getPaymentOperation(client, op.operationId))!.status).toBe('SUCCEEDED');
  });

  it('a live execution longer than the heartbeat timeout is not reaped while another process reaps', async () => {
    const runId = await releasedRun();
    await execute(runId);
    useHandlers(undefined, async (ctx, real, call) => {
      if (call === 1) await new Promise((r) => setTimeout(r, 2500));
      return real();
    });
    let reaping = true;
    const reaped: string[] = [];
    const reaper = (async () => {
      while (reaping) {
        reaped.push(...(await withTenant(client, (tx) => reapOrphans(tx, client, 1000))));
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    const statuses = await drive({ heartbeatMs: 200 });
    reaping = false;
    await reaper;
    expect(statuses).toEqual(['SUCCEEDED']);
    expect(reaped).toEqual([]);
    expect((await getPaymentRun(client, RUN_DATE, runId))!.status).toBe('EXECUTED');
  });
});

describe('what the generic job tables hold', () => {
  it('carries no supplier, amount, invoice or bank in parameters, progress, results, errors or logs', async () => {
    const runId = await releasedRun();
    const op = await execute(runId);
    useHandlers(undefined, async (ctx, real, call) => {
      if (call === 1) {
        // A refusal inside the business code names a supplier and a bank.
        return runPaymentExecuteChunk({ ...ctx, fence: (() => { let first = true; return async (tx: Parameters<Ctx['fence']>[0]) => { if (first) { first = false; throw new PaymentRunError('Supplier V10000 is blocked at house bank HB01 for 550.0000'); } return ctx.fence(tx); }; })() });
      }
      return real();
    });
    await drive();
    const row = await opRow(op.operationId);
    expect(String(row.error_text)).toContain('V10000');
    const logs = (await withTenant(client, (tx) => tx.execute(sql`select message, context::text as context from job_log where client = ${client} and job_run_id = ${String(row.jid)}`))) as unknown as Array<Record<string, string>>;
    const jobs = (await withTenant(client, (tx) => tx.execute(sql`select parameters::text as p, progress_text, result_summary, error_text, cursor::text as cursor from job_run where client = ${client} and id = ${String(row.jid)}`))) as unknown as Array<Record<string, string | null>>;
    const blob = JSON.stringify([logs, jobs]);
    for (const secret of ['V10000', 'HB01', 'MAIN', '550', randomUUID().slice(0, 0) + 'INV']) {
      expect(blob).not.toContain(secret || 'never');
    }
    expect(blob).toContain('payment run screen');
  });
});
