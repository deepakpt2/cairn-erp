import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postVendorDownPayment } from '../src/modules/finance/vendor-down-payment';
import {
  createVendorDownPaymentRequest, getVendorDownPaymentRequests,
} from '../src/modules/finance/vendor-down-payment-request';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR086_F47_TEST';

/**
 * SCR-086 acceptance: a vendor down-payment request is a noted
 * item — no journal, no liability — and an F-48 payment fulfills
 * it by explicit allocation. The payment block refuses the
 * disbursement (F-48), never the request.
 */
describe('SCR-086 vendor down payment request (F-47)', () => {
  let client = '';
  let requestNumber = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr086-vendor-dp-request');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'VENDDPREQ', subObject: '*', prefix: 'VR', numberLength: 7, createdBy: ACTOR });
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values
            (${client}, 'V10000', 'ORGANIZATION', 'Test Vendor', ${ACTOR}),
            (${client}, 'V20000', 'ORGANIZATION', 'Blocked Vendor', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values
            (${client}, 'V10000', 'SUPPLIER', ${ACTOR}),
            (${client}, 'V20000', 'SUPPLIER', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
          values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, is_blocked, created_by
          )
          values
            (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', false, ${ACTOR}),
            (${client}, 'V20000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', true, ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into special_gl_config (
            client, company_code, account_type, indicator,
            alternative_reconciliation_account, target_special_gl_indicator, description, created_by
          )
          values
            (${client}, '', 'AP', 'A', '230000', null, 'Vendor advances', ${ACTOR}),
            (${client}, '', 'AP', 'B', '230000', null, 'Other advances', ${ACTOR}),
            (${client}, '', 'AP', 'F', '230000', 'A', 'Advance requests', ${ACTOR})
          on conflict do nothing
        `);
      });
    }
    return client;
  }

  const request = (patch: Partial<Parameters<typeof createVendorDownPaymentRequest>[0]> = {}) => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-04-01', postingDate: '2026-04-01', dueDate: '2026-04-15',
    amount: 10000, currency: 'USD', specialGlIndicator: 'F', documentType: 'KA',
    reference: 'REQ-V-2026-001', requestKey: `vreq-${Math.random()}`,
    ...patch,
  });

  const payment = (patch: Partial<Parameters<typeof postVendorDownPayment>[0]> = {}) => ({
    client, changedBy: ACTOR,
    vendorNumber: 'V10000', companyCode: '1000',
    documentDate: '2026-04-10', postingDate: '2026-04-10',
    bankGlAccount: '101000', amount: 4000, currency: 'USD',
    specialGlIndicator: 'A', requestKey: `vreq-pay-${Math.random()}`,
    ...patch,
  });

  it('refuses actual indicators, unknown indicators, strangers and bad types by name', async () => {
    await standingClient();
    await expect(createVendorDownPaymentRequest(request({ specialGlIndicator: 'A' })))
      .rejects.toThrow('is not configured as a down-payment request indicator');
    await expect(createVendorDownPaymentRequest(request({ specialGlIndicator: 'Z' })))
      .rejects.toThrow('Special G/L indicator Z is not configured for vendors');
    await expect(createVendorDownPaymentRequest(request({ vendorNumber: 'V99999' })))
      .rejects.toThrow('does not stand extended');
    await expect(createVendorDownPaymentRequest(request({ documentType: 'XX' })))
      .rejects.toThrow('Document type XX is not configured');
    await expect(createVendorDownPaymentRequest(request({ amount: 0 })))
      .rejects.toThrow('must stand above zero');
  });

  it('posts a noted item: a drawn number, no journal, and the payment block no refusal', async () => {
    const c = await standingClient();
    const created = await createVendorDownPaymentRequest(request({ requestKey: 'vreq-main' }));
    requestNumber = created.requestNumber;
    expect(requestNumber).toBeTruthy();
    expect(created.targetIndicator).toBe('A');
    expect(created.status).toBe('OPEN');

    // A blocked vendor may still be asked; the block bites at F-48.
    const blocked = await createVendorDownPaymentRequest(request({ vendorNumber: 'V20000', amount: 100 }));
    expect(blocked.status).toBe('OPEN');
    await expect(postVendorDownPayment(payment({ vendorNumber: 'V20000', amount: 50 })))
      .rejects.toThrow('is blocked for company');

    const journals = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${c}
    `));
    expect((journals as unknown as Array<{ n: number }>)[0].n).toBe(0);

    const [view] = await getVendorDownPaymentRequests(c, 'V10000', '1000');
    expect(view).toMatchObject({
      requestNumber, requestedAmount: 10000, fulfilledAmount: 0,
      remainingAmount: 10000, status: 'OPEN', dueDate: '2026-04-15',
    });

    const replay = await createVendorDownPaymentRequest(request({ requestKey: 'vreq-main' }));
    expect(replay.requestNumber).toBe(requestNumber);
  });

  it('an F-48 payment fulfills the request by explicit allocation', async () => {
    const c = await standingClient();
    await expect(postVendorDownPayment(payment({ specialGlIndicator: 'F' })))
      .rejects.toThrow('is a down-payment request indicator');

    const first = await postVendorDownPayment(payment({
      requestAllocations: [{ requestNumber }],
    }));
    let [view] = await getVendorDownPaymentRequests(c, 'V10000', '1000');
    expect(view).toMatchObject({ fulfilledAmount: 4000, remainingAmount: 6000, status: 'PARTIAL' });

    const links = await withTenant(c, (tx) => tx.execute(sql`
      select actual_document_number as doc, fulfilled_amount::text as amount, status
      from vendor_dp_request_fulfillment
      where client = ${c} and request_number = ${requestNumber}
    `));
    const rows = links as unknown as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ doc: first.journalDocumentNumber, amount: '4000.0000', status: 'ACTIVE' });

    await expect(postVendorDownPayment(payment({
      amount: 7000, requestAllocations: [{ requestNumber, amount: 6500 }],
    }))).rejects.toThrow('exceeds the remaining');
    await expect(postVendorDownPayment(payment({
      specialGlIndicator: 'B', requestAllocations: [{ requestNumber }],
    }))).rejects.toThrow('expects indicator A at fulfillment');

    await postVendorDownPayment(payment({
      amount: 6000, requestAllocations: [{ requestNumber }],
    }));
    [view] = await getVendorDownPaymentRequests(c, 'V10000', '1000');
    expect(view).toMatchObject({ fulfilledAmount: 10000, remainingAmount: 0, status: 'FULFILLED' });

    await expect(postVendorDownPayment(payment({
      amount: 10, requestAllocations: [{ requestNumber }],
    }))).rejects.toThrow('already stands fulfilled');
  });
});
