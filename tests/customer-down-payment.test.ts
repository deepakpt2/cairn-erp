import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { getReceivables } from '../src/modules/finance/incoming-payment';
import {
  getCustomerDownPayments, postCustomerDownPayment,
} from '../src/modules/finance/customer-down-payment';
import { deleteSpecialGlConfig } from '../src/modules/foundation/special-gl';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR083_F29_TEST';

/**
 * SCR-083 acceptance: a customer down payment received resolves
 * its special G/L indicator to the configured alternative
 * reconciliation account, posts DZ, and stands open outside
 * ordinary receivables.
 */
describe('SCR-083 customer down payment (F-29)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr083-customer-down-payment');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7, createdBy: ACTOR });
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
        await tx.execute(sql`
          insert into special_gl_config (
            client, company_code, account_type, indicator,
            alternative_reconciliation_account, description, created_by
          )
          values (${client}, '', 'AR', 'A', '230000', 'Customer advances', ${ACTOR})
          on conflict do nothing
        `);
      });
      await postCustomerInvoice({
        client, changedBy: ACTOR, customerNumber: 'C10000', companyCode: '1000',
        documentDate: '2026-10-16', postingDate: '2026-10-18',
        reference: 'INV-CDP-1', currency: 'USD', grossAmount: 550, requestKey: 'cdp-inv-1',
        lines: [{ glAccount: '300000', netAmount: 550 }],
      });
    }
    return client;
  }

  const payment = (patch: Partial<Parameters<typeof postCustomerDownPayment>[0]> = {}) => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-10-20', postingDate: '2026-10-20',
    bankGlAccount: '101000', amount: 8000, currency: 'USD',
    specialGlIndicator: 'A', reference: 'CDP-2026-001',
    requestKey: `cdp-${Math.random()}`,
    ...patch,
  });

  it('refuses an unconfigured indicator and unextended customer by name', async () => {
    await standingClient();
    await expect(postCustomerDownPayment(payment({ specialGlIndicator: 'Z' })))
      .rejects.toThrow('Special G/L indicator Z is not configured for customers');
    await expect(postCustomerDownPayment(payment({ customerNumber: 'C99999' })))
      .rejects.toThrow('does not stand extended');
  });

  it('posts DZ on the alternative account, standing outside ordinary receivables', async () => {
    const c = await standingClient();
    const posted = await postCustomerDownPayment(payment({ requestKey: 'cdp-pay-1', valueDate: '2026-10-22' }));
    expect(posted.alternativeAccount).toBe('230000');

    const header = await withTenant(c, (tx) => tx.execute(sql`
      select document_type from journal_entry
      where client = ${c} and document_number = ${posted.journalDocumentNumber}
    `));
    expect((header as unknown as Array<{ document_type: string }>)[0].document_type).toBe('DZ');

    const lines = await withTenant(c, (tx) => tx.execute(sql`
      select gl_account, debit_credit, amount_local::text as amount, line_text from journal_entry_line
      where client = ${c} and document_number = ${posted.journalDocumentNumber} order by line_number
    `));
    const rows = lines as unknown as Array<Record<string, string>>;
    expect(rows[0]).toMatchObject({ gl_account: '101000', debit_credit: 'S', amount: '8000.0000' });
    expect(rows[1]).toMatchObject({ gl_account: '230000', debit_credit: 'H', amount: '8000.0000', line_text: 'Down payment A' });

    const record = await withTenant(c, (tx) => tx.execute(sql`
      select special_gl_indicator as ind, alternative_reconciliation_account as alt, value_date::text as vd
      from customer_down_payment where client = ${c} and payment_number = ${posted.paymentNumber}
    `));
    expect((record as unknown as Array<Record<string, string>>)[0])
      .toMatchObject({ ind: 'A', alt: '230000', vd: '2026-10-22' });

    // Only the 550 invoice stands as a receivable; the advance
    // stands separately as an open customer down payment.
    const receivables = await getReceivables(c, 'C10000', '1000');
    expect(receivables.openItems.map((i) => i.signed)).toEqual([550]);
    const advances = await getCustomerDownPayments(c, 'C10000', '1000');
    expect(advances).toHaveLength(1);
    expect(Number(advances[0].amount)).toBe(8000);

    const replay = await postCustomerDownPayment(payment({ requestKey: 'cdp-pay-1' }));
    expect(replay.journalDocumentNumber).toBe(posted.journalDocumentNumber);
  });

  it('does not guard AR deletion by vendor history', async () => {
    const c = await standingClient();
    // Deleting an AR indicator is not blocked by AP down payments;
    // this also proves the indicator rows stay side-specific.
    await expect(deleteSpecialGlConfig({
      client: c, changedBy: ACTOR, companyCode: '', accountType: 'AR', indicator: 'A', reason: 'reconfigure',
    })).resolves.toBeUndefined();
    await expect(postCustomerDownPayment(payment()))
      .rejects.toThrow('Special G/L indicator A is not configured');
  });
});
