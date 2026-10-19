import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { listCreditMonitor, saveCustomerCredit } from '../src/modules/finance/credit';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'MONITOR-TEST';
const AREA = '1000';
let client = '';
let company = '';

async function receivable(customer: string, amount: number, key: string) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into journal_entry
        (client, document_number, fiscal_year, document_type, company_code, document_date,
         posting_date, posting_period, document_currency, local_currency, status, created_by)
      values (${client}, ${key}, 2026, 'SA', ${company}, '2026-04-10', '2026-04-10', 4, 'USD', 'USD', 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into journal_entry_line
        (client, document_number, fiscal_year, line_number, gl_account, company_code,
         debit_credit, amount_local, amount_document, currency, business_partner)
      values
        (${client}, ${key}, 2026, 1, '101000', ${company}, 'S', ${amount}, ${amount}, 'USD', ${customer}),
        (${client}, ${key}, 2026, 2, '300000', ${company}, 'H', ${amount}, ${amount}, 'USD', null)
    `);
  });
}

beforeAll(async () => {
  const fx = await createTenant('creditmonitor');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
      values (${client}, ${AREA}, 'Main credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`update company_code set credit_control_area = ${AREA} where client = ${client} and company_code = ${company}`);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name)
      values (${client}, 'C100', 'Within Limit Ltd'), (${client}, 'C200', 'No Record GmbH'), (${client}, 'C300', 'Blocked and Over SA')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_risk_category (client, risk_category, name, created_by)
      values (${client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_block_reason (client, reason_code, name, created_by)
      values (${client}, '01', 'Manual credit hold', ${ACTOR}) on conflict do nothing
    `);
  });
  await receivable('C100', 4000, 'MON-SEED-1');
  await receivable('C200', 2500, 'MON-SEED-2');
  await receivable('C300', 1500, 'MON-SEED-3');
  await saveCustomerCredit({
    client, changedBy: ACTOR, customer: 'C100', creditControlArea: AREA,
    creditLimit: '5000', riskCategory: 'A', isBlocked: false, changeReason: 'Initial assessment',
  });
  await saveCustomerCredit({
    client, changedBy: ACTOR, customer: 'C300', creditControlArea: AREA,
    creditLimit: '1000', riskCategory: 'A', isBlocked: true, blockReason: '01', changeReason: 'Hold placed',
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-104 credit exposure monitor F.31 (R-152)', () => {
  it('computes exposure, utilization and flags in one overview', async () => {
    const result = await listCreditMonitor(client, { areaFrom: AREA });
    expect(result.totalCustomers).toBe(3);
    const byCustomer = new Map(result.rows.map((r) => [r.customer, r]));
    const within = byCustomer.get('C100');
    expect(within?.arExposure).toBe(4000);
    expect(within?.totalExposure).toBe(4000);
    expect(within?.availableCredit).toBe(1000);
    expect(within?.utilizationPercent).toBeCloseTo(80);
    expect(within?.orderExposure).toBeNull(); // unavailable, never a silent zero

    const noRecord = byCustomer.get('C200');
    expect(noRecord?.noCreditRecord).toBe(true);
    expect(noRecord?.creditLimit).toBeNull();
    expect(noRecord?.utilizationPercent).toBeNull();
    expect(noRecord?.totalExposure).toBe(2500);

    const blocked = byCustomer.get('C300');
    expect(blocked?.isBlocked).toBe(true);
    expect(blocked?.utilizationPercent).toBeCloseTo(150);
    expect(blocked?.availableCredit).toBe(-500); // may go negative
    // Sorted by utilization: blocked (150) ahead of within (80).
    expect(result.rows[0]?.customer).toBe('C300');
  });

  it('applies the exceeded/blocked filters and judges filter values', async () => {
    const exceeded = await listCreditMonitor(client, { areaFrom: AREA, limitExceededOnly: true });
    expect(exceeded.rows.map((r) => r.customer)).toEqual(['C300']);
    const blockedOnly = await listCreditMonitor(client, { areaFrom: AREA, blockedOnly: true });
    expect(blockedOnly.rows.map((r) => r.customer)).toEqual(['C300']);
    const risk = await listCreditMonitor(client, { areaFrom: AREA, riskCategory: 'A' });
    expect(risk.rows.map((r) => r.customer).sort()).toEqual(['C100', 'C300']); // no-record rows excluded
    await expect(listCreditMonitor(client, { areaFrom: 'ZZZZ' })).rejects.toThrow('does not stand configured');
    await expect(listCreditMonitor(client, { riskCategory: 'ZZ' })).rejects.toThrow('Risk category');
    await expect(listCreditMonitor(client, { companyCode: 'NOPE' })).rejects.toThrow('does not stand');
  });

  it('converts to the reporting currency and flags missing rates', async () => {
    // The fixture may deliver rates; clear the pair so the
    // missing-rate path is the one under test.
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        delete from exchange_rate where client = ${client} and from_currency = 'USD' and to_currency = 'EUR'
      `);
    });
    const unconverted = await listCreditMonitor(client, { areaFrom: AREA, reportingCurrency: 'EUR' });
    const row = unconverted.rows.find((r) => r.customer === 'C100');
    expect(row?.conversionMissing).toBe(true);
    expect(row?.creditCurrency).toBe('USD'); // kept, never wrongly converted

    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, ratio_from, ratio_to, created_by)
        values (${client}, 'AVERAGE', 'USD', 'EUR', '2026-01-01', 0.9, 1, 1, ${ACTOR})
        on conflict do nothing
      `);
    });
    const converted = await listCreditMonitor(client, { areaFrom: AREA, reportingCurrency: 'EUR' });
    const convertedRow = converted.rows.find((r) => r.customer === 'C100');
    expect(convertedRow?.conversionMissing).toBe(false);
    expect(convertedRow?.creditCurrency).toBe('EUR');
    expect(convertedRow?.arExposure).toBeCloseTo(3600);
    expect(convertedRow?.creditLimit).toBeCloseTo(4500);
    expect(convertedRow?.utilizationPercent).toBeCloseTo(80); // currency-invariant
  });
});
