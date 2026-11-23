/**
 * Controlled salary-file reissue — all or selected employees.
 *
 * What is worth proving: reissue reproduces the original frozen amounts (never a recalculation); ALL and SELECTED
 * both work; mixed attested outcomes are recorded; unknown/pending/paid are refused; "not uploaded" needs an
 * explicit no-submission confirmation; a different approver is required; the replacement uses corrected
 * effective-dated bank details and leaves the original and unselected employees unchanged; successive versions
 * are traceable; stale/concurrent/idempotent requests behave; a draft can be cancelled before approval; a
 * superseded source file is blocked from ordinary download but stays readable as historical evidence; downloads
 * are byte-stable; and no accounting is posted or reversed.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const requestContext = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (requestContext.cookie ? { value: requestContext.cookie } : undefined) }),
}));
vi.mock('next/navigation', () => ({ redirect: (path: string): never => { throw new Error(`REDIRECT:${path}`); } }));

import { withTenant } from '../src/platform/db/client';
import { createSession, encodeSessionCookie } from '../src/platform/auth/session';
import { hashPassword } from '../src/platform/auth/password';
import { appUser, authOrgRestriction, role, roleCapability, userRole } from '../src/platform/tables/security';
import { parseBankDataKeyring } from '../src/platform/security/bank-data-keyring';
import { maintainNumberRange } from '../src/modules/foundation/number-ranges';
import { assignStructure, defineSalaryStructure, SALARY_STRUCTURE_CAPABILITY, setStructureComponent } from '../src/modules/people/payroll-structure';
import { PAYROLL_RUN_CAPABILITY, proposePayrollRun, releasePayrollRun } from '../src/modules/people/payroll-run';
import { postPayrollRun } from '../src/modules/people/payroll-posting';
import { createEmployeeBank, endEmployeeBank, listEmployeeBank } from '../src/modules/people/employee-bank';
import {
  PAYMENT_FILE_CAPABILITY,
  PaymentFileError,
  downloadPaymentFile,
  preparePaymentFile,
} from '../src/modules/people/payroll-payment-file';
import {
  REISSUE_APPROVE_CAPABILITY,
  REISSUE_DOWNLOAD_CAPABILITY,
  REISSUE_REQUEST_CAPABILITY,
  FILE_HISTORICAL_CAPABILITY,
  ReissueError,
  approveReissue,
  cancelReissue,
  downloadHistoricalFile,
  downloadHistoricalReissue,
  downloadReissue,
  listReissueSourceEmployees, listReissues,
  previewReissue,
  requestReissue,
} from '../src/modules/people/payroll-payment-reissue';
import { buildPayrollFixture, createPayrollPoster, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';
import { GET as REISSUE_GET, POST as REISSUE_POST } from '../src/app/people/payroll-runs/payment-file/reissue/route';

const KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: randomBytes(32).toString('base64url') } });
const KEYRING = parseBankDataKeyring(KEYRING_JSON);
const RUN_AUTH: readonly string[] = [PAYROLL_RUN_CAPABILITY];
const STRUCTURE_AUTH: readonly string[] = [SALARY_STRUCTURE_CAPABILITY];
const YEAR = 2025;
const ACTOR = 'REISSUE_TEST';
const savedRing = process.env.CAIRN_BANK_DATA_KEYRING_JSON;

let tenant: TestTenant;
let fx: PayrollFixture;
let otherTenant: TestTenant;

interface Actor { userId: string; sessionId: string; token: string; authorization: { userId: string; sessionId: string } }

async function createActor(client: string, options: { capabilities?: readonly string[]; companyScopes?: readonly string[]; suffix?: string } = {}): Promise<Actor> {
  const suffix = (options.suffix ?? randomUUID().replaceAll('-', '').slice(0, 8)).toUpperCase();
  const capabilities = options.capabilities ?? [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY, REISSUE_DOWNLOAD_CAPABILITY, FILE_HISTORICAL_CAPABILITY, 'PEOPLE.BANK.REVEAL'];
  const companies = options.companyScopes ?? ['1000'];
  const userId = randomUUID();
  const username = `RI.${suffix}`;
  const roleCode = `TEST_RI_${suffix}`;
  const created = await withTenant(client, async (tx) => {
    await tx.insert(role).values({ client, code: roleCode, name: 'Reissue test authority', description: 'Test', isSystemRole: false, isReadOnly: false, createdBy: ACTOR });
    for (const capabilityCode of capabilities) await tx.insert(roleCapability).values({ client, roleCode, capabilityCode, createdBy: ACTOR });
    await tx.insert(appUser).values({ id: userId, client, username, fullName: username, passwordHash: await hashPassword('reissue-test-not-a-login-secret'), isActive: true, isLocked: false, createdBy: ACTOR });
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: ACTOR });
    if (companies.length) await tx.insert(authOrgRestriction).values(companies.map((scopeValue) => ({ id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE' as const, scopeValue, createdBy: ACTOR })));
    const session = await createSession(tx, { client, userId });
    const rows = await tx.execute(sql`select id from user_session where client = ${client} and user_id = ${userId} order by issued_at desc limit 1`) as unknown as Array<{ id: string }>;
    return { sessionId: String(rows[0]!.id), token: session.token };
  });
  return { userId, ...created, authorization: { userId, sessionId: created.sessionId } };
}

async function expectRefusal(promise: Promise<unknown>, wanted: string): Promise<Error> {
  try { await promise; } catch (error) {
    expect(error instanceof ReissueError || error instanceof PaymentFileError, String(error)).toBe(true);
    expect((error as { code: string }).code, (error as Error).message).toBe(wanted);
    return error as Error;
  }
  throw new Error(`Expected refusal ${wanted}, nothing was thrown.`);
}

/** Approve a draft, supplying the frozen snapshot digest the approver acknowledged in review. */
async function approveWithDigest(reissueId: string, approverName = 'RI.APP', actor = approver) {
  const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`select checksum from payroll_payment_reissue where client = ${tenant.client} and reissue_id = ${reissueId}`)) as unknown as Array<{ checksum: string }>;
  const confirmDigest = rows[0]?.checksum;
  return approveReissue(tenant.client, reissueId, approverName, { authorization: actor.authorization }, { confirmDigest });
}

async function employeeOn(): Promise<string> {
  const pn = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
  await assignStructure({ client: tenant.client, personnelNumber: pn, structureCode: main, baseAmount: '1000', currency: fx.currency, validFrom: '2024-01-01', validTo: null, changedBy: ACTOR }, STRUCTURE_AUTH);
  return pn;
}

async function bankAccount(pn: string, options: { from?: string; value?: string; actor?: Actor; beneficiary?: string } = {}) {
  return createEmployeeBank({
    client: tenant.client, personnelNumber: pn, beneficiaryName: options.beneficiary ?? `Beneficiary ${pn}`, bankName: 'Gulf Bank', bankCode: 'GBK01',
    accountKind: 'IBAN', accountValue: options.value ?? `KW00GBK000000000000${pn.slice(-4)}`, validFrom: options.from ?? '2024-01-01', changedBy: ACTOR,
  }, { authorization: (options.actor ?? bankAdmin).authorization }, KEYRING);
}

let main: string;
let runId: string;
let preparationId: string;
let requester: Actor;
let bankAdmin: Actor;
let approver: Actor;
let outsider: Actor;
let otherTenantActor: Actor;
let employees: string[] = [];

beforeAll(async () => {
  process.env.CAIRN_BANK_DATA_KEYRING_JSON = KEYRING_JSON;
  tenant = await createTenant('payroll-reissue', { currency: 'KWD' });
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
      (${tenant.client}, 'PENS', 'Pension (employee)', 'DEDUCTION', true, true, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, created_by)
      values (${tenant.client}, 'PENS', ${fx.chart}, null, '250000', 'NONE', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`update pay_component_config set cost_receiver_category = 'ASSIGNMENT' where client = ${tenant.client} and component_code = 'BASIC' and chart_of_accounts = ${fx.chart}`);
  });
  main = `RI${Date.now().toString().slice(-6)}`;
  await defineSalaryStructure({ client: tenant.client, code: main, name: 'Reissue staff', currency: fx.currency, validFrom: '2024-01-01', changedBy: ACTOR }, STRUCTURE_AUTH);
  for (const [component, kind, value] of [['BASIC', 'PERCENT_OF_BASE', '100'], ['HOUSING', 'FIXED', '200'], ['PENS', 'PERCENT_OF_BASE', '5']] as const) {
    await setStructureComponent({ client: tenant.client, structureCode: main, componentCode: component, amountKind: kind, amountValue: value, changedBy: ACTOR }, STRUCTURE_AUTH);
  }
  requester = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY, REISSUE_DOWNLOAD_CAPABILITY, FILE_HISTORICAL_CAPABILITY, PAYMENT_FILE_CAPABILITY, 'PEOPLE.BANK.REVEAL'], suffix: 'REQ' });
  bankAdmin = await createActor(tenant.client, { capabilities: ['PEOPLE.BANK.MAINTAIN', 'PEOPLE.BANK.VIEW'], suffix: 'BANK' });
  approver = await createActor(tenant.client, { suffix: 'APP' });
  outsider = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY], companyScopes: ['ZZZZ'], suffix: 'OUT' });
  for (let i = 0; i < 3; i++) employees.push(await employeeOn());
  for (const pn of employees) await bankAccount(pn);

  const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 3, changedBy: ACTOR }, RUN_AUTH);
  expect(run.exceptions, JSON.stringify(run.exceptions)).toEqual([]);
  await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: ACTOR }, RUN_AUTH);
  await maintainNumberRange({ client: tenant.client, objectCode: 'RF_BELEG', companyCode: fx.companyCode, subObject: 'GENERAL', fiscalYear: 0, prefix: 'PR', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE', mode: 'CREATE', changedBy: ACTOR, reason: 'reissue setup' });
  const poster = await createPayrollPoster(tenant.client);
  await postPayrollRun({ client: tenant.client, runId: run.runId, changedBy: poster.username, authorization: poster.authorization });
  runId = run.runId;
  const view = await preparePaymentFile({ client: tenant.client, runId, intendedPaymentDate: '2025-04-01', changedBy: ACTOR }, { authorization: requester.authorization });
  preparationId = view.preparationId;

  otherTenant = await createTenant('payroll-reissue-other', { withConfiguration: false });
  otherTenantActor = await createActor(otherTenant.client, { suffix: 'TEN' });
}, 180_000);

afterAll(async () => {
  if (savedRing === undefined) delete process.env.CAIRN_BANK_DATA_KEYRING_JSON; else process.env.CAIRN_BANK_DATA_KEYRING_JSON = savedRing;
  if (tenant) await destroyTenant(tenant.client);
  if (otherTenant) await destroyTenant(otherTenant.client);
});

const att = (pn: string, outcome = 'BANK_REJECTED', extra: Record<string, unknown> = {}) => ({
  personnelNumber: pn, outcome, reason: 'Bank rejected the file', verificationDate: '2025-04-02', evidenceReference: 'BANKREF-1', ...extra,
});

async function requestSelected(pns: string[], actor = requester, date = '2025-04-15', attestations?: unknown[]) {
  return requestReissue({
    client: tenant.client, sourcePreparationId: preparationId, selection: 'SELECTED', personnelNumbers: pns,
    intendedPaymentDate: date, reason: 'Bank rejected the original file',
    attestations: (attestations ?? pns.map((pn) => att(pn))) as never, requestKey: randomUUID(), changedBy: 'RI.REQ',
  }, { authorization: actor.authorization });
}

describe('preview and eligibility', () => {
  it('previews ALL and per-employee eligibility, and refuses a missing account', async () => {
    const all = await previewReissue(tenant.client, { sourcePreparationId: preparationId, selection: 'ALL', intendedPaymentDate: '2025-04-15' }, { authorization: requester.authorization });
    expect(all.employeeCount).toBe(3);
    expect(all.totalAmount).toMatch(/^\d+\.\d{3}$/);
    // A replacement intended date with no effective account: every employee becomes ineligible with a reason.
    const gap = await previewReissue(tenant.client, { sourcePreparationId: preparationId, selection: 'ALL', intendedPaymentDate: '2023-01-01' }, { authorization: requester.authorization });
    expect(gap.employeeCount).toBe(0);
    expect(gap.ineligible.length).toBe(3);
    expect(gap.ineligible[0]!.blocker).toMatch(/No bank account is effective/);
  });
});

describe('attestation and approval', () => {
  it('blocks unknown/pending/paid outcomes and unconfirmed "not uploaded"', async () => {
    await expectRefusal(requestSelected([employees[0]!], requester, '2025-04-15', [att(employees[0]!, 'PENDING')]), 'ATTESTATION_INVALID');
    await expectRefusal(requestSelected([employees[0]!], requester, '2025-04-15', [att(employees[0]!, 'ACCEPTED')]), 'ATTESTATION_INVALID');
    await expectRefusal(requestSelected([employees[0]!], requester, '2025-04-15', [{ ...att(employees[0]!, 'NOT_UPLOADED'), confirmedNoSubmission: false }]), 'NO_SUBMISSION_UNCONFIRMED');
  });

  it('a valid draft is created, then only a different approver can release it', async () => {
    const draft = await requestSelected([employees[0]!], requester);
    expect(draft.status).toBe('DRAFT');
    expect(draft.version).toBe(1);
    expect(draft.lines).toHaveLength(1);
    await expectRefusal(approveReissue(tenant.client, draft.reissueId, 'RI.REQ', { authorization: requester.authorization }), 'FOUR_EYES');
    const approved = await approveWithDigest(draft.reissueId);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedBy).toBe('RI.APP');
  });

  it('a draft can be cancelled before approval, with audit', async () => {
    const draft = await requestSelected([employees[1]!], requester);
    const cancelled = await cancelReissue(tenant.client, draft.reissueId, { reason: 'Wrong reason', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    expect(cancelled.status).toBe('CANCELLED');
    const audit = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select detail from audit_access_log where client = ${tenant.client} and object_key = ${draft.reissueId} and detail like '%Cancelled%' limit 1`)) as unknown as Array<{ detail: string }>;
    expect(audit.length).toBe(1);
  });
});

describe('replacement content and safety', () => {
  it('reproduces the original frozen amount, uses corrected bank details, and leaves the original unchanged', async () => {
    // Change employee[0]'s bank account to a new one effective recently.
    for (const rec of await listEmployeeBank(tenant.client, employees[0]!, { authorization: bankAdmin.authorization }, KEYRING)) {
      if (rec.isActive && !rec.validTo) await endEmployeeBank({ client: tenant.client, bankRecordId: rec.bankRecordId, validTo: '2025-04-09', changedBy: ACTOR }, { authorization: bankAdmin.authorization }, KEYRING);
    }
    await bankAccount(employees[0]!, { from: '2025-04-10', value: 'KW00GBKNEW0000000009999' });

    const originalBefore = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select bank_snapshot::text as snap from payroll_payment_file where client = ${tenant.client} and preparation_id = ${preparationId}`)) as unknown as Array<{ snap: string }>;
    const originalSnapBefore = originalBefore[0]!.snap;

    const draft = await requestSelected([employees[0]!], requester, '2025-04-20');
    await approveWithDigest(draft.reissueId);
    const download = await downloadReissue(tenant.client, draft.reissueId, { requestedBy: 'RI.APP' }, { authorization: approver.authorization });
    const csv = download.body.toString('utf8');
    // The corrected (new) account, at the replacement's effective date.
    expect(csv).toMatch(/KW00GBKNEW0000000009999/);
    // The frozen amount equals the source's frozen amount for that employee.
    const source = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select bank_snapshot::jsonb as snap from payroll_payment_file where client = ${tenant.client} and preparation_id = ${preparationId}`)) as unknown as Array<{ snap: Array<{ personnelNumber: string; amount: string }> }>;
    const sourceAmount = source[0]!.snap.find((s) => s.personnelNumber === employees[0]!)!.amount;
    expect(csv).toContain(sourceAmount);
    // The replacement carries exactly one row for the selected employee.
    expect(csv.trimEnd().split('\r\n')).toHaveLength(2);

    // The original file's frozen snapshot is byte-unchanged.
    const original = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select bank_snapshot::text as snap from payroll_payment_file where client = ${tenant.client} and preparation_id = ${preparationId}`)) as unknown as Array<{ snap: string }>;
    expect(original[0]!.snap).toBe(originalSnapBefore);
  });

  it('a fresh download is not a reuse, and a re-download is byte-stable and flagged', async () => {
    // A brand-new approved replacement has never been downloaded, so the first download must not look reused.
    const draft = await requestSelected([employees[2]!], requester, '2025-05-10');
    await approveWithDigest(draft.reissueId);
    const first = await downloadReissue(tenant.client, draft.reissueId, { requestedBy: 'RI.A' }, { authorization: approver.authorization });
    const second = await downloadReissue(tenant.client, draft.reissueId, { requestedBy: 'RI.B' }, { authorization: approver.authorization });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.body.equals(second.body)).toBe(true);
  });

  it('no payroll recalculation and no accounting change on request/approve/download', async () => {
    const snapshot = async () => withTenant(tenant.client, async (tx) => {
      const [j] = (await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${tenant.client}`)) as unknown as Array<{ n: number }>;
      const [p] = (await tx.execute(sql`select count(*)::int as n from payroll_result where client = ${tenant.client}`)) as unknown as Array<{ n: number }>;
      return { journals: j!.n, results: p!.n };
    });
    const before = await snapshot();
    const draft = await requestSelected([employees[2]!], requester);
    await approveWithDigest(draft.reissueId);
    await downloadReissue(tenant.client, draft.reissueId, { requestedBy: 'RI.APP' }, { authorization: approver.authorization });
    expect(await snapshot()).toEqual(before);
  });
});

describe('traceability, blocking and concurrency', () => {
  it('repeated selected reissues form successive versions, each linked to its predecessor', async () => {
    const draft = await requestSelected([employees[2]!], requester);
    // A second draft for the same employee while the first is unapproved is refused.
    await expectRefusal(requestSelected([employees[2]!], requester), 'REISSUE_CONFLICT');
    await approveWithDigest(draft.reissueId);
    // A second version for the same employee now links to the first reissue as its predecessor.
    const second = await requestSelected([employees[2]!], requester, '2025-04-25');
    expect(second.lines[0]!.predecessorKind).toBe('REISSUE');
    expect(second.lines[0]!.predecessorId).toBe(draft.reissueId);
    expect(second.version).toBeGreaterThan(draft.version);
  });

  it('blocks the ordinary download of a superseded source file, but exposes it as historical evidence', async () => {
    await expectRefusal(
      downloadPaymentFile(tenant.client, runId, { confirmReuse: true, requestedBy: 'RI.X' }, { authorization: requester.authorization }),
      'FILE_SUPERSEDED',
    );
    const historical = await downloadHistoricalFile(tenant.client, preparationId, { authorization: approver.authorization });
    expect(historical.historical).toBe(true);
    expect(historical.filename.startsWith('HISTORICAL-')).toBe(true);
    // Historical access is a separate capability; an actor without it is refused.
    const noHist = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY], suffix: 'NOHIST' });
    await expectRefusal(downloadHistoricalFile(tenant.client, preparationId, { authorization: noHist.authorization }), 'REISSUE_AUTHORITY');
  });

  it('is idempotent under a repeated request key and refuses a stale/ineligible request', async () => {
    const key = randomUUID();
    const first = await requestReissue({
      client: tenant.client, sourcePreparationId: preparationId, selection: 'SELECTED', personnelNumbers: [employees[1]!],
      intendedPaymentDate: '2025-04-15', reason: 'Idempotent retry', attestations: [att(employees[1]!)] as never, requestKey: key, changedBy: 'RI.REQ',
    }, { authorization: requester.authorization });
    const replay = await requestReissue({
      client: tenant.client, sourcePreparationId: preparationId, selection: 'SELECTED', personnelNumbers: [employees[1]!],
      intendedPaymentDate: '2025-04-15', reason: 'Idempotent retry', attestations: [att(employees[1]!)] as never, requestKey: key, changedBy: 'RI.REQ',
    }, { authorization: requester.authorization });
    expect(replay.reissueId).toBe(first.reissueId);
    // A draft stands for employees[1]; requesting again without its key is refused.
    await expectRefusal(requestSelected([employees[1]!], requester), 'REISSUE_CONFLICT');
  });

  it('refuses an out-of-scope, missing-capability, unauthenticated and wrong-tenant caller', async () => {
    await expectRefusal(previewReissue(tenant.client, { sourcePreparationId: preparationId, selection: 'ALL', intendedPaymentDate: '2025-04-15' }, { authorization: undefined }), 'REISSUE_AUTHORITY');
    await expectRefusal(previewReissue(tenant.client, { sourcePreparationId: preparationId, selection: 'ALL', intendedPaymentDate: '2025-04-15' }, { authorization: outsider.authorization }), 'FILE_UNAVAILABLE');
    await expectRefusal(listReissues(otherTenant.client, runId, { authorization: otherTenantActor.authorization }), 'REISSUE_UNAVAILABLE');
  });

  it('a caller who reaches no company cannot list or cancel a replacement', async () => {
    const open = (await listReissues(tenant.client, runId, { authorization: requester.authorization })).find((r) => r.status === 'DRAFT');
    expect(open).toBeTruthy();
    const scopedOut = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY], companyScopes: ['ZZZZ'], suffix: 'SCOPE' });
    await expectRefusal(listReissues(tenant.client, runId, { authorization: scopedOut.authorization }), 'REISSUE_UNAVAILABLE');
    await expectRefusal(cancelReissue(tenant.client, open!.reissueId, { reason: 'x', changedBy: 'RI.SCOPE' }, { authorization: scopedOut.authorization }), 'REISSUE_UNAVAILABLE');
  });

  it('concurrent requests for the same employee create exactly one draft', async () => {
    for (const r of (await listReissues(tenant.client, runId, { authorization: requester.authorization })).filter((x) => x.status === 'DRAFT')) {
      await cancelReissue(tenant.client, r.reissueId, { reason: 'Test prep', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    }
    const settle = await Promise.allSettled([
      requestSelected([employees[0]!], requester, '2025-06-01'),
      requestSelected([employees[0]!], requester, '2025-06-01'),
    ]);
    expect(settle.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settle.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect((rejected[0]!.reason as ReissueError).code).toBe('REISSUE_CONFLICT');
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from payroll_payment_reissue_line where client = ${tenant.client} and run_id = ${runId} and personnel_number = ${employees[0]!} and state = 'DRAFT'`)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  }, 60_000);

  it('a legacy file (plaintext body, no snapshot) can still be replaced once accounts exist', async () => {
    const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 6, changedBy: ACTOR }, RUN_AUTH);
    expect(run.exceptions, JSON.stringify(run.exceptions)).toEqual([]);
    await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: ACTOR }, RUN_AUTH);
    const poster = await createPayrollPoster(tenant.client);
    await postPayrollRun({ client: tenant.client, runId: run.runId, changedBy: poster.username, authorization: poster.authorization });
    for (const pn of (await withTenant(tenant.client, (tx) => tx.execute(sql`select personnel_number as pn from payroll_result where client = ${tenant.client} and run_id = ${run.runId}`)) as unknown as Array<{ pn: string }>).map((r) => r.pn)) {
      await bankAccount(pn, { from: '2024-01-01' }).catch(() => null);
    }
    const prepared = await preparePaymentFile({ client: tenant.client, runId: run.runId, intendedPaymentDate: '2025-07-01', changedBy: ACTOR }, { authorization: requester.authorization });
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`select bank_snapshot::text as snap from payroll_payment_file where client = ${tenant.client} and preparation_id = ${prepared.preparationId}`)) as unknown as Array<{ snap: string }>;
    const snap = JSON.parse(rows[0]!.snap) as Array<{ personnelNumber: string; beneficiaryName: string; amount: string; currency: string; intendedPaymentDate: string }>;
    const legacyCsv = 'file_reference,run_reference,personnel_number,beneficiary_name,amount,currency,intended_payment_date,beneficiary_bank_name,beneficiary_bank_code,beneficiary_account,beneficiary_iban,remittance_information\r\n'
      + snap.map((r) => `${prepared.fileReference},RUN,${r.personnelNumber},${r.beneficiaryName},${r.amount},${r.currency},${r.intendedPaymentDate},,,,,`).join('\r\n') + '\r\n';
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update payroll_payment_file set body = ${Buffer.from(legacyCsv, 'utf8')}, bank_data_included = false, bank_snapshot = '[]'::jsonb
       where client = ${tenant.client} and preparation_id = ${prepared.preparationId}`));
    const sources = await listReissueSourceEmployees(tenant.client, prepared.preparationId, { authorization: requester.authorization });
    expect(sources.length).toBe(3);
    const draft = await requestReissue({
      client: tenant.client, sourcePreparationId: prepared.preparationId, selection: 'ALL', intendedPaymentDate: '2025-07-10',
      reason: 'Legacy file replaced', attestations: sources.map((s) => att(s.personnelNumber, 'NOT_UPLOADED', { confirmedNoSubmission: true })) as never,
      requestKey: randomUUID(), changedBy: 'RI.REQ',
    }, { authorization: requester.authorization });
    expect(draft.employeeCount).toBe(3);
    await cancelReissue(tenant.client, draft.reissueId, { reason: 'Test cleanup', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
  }, 120_000);

  it('a reversed salary payment refuses a replacement', async () => {
    const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 7, changedBy: ACTOR }, RUN_AUTH);
    await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: ACTOR }, RUN_AUTH);
    const poster = await createPayrollPoster(tenant.client);
    await postPayrollRun({ client: tenant.client, runId: run.runId, changedBy: poster.username, authorization: poster.authorization });
    for (const pn of (await withTenant(tenant.client, (tx) => tx.execute(sql`select personnel_number as pn from payroll_result where client = ${tenant.client} and run_id = ${run.runId}`)) as unknown as Array<{ pn: string }>).map((r) => r.pn)) {
      await bankAccount(pn, { from: '2024-01-01' }).catch(() => null);
    }
    const prepared = await preparePaymentFile({ client: tenant.client, runId: run.runId, intendedPaymentDate: '2025-08-01', changedBy: ACTOR }, { authorization: requester.authorization });
    // A salary-payment row (PY) is test setup only; the guard under test is the reissue reversal check.
    const doc = 'PY-REV-TEST';
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into salary_payment (client, payment_id, run_id, company_code, fiscal_year, period, payment_date, currency,
          house_bank_key, bank_account_id, bank_gl_account, net_pay_account, employee_count, total_amount,
          document_number, document_fiscal_year, request_key, paid_by, paid_at, created_by)
        values (${tenant.client}, ${randomUUID()}, ${run.runId}, ${fx.companyCode}, ${YEAR}, 7, '2025-08-01', ${fx.currency},
          'HB001', 'ACC01', '120000', '251000', 3, 1, ${doc}, ${YEAR}, ${'PY-REQ-' + run.runId.slice(0, 8)}, ${ACTOR}, now(), ${ACTOR})`);
      await tx.execute(sql`
        insert into accounting_reversal_link (client, original_company_code, original_document_number, original_fiscal_year,
          reversal_company_code, reversal_document_number, reversal_fiscal_year, reversal_reason, reversal_document_date,
          reversal_posting_period, reversal_posting_date, reversed_by)
        values (${tenant.client}, ${fx.companyCode}, ${doc}, ${YEAR}, ${fx.companyCode}, 'REV-SAL-1',
          ${YEAR}, '01', '2025-09-30', 9, '2025-09-30', ${ACTOR})`);
    });
    const source = await listReissueSourceEmployees(tenant.client, prepared.preparationId, { authorization: requester.authorization });
    await expectRefusal(requestReissue({
      client: tenant.client, sourcePreparationId: prepared.preparationId, selection: 'ALL', intendedPaymentDate: '2025-09-05',
      reason: 'After reversal', attestations: source.map((s) => att(s.personnelNumber)) as never, requestKey: randomUUID(), changedBy: 'RI.REQ',
    }, { authorization: requester.authorization }), 'PAYMENT_REVERSED');
  }, 120_000);
});

describe('supersession, scope, review and idempotency guarantees', () => {
  // Build an isolated run with three employees and a first file, then a v1 replacement for ONE employee and a
  // v2 replacement for the SAME employee — so v1 is superseded while the other employees stay untouched.
  let sRunId: string;
  let sPrep: string;
  let sEmployees: string[] = [];

  beforeAll(async () => {
    const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 12, changedBy: ACTOR }, RUN_AUTH);
    expect(run.exceptions, JSON.stringify(run.exceptions)).toEqual([]);
    await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: ACTOR }, RUN_AUTH);
    const poster = await createPayrollPoster(tenant.client);
    await postPayrollRun({ client: tenant.client, runId: run.runId, changedBy: poster.username, authorization: poster.authorization });
    sRunId = run.runId;
    sEmployees = (await withTenant(tenant.client, (tx) => tx.execute(sql`select personnel_number as pn from payroll_result where client = ${tenant.client} and run_id = ${run.runId} order by personnel_number`)) as unknown as Array<{ pn: string }>).map((r) => r.pn);
    for (const pn of sEmployees) await bankAccount(pn).catch(() => null);
    sPrep = (await preparePaymentFile({ client: tenant.client, runId: run.runId, intendedPaymentDate: '2025-12-10', changedBy: ACTOR }, { authorization: requester.authorization })).preparationId;
  }, 120_000);

  it('v1 → v2 supersession of one employee in a multi-employee file blocks the old replacement and original', async () => {
    const target = sEmployees[0]!;
    const v1 = await requestReissue({ client: tenant.client, sourcePreparationId: sPrep, selection: 'SELECTED', personnelNumbers: [target], intendedPaymentDate: '2025-12-12', reason: 'v1', attestations: [att(target)] as never, requestKey: randomUUID(), changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    await approveWithDigest(v1.reissueId);
    const v1dl = await downloadReissue(tenant.client, v1.reissueId, { requestedBy: 'RI.A' }, { authorization: approver.authorization });
    expect(v1dl.body.length).toBeGreaterThan(0);
    // v2 for the same employee, approved → v1 is now superseded.
    const v2 = await requestReissue({ client: tenant.client, sourcePreparationId: sPrep, selection: 'SELECTED', personnelNumbers: [target], intendedPaymentDate: '2025-12-20', reason: 'v2', attestations: [att(target, 'RETURNED')] as never, requestKey: randomUUID(), changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    await approveWithDigest(v2.reissueId);
    // The old replacement may no longer be downloaded; the current one may.
    const err = await expectRefusal(downloadReissue(tenant.client, v1.reissueId, { requestedBy: 'RI.A' }, { authorization: approver.authorization }), 'REISSUE_SUPERSEDED');
    expect((err as ReissueError).message).toMatch(/later approved replacement/);
    const current = await downloadReissue(tenant.client, v2.reissueId, { requestedBy: 'RI.A' }, { authorization: approver.authorization });
    expect(current.body.length).toBeGreaterThan(0);
    // The original file (with a superseded instruction) is blocked from ordinary download, but readable as history.
    await expectRefusal(downloadPaymentFile(tenant.client, sRunId, { confirmReuse: true, requestedBy: 'RI.X' }, { authorization: requester.authorization }), 'FILE_SUPERSEDED');
    const hist = await downloadHistoricalFile(tenant.client, sPrep, { authorization: approver.authorization });
    expect(hist.warning).toMatch(/HISTORICAL/);
    // An unselected employee's obligation is unchanged: the source still lists them, and no replacement covers them.
    const latest = await listReissues(tenant.client, sRunId, { authorization: approver.authorization });
    const covered = new Set(latest.filter((r) => r.status === 'APPROVED').flatMap((r) => r.lines.map((l) => l.personnelNumber)));
    expect(covered.has(target)).toBe(true);
    expect(covered.has(sEmployees[1]!)).toBe(false);
  }, 120_000);

  it('a plant-limited or wrong-tenant caller cannot preview, list, source-list or replay outside reach', async () => {
    // A company-scoped-out actor (reaches nothing) is refused on every read path.
    const none = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY, REISSUE_DOWNLOAD_CAPABILITY, FILE_HISTORICAL_CAPABILITY, 'PEOPLE.BANK.REVEAL'], companyScopes: ['ZZZZ'], suffix: 'NONE' });
    await expectRefusal(previewReissue(tenant.client, { sourcePreparationId: sPrep, selection: 'ALL', intendedPaymentDate: '2025-12-10' }, { authorization: none.authorization }), 'FILE_UNAVAILABLE');
    await expectRefusal(listReissueSourceEmployees(tenant.client, sPrep, { authorization: none.authorization }), 'FILE_UNAVAILABLE');
    await expectRefusal(listReissues(tenant.client, sRunId, { authorization: none.authorization }), 'REISSUE_UNAVAILABLE');
    await expectRefusal(downloadHistoricalFile(tenant.client, sPrep, { authorization: none.authorization }), 'FILE_UNAVAILABLE');
    // Wrong tenant: indistinguishable from missing.
    await expectRefusal(previewReissue(otherTenant.client, { sourcePreparationId: sPrep, selection: 'ALL', intendedPaymentDate: '2025-12-10' }, { authorization: otherTenantActor.authorization }), 'FILE_UNAVAILABLE');
  });

  it('a key cannot replay a request with different employees or attestations', async () => {
    const key = randomUUID();
    const first = await requestReissue({ client: tenant.client, sourcePreparationId: sPrep, selection: 'SELECTED', personnelNumbers: [sEmployees[1]!], intendedPaymentDate: '2025-12-15', reason: 'key test', attestations: [att(sEmployees[1]!)] as never, requestKey: key, changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    // Different attestation (outcome) with the same key → refused, not the wrong draft.
    await expectRefusal(requestReissue({ client: tenant.client, sourcePreparationId: sPrep, selection: 'SELECTED', personnelNumbers: [sEmployees[1]!], intendedPaymentDate: '2025-12-15', reason: 'key test', attestations: [att(sEmployees[1]!, 'RETURNED')] as never, requestKey: key, changedBy: 'RI.REQ' }, { authorization: requester.authorization }), 'REISSUE_KEY_REUSED');
    // Different employee set with the same key → refused.
    await expectRefusal(requestReissue({ client: tenant.client, sourcePreparationId: sPrep, selection: 'SELECTED', personnelNumbers: [sEmployees[2]!], intendedPaymentDate: '2025-12-15', reason: 'key test', attestations: [att(sEmployees[2]!)] as never, requestKey: key, changedBy: 'RI.REQ' }, { authorization: requester.authorization }), 'REISSUE_KEY_REUSED');
    // An identical retry replays the same draft.
    const same = await requestReissue({ client: tenant.client, sourcePreparationId: sPrep, selection: 'SELECTED', personnelNumbers: [sEmployees[1]!], intendedPaymentDate: '2025-12-15', reason: 'key test', attestations: [att(sEmployees[1]!)] as never, requestKey: key, changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    expect(same.reissueId).toBe(first.reissueId);
    await cancelReissue(tenant.client, first.reissueId, { reason: 'cleanup', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
  }, 60_000);

  it('concurrent identical and different keyed retries never return the wrong draft', async () => {
    const key = randomUUID();
    const payload = { client: tenant.client, sourcePreparationId: sPrep, selection: 'SELECTED' as const, personnelNumbers: [sEmployees[2]!], intendedPaymentDate: '2025-12-16', reason: 'concurrent key', attestations: [att(sEmployees[2]!)] as never, requestKey: key, changedBy: 'RI.REQ' };
    const results = await Promise.allSettled([requestReissue(payload, { authorization: requester.authorization }), requestReissue(payload, { authorization: requester.authorization })]);
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ reissueId: string }>[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.value.reissueId)).size).toBe(1);
    await cancelReissue(tenant.client, ok[0]!.value.reissueId, { reason: 'cleanup', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
  }, 60_000);

  it('approval is refused when the effective bank details changed since the draft was prepared', async () => {
    const target = sEmployees[2]!;
    const draft = await requestReissue({ client: tenant.client, sourcePreparationId: sPrep, selection: 'SELECTED', personnelNumbers: [target], intendedPaymentDate: '2025-12-18', reason: 'bank change', attestations: [att(target)] as never, requestKey: randomUUID(), changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    // Change the account effective on the draft's date, after the draft was frozen.
    for (const rec of await listEmployeeBank(tenant.client, target, { authorization: bankAdmin.authorization }, KEYRING)) {
      if (rec.isActive && !rec.validTo) await endEmployeeBank({ client: tenant.client, bankRecordId: rec.bankRecordId, validTo: '2025-12-17', changedBy: ACTOR }, { authorization: bankAdmin.authorization }, KEYRING);
    }
    await bankAccount(target, { from: '2025-12-18', value: 'KW00GBKCHANGED0000007777' });
    await expectRefusal(approveWithDigest(draft.reissueId), 'REISSUE_BANK_CHANGED');
    await cancelReissue(tenant.client, draft.reissueId, { reason: 'obsolete destination', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
  }, 60_000);

  it('double approve and approve/cancel races: exactly one wins', async () => {
    const target = sEmployees[1]!;
    // Free any standing draft for the target first.
    for (const r of (await listReissues(tenant.client, sRunId, { authorization: approver.authorization })).filter((x) => x.status === 'DRAFT')) {
      await cancelReissue(tenant.client, r.reissueId, { reason: 'prep', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    }
    const draft = await requestReissue({ client: tenant.client, sourcePreparationId: sPrep, selection: 'SELECTED', personnelNumbers: [target], intendedPaymentDate: '2025-12-19', reason: 'race', attestations: [att(target)] as never, requestKey: randomUUID(), changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    // approve vs cancel concurrently
    const race = await Promise.allSettled([
      approveWithDigest(draft.reissueId),
      cancelReissue(tenant.client, draft.reissueId, { reason: 'race cancel', changedBy: 'RI.REQ' }, { authorization: requester.authorization }),
    ]);
    const won = race.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const lost = race.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    expect(['REISSUE_STATE', 'REISSUE_CONFLICT']).toContain((lost!.reason as ReissueError).code);
  }, 60_000);

  it('the beneficiary name is the effective bank record, not the employee master', async () => {
    // The outer beforeAll created the source file; its rows must carry the bank record's beneficiary name
    // (bankAccount default `Beneficiary <pn>`), while the employee master reads `Payroll Test <pn>`.
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select bank_snapshot::text as snap from payroll_payment_file where client = ${tenant.client} and preparation_id = ${preparationId}`)) as unknown as Array<{ snap: string }>;
    const snap = JSON.parse(rows[0]!.snap) as Array<{ personnelNumber: string; beneficiaryName: string }>;
    const masters = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select personnel_number as pn, full_name as name from employee where client = ${tenant.client} and personnel_number in (${sql.join(employees.map((e) => sql`${e}`), sql`, `)})`)) as unknown as Array<{ pn: string; name: string }>;
    for (const row of snap) {
      const master = masters.find((m) => m.pn === row.personnelNumber);
      if (!master) continue;
      expect(row.beneficiaryName).toBe(`Beneficiary ${row.personnelNumber}`);
      expect(row.beneficiaryName).not.toBe(master.name);
    }
  }, 60_000);

  it('reissue and historical downloads require the bank-reveal authority, not just their own capability', async () => {
    const noBank = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY, REISSUE_DOWNLOAD_CAPABILITY, FILE_HISTORICAL_CAPABILITY], suffix: 'NOBANK' });
    // An approved, current replacement exists in the suite (from the supersession test the target's v2).
    const approved = (await listReissues(tenant.client, sRunId, { authorization: approver.authorization })).find((r) => r.status === 'APPROVED');
    if (approved) {
      await expectRefusal(downloadReissue(tenant.client, approved.reissueId, { requestedBy: 'RI.NB' }, { authorization: noBank.authorization }), 'REISSUE_BANK_AUTHORITY');
    }
    await expectRefusal(downloadHistoricalFile(tenant.client, sPrep, { authorization: noBank.authorization }), 'REISSUE_BANK_AUTHORITY');
  });
});

describe('destination checks, historical replacements, and deliberate approval', () => {
  // Reuse the outer 3-employee source file, but normalise every employee's bank history to a late, unambiguous
  // window so these tests are independent of what earlier tests left behind.
  const D = { endOld: '2025-12-31', start: '2026-01-01', payment: '2026-01-15', draft: '2026-01-20' };
  let dPrep: string;
  let dEmployees: string[] = [];

  beforeAll(async () => {
    dPrep = preparationId;
    dEmployees = [...employees];
    for (const pn of dEmployees) {
      for (const rec of await listEmployeeBank(tenant.client, pn, { authorization: bankAdmin.authorization }, KEYRING)) {
        if (rec.isActive && !rec.validTo && rec.validFrom <= D.endOld) {
          await endEmployeeBank({ client: tenant.client, bankRecordId: rec.bankRecordId, validTo: D.endOld, changedBy: ACTOR }, { authorization: bankAdmin.authorization }, KEYRING).catch(() => null);
        }
      }
      await bankAccount(pn, { beneficiary: `Bank ${pn}`, from: D.start }).catch(() => null);
    }
    // A replacement source snapshot taken at the late payment date, so its rows carry the normalised accounts.
    dPrep = (await preparePaymentFile({ client: tenant.client, runId, intendedPaymentDate: D.payment, changedBy: ACTOR }, { authorization: requester.authorization }).catch(() => null))?.preparationId ?? preparationId;
  }, 120_000);

  async function draftFor(pn: string, date = D.draft) {
    // Free any standing draft for the obligation first.
    for (const r of (await listReissues(tenant.client, runId, { authorization: approver.authorization })).filter((x) => x.status === 'DRAFT')) {
      await cancelReissue(tenant.client, r.reissueId, { reason: 'prep', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    }
    return requestReissue({ client: tenant.client, sourcePreparationId: dPrep, selection: 'SELECTED', personnelNumbers: [pn], intendedPaymentDate: date, reason: 'dest test', attestations: [att(pn)] as never, requestKey: randomUUID(), changedBy: 'RI.REQ' }, { authorization: requester.authorization });
  }
  async function replaceAccount(pn: string, beneficiary: string, value: string, kind: 'IBAN' | 'ACCOUNT' = 'IBAN') {
    for (const rec of await listEmployeeBank(tenant.client, pn, { authorization: bankAdmin.authorization }, KEYRING)) {
      if (rec.isActive && !rec.validTo) await endEmployeeBank({ client: tenant.client, bankRecordId: rec.bankRecordId, validTo: '2026-01-09', changedBy: ACTOR }, { authorization: bankAdmin.authorization }, KEYRING).catch(() => null);
    }
    return createEmployeeBank({ client: tenant.client, personnelNumber: pn, beneficiaryName: beneficiary, bankName: 'Gulf Bank', bankCode: 'GBK01', accountKind: kind, accountValue: value, validFrom: '2026-01-10', changedBy: ACTOR }, { authorization: bankAdmin.authorization }, KEYRING);
  }

  it('a changed beneficiary with the SAME account number is refused at approval', async () => {
    const pn = dEmployees[0]!;
    const draft = await draftFor(pn);
    await replaceAccount(pn, 'A Different Beneficiary', `KW00GBK000000000000${pn.slice(-4)}`);
    await expectRefusal(approveWithDigest(draft.reissueId), 'REISSUE_BANK_CHANGED');
    await cancelReissue(tenant.client, draft.reissueId, { reason: 'changed', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
  }, 60_000);

  it('a changed account kind is refused at approval', async () => {
    const pn = dEmployees[1]!;
    const d1 = await draftFor(pn);
    await replaceAccount(pn, `Bank ${pn}`, `0099887766554433`, 'ACCOUNT');
    await expectRefusal(approveWithDigest(d1.reissueId), 'REISSUE_BANK_CHANGED');
    await cancelReissue(tenant.client, d1.reissueId, { reason: 'kind changed', changedBy: 'RI.REQ' }, { authorization: requester.authorization });
  }, 60_000);

  it('approval requires the reviewed snapshot digest (missing and stale are refused)', async () => {
    const pn = dEmployees[2]!;
    const draft = await draftFor(pn);
    await expectRefusal(approveReissue(tenant.client, draft.reissueId, 'RI.APP', { authorization: approver.authorization }), 'REISSUE_CONFIRMATION_REQUIRED');
    await expectRefusal(approveReissue(tenant.client, draft.reissueId, 'RI.APP', { authorization: approver.authorization }, { confirmDigest: 'deadbeef' }), 'REISSUE_CONFIRMATION_STALE');
    const ok = await approveWithDigest(draft.reissueId);
    expect(ok.status).toBe('APPROVED');
    expect(ok.snapshotDigest).toBe(draft.snapshotDigest);
  }, 60_000);

  it('the review view exposes a frozen beneficiary name and masks the account', async () => {
    const reissues = await listReissues(tenant.client, runId, { authorization: approver.authorization });
    const approved = reissues.find((r) => r.status === 'APPROVED')!;
    for (const l of approved.lines) {
      expect(l.beneficiaryName.length).toBeGreaterThan(0);
      expect(l.maskedAccount.startsWith('••••')).toBe(true);
    }
    expect(JSON.stringify(approved)).not.toMatch(/KW00GBK\d{10}/);
  });

  it('v1 (two employees) superseded by v2 (one) is blocked, readable historically, and its bytes match the earlier download', async () => {
    const [a, b] = [dEmployees[0]!, dEmployees[1]!];
    // Both a and b already have an effective account from the tests above (effective 2026-01-10 onward).
    const v1 = await requestReissue({ client: tenant.client, sourcePreparationId: dPrep, selection: 'SELECTED', personnelNumbers: [a, b], intendedPaymentDate: '2026-01-15', reason: 'v1 two', attestations: [att(a), att(b)] as never, requestKey: randomUUID(), changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    await approveWithDigest(v1.reissueId);
    const v1Bytes = (await downloadReissue(tenant.client, v1.reissueId, { requestedBy: 'RI.A' }, { authorization: approver.authorization })).body;
    const v2 = await requestReissue({ client: tenant.client, sourcePreparationId: dPrep, selection: 'SELECTED', personnelNumbers: [a], intendedPaymentDate: '2026-01-20', reason: 'v2 one', attestations: [att(a, 'RETURNED')] as never, requestKey: randomUUID(), changedBy: 'RI.REQ' }, { authorization: requester.authorization });
    await approveWithDigest(v2.reissueId);
    await expectRefusal(downloadReissue(tenant.client, v1.reissueId, { requestedBy: 'RI.A' }, { authorization: approver.authorization }), 'REISSUE_SUPERSEDED');
    const view1 = (await listReissues(tenant.client, runId, { authorization: approver.authorization })).find((r) => r.reissueId === v1.reissueId)!;
    expect(view1.superseded).toBe(true);
    expect(view1.downloadable).toBe(false);
    const v2dl = await downloadReissue(tenant.client, v2.reissueId, { requestedBy: 'RI.A' }, { authorization: approver.authorization });
    expect(v2dl.body.length).toBeGreaterThan(0);
    const hist = await downloadHistoricalReissue(tenant.client, v1.reissueId, { authorization: approver.authorization });
    expect(hist.filename.startsWith('HISTORICAL-DO-NOT-UPLOAD-')).toBe(true);
    expect(hist.body.equals(v1Bytes)).toBe(true);
    const noHist = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY, REISSUE_DOWNLOAD_CAPABILITY, 'PEOPLE.BANK.REVEAL'], suffix: 'DNOHIST' });
    await expectRefusal(downloadHistoricalReissue(tenant.client, v1.reissueId, { authorization: noHist.authorization }), 'REISSUE_AUTHORITY');
    expect(v2.lines.some((l) => l.personnelNumber === b)).toBe(false);
  }, 90_000);
});

describe('the reissue endpoint', () => {
  const post = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return new Request('http://localhost/people/payroll-runs/payment-file/reissue', { method: 'POST', body: f }); };

  it('401 without a session and 403 without the capability', async () => {
    requestContext.cookie = undefined;
    expect((await REISSUE_POST(post({ action: 'preview', sourcePreparationId: preparationId, selection: 'ALL', intendedPaymentDate: '2025-04-15' }))).status).toBe(401);
    const noReq = await createActor(tenant.client, { capabilities: ['PEOPLE.EMPLOYEE.CREATE'], suffix: 'ENDPT' });
    requestContext.cookie = encodeSessionCookie(tenant.client, noReq.token);
    expect((await REISSUE_POST(post({ action: 'preview', sourcePreparationId: preparationId, selection: 'ALL', intendedPaymentDate: '2025-04-15' }))).status).toBe(403);
  });

  it('previews over HTTP for a capable caller', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, requester.token);
    const response = await REISSUE_POST(post({ action: 'preview', sourcePreparationId: preparationId, selection: 'ALL', intendedPaymentDate: '2025-04-15' }));
    expect(response.status).toBe(200);
    const body = await response.json() as { employeeCount: number; employees: unknown[] };
    expect(typeof body.employeeCount).toBe('number');
    expect(Array.isArray(body.employees)).toBe(true);
  });

  it('the direct reissue endpoint refuses a caller without bank-reveal authority (403)', async () => {
    const reissues2 = await listReissues(tenant.client, runId, { authorization: approver.authorization });
    const approved = reissues2.find((r) => r.status === 'APPROVED')!;
    const noBank = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY, REISSUE_DOWNLOAD_CAPABILITY, FILE_HISTORICAL_CAPABILITY], suffix: 'EPNOBANK' });
    requestContext.cookie = encodeSessionCookie(tenant.client, noBank.token);
    const response = await REISSUE_GET(new Request(`http://localhost/people/payroll-runs/payment-file/reissue?reissue=${approved.reissueId}`));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('PEOPLE.BANK.REVEAL');
  });

  it('the endpoint serves a historical replacement with do-not-upload headers, and requires bank authority', async () => {
    const all = await listReissues(tenant.client, runId, { authorization: approver.authorization });
    const superseded = all.find((r) => r.status === 'APPROVED' && r.superseded);
    if (superseded) {
      requestContext.cookie = encodeSessionCookie(tenant.client, approver.token);
      const ok = await REISSUE_GET(new Request(`http://localhost/people/payroll-runs/payment-file/reissue?historical=1&reissue=${superseded.reissueId}`));
      expect(ok.status).toBe(200);
      expect(ok.headers.get('x-payment-file-historical')).toBe('do-not-upload');
      expect(ok.headers.get('content-disposition')).toContain('HISTORICAL-DO-NOT-UPLOAD-');
      expect(ok.headers.get('cache-control')).toBe('private, no-store');
    }
    // Without the historical capability the same route is refused.
    const noHist = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY, 'PEOPLE.BANK.REVEAL'], suffix: 'EPNOHIST' });
    requestContext.cookie = encodeSessionCookie(tenant.client, noHist.token);
    const denied = await REISSUE_GET(new Request('http://localhost/people/payroll-runs/payment-file/reissue?historical=1&reissue=' + (superseded?.reissueId ?? randomUUID())));
    expect([403, 404]).toContain(denied.status);
  });

  it('the approve action over HTTP refuses without a confirm digest', async () => {
    const all = await listReissues(tenant.client, runId, { authorization: approver.authorization });
    const draft = all.find((r) => r.status === 'DRAFT');
    if (draft) {
      requestContext.cookie = encodeSessionCookie(tenant.client, approver.token);
      const response = await REISSUE_POST(post({ action: 'approve', reissueId: draft.reissueId }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('review');
    }
  });

  it('downloads an approved replacement with private, no-store', async () => {
    const reissues = await listReissues(tenant.client, runId, { authorization: approver.authorization });
    const approved = reissues.find((r) => r.status === 'APPROVED')!;
    requestContext.cookie = encodeSessionCookie(tenant.client, approver.token);
    const response = await REISSUE_GET(new Request(`http://localhost/people/payroll-runs/payment-file/reissue?reissue=${approved.reissueId}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
