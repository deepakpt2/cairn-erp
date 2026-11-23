/**
 * Generic salary payment file — the preparation service and its download route.
 *
 * What is worth proving: the CSV has exactly one row per positive net-pay employee in personnel-number
 * order with exact non-two-decimal amounts; commas, quotes, newlines and formula-like names are neutralised;
 * beneficiary bank columns are blank (no employee bank master exists); zero-net employees are excluded and
 * negative net refuses the file; only a POSTED run produces a file; a reversed posting or payment refuses
 * both preparation and download; a retry, a concurrent call and a repeat download return the same frozen
 * snapshot after master-data changes; and no preparation or download posts, clears or marks anything paid.
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
  proposePayrollRun,
  releasePayrollRun,
} from '../src/modules/people/payroll-run';
import { postPayrollRun } from '../src/modules/people/payroll-posting';
import { paySalaryRun } from '../src/modules/people/salary-payment';
import {
  PAYMENT_FILE_CAPABILITY,
  PAYMENT_FILE_ROUTE,
  PaymentFileError,
  buildPaymentCsv,
  csvCell,
  downloadPaymentFile,
  fileReferenceOf,
  getPaymentFile,
  preparePaymentFile,
  selectPayableResults,
} from '../src/modules/people/payroll-payment-file';
import { moneyOf } from '../src/platform/posting/money';
import { buildPayrollFixture, createPayrollPoster, payrollEmployee, type PayrollFixture } from './helpers/payroll-actor';
import { createTenant, destroyTenant, type TestTenant } from './helpers';
import { GET, POST } from '../src/app/people/payroll-runs/payment-file/route';
import { parseBankDataKeyring } from '../src/platform/security/bank-data-keyring';
import { BANK_MAINTAIN_CAPABILITY, createEmployeeBank, endEmployeeBank, listEmployeeBank } from '../src/modules/people/employee-bank';
import { createHash, randomBytes } from 'node:crypto';

/** A deployment-shaped keyring, set in the process environment for the service's on-demand loader. */
const KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: randomBytes(32).toString('base64url') } });
const KEYRING = parseBankDataKeyring(KEYRING_JSON);

const RUN_AUTH: readonly string[] = [PAYROLL_RUN_CAPABILITY];
const STRUCTURE_AUTH: readonly string[] = [SALARY_STRUCTURE_CAPABILITY];
const YEAR = 2025;
const ACTOR = 'PAYMENT_FILE_TEST';

let tenant: TestTenant;
let fx: PayrollFixture;
let otherTenant: TestTenant;

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
  const capabilities = options.capabilities ?? [PAYMENT_FILE_CAPABILITY, 'PEOPLE.BANK.REVEAL'];
  const companies = options.companyScopes ?? ['1000'];
  const userId = randomUUID();
  const username = `PF.${suffix}`;
  const roleCode = `TEST_PF_${suffix}`;
  const created = await withTenant(client, async (tx) => {
    await tx.insert(role).values({
      client, code: roleCode, name: 'Payment file test authority', description: 'Test-only',
      isSystemRole: false, isReadOnly: false, createdBy: ACTOR,
    });
    for (const capabilityCode of capabilities) {
      await tx.insert(roleCapability).values({ client, roleCode, capabilityCode, createdBy: ACTOR });
    }
    await tx.insert(appUser).values({
      id: userId, client, username, fullName: username,
      passwordHash: await hashPassword('payment-file-test-not-a-login-secret'),
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

async function expectRefusal(promise: Promise<unknown>, wanted: string): Promise<PaymentFileError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(PaymentFileError);
    expect((error as PaymentFileError).code, (error as Error).message).toBe(wanted);
    expect((error as PaymentFileError).remedy).toBeTruthy();
    return error as PaymentFileError;
  }
  throw new Error(`Expected PaymentFileError ${wanted}, nothing was thrown.`);
}

async function employeeOn(structureCode: string, from = '2024-01-01'): Promise<string> {
  const pn = await payrollEmployee(fx, { positionFrom: from });
  await assignStructure({
    client: tenant.client, personnelNumber: pn, structureCode, baseAmount: '1000', currency: fx.currency,
    validFrom: '2024-01-01', validTo: null, changedBy: ACTOR,
  }, STRUCTURE_AUTH);
  return pn;
}

/** A bank account effective from `from`, created through the real service with a bank-maintainer actor. */
async function bankAccount(pn: string, options: { bankName?: string; value?: string; kind?: 'IBAN' | 'ACCOUNT'; from?: string } = {}) {
  return createEmployeeBank({
    client: tenant.client, personnelNumber: pn, beneficiaryName: `Beneficiary ${pn}`,
    bankName: options.bankName ?? 'Gulf Bank', bankCode: 'GBK01',
    accountKind: options.kind ?? 'IBAN', accountValue: options.value ?? `KW00GBK000000000000${pn.slice(-4)}`,
    validFrom: options.from ?? '2024-01-01', changedBy: ACTOR,
  }, { authorization: bankAdmin.authorization }, KEYRING);
}

let main: string;
let postedRunId: string;
let reader: Actor;
let noCapability: Actor;
let elsewhere: Actor;
let otherTenantActor: Actor;
let bankAdmin: Actor;
const POST_DATE = '2025-03-31';
const savedRing = process.env.CAIRN_BANK_DATA_KEYRING_JSON;

beforeAll(async () => {
  process.env.CAIRN_BANK_DATA_KEYRING_JSON = KEYRING_JSON;
  tenant = await createTenant('payroll-payment-file', { currency: 'KWD' });
  fx = await buildPayrollFixture(tenant.client, tenant.companyCode);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into pay_component (client, code, name, component_kind, affects_net_pay, is_valid, created_by) values
        (${tenant.client}, 'PENS', 'Pension (employee)', 'DEDUCTION', true, true, ${ACTOR}),
        (${tenant.client}, 'BONUS', 'One-time bonus', 'EARNING', true, true, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into pay_component_config (client, component_code, chart_of_accounts, debit_account, credit_account, cost_receiver_category, controlling_area, cost_center, created_by)
      values (${tenant.client}, 'PENS', ${fx.chart}, null, '250000', 'NONE', null, null, ${ACTOR}),
             (${tenant.client}, 'BONUS', ${fx.chart}, '500000', null, 'ASSIGNMENT', null, null, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      update pay_component_config set cost_receiver_category = 'ASSIGNMENT'
       where client = ${tenant.client} and component_code = 'BASIC' and chart_of_accounts = ${fx.chart}`);
  });

  main = `PF${Date.now().toString().slice(-6)}`;
  await defineSalaryStructure({ client: tenant.client, code: main, name: 'Payment file staff', currency: fx.currency, validFrom: '2024-01-01', changedBy: ACTOR }, STRUCTURE_AUTH);
  for (const [component, kind, value] of [
    ['BASIC', 'PERCENT_OF_BASE', '100'],
    ['HOUSING', 'FIXED', '200'],
    ['PENS', 'PERCENT_OF_BASE', '5'],
  ] as const) {
    await setStructureComponent({ client: tenant.client, structureCode: main, componentCode: component, amountKind: kind, amountValue: value, changedBy: ACTOR }, STRUCTURE_AUTH);
  }
  // Three employees with distinctive names, one of them hostile to CSV/spreadsheets.
  const plain = await employeeOn(main);
  const quoted = await employeeOn(main);
  const hostile = await employeeOn(main);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`update employee set full_name = 'O''Brien, "Pat"' where client = ${tenant.client} and personnel_number = ${quoted}`);
    await tx.execute(sql`update employee set full_name = '=HYPERLINK("http://evil")' where client = ${tenant.client} and personnel_number = ${hostile}`);
  });

  const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 3, changedBy: ACTOR }, RUN_AUTH);
  expect(run.exceptions, JSON.stringify(run.exceptions)).toEqual([]);
  await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: ACTOR }, RUN_AUTH);
  await maintainNumberRange({
    client: tenant.client, objectCode: 'RF_BELEG', companyCode: fx.companyCode, subObject: 'GENERAL', fiscalYear: 0,
    prefix: 'PR', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE',
    mode: 'CREATE', changedBy: ACTOR, reason: 'Payment file test setup',
  });
  const poster = await createPayrollPoster(tenant.client);
  await postPayrollRun({ client: tenant.client, runId: run.runId, changedBy: poster.username, authorization: poster.authorization });
  postedRunId = run.runId;
  void plain;

  reader = await createActor(tenant.client, { suffix: 'READER' });
  noCapability = await createActor(tenant.client, { capabilities: ['PEOPLE.PAYROLL.RESULT'], suffix: 'NOCAP' });
  elsewhere = await createActor(tenant.client, { companyScopes: ['ZZZZ'], suffix: 'OTHER' });
  bankAdmin = await createActor(tenant.client, { capabilities: [BANK_MAINTAIN_CAPABILITY, 'PEOPLE.BANK.VIEW'], suffix: 'BANKADM' });

  // A valid effective main account for each payable employee, dated before the intended payment date.
  for (const pn of [plain, quoted, hostile]) await bankAccount(pn);

  otherTenant = await createTenant('payroll-payment-file-other', { withConfiguration: false });
  otherTenantActor = await createActor(otherTenant.client, { suffix: 'TENANT' });
}, 180_000);

afterAll(async () => {
  if (savedRing === undefined) delete process.env.CAIRN_BANK_DATA_KEYRING_JSON;
  else process.env.CAIRN_BANK_DATA_KEYRING_JSON = savedRing;
  if (tenant) await destroyTenant(tenant.client);
  if (otherTenant) await destroyTenant(otherTenant.client);
});

const post = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request(`http://localhost${PAYMENT_FILE_ROUTE}`, { method: 'POST', body: form });
};
const get = (runId: string, confirm?: string) => new Request(
  `http://localhost${PAYMENT_FILE_ROUTE}?run=${encodeURIComponent(runId)}${confirm ? `&confirm=${confirm}` : ''}`,
);

describe('csv cell escaping (pure)', () => {
  it('quotes commas, quotes and newlines; prefixes spreadsheet formula leads', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('=A,B')).toBe(`"'=A,B"`);
  });

  it('renders a whole file with CRLF and the fixed column order', () => {
    const csv = buildPaymentCsv({ fileReference: 'SALPAY-1000-2025-03-abc', runReference: 'RUN-1000-2025-03-abc' }, [
      {
        personnelNumber: 'P1', beneficiaryName: 'Doe, Jane', amount: '1234.567', currency: 'KWD',
        intendedPaymentDate: '2025-04-01', beneficiaryBankName: '', beneficiaryBankCode: '', beneficiaryAccount: '', beneficiaryIban: '',
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('file_reference,run_reference,personnel_number,beneficiary_name,amount,currency,intended_payment_date,beneficiary_bank_name,beneficiary_bank_code,beneficiary_account,beneficiary_iban,remittance_information');
    expect(lines[1]).toBe('SALPAY-1000-2025-03-abc,RUN-1000-2025-03-abc,P1,"Doe, Jane",1234.567,KWD,2025-04-01,,,,,Salary RUN-1000-2025-03-abc');
  });
});

describe('preparation service', () => {
  it('refuses a caller holding only the file-export capability, without the bank reveal authority', async () => {
    // The CSV carries each employee's full account identifier, so file export alone is not enough.
    const exportOnly = await createActor(tenant.client, { capabilities: [PAYMENT_FILE_CAPABILITY], suffix: 'EXPORTONLY' });
    await expectRefusal(
      preparePaymentFile({ client: tenant.client, runId: postedRunId, intendedPaymentDate: '2025-04-01', changedBy: ACTOR }, { authorization: exportOnly.authorization }),
      'FILE_BANK_AUTHORITY',
    );
  });

  it('refuses a run that is not posted', async () => {
    const proposed = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 5, changedBy: ACTOR }, RUN_AUTH);
    await expectRefusal(
      preparePaymentFile({ client: tenant.client, runId: proposed.runId, intendedPaymentDate: POST_DATE, changedBy: ACTOR }, { authorization: reader.authorization }),
      'RUN_NOT_POSTED',
    );
  });

  it('prepares one frozen file at three decimals with each employee’s effective bank account', async () => {
    const view = await preparePaymentFile(
      { client: tenant.client, runId: postedRunId, intendedPaymentDate: '2025-04-01', changedBy: 'PF.PREPARER' },
      { authorization: reader.authorization },
    );
    expect(view.rowCount).toBe(3);
    expect(view.currency).toBe('KWD');
    expect(view.bankDataIncluded).toBe(true);
    expect(view.fileReference).toBe(fileReferenceOf({ companyCode: fx.companyCode, fiscalYear: YEAR, period: 3, runId: postedRunId }));
    expect(view.totalAmount).toMatch(/^\d+\.\d{3}$/);

    const download = await downloadPaymentFile(tenant.client, postedRunId, { requestedBy: 'PF.READER' }, { authorization: reader.authorization });
    const csv = download.body.toString('utf8');
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(4); // header + 3
    for (const line of lines.slice(1)) {
      const cols = parseCsvLine(line);
      expect(cols[7]).toBe('Gulf Bank');
      expect(cols[8]).toBe('GBK01');
      // IBAN populated in the iban column; account column blank.
      expect(cols[9]).toBe('');
      expect(cols[10]).toMatch(/^KW00GBK/);
      expect(cols[4]).toMatch(/^\d+\.\d{3}$/);
      expect(cols[5]).toBe('KWD');
      expect(cols[6]).toBe('2025-04-01');
    }
    // Deterministic order: personnel numbers ascending.
    const pns = lines.slice(1).map((l) => parseCsvLine(l)[2]!);
    expect([...pns]).toEqual([...pns].sort());
  });

  it('stores no plaintext account number or IBAN in the payment-file row', async () => {
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select body, bank_snapshot::text as snap from payroll_payment_file where client = ${tenant.client} and run_id = ${postedRunId}`)) as unknown as Array<{ body: unknown; snap: string }>;
    expect(rows[0]!.body).toBeNull();
    expect(rows[0]!.snap).toMatch(/cbd1\./);
    expect(rows[0]!.snap).not.toContain('KW00GBK');
  });

  it('neutralises a comma/quote name and a formula-like name', async () => {
    const download = await downloadPaymentFile(tenant.client, postedRunId, { confirmReuse: true, requestedBy: 'PF.READER' }, { authorization: reader.authorization });
    const csv = download.body.toString('utf8');
    expect(csv).toContain(`"O'Brien, ""Pat"""`);
    expect(csv).toContain(`'=HYPERLINK(""http://evil"")`);
    // The raw formula never starts a cell.
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/);
  });

  it('is idempotent: a retry returns the same snapshot, a different date is refused', async () => {
    const again = await preparePaymentFile({ client: tenant.client, runId: postedRunId, intendedPaymentDate: '2025-04-01', changedBy: 'PF.OTHER' }, { authorization: reader.authorization });
    expect(again.fileReference).toBe(fileReferenceOf({ companyCode: fx.companyCode, fiscalYear: YEAR, period: 3, runId: postedRunId }));
    await expectRefusal(
      preparePaymentFile({ client: tenant.client, runId: postedRunId, intendedPaymentDate: '2025-05-01', changedBy: 'PF.OTHER' }, { authorization: reader.authorization }),
      'FILE_EXISTS',
    );
  });

  it('concurrent preparations return the same single batch', async () => {
    const fresh = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 6, changedBy: ACTOR }, RUN_AUTH);
    await releasePayrollRun({ client: tenant.client, runId: fresh.runId, changedBy: ACTOR }, RUN_AUTH);
    const poster = await createPayrollPoster(tenant.client);
    await postPayrollRun({ client: tenant.client, runId: fresh.runId, changedBy: poster.username, authorization: poster.authorization });
    const [a, b] = await Promise.all([
      preparePaymentFile({ client: tenant.client, runId: fresh.runId, intendedPaymentDate: '2025-07-01', changedBy: 'A' }, { authorization: reader.authorization }),
      preparePaymentFile({ client: tenant.client, runId: fresh.runId, intendedPaymentDate: '2025-07-01', changedBy: 'B' }, { authorization: reader.authorization }),
    ]);
    expect(a.preparationId).toBe(b.preparationId);
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from payroll_payment_file where client = ${tenant.client} and run_id = ${fresh.runId}`)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  it('a repeat download after a master-data change returns the frozen bytes', async () => {
    const before = await downloadPaymentFile(tenant.client, postedRunId, { confirmReuse: true, requestedBy: 'PF.R1' }, { authorization: reader.authorization });
    await withTenant(tenant.client, async (tx) => {
      // Rename an employee: the frozen file must not change.
      await tx.execute(sql`update employee set full_name = 'Renamed After Preparation' where client = ${tenant.client} and personnel_number in (
        select personnel_number from payroll_result where client = ${tenant.client} and run_id = ${postedRunId} limit 1)`);
    });
    const after = await downloadPaymentFile(tenant.client, postedRunId, { confirmReuse: true, requestedBy: 'PF.R2' }, { authorization: reader.authorization });
    expect(after.body.equals(before.body)).toBe(true);
    expect(after.reused).toBe(true);
  });

  it('refuses a second download without the duplicate-upload confirmation', async () => {
    await expectRefusal(downloadPaymentFile(tenant.client, postedRunId, { requestedBy: 'PF.R3' }, { authorization: reader.authorization }), 'FILE_REUSE');
  });

  it('a reversed payroll posting refuses both preparation and download', async () => {
    const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 7, changedBy: ACTOR }, RUN_AUTH);
    await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: ACTOR }, RUN_AUTH);
    const poster = await createPayrollPoster(tenant.client);
    await postPayrollRun({ client: tenant.client, runId: run.runId, changedBy: poster.username, authorization: poster.authorization });
    const view = await preparePaymentFile({ client: tenant.client, runId: run.runId, intendedPaymentDate: '2025-08-01', changedBy: ACTOR }, { authorization: reader.authorization });
    expect(view.rowCount).toBeGreaterThan(0);
    await withTenant(tenant.client, async (tx) => {
      const [row] = (await tx.execute(sql`select document_number, document_fiscal_year, company_code from payroll_run where client = ${tenant.client} and run_id = ${run.runId}`)) as unknown as Array<{ document_number: string; document_fiscal_year: number; company_code: string }>;
      await tx.execute(sql`
        insert into accounting_reversal_link
          (client, original_company_code, original_document_number, original_fiscal_year, reversal_company_code, reversal_document_number,
           reversal_fiscal_year, reversal_reason, reversal_document_date, reversal_posting_period, reversal_posting_date, reversed_by)
        values (${tenant.client}, ${row.company_code}, ${row.document_number}, ${row.document_fiscal_year}, ${row.company_code}, 'REV-TEST-1',
           ${row.document_fiscal_year}, '01', '2025-08-31', 8, '2025-08-31', ${ACTOR})`);
    });
    await expectRefusal(preparePaymentFile({ client: tenant.client, runId: run.runId, intendedPaymentDate: '2025-08-01', changedBy: ACTOR }, { authorization: reader.authorization }), 'RUN_REVERSED');
    await expectRefusal(downloadPaymentFile(tenant.client, run.runId, { confirmReuse: true, requestedBy: 'PF.R4' }, { authorization: reader.authorization }), 'RUN_REVERSED');
  });

  it('refuses preparation with an employee-level list when an account is not effective on the intended date, then selects by that date', async () => {
    // A fresh posted run; give every included employee a covered account, then a gap, then a later one.
    const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 10, changedBy: ACTOR }, RUN_AUTH);
    expect(run.exceptions, JSON.stringify(run.exceptions)).toEqual([]);
    await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: ACTOR }, RUN_AUTH);
    const poster = await createPayrollPoster(tenant.client);
    await postPayrollRun({ client: tenant.client, runId: run.runId, changedBy: poster.username, authorization: poster.authorization });
    const pns = (await withTenant(tenant.client, (tx) => tx.execute(sql`
      select personnel_number as pn from payroll_result where client = ${tenant.client} and run_id = ${run.runId}`)) as unknown as Array<{ pn: string }>).map((r) => r.pn);
    for (const pn of pns) {
      // End the standing account on 2025-10-31 (history kept), then add one effective 2025-11-15.
      for (const rec of await listEmployeeBank(tenant.client, pn, { authorization: bankAdmin.authorization }, KEYRING)) {
        if (rec.isActive && !rec.validTo) {
          await endEmployeeBank({ client: tenant.client, bankRecordId: rec.bankRecordId, validTo: '2025-10-31', changedBy: ACTOR }, { authorization: bankAdmin.authorization }, KEYRING);
        }
      }
      await bankAccount(pn, { from: '2025-11-15', value: `KW00GBK${pn.replace(/\D/g, '').padStart(8, '0')}0022` });
    }
    // Between the two accounts: every employee is missing — refuse, never a partial file.
    const err = await expectRefusal(
      preparePaymentFile({ client: tenant.client, runId: run.runId, intendedPaymentDate: '2025-11-01', changedBy: ACTOR }, { authorization: reader.authorization }),
      'BANK_DETAILS_MISSING',
    );
    expect((err as PaymentFileError).message).toMatch(/No valid bank account is effective/);
    // On/after the new effective date the file prepares and carries each employee's account.
    const view = await preparePaymentFile({ client: tenant.client, runId: run.runId, intendedPaymentDate: '2025-11-20', changedBy: ACTOR }, { authorization: reader.authorization });
    expect(view.bankDataIncluded).toBe(true);
    const download = await downloadPaymentFile(tenant.client, run.runId, { requestedBy: 'PF.EFF' }, { authorization: reader.authorization });
    expect(download.body.toString('utf8')).toMatch(/KW00GBK\d+0022/);
  }, 120_000);

  it('a legacy file (pre-bank) with a plaintext body downloads byte-for-byte and is not regenerated', async () => {
    // A different posted run, whose prepared row is overwritten to look like a pre-9322 file: body set, no snapshot.
    const run = await proposePayrollRun({ client: tenant.client, companyCode: fx.companyCode, fiscalYear: YEAR, period: 11, changedBy: ACTOR }, RUN_AUTH);
    await releasePayrollRun({ client: tenant.client, runId: run.runId, changedBy: ACTOR }, RUN_AUTH);
    const poster = await createPayrollPoster(tenant.client);
    await postPayrollRun({ client: tenant.client, runId: run.runId, changedBy: poster.username, authorization: poster.authorization });
    const view = await preparePaymentFile({ client: tenant.client, runId: run.runId, intendedPaymentDate: '2025-12-01', changedBy: ACTOR }, { authorization: reader.authorization });
    const legacyCsv = `file_reference,run_reference,personnel_number,beneficiary_name,amount,currency,intended_payment_date,beneficiary_bank_name,beneficiary_bank_code,beneficiary_account,beneficiary_iban,remittance_information\r\nLEGACY,,,Plan,,,,,,,,\r\n`;
    const legacyBody = Buffer.from(legacyCsv, 'utf8');
    const legacyChecksum = createHash('sha256').update(legacyBody).digest('hex');
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update payroll_payment_file set body = ${legacyBody}, checksum = ${legacyChecksum},
        bank_data_included = false, bank_snapshot = '[]'::jsonb
       where client = ${tenant.client} and run_id = ${run.runId}`));
    const download = await downloadPaymentFile(tenant.client, run.runId, { requestedBy: 'PF.LEGACY' }, { authorization: reader.authorization });
    expect(download.body.toString('utf8')).toBe(legacyCsv);
    expect(view.bankDataIncluded).toBe(true); // the earlier prepared view flagged bank data; the row is now legacy.
  }, 120_000);

  it('selects payable rows exactly: positive only, zero dropped, negative split out, ordered', () => {
    const money = moneyOf('KWD', 3);
    const { payable, negative, totalUnits } = selectPayableResults([
      { personnelNumber: 'P3', netPay: '10.5000', fullName: 'Three' },
      { personnelNumber: 'P1', netPay: '1000.0000', fullName: 'One' },
      { personnelNumber: 'P2', netPay: '0.0000', fullName: 'Two' },
      { personnelNumber: 'P4', netPay: '-5.2500', fullName: 'Four' },
    ], money);
    expect(payable.map((r) => r.personnelNumber)).toEqual(['P1', 'P3']);
    expect(negative.map((r) => r.personnelNumber)).toEqual(['P4']);
    expect(money.fromUnits(totalUnits)).toBe('1010.500');
  });

  it('never posts, clears or marks a salary paid', async () => {
    const snapshot = async () => withTenant(tenant.client, async (tx) => {
      const [j] = (await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${tenant.client}`)) as unknown as Array<{ n: number }>;
      const [p] = (await tx.execute(sql`select count(*)::int as n from salary_payment where client = ${tenant.client} and run_id = ${postedRunId}`)) as unknown as Array<{ n: number }>;
      return { journals: j!.n, paid: p!.n };
    });
    const before = await snapshot();
    await preparePaymentFile({ client: tenant.client, runId: postedRunId, intendedPaymentDate: '2025-04-01', changedBy: ACTOR }, { authorization: reader.authorization });
    await downloadPaymentFile(tenant.client, postedRunId, { confirmReuse: true, requestedBy: 'PF.R5' }, { authorization: reader.authorization });
    expect(await snapshot()).toEqual(before);
    expect(before.paid).toBe(0);
  });

  it('refuses an unauthenticated, wrong-capability, wrong-company and wrong-tenant caller', async () => {
    await expectRefusal(preparePaymentFile({ client: tenant.client, runId: postedRunId, changedBy: ACTOR }, { authorization: undefined }), 'FILE_AUTHORITY');
    await expectRefusal(preparePaymentFile({ client: tenant.client, runId: postedRunId, changedBy: ACTOR }, { authorization: noCapability.authorization }), 'FILE_AUTHORITY');
    await expectRefusal(preparePaymentFile({ client: tenant.client, runId: postedRunId, changedBy: ACTOR }, { authorization: elsewhere.authorization }), 'FILE_UNAVAILABLE');
    await expectRefusal(preparePaymentFile({ client: otherTenant.client, runId: postedRunId, changedBy: ACTOR }, { authorization: otherTenantActor.authorization }), 'FILE_UNAVAILABLE');
    // A missing run reads like an out-of-scope one.
    await expectRefusal(getPaymentFile(tenant.client, randomUUID(), { authorization: reader.authorization }), 'FILE_UNAVAILABLE');
  });
});

describe('the download route', () => {
  it('POST is 401 unauthenticated and 403 without the capability', async () => {
    requestContext.cookie = undefined;
    expect((await POST(post({ runId: postedRunId }))).status).toBe(401);
    requestContext.cookie = encodeSessionCookie(tenant.client, noCapability.token);
    expect((await POST(post({ runId: postedRunId }))).status).toBe(403);
  });

  it('GET returns the CSV as an attachment, private and no-store', async () => {
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    const response = await GET(get(postedRunId, 'yes'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body.split('\r\n')[0]).toContain('personnel_number');
  });

  it('GET is 404 for a wrong tenant, 404 for a missing run, 409 for an unconfirmed re-download', async () => {
    requestContext.cookie = encodeSessionCookie(otherTenant.client, otherTenantActor.token);
    expect((await GET(get(postedRunId, 'yes'))).status).toBe(404);
    requestContext.cookie = encodeSessionCookie(tenant.client, reader.token);
    expect((await GET(get(randomUUID(), 'yes'))).status).toBe(404);
    expect((await GET(get(postedRunId, 'no'))).status).toBe(409);
  });

  it('exposes GET and POST and forces dynamic handling', async () => {
    const route = await import('../src/app/people/payroll-runs/payment-file/route');
    expect(route.dynamic).toBe('force-dynamic');
    expect(typeof route.GET).toBe('function');
    expect(typeof route.POST).toBe('function');
  });
});

/** A tiny RFC 4180 reader, enough for the assertions above. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
