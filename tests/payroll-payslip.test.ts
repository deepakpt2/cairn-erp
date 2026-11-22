/**
 * Printable employee payslips — the print endpoint and the service behind it.
 *
 * What is worth proving: only a RELEASED or POSTED result yields an official payslip; a PROPOSED and a
 * CANCELLED result is refused by name; a missing result, a wrong capability, a wrong company code, a
 * wrong tenant and an unauthenticated request are all refused at the real route; the payslip shows the
 * persisted totals and component lines at the currency's precision (KWD, three decimals here) and keeps
 * employer contributions out of the employee's deductions and net pay; and nothing on the page asserts
 * that a bank payment succeeded.
 *
 * The route is exercised with a real session cookie, so `getSession` runs its real query against erp_test.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const requestContext = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (requestContext.cookie ? { value: requestContext.cookie } : undefined) }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string): never => { throw new Error(`REDIRECT:${path}`); },
}));

import { withTenant } from '../src/platform/db/client';
import { createSession, encodeSessionCookie } from '../src/platform/auth/session';
import { hashPassword } from '../src/platform/auth/password';
import { appUser, authOrgRestriction, role, roleCapability, userRole } from '../src/platform/tables/security';
import { maintainNumberRange } from '../src/modules/foundation/number-ranges';
import { assignStructure, defineSalaryStructure, SALARY_STRUCTURE_CAPABILITY, setStructureComponent } from '../src/modules/people/payroll-structure';
import {
  PAYROLL_RUN_CAPABILITY,
  cancelPayrollRun,
  proposePayrollRun,
  releasePayrollRun,
} from '../src/modules/people/payroll-run';
import { postPayrollRun } from '../src/modules/people/payroll-posting';
import {
  PAYSLIP_ROUTE,
  PayslipError,
  getPayslip,
  payslipAvailable,
  payslipHref,
  renderPayslipHtml,
} from '../src/modules/people/payroll-payslip';
import { buildPayrollFixture, createPayrollPoster, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';
import { GET } from '../src/app/people/payroll-results/payslip/route';

const RUN_AUTH: readonly string[] = [PAYROLL_RUN_CAPABILITY];
/** The structure services ask for their own authority; payroll-run reads ask for the run capability. */
const STRUCTURE_AUTH: readonly string[] = [SALARY_STRUCTURE_CAPABILITY];
const RESULT_CAPABILITY = 'PEOPLE.PAYROLL.RESULT';
const YEAR = 2025;
const ACTOR = 'PAYSLIP_TEST';

let tenant: TestTenant;
let fx: PayrollFixture;
let otherTenant: TestTenant;

interface Actor {
  userId: string;
  sessionId: string;
  token: string;
  authorization: { userId: string; sessionId: string };
}

/** A live signed-in actor holding one capability and one Company Code scope. */
async function createActor(
  client: string,
  options: { capabilities?: readonly string[]; companyScopes?: readonly string[]; suffix?: string } = {},
): Promise<Actor> {
  const suffix = (options.suffix ?? randomUUID().replaceAll('-', '').slice(0, 8)).toUpperCase();
  const capabilities = options.capabilities ?? [RESULT_CAPABILITY];
  const companies = options.companyScopes ?? ['1000'];
  const userId = randomUUID();
  const username = `PAYSLIP.${suffix}`;
  const roleCode = `TEST_PAYSLIP_${suffix}`;
  const created = await withTenant(client, async (tx) => {
    await tx.insert(role).values({
      client, code: roleCode, name: 'Payslip test authority', description: 'Test-only role',
      isSystemRole: false, isReadOnly: false, createdBy: ACTOR,
    });
    for (const capabilityCode of capabilities) {
      await tx.insert(roleCapability).values({ client, roleCode, capabilityCode, createdBy: ACTOR });
    }
    await tx.insert(appUser).values({
      id: userId, client, username, fullName: username,
      passwordHash: await hashPassword('payslip-test-not-a-login-secret'),
      isActive: true, isLocked: false, createdBy: ACTOR,
    });
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: ACTOR });
    if (companies.length) {
      await tx.insert(authOrgRestriction).values(companies.map((scopeValue) => ({
        id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE' as const, scopeValue, createdBy: ACTOR,
      })));
    }
    const session = await createSession(tx, { client, userId });
    const rows = await tx.execute(sql`
      select id from user_session where client = ${client} and user_id = ${userId}
       order by issued_at desc limit 1`) as unknown as Array<{ id: string }>;
    return { sessionId: String(rows[0]!.id), token: session.token };
  });
  return { userId, ...created, authorization: { userId, sessionId: created.sessionId } };
}

async function expectRefusal(promise: Promise<unknown>, wanted: string): Promise<PayslipError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(PayslipError);
    expect((error as PayslipError).code, (error as Error).message).toBe(wanted);
    expect((error as PayslipError).remedy).toBeTruthy();
    return error as PayslipError;
  }
  throw new Error(`Expected PayslipError ${wanted}, nothing was thrown.`);
}

const request = (resultId: string) => new Request(`http://localhost${PAYSLIP_ROUTE}?result=${encodeURIComponent(resultId)}`);

let main: string;
let releasedResultId: string;
let proposedResultId: string;
let cancelledResultId: string;
let postedResultId: string;
let unpostedResultId: string;
let presentedResultId: string;
let reader: Actor;
let noCapability: Actor;
let elsewhere: Actor;
let otherTenantActor: Actor;

async function employeeOn(structureCode: string, personnelNumberFrom: string): Promise<string> {
  const pn = await payrollEmployee(fx, { positionFrom: personnelNumberFrom });
  await assignStructure({
    client: tenant.client, personnelNumber: pn, structureCode, baseAmount: '1000', currency: fx.currency,
    validFrom: '2024-01-01', validTo: null, changedBy: ACTOR,
  }, STRUCTURE_AUTH);
  return pn;
}

beforeAll(async () => {
  tenant = await createTenant('payroll-payslip', { currency: 'KWD' });
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'PENS', 'Pension (employee)', 'DEDUCTION', true, true, ${ACTOR}),
        (${tenant.client}, 'ERC', 'Employer contribution', 'EMPLOYER_CONTRIBUTION', false, true, ${ACTOR}),
        (${tenant.client}, 'BONUS', 'One-time bonus', 'EARNING', true, true, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, controlling_area, cost_center, created_by)
      values (${tenant.client}, 'PENS', ${fx.chart}, null, '250000', 'NONE', null, null, ${ACTOR}),
             (${tenant.client}, 'ERC', ${fx.chart}, '500100', '250000', 'FIXED', 'A000', 'CC100', ${ACTOR}),
             (${tenant.client}, 'BONUS', ${fx.chart}, '500000', null, 'ASSIGNMENT', null, null, ${ACTOR})
      on conflict do nothing`);
    // Account 500000 requires a cost object; the fixture maps BASIC with no receiver, and the employee's
    // position assignment carries the cost centre the posting reads.
    await tx.execute(sql`
      update pay_component_config set cost_receiver_category = 'ASSIGNMENT'
       where client = ${tenant.client} and component_code = 'BASIC' and chart_of_accounts = ${fx.chart}`);
  });

  main = `PS${Date.now().toString().slice(-6)}`;
  await defineSalaryStructure({ client: tenant.client, code: main, name: 'Payslip staff', currency: fx.currency, validFrom: '2024-01-01', changedBy: ACTOR }, STRUCTURE_AUTH);
  for (const [component, kind, value] of [
    ['BASIC', 'PERCENT_OF_BASE', '100'],
    ['HOUSING', 'FIXED', '200'],
    ['PENS', 'PERCENT_OF_BASE', '5'],
    ['ERC', 'PERCENT_OF_BASE', '11'],
  ] as const) {
    await setStructureComponent({ client: tenant.client, structureCode: main, componentCode: component, amountKind: kind, amountValue: value, changedBy: ACTOR }, STRUCTURE_AUTH);
  }
  const pn = await employeeOn(main, '2024-01-01');
  // An approved one-time adjustment, entered and approved by two people (the DB refuses self-approval).
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into payroll_adjustment (client, adjustment_id, company_code, fiscal_year, period, personnel_number,
        component_code, component_kind, amount, currency, reason, status, decided_by, decided_at, created_by)
      values (${tenant.client}, ${randomUUID()}, ${fx.companyCode}, ${YEAR}, 3, ${pn},
        'BONUS', 'EARNING', '500.0000', ${fx.currency}, 'Annual bonus', 'APPROVED', 'PAYSLIP.APPROVER', now(), ${ACTOR})`);
  });

  const released = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 3, changedBy: ACTOR }, RUN_AUTH);
  expect(released.exceptions, JSON.stringify(released.exceptions)).toEqual([]);
  await releasePayrollRun({ client: tenant.client, runId: released.runId, changedBy: ACTOR }, RUN_AUTH);
  releasedResultId = await resultIdOf(released.runId, pn);

  // POSTED: one PR document, from the payroll posting service, so the payslip can name it.
  await maintainNumberRange({
    client: tenant.client, objectCode: 'RF_BELEG', companyCode: fx.companyCode, subObject: 'GENERAL', fiscalYear: 0,
    prefix: 'PR', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE',
    mode: 'CREATE', changedBy: ACTOR, reason: 'Payslip test setup',
  });
  const poster = await createPayrollPoster(tenant.client);
  await postPayrollRun({ client: tenant.client, runId: released.runId, changedBy: poster.username, authorization: poster.authorization });
  postedResultId = releasedResultId;

  // A released run that is never posted: the payslip must not claim a posting for it.
  const unposted = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 6, changedBy: ACTOR }, RUN_AUTH);
  await releasePayrollRun({ client: tenant.client, runId: unposted.runId, changedBy: ACTOR }, RUN_AUTH);
  unpostedResultId = await resultIdOf(unposted.runId, pn);

  const proposed = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 4, changedBy: ACTOR }, RUN_AUTH);
  proposedResultId = await resultIdOf(proposed.runId, pn);
  await cancelPayrollRun({ client: tenant.client, runId: proposed.runId, reason: 'payslip test cancellation', changedBy: ACTOR }, RUN_AUTH);
  cancelledResultId = proposedResultId;

  // A second employee and run, left PROPOSED, to prove the refusal on a live result.
  const waiting = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 5, changedBy: ACTOR }, RUN_AUTH);
  presentedResultId = await resultIdOf(waiting.runId, pn);

  reader = await createActor(tenant.client, { suffix: 'READER' });
  noCapability = await createActor(tenant.client, { capabilities: ['PEOPLE.LEAVE.VIEW'], suffix: 'NOCAP' });
  elsewhere = await createActor(tenant.client, { companyScopes: ['ZZZZ'], suffix: 'ELSEWHERE' });

  otherTenant = await createTenant('payroll-payslip-other', { withConfiguration: false });
  otherTenantActor = await createActor(otherTenant.client, { suffix: 'OTHER' });
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  if (otherTenant) await destroyTenant(otherTenant.client);
});

async function resultIdOf(runId: string, personnelNumber: string): Promise<string> {
  const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
    select result_id from payroll_result
     where client = ${tenant.client} and run_id = ${runId} and personnel_number = ${personnelNumber}`)) as unknown as Array<{ result_id: string }>;
  expect(rows[0], `result of ${personnelNumber} in ${runId}`).toBeTruthy();
  return String(rows[0]!.result_id);
}

describe('payslip availability (pure)', () => {
  it('only a released or posted run is final', () => {
    expect(payslipAvailable('RELEASED')).toBe(true);
    expect(payslipAvailable('POSTED')).toBe(true);
    expect(payslipAvailable('PROPOSED')).toBe(false);
    expect(payslipAvailable('CANCELLED')).toBe(false);
    expect(payslipHref('abc')).toBe(`${PAYSLIP_ROUTE}?result=abc`);
  });
});

describe('the print route — authorised access', () => {
  it('a POSTED result prints, at three decimals, with the persisted totals', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const response = await GET(request(postedResultId));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body).toContain('Gross pay');
    expect(body).toContain('1700.000');
    expect(body).toContain('50.000');
    expect(body).toContain('1650.000');
    expect(body).toContain('500.000');
    expect(body).toContain('KWD');
    expect(body).toContain('posted');
  });

  it('the route is dynamic and exports only GET', async () => {
    const route = await import('../src/app/people/payroll-results/payslip/route');
    expect(route.dynamic).toBe('force-dynamic');
    expect((route as unknown as Record<string, unknown>).POST).toBeUndefined();
  });

  it('shows the persisted posting document without treating it as a payment', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const response = await GET(request(postedResultId));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Payroll posting document');
    expect(body).toContain('not proof that money left the company');
  });

  it('a released run that is not posted says so, and claims no posting', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const response = await GET(request(unpostedResultId));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('released and not yet posted');
    expect(body).not.toContain('Payroll posting document');
  });

  it('is a self-contained print page: no script, form, button or external resource', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const body = await (await GET(request(postedResultId))).text();
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/<form/i);
    expect(body).not.toMatch(/<button/i);
    expect(body).not.toMatch(/<nav/i);
    expect(body).not.toMatch(/https?:\/\//i);
    expect(body).toContain('@media print');
  });

  it('never asserts that a payment succeeded, and omits accounts and bank details', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const body = await (await GET(request(postedResultId))).text();
    expect(body).not.toMatch(/payment (was )?successful/i);
    expect(body).not.toMatch(/paid successfully/i);
    expect(body).not.toMatch(/bank account/i);
    expect(body).not.toMatch(/IBAN/i);
    expect(body).not.toMatch(/debit account/i);
    expect(body).toContain('not evidence that a bank payment succeeded');
  });
});

describe('the print route — refusals', () => {
  it('an unauthenticated request is refused with 401', async () => {
    requestContext.cookie = undefined;
    const response = await GET(request(postedResultId));
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Sign in');
  });

  it('a caller without the payroll-result capability is refused with 403, naming it', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, noCapability.token);
    const response = await GET(request(postedResultId));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(RESULT_CAPABILITY);
  });

  it('a result outside the caller’s Company Code scope answers like a missing one (404)', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, elsewhere.token);
    const response = await GET(request(postedResultId));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('posted');
  });

  it('a result of another tenant answers like a missing one (404)', async () => {
    requestContext.cookie = encodeSessionCookie(otherTenant.client, otherTenantActor.token);
    const response = await GET(request(postedResultId));
    expect(response.status).toBe(404);
  });

  it('a missing result is refused without revealing anything', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const response = await GET(request(randomUUID()));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('does not belong');
  });

  it('a PROPOSED result is refused: not final', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const response = await GET(request(presentedResultId));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('still proposed');
  });

  it('a CANCELLED result is refused: not an official payslip', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const response = await GET(request(cancelledResultId));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('cancelled');
  });

  it('a blank result parameter is refused', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const response = await GET(new Request(`http://localhost${PAYSLIP_ROUTE}`));
    expect(response.status).toBe(400);
  });
});

describe('the service boundary', () => {
  it('refuses a caller with no session before it reads anything', async () => {
    await expectRefusal(getPayslip(tenant.client, postedResultId, { authorization: undefined }), 'PAYSLIP_AUTHORITY');
  });

  it('shows precisely the persisted earning, deduction and adjustment lines, and no employer cost in net', async () => {
    const view = await getPayslip(tenant.client, postedResultId, { authorization: reader.authorization });
    expect(view.currency).toBe('KWD');
    expect(view.decimals).toBe(3);

    const kinds = (lines: Array<{ componentCode: string }>) => lines.map((l) => l.componentCode).sort();
    expect(kinds(view.earnings)).toEqual(['BASIC', 'BONUS', 'HOUSING']);
    expect(kinds(view.deductions)).toEqual(['PENS']);
    expect(kinds(view.employerContributions)).toEqual(['ERC']);
    expect(view.otherLines).toEqual([]);

    // The persisted totals, written at the currency's precision — not recalculated here.
    expect(view.totals).toEqual({ gross: '1700.000', deductions: '50.000', net: '1650.000', employerCost: '110.000' });
    expect(Number(view.totals.net)).toBe(Number(view.totals.gross) - Number(view.totals.deductions));
    const sum = (lines: Array<{ amount: string }>) => lines.reduce((s, l) => s + Number(l.amount), 0);
    expect(sum(view.earnings)).toBe(Number(view.totals.gross));
    expect(sum(view.deductions)).toBe(Number(view.totals.deductions));
    // Employer contributions are the company's cost: apart, and never added to net pay.
    expect(sum(view.employerContributions)).toBe(Number(view.totals.employerCost));
    expect(view.deductions.some((l) => l.componentCode === 'ERC')).toBe(false);

    const html = renderPayslipHtml(view);
    expect(html).toContain('Employer contributions');
    expect(html).toContain('not deducted from the employee’s net pay');
  });

  it('uses the one-time adjustment line with its source and dates from the snapshot', async () => {
    const view = await getPayslip(tenant.client, postedResultId, { authorization: reader.authorization });
    const bonus = view.earnings.find((l) => l.componentCode === 'BONUS')!;
    expect(bonus.sourceLabel).toBe('One-time adjustment');
    expect(bonus.amount).toBe('500.000');
    expect(bonus.segmentFrom).toBe('2025-03-01');
    expect(bonus.segmentTo).toBe('2025-03-31');
  });

  it('refuses a wrong tenant, wrong company and wrong capability at the service too', async () => {
    await expectRefusal(
      getPayslip(otherTenant.client, postedResultId, { authorization: otherTenantActor.authorization }),
      'PAYSLIP_UNAVAILABLE',
    );
    await expectRefusal(
      getPayslip(tenant.client, postedResultId, { authorization: elsewhere.authorization }),
      'PAYSLIP_UNAVAILABLE',
    );
    await expectRefusal(
      getPayslip(tenant.client, postedResultId, { authorization: noCapability.authorization }),
      'PAYSLIP_AUTHORITY',
    );
  });

  it('refuses the proposed and cancelled results at the service, before rendering', async () => {
    await expectRefusal(getPayslip(tenant.client, presentedResultId, { authorization: reader.authorization }), 'PAYSLIP_NOT_FINAL');
    await expectRefusal(getPayslip(tenant.client, cancelledResultId, { authorization: reader.authorization }), 'PAYSLIP_CANCELLED');
  });

  it('escapes a component description rather than trusting it into the page', async () => {
    const view = await getPayslip(tenant.client, postedResultId, { authorization: reader.authorization });
    const hostile = { ...view, employeeName: '<script>alert(1)</script>', company: { ...view.company, name: '<b>Evil</b>' } };
    const html = renderPayslipHtml(hostile);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
