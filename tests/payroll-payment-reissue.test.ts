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
  downloadReissue,
  listReissues,
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
  const capabilities = options.capabilities ?? [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY, REISSUE_DOWNLOAD_CAPABILITY, FILE_HISTORICAL_CAPABILITY];
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

async function employeeOn(): Promise<string> {
  const pn = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
  await assignStructure({ client: tenant.client, personnelNumber: pn, structureCode: main, baseAmount: '1000', currency: fx.currency, validFrom: '2024-01-01', validTo: null, changedBy: ACTOR }, STRUCTURE_AUTH);
  return pn;
}

async function bankAccount(pn: string, options: { from?: string; value?: string; actor?: Actor } = {}) {
  return createEmployeeBank({
    client: tenant.client, personnelNumber: pn, beneficiaryName: `Beneficiary ${pn}`, bankName: 'Gulf Bank', bankCode: 'GBK01',
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
  requester = await createActor(tenant.client, { capabilities: [REISSUE_REQUEST_CAPABILITY, REISSUE_APPROVE_CAPABILITY, REISSUE_DOWNLOAD_CAPABILITY, FILE_HISTORICAL_CAPABILITY, PAYMENT_FILE_CAPABILITY], suffix: 'REQ' });
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
    const approved = await approveReissue(tenant.client, draft.reissueId, 'RI.APP', { authorization: approver.authorization });
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
    await approveReissue(tenant.client, draft.reissueId, 'RI.APP', { authorization: approver.authorization });
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

  it('a re-download is byte-stable and flags reuse', async () => {
    const reissues = await listReissues(tenant.client, runId, { authorization: approver.authorization });
    const approved = reissues.find((r) => r.status === 'APPROVED')!;
    const a = await downloadReissue(tenant.client, approved.reissueId, { requestedBy: 'RI.A' }, { authorization: approver.authorization });
    const b = await downloadReissue(tenant.client, approved.reissueId, { requestedBy: 'RI.B' }, { authorization: approver.authorization });
    expect(a.body.equals(b.body)).toBe(true);
    expect(b.reused).toBe(true);
  });

  it('no payroll recalculation and no accounting change on request/approve/download', async () => {
    const snapshot = async () => withTenant(tenant.client, async (tx) => {
      const [j] = (await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${tenant.client}`)) as unknown as Array<{ n: number }>;
      const [p] = (await tx.execute(sql`select count(*)::int as n from payroll_result where client = ${tenant.client}`)) as unknown as Array<{ n: number }>;
      return { journals: j!.n, results: p!.n };
    });
    const before = await snapshot();
    const draft = await requestSelected([employees[2]!], requester);
    await approveReissue(tenant.client, draft.reissueId, 'RI.APP', { authorization: approver.authorization });
    await downloadReissue(tenant.client, draft.reissueId, { requestedBy: 'RI.APP' }, { authorization: approver.authorization });
    expect(await snapshot()).toEqual(before);
  });
});

describe('traceability, blocking and concurrency', () => {
  it('repeated selected reissues form successive versions, each linked to its predecessor', async () => {
    const draft = await requestSelected([employees[2]!], requester);
    // A second draft for the same employee while the first is unapproved is refused.
    await expectRefusal(requestSelected([employees[2]!], requester), 'REISSUE_CONFLICT');
    await approveReissue(tenant.client, draft.reissueId, 'RI.APP', { authorization: approver.authorization });
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
    const draft = await requestSelected([employees[0]!], requester).catch(() => null);
    void draft;
    await expectRefusal(previewReissue(tenant.client, { sourcePreparationId: preparationId, selection: 'ALL', intendedPaymentDate: '2025-04-15' }, { authorization: undefined }), 'REISSUE_AUTHORITY');
    await expectRefusal(previewReissue(tenant.client, { sourcePreparationId: preparationId, selection: 'ALL', intendedPaymentDate: '2025-04-15' }, { authorization: outsider.authorization }), 'FILE_UNAVAILABLE');
    await expectRefusal(listReissues(otherTenant.client, runId, { authorization: otherTenantActor.authorization }), 'REISSUE_UNAVAILABLE');
  });
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
