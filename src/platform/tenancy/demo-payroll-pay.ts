/**
 * Demo phase D10_PAYROLL_PAY — payroll phase 4: the posted run, paid.
 *
 * The demo company had no house bank: its finance phase pays from G/L account 101000 by plain journal.
 * A salary payment pays from a house-bank account, so this phase defines one through the product's
 * configuration services — a bank in the bank master, house bank `VFB` for company 1000, and account
 * `MAIN` in KWD on 101000 (the same G/L account the rest of the demo banks through) — and then pays
 * the run D9 posted: one PY document, a debit per employee on the net pay payable, one bank credit,
 * and the payroll document's payable cleared.
 *
 * The payment is dated the last day of the run's period, the earliest day a period's salaries may be
 * paid, which keeps it inside the demo's open periods. Paid by `demo.admin` (D9 gave it its explicit
 * Company Code scope); no role is granted PEOPLE.PAYROLL.PAYMENT.
 *
 * Idempotent: the bank, house bank and account are created only when missing, and a run already paid
 * is left as it is.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { saveBank } from '../../modules/foundation/bank-master';
import { listHouseBanks, saveBankAccount, saveHouseBank } from '../../modules/foundation/house-bank-definition';
import { listPayrollRuns } from '../../modules/people/payroll-run';
import { getSalaryPayment, paySalaryRun } from '../../modules/people/salary-payment';
import { DEMO_ACTOR, DEMO_FOUNDER_ACCOUNTS, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

const BANK = { country: 'KW', key: 'VFDEMO01', name: 'Gulf Demonstration Bank', city: 'Kuwait City' } as const;
const HOUSE_BANK = 'VFB';
const ACCOUNT = { id: 'MAIN', number: '0012345678', glAccount: '101000' } as const;
const REASON = 'Demo: the house bank salaries are paid from';

export interface DemoPayrollPayResult {
  runId: string;
  paymentDate: string;
  documentNumber: string;
  displayNumber: string;
  employeeCount: number;
  totalAmount: string;
}

async function ensureHouseBank(client: string, companyCode: string): Promise<void> {
  const known = await withTenant(client, async (tx) => ((await tx.execute(sql`
    select 1 from bank_master where bank_country = ${BANK.country} and bank_key = ${BANK.key}`)) as unknown as unknown[]).length > 0);
  if (!known) {
    await saveBank({ client, changedBy: DEMO_ACTOR, mode: 'CREATE', bankCountry: BANK.country, bankKey: BANK.key, name: BANK.name, city: BANK.city, swift: '' });
  }
  const standing = (await listHouseBanks(client)).find((h) => h.companyCode === companyCode && h.houseBankKey === HOUSE_BANK);
  if (!standing) {
    await saveHouseBank({
      client, changedBy: DEMO_ACTOR, reason: REASON, mode: 'CREATE',
      companyCode, houseBankKey: HOUSE_BANK, bankCountry: BANK.country, bankKey: BANK.key,
    });
  }
  if (!standing?.accounts.some((a) => a.accountId === ACCOUNT.id)) {
    await saveBankAccount({
      client, changedBy: DEMO_ACTOR, reason: REASON, mode: 'CREATE',
      companyCode, houseBankKey: HOUSE_BANK, accountId: ACCOUNT.id, accountNumber: ACCOUNT.number, iban: '',
      currency: DEMO_IDENTITY.currency, glAccount: ACCOUNT.glAccount,
    });
  }
}

export async function buildDemoPayrollPay(input: { client?: string; timeline: DemoTimeline }): Promise<DemoPayrollPayResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const companyCode = DEMO_STRUCTURE.companyCode;
  await ensureHouseBank(client, companyCode);

  const posted = (await listPayrollRuns(client))
    .filter((r) => r.companyCode === companyCode && r.status === 'POSTED')
    .sort((a, b) => b.fiscalYear - a.fiscalYear || b.period - a.period)[0];
  if (!posted) throw new Error('D10_PAYROLL_PAY: no posted payroll run stands; D9_PAYROLL_POST posts it.');

  const existing = await getSalaryPayment(client, posted.runId);
  if (!existing) {
    const payer = DEMO_FOUNDER_ACCOUNTS.administrator.username;
    await withActingUser(client, payer, (actor) => paySalaryRun({
      client, changedBy: payer, authorization: actor, runId: posted.runId,
      paymentDate: posted.periodTo, houseBankKey: HOUSE_BANK, bankAccountId: ACCOUNT.id,
    }));
  }
  const payment = (await getSalaryPayment(client, posted.runId))!;
  return {
    runId: posted.runId,
    paymentDate: payment.paymentDate,
    documentNumber: payment.documentNumber,
    displayNumber: payment.displayNumber,
    employeeCount: payment.employeeCount,
    totalAmount: payment.totalAmount,
  };
}
