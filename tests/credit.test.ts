import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  evaluateCreditCheck, getCustomerCredit, listCreditAudit, saveCustomerCredit,
} from '../src/modules/finance/credit';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'CREDIT-TEST';
const AREA = '1000';
let client = '';
let company = '';

const baseSave = (overrides: Record<string, unknown> = {}) => ({
  client, changedBy: ACTOR, customer: 'C100', creditControlArea: AREA,
  creditLimit: '10000', riskCategory: 'A', isBlocked: false,
  changeReason: 'Annual credit review',
  ...(overrides as object),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);

beforeAll(async () => {
  const fx = await createTenant('credit');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
      values (${client}, ${AREA}, 'Main credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      update company_code set credit_control_area = ${AREA} where client = ${client} and company_code = ${company}
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name) values (${client}, 'C100', 'Credit Customer')
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
  // Open receivable for C100, seeded directly: FB50 lines carry
  // no partner assignment (that arrives with customer invoices).
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into journal_entry
        (client, document_number, fiscal_year, document_type, company_code, document_date,
         posting_date, posting_period, document_currency, local_currency, status, created_by)
      values (${client}, 'CREDIT-SEED-1', 2026, 'SA', ${company}, '2026-04-10', '2026-04-10', 4, 'USD', 'USD', 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into journal_entry_line
        (client, document_number, fiscal_year, line_number, gl_account, company_code,
         debit_credit, amount_local, amount_document, currency, business_partner)
      values
        (${client}, 'CREDIT-SEED-1', 2026, 1, '101000', ${company}, 'S', 4000, 4000, 'USD', 'C100'),
        (${client}, 'CREDIT-SEED-1', 2026, 2, '300000', ${company}, 'H', 4000, 4000, 'USD', null)
    `);
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-103 customer credit management FD32 (R-151)', () => {
  it('never bypasses a missing record, and judges configuration on save', async () => {
    const check = await evaluateCreditCheck({ client, customer: 'C100', creditControlArea: AREA });
    expect(check.decision).toBe('BLOCK');
    expect(check.reason).toBe('NO_CREDIT_RECORD');

    await expect(saveCustomerCredit(baseSave({ riskCategory: 'ZZ' }))).rejects.toThrow('Risk category');
    await expect(saveCustomerCredit(baseSave({ creditLimit: '-5' }))).rejects.toThrow('cannot be negative');
    await expect(saveCustomerCredit(baseSave({ changeReason: ' ' }))).rejects.toThrow('change reason is mandatory');
    await expect(saveCustomerCredit(baseSave({ customer: 'C404' }))).rejects.toThrow('does not stand');
  });

  it('derives exposure from open receivables and audits every changed field', async () => {
    const saved = await saveCustomerCredit(baseSave());
    expect(saved.creditLimit).toBe(10000);
    expect(saved.exposure).toBe(4000);
    expect(saved.availableCredit).toBe(6000);
    expect(saved.utilizationPercent).toBeCloseTo(40);
    expect(saved.version).toBe(1);

    const audit = await listCreditAudit(client, 'C100', AREA);
    expect(audit.map((a) => a.field)).toContain('credit_limit');
    expect(audit.every((a) => a.changeReason === 'Annual credit review')).toBe(true);

    const tightened = await saveCustomerCredit(baseSave({
      creditLimit: '5000', changeReason: 'Limit tightened after review', expectedVersion: 1,
    }));
    expect(tightened.version).toBe(2);
    const limitChange = (await listCreditAudit(client, 'C100', AREA))
      .find((a) => a.field === 'credit_limit' && Number(a.newValue) === 5000);
    expect(Number(limitChange?.previousValue)).toBe(10000);

    await expect(saveCustomerCredit(baseSave({
      creditLimit: '6000', changeReason: 'Stale edit', expectedVersion: 1,
    }))).rejects.toThrow('changed since it was loaded');
  });

  it('warns at the threshold, blocks beyond the limit, on hold, and when expired', async () => {
    // Limit stands at 5000 with 4000 exposure.
    const warn = await evaluateCreditCheck({ client, customer: 'C100', creditControlArea: AREA, amount: '600' });
    expect(warn.decision).toBe('WARN'); // 4600/5000 = 92% ≥ 90%
    const exceeded = await evaluateCreditCheck({ client, customer: 'C100', creditControlArea: AREA, amount: '1500' });
    expect(exceeded.decision).toBe('BLOCK');
    expect(exceeded.reason).toBe('LIMIT_EXCEEDED');

    await expect(saveCustomerCredit(baseSave({
      isBlocked: true, changeReason: 'Hold without reason', expectedVersion: 2,
    }))).rejects.toThrow('block reason is required');
    await saveCustomerCredit(baseSave({
      isBlocked: true, blockReason: '01', changeReason: 'Payment behaviour concern', expectedVersion: 2,
    }));
    const held = await evaluateCreditCheck({ client, customer: 'C100', creditControlArea: AREA });
    expect(held.decision).toBe('BLOCK');
    expect(held.reason).toBe('MANUAL_HOLD');

    await saveCustomerCredit(baseSave({
      isBlocked: false, validTo: '2020-01-01', changeReason: 'Released; validity lapsed', expectedVersion: 3,
    }));
    const expired = await evaluateCreditCheck({ client, customer: 'C100', creditControlArea: AREA });
    expect(expired.decision).toBe('BLOCK');
    expect(expired.reason).toBe('LIMIT_EXPIRED');
    const view = await getCustomerCredit(client, 'C100', AREA);
    expect(view?.limitExpired).toBe(true);
  });
});
