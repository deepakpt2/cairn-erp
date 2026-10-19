/**
 * SCR-115 / R-163 stage 5 — G/L to subledger tie-out.
 *
 * Each reconciliation account's total over all posted lines
 * stands beside the total over partner-carrying lines; the
 * difference is named, partnerless lines are the exception
 * detail, and partners posting away from their assigned
 * account are warned. Read-only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postGlDocument } from '../src/modules/finance/gl-document';
import {
  calculateSubledgerTie, SubledgerTieError, type SubledgerTieSelection,
} from '../src/modules/finance/subledger-tie-out';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCR115-TEST';
let tenant: TestTenant | undefined;
let client = '';
let currency = 'USD';

function selection(overrides: Partial<SubledgerTieSelection> = {}): SubledgerTieSelection {
  return { companyCode: '1000', fiscalYear: 2026, periodTo: 12, ledger: '0L', ...overrides };
}

async function post(amount: string, lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; businessPartner?: string }>, key: string) {
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: key, companyCode: '1000',
    documentDate: '2026-04-10', postingDate: '2026-04-10', documentType: 'SA', currency,
    lines: lines.map((l) => ({ amount, ...l })),
  });
}

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    return rows[0]!.n;
  });
}

beforeAll(async () => {
  tenant = await createTenant('scr115-tie');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select currency from company_code where client = ${client} and company_code = '1000'
    `) as unknown as Array<{ currency: string }>;
    currency = rows[0]?.currency ?? 'USD';
    await tx.execute(sql`
      update gl_account set reconciliation_type = 'CUSTOMERS'
      where client = ${client} and account_number in ('110000', '110100')
    `);
    await tx.execute(sql`
      update gl_account set reconciliation_type = 'VENDORS'
      where client = ${client} and account_number = '160000'
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'C10000', 'ORGANIZATION', 'Test Customer', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'C10000', 'CUSTOMER', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into customer_company_code (
        client, partner_number, role_code, company_code, chart_of_accounts,
        reconciliation_account, payment_terms_code, created_by
      )
      values (${client}, 'C10000', 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
      on conflict do nothing
    `);
  });

  await post('7000', [{ glAccount: '110000', debitCredit: 'S', businessPartner: 'C10000' }, { glAccount: '300000', debitCredit: 'H' }], 'tie-2026-1');
  await post('500', [{ glAccount: '110000', debitCredit: 'S' }, { glAccount: '101000', debitCredit: 'H' }], 'tie-2026-2');
  await post('2000', [{ glAccount: '101000', debitCredit: 'S' }, { glAccount: '160000', debitCredit: 'H', businessPartner: 'V10000' }], 'tie-2026-3');
  await post('100', [{ glAccount: '110100', debitCredit: 'S', businessPartner: 'C10000' }, { glAccount: '101000', debitCredit: 'H' }], 'tie-2026-4');
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
}, 180_000);

describe('SCR-115 G/L to subledger tie-out (R-163)', () => {
  it('names the exception where partnerless lines stand on a reconciliation account', async () => {
    const before = await journalCount();
    const result = await calculateSubledgerTie({ client, selection: selection() });
    expect(await journalCount()).toBe(before); // read-only

    const ar = result.rows.find((r) => r.kind === 'ACCOUNT' && r.accountNumber === '110000');
    expect(ar?.glTotal).toBe(7500);
    expect(ar?.subledgerTotal).toBe(7000);
    expect(ar?.difference).toBe(500);
    expect(ar?.status).toBe('EXCEPTION');
    const partner = result.rows.find((r) => r.kind === 'PARTNER' && r.businessPartner === 'C10000' && r.accountNumber === '110000');
    expect(partner?.subledgerTotal).toBe(7000);
    expect(result.partnerlessLines).toBe(1);
    expect(result.partnerlessAmount).toBe(500);
    expect(result.warnings.some((w) => w.includes('partnerless'))).toBe(true);
  });

  it('ties accounts that only move through their subledger', async () => {
    const result = await calculateSubledgerTie({ client, selection: selection() });
    const ap = result.rows.find((r) => r.kind === 'ACCOUNT' && r.accountNumber === '160000');
    expect(ap?.glTotal).toBe(-2000);
    expect(ap?.subledgerTotal).toBe(-2000);
    expect(ap?.difference).toBe(0);
    expect(ap?.status).toBe('TIED');
  });

  it('names partners posting away from their assigned reconciliation account', async () => {
    const result = await calculateSubledgerTie({ client, selection: selection() });
    expect(result.warnings.some((w) => w.includes('C10000 posts on 110100'))).toBe(true);
  });

  it('refuses non-leading ledgers by name', async () => {
    await expect(calculateSubledgerTie({ client, selection: selection({ ledger: '2L' }) }))
      .rejects.toBeInstanceOf(SubledgerTieError);
  });
});
