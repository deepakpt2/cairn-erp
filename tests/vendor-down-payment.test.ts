import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postVendorInvoice } from '../src/modules/finance/vendor-invoice';
import { getPayables } from '../src/modules/finance/outgoing-payment';
import {
  getVendorDownPayments, postVendorDownPayment,
} from '../src/modules/finance/vendor-down-payment';
import { deleteSpecialGlConfig } from '../src/modules/foundation/special-gl';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR081_F48_TEST';

/**
 * SCR-081 acceptance: a vendor down payment resolves its special
 * G/L indicator to the configured alternative reconciliation
 * account, posts KA, and stands open outside ordinary payables.
 */
describe('SCR-081 vendor down payment (F-48)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr081-vendor-down-payment');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: 'VI', numberLength: 7, createdBy: ACTOR });
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${client}, 'V10000', 'ORGANIZATION', 'Test Vendor', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
          values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into special_gl_config (
            client, company_code, account_type, indicator,
            alternative_reconciliation_account, description, created_by
          )
          values (${client}, '', 'AP', 'A', '230000', 'Down payments', ${ACTOR})
          on conflict do nothing
        `);
      });
      await postVendorInvoice({
        client, changedBy: ACTOR, vendorNumber: 'V10000', companyCode: '1000',
        documentDate: '2026-10-16', postingDate: '2026-10-18',
        reference: 'INV-DP-1', currency: 'USD', grossAmount: 550, requestKey: 'dp-inv-1',
        lines: [{ glAccount: '400000', netAmount: 550 }],
      });
    }
    return client;
  }

  const payment = (patch: Partial<Parameters<typeof postVendorDownPayment>[0]> = {}) => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-10-20', postingDate: '2026-10-20',
    bankGlAccount: '101000', amount: 10000, currency: 'USD',
    specialGlIndicator: 'A', reference: 'DP-2026-001',
    requestKey: `dp-${Math.random()}`,
    ...patch,
  });

  it('refuses an unconfigured indicator and a malformed one by name', async () => {
    await standingClient();
    await expect(postVendorDownPayment(payment({ specialGlIndicator: 'Z' })))
      .rejects.toThrow('Special G/L indicator Z is not configured');
    await expect(postVendorDownPayment(payment({ specialGlIndicator: 'AB' })))
      .rejects.toThrow('single character');
    await expect(postVendorDownPayment(payment({ vendorNumber: 'V99999' })))
      .rejects.toThrow('does not stand extended');
  });

  it('posts KA on the alternative account, standing outside ordinary payables', async () => {
    const c = await standingClient();
    const posted = await postVendorDownPayment(payment({ requestKey: 'dp-pay-1', valueDate: '2026-10-22' }));
    expect(posted.alternativeAccount).toBe('230000');

    const header = await withTenant(c, (tx) => tx.execute(sql`
      select document_type from journal_entry
      where client = ${c} and document_number = ${posted.journalDocumentNumber}
    `));
    expect((header as unknown as Array<{ document_type: string }>)[0].document_type).toBe('KA');

    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, line_text from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber} order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, string>>;
    expect(rows[0]).toMatchObject({ gl_account: '230000', debit_credit: 'S', amount: '10000.0000', line_text: 'Down payment A' });
    expect(rows[1]).toMatchObject({ gl_account: '101000', debit_credit: 'H', amount: '10000.0000' });

    const record = await withTenant(c, (tx) => tx.execute(sql`
      select special_gl_indicator as ind, alternative_reconciliation_account as alt, value_date::text as vd
      from vendor_down_payment where client = ${c} and payment_number = ${posted.paymentNumber}
    `));
    expect((record as unknown as Array<Record<string, string>>)[0])
      .toMatchObject({ ind: 'A', alt: '230000', vd: '2026-10-22' });

    // The advance is not a payable: only the 550 invoice stands open,
    // while the down payment itself stands listed as an open advance.
    const payables = await getPayables(c, 'V10000', '1000');
    expect(payables.openItems.map((i) => i.signed)).toEqual([550]);
    const advances = await getVendorDownPayments(c, 'V10000', '1000');
    expect(advances).toHaveLength(1);
    expect(Number(advances[0].amount)).toBe(10000);

    const replay = await postVendorDownPayment(payment({ requestKey: 'dp-pay-1' }));
    expect(replay.journalDocumentNumber).toBe(posted.journalDocumentNumber);
  });

  it('resolves the company scope over the tenant-wide default and guards deletion', async () => {
    const c = await standingClient();
    await withTenant(c, (tx) => tx.execute(sql`
      insert into special_gl_config (
        client, company_code, account_type, indicator,
        alternative_reconciliation_account, description, created_by
      )
      values (${c}, '1000', 'AP', 'A', '240000', 'Company down payments', ${ACTOR})
      on conflict do nothing
    `));
    const posted = await postVendorDownPayment(payment({ amount: 500 }));
    expect(posted.alternativeAccount).toBe('240000');

    await expect(deleteSpecialGlConfig({
      client: c, changedBy: ACTOR, companyCode: '', accountType: 'AP', indicator: 'A', reason: 'cleanup',
    })).rejects.toThrow('cannot be deleted');
  });
});
