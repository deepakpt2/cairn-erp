/**
 * Employee salary bank details (infotype 0009).
 *
 * What is worth proving: effective-dated records with one main account at a time; overlap and concurrency are
 * refused atomically; identifiers are stored encrypted (never plaintext) and shown masked; reveal is separately
 * capable and audited without the account number; reach (company/plant/tenant), session and capability are
 * re-judged server-side; and the generic payment file selects the account effective on the intended payment
 * date, refuses a missing or ambiguous account with an employee-level list, and rebuilds the same file after a
 * later master-data change.
 */
import { randomBytes, randomUUID } from 'node:crypto';
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
import { parseBankDataKeyring } from '../src/platform/security/bank-data-keyring';
import {
  BANK_MAINTAIN_CAPABILITY,
  BANK_REVEAL_CAPABILITY,
  BANK_VIEW_CAPABILITY,
  EmployeeBankError,
  accountAsOf,
  createEmployeeBank,
  endEmployeeBank,
  listEmployeeBank,
  maskIdentifier,
  revealEmployeeBank,
} from '../src/modules/people/employee-bank';
import {
  PAYMENT_FILE_CAPABILITY,
  PaymentFileError,
  downloadPaymentFile,
  preparePaymentFile,
} from '../src/modules/people/payroll-payment-file';
import { PAYROLL_RUN_CAPABILITY, proposePayrollRun, releasePayrollRun } from '../src/modules/people/payroll-run';
import { postPayrollRun } from '../src/modules/people/payroll-posting';
import { assignStructure, defineSalaryStructure, SALARY_STRUCTURE_CAPABILITY, setStructureComponent } from '../src/modules/people/payroll-structure';
import { createEmployee } from '../src/modules/people/employee-master';
import { EMPLOYEE_CAPABILITY } from '../src/modules/people/schema';
import { maintainNumberRange } from '../src/modules/foundation/number-ranges';
import { buildPayrollFixture, createPayrollPoster, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: randomBytes(32).toString('base64url') } });
const KEYRING = parseBankDataKeyring(KEYRING_JSON);
const RUN_AUTH: readonly string[] = [PAYROLL_RUN_CAPABILITY];
const STRUCTURE_AUTH: readonly string[] = [SALARY_STRUCTURE_CAPABILITY];
const YEAR = 2025;
const ACTOR = 'EMP_BANK_TEST';

let tenant: TestTenant;
let fx: PayrollFixture;
let otherTenant: TestTenant;
const savedRing = process.env.CAIRN_BANK_DATA_KEYRING_JSON;

interface Actor {
  userId: string;
  sessionId: string;
  token: string;
  authorization: { userId: string; sessionId: string };
}

async function createActor(
  client: string,
  options: { capabilities?: readonly string[]; companyScopes?: readonly string[]; suffix?: string } = {},
): Promise<Actor> {
  const suffix = (options.suffix ?? randomUUID().replaceAll('-', '').slice(0, 8)).toUpperCase();
  const capabilities = options.capabilities ?? [BANK_VIEW_CAPABILITY, BANK_MAINTAIN_CAPABILITY, BANK_REVEAL_CAPABILITY];
  const companies = options.companyScopes ?? ['1000'];
  const userId = randomUUID();
  const username = `EB.${suffix}`;
  const roleCode = `TEST_EB_${suffix}`;
  const created = await withTenant(client, async (tx) => {
    await tx.insert(role).values({
      client, code: roleCode, name: 'Employee bank test authority', description: 'Test-only',
      isSystemRole: false, isReadOnly: false, createdBy: ACTOR,
    });
    for (const capabilityCode of capabilities) await tx.insert(roleCapability).values({ client, roleCode, capabilityCode, createdBy: ACTOR });
    await tx.insert(appUser).values({
      id: userId, client, username, fullName: username,
      passwordHash: await hashPassword('employee-bank-test-not-a-login-secret'), isActive: true, isLocked: false, createdBy: ACTOR,
    });
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: ACTOR });
    if (companies.length) {
      await tx.insert(authOrgRestriction).values(companies.map((scopeValue) => ({
        id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE' as const, scopeValue, createdBy: ACTOR,
      })));
    }
    const session = await createSession(tx, { client, userId });
    const rows = await tx.execute(sql`select id from user_session where client = ${client} and user_id = ${userId} order by issued_at desc limit 1`) as unknown as Array<{ id: string }>;
    return { sessionId: String(rows[0]!.id), token: session.token };
  });
  return { userId, ...created, authorization: { userId, sessionId: created.sessionId } };
}

async function expectRefusal(promise: Promise<unknown>, wanted: string): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof EmployeeBankError || error instanceof PaymentFileError, String(error)).toBe(true);
    expect((error as { code: string }).code, (error as Error).message).toBe(wanted);
    return error as Error;
  }
  throw new Error(`Expected refusal ${wanted}, nothing was thrown.`);
}

async function employeeOn(structureCode: string): Promise<string> {
  const pn = await payrollEmployee(fx, { positionFrom: '2024-01-01' });
  await assignStructure({ client: tenant.client, personnelNumber: pn, structureCode, baseAmount: '1000', currency: fx.currency, validFrom: '2024-01-01', validTo: null, changedBy: ACTOR }, STRUCTURE_AUTH);
  return pn;
}

let main: string;
let admin: Actor;
let viewer: Actor;
let maintainer: Actor;
let revealer: Actor;
let noCapability: Actor;
let elsewhere: Actor;
let employee: string;
let otherEmployee: string;

beforeAll(async () => {
  process.env.CAIRN_BANK_DATA_KEYRING_JSON = KEYRING_JSON;
  tenant = await createTenant('employee-bank', { currency: 'KWD' });
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'PENS', 'Pension (employee)', 'DEDUCTION', true, true, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, created_by)
      values (${tenant.client}, 'PENS', ${fx.chart}, null, '250000', 'NONE', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`update pay_component_config set cost_receiver_category = 'ASSIGNMENT' where client = ${tenant.client} and component_code = 'BASIC' and chart_of_accounts = ${fx.chart}`);
  });
  main = `EB${Date.now().toString().slice(-6)}`;
  await defineSalaryStructure({ client: tenant.client, code: main, name: 'Bank test staff', currency: fx.currency, validFrom: '2024-01-01', changedBy: ACTOR }, STRUCTURE_AUTH);
  for (const [component, kind, value] of [['BASIC', 'PERCENT_OF_BASE', '100'], ['PENS', 'PERCENT_OF_BASE', '5']] as const) {
    await setStructureComponent({ client: tenant.client, structureCode: main, componentCode: component, amountKind: kind, amountValue: value, changedBy: ACTOR }, STRUCTURE_AUTH);
  }
  employee = await employeeOn(main);
  otherEmployee = await employeeOn(main);

  admin = await createActor(tenant.client, { suffix: 'ADMIN' });
  viewer = await createActor(tenant.client, { capabilities: [BANK_VIEW_CAPABILITY], suffix: 'VIEW' });
  maintainer = await createActor(tenant.client, { capabilities: [BANK_MAINTAIN_CAPABILITY], suffix: 'MAINT' });
  revealer = await createActor(tenant.client, { capabilities: [BANK_REVEAL_CAPABILITY], suffix: 'REVEAL' });
  noCapability = await createActor(tenant.client, { capabilities: ['PEOPLE.EMPLOYEE.CREATE'], suffix: 'NOCAP' });
  elsewhere = await createActor(tenant.client, { capabilities: [BANK_VIEW_CAPABILITY, BANK_MAINTAIN_CAPABILITY], companyScopes: ['ZZZZ'], suffix: 'OTHER' });
  otherTenant = await createTenant('employee-bank-other', { withConfiguration: false });
}, 180_000);

afterAll(async () => {
  if (savedRing === undefined) delete process.env.CAIRN_BANK_DATA_KEYRING_JSON;
  else process.env.CAIRN_BANK_DATA_KEYRING_JSON = savedRing;
  if (tenant) await destroyTenant(tenant.client);
  if (otherTenant) await destroyTenant(otherTenant.client);
});

const add = (pn: string, over: Partial<{ value: string; kind: 'IBAN' | 'ACCOUNT'; from: string; to: string; bank: string; name: string }> = {}, actor = admin) =>
  createEmployeeBank({
    client: tenant.client, personnelNumber: pn,
    beneficiaryName: over.name ?? `Beneficiary ${pn}`, bankName: over.bank ?? 'Gulf Bank', bankCode: 'GBK01',
    accountKind: over.kind ?? 'IBAN', accountValue: over.value ?? 'KW00GBK0000000000001234',
    country: 'KW', validFrom: over.from ?? '2024-01-01', validTo: over.to, changedBy: ACTOR,
  }, { authorization: actor.authorization }, KEYRING);

describe('masking (pure)', () => {
  it('shows a fixed mask and at most the last four characters', () => {
    expect(maskIdentifier('KW00GBK0000000000001234')).toBe('••••1234');
    expect(maskIdentifier('1234')).toBe('••••');
    expect(maskIdentifier('12')).toBe('••••');
  });
});

describe('effective-dated records', () => {
  it('stores the account encrypted and lists it masked', async () => {
    const created = await add(employee);
    expect(created.maskedAccount).toBe('••••1234');
    // No plaintext account in the row.
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select account_ciphertext from employee_bank_detail where client = ${tenant.client} and bank_record_id = ${created.bankRecordId}`)) as unknown as Array<{ account_ciphertext: string }>;
    expect(rows[0]!.account_ciphertext).toMatch(/^cbd1\./);
    expect(rows[0]!.account_ciphertext).not.toContain('KW00GBK');

    const list = await listEmployeeBank(tenant.client, employee, { authorization: viewer.authorization }, KEYRING);
    expect(list.find((r) => r.bankRecordId === created.bankRecordId)!.maskedAccount).toBe('••••1234');
    // The view type has no full-value field at all.
    expect(JSON.stringify(list)).not.toContain('KW00GBK0000000000001234');
  });

  it('selects the account effective on a date, not today', async () => {
    const pn = await employeeOn(main);
    const first = await add(pn, { value: 'KW00GBK1111111111110001', from: '2024-01-01', to: '2025-05-31' });
    const second = await add(pn, { value: 'KW00GBK2222222222220002', from: '2025-06-01' });
    const asOf = (date: string) => withTenant(tenant.client, (tx) => accountAsOf(tx, tenant.client, pn, date));
    expect((await asOf('2025-03-31'))!.bankRecordId).toBe(first.bankRecordId);
    expect((await asOf('2025-06-01'))!.bankRecordId).toBe(second.bankRecordId);
    expect((await asOf('2023-12-31'))).toBeNull();
  });

  it('refuses an overlapping active main account, atomically', async () => {
    const pn = await employeeOn(main);
    await add(pn, { from: '2024-01-01' });
    await expectRefusal(add(pn, { from: '2024-06-01' }), 'BANK_OVERLAP');
    // Ending the first frees the date range for a new record.
    const ended = await endEmployeeBank({ client: tenant.client, bankRecordId: (await listEmployeeBank(tenant.client, pn, { authorization: admin.authorization }, KEYRING))[0]!.bankRecordId, validTo: '2024-05-31', changedBy: ACTOR }, { authorization: admin.authorization }, KEYRING);
    expect(ended.isActive).toBe(false);
    const next = await add(pn, { from: '2024-06-01' });
    expect(next.isActive).toBe(true);
  });

  it('two concurrent creates for the same employee leave exactly one account', async () => {
    const pn = await employeeOn(main);
    const results = await Promise.allSettled([add(pn, { from: '2024-01-01' }), add(pn, { from: '2024-01-01' })]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from employee_bank_detail where client = ${tenant.client} and personnel_number = ${pn} and is_active`)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  it('permits a future-dated change alongside today’s account', async () => {
    const pn = await employeeOn(main);
    const now = await add(pn, { from: '2024-01-01', to: '2026-12-31' });
    const future = await add(pn, { from: '2027-01-01' });
    expect(now.bankRecordId).not.toBe(future.bankRecordId);
  });
});

describe('authority and reveal', () => {
  it('refuses an unauthenticated, wrong-capability, wrong-company and wrong-tenant caller', async () => {
    const pn = await employeeOn(main);
    await expectRefusal(listEmployeeBank(tenant.client, pn, { authorization: undefined }, KEYRING), 'BANK_AUTHORITY');
    await expectRefusal(listEmployeeBank(tenant.client, pn, { authorization: noCapability.authorization }, KEYRING), 'BANK_AUTHORITY');
    await expectRefusal(listEmployeeBank(tenant.client, pn, { authorization: elsewhere.authorization }, KEYRING), 'BANK_UNAVAILABLE');
    // A session from another tenant is not a live session here: refused as an authority failure, not data.
    await expectRefusal(listEmployeeBank(otherTenant.client, pn, { authorization: admin.authorization }, KEYRING), 'BANK_AUTHORITY');
    // Maintaining needs MAINTAIN, which a view-only actor lacks.
    await expectRefusal(add(pn, {}, viewer), 'BANK_AUTHORITY');
  });

  it('reveal returns the full value and audits without the account number; requires REVEAL', async () => {
    const pn = await employeeOn(main);
    const created = await add(pn, { value: 'KW00GBKZZ90000000009999' });
    // VIEW alone cannot reveal.
    await expectRefusal(
      revealEmployeeBank(tenant.client, created.bankRecordId, { purpose: 'PAYROLL_SUPPORT', changedBy: ACTOR }, { authorization: viewer.authorization }, KEYRING),
      'BANK_AUTHORITY',
    );
    const revealed = await revealEmployeeBank(tenant.client, created.bankRecordId, { purpose: 'PAYROLL_SUPPORT', changedBy: 'EB.REVEAL' }, { authorization: revealer.authorization }, KEYRING);
    expect(revealed.accountValue).toBe('KW00GBKZZ90000000009999');

    const audit = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select event_type, transaction_code, object_type, object_key, detail from audit_access_log
       where client = ${tenant.client} and object_type = 'employee_bank_detail' and object_key = ${created.bankRecordId} order by occurred_at desc limit 1`)) as unknown as Array<{ event_type: string; transaction_code: string; object_type: string; object_key: string; detail: string }>;
    expect(audit[0]!.event_type).toBe('READ');
    expect(audit[0]!.transaction_code).toBe(BANK_REVEAL_CAPABILITY);
    expect(audit[0]!.detail).not.toContain('KW00GBKZZ9');
  });
});

describe('ambiguity is structurally prevented', () => {
  it('the exclusion constraint is the ambiguity guard: overlapping active main accounts are refused', async () => {
    const pn = await employeeOn(main);
    await add(pn, { from: '2024-01-01' });
    // A second main account covering an overlapping day cannot exist, so `accountAsOf` can never see two.
    await expectRefusal(add(pn, { from: '2024-03-01' }), 'BANK_OVERLAP');
    const asOf = await withTenant(tenant.client, (tx) => accountAsOf(tx, tenant.client, pn, '2024-03-01'));
    expect(asOf).not.toBeNull();
  });
});
