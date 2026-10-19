import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postCustomerDownPayment } from '../src/modules/finance/customer-down-payment';
import {
  createCustomerDownPaymentRequest, getCustomerDownPaymentRequests,
} from '../src/modules/finance/customer-down-payment-request';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR085_F37_TEST';

/**
 * SCR-085 acceptance: a down-payment request is a noted item —
 * it moves no account and creates no journal — and an F-29
 * receipt fulfills it by explicit allocation, the fulfilled and
 * remaining amounts deriving from the standing links.
 */
describe('SCR-085 customer down payment request (F-37)', () => {
  let client = '';
  let requestNumber = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr085-customer-dp-request');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'CUSTDPREQ', subObject: '*', prefix: 'CR', numberLength: 7, createdBy: ACTOR });
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
            alternative_reconciliation_account, target_special_gl_indicator, description, created_by
          )
          values
            (${client}, '', 'AR', 'A', '230000', null, 'Customer advances', ${ACTOR}),
            (${client}, '', 'AR', 'B', '230000', null, 'Other advances', ${ACTOR}),
            (${client}, '', 'AR', 'F', '230000', 'A', 'Advance requests', ${ACTOR})
          on conflict do nothing
        `);
      });
    }
    return client;
  }

  const request = (patch: Partial<Parameters<typeof createCustomerDownPaymentRequest>[0]> = {}) => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-04-01', postingDate: '2026-04-01', dueDate: '2026-04-15',
    amount: 5000, currency: 'USD', specialGlIndicator: 'F', documentType: 'DZ',
    reference: 'REQ-2026-001', requestKey: `req-${Math.random()}`,
    ...patch,
  });

  const receipt = (patch: Partial<Parameters<typeof postCustomerDownPayment>[0]> = {}) => ({
    client, changedBy: ACTOR,
    customerNumber: 'C10000', companyCode: '1000',
    documentDate: '2026-04-10', postingDate: '2026-04-10',
    bankGlAccount: '101000', amount: 2000, currency: 'USD',
    specialGlIndicator: 'A', requestKey: `req-rcpt-${Math.random()}`,
    ...patch,
  });

  it('refuses actual indicators, unknown indicators, strangers and bad types by name', async () => {
    await standingClient();
    await expect(createCustomerDownPaymentRequest(request({ specialGlIndicator: 'A' })))
      .rejects.toThrow('is not configured as a down-payment request indicator');
    await expect(createCustomerDownPaymentRequest(request({ specialGlIndicator: 'Z' })))
      .rejects.toThrow('Special G/L indicator Z is not configured for customers');
    await expect(createCustomerDownPaymentRequest(request({ customerNumber: 'C99999' })))
      .rejects.toThrow('does not stand extended');
    await expect(createCustomerDownPaymentRequest(request({ documentType: 'XX' })))
      .rejects.toThrow('Document type XX is not configured');
    await expect(createCustomerDownPaymentRequest(request({ amount: 0 })))
      .rejects.toThrow('must stand above zero');
  });

  it('posts a noted item: a drawn number and no journal at all', async () => {
    const c = await standingClient();
    const created = await createCustomerDownPaymentRequest(request({ requestKey: 'req-main' }));
    requestNumber = created.requestNumber;
    expect(requestNumber).toBeTruthy();
    expect(created.targetIndicator).toBe('A');
    expect(created.status).toBe('OPEN');

    const journals = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${c}
    `));
    expect((journals as unknown as Array<{ n: number }>)[0].n).toBe(0);

    const [view] = await getCustomerDownPaymentRequests(c, 'C10000', '1000');
    expect(view).toMatchObject({
      requestNumber, requestedAmount: 5000, fulfilledAmount: 0,
      remainingAmount: 5000, status: 'OPEN', dueDate: '2026-04-15',
    });

    const replay = await createCustomerDownPaymentRequest(request({ requestKey: 'req-main' }));
    expect(replay.requestNumber).toBe(requestNumber);
  });

  it('an F-29 receipt fulfills the request by explicit allocation', async () => {
    const c = await standingClient();
    // A request indicator cannot itself receive an actual receipt.
    await expect(postCustomerDownPayment(receipt({ specialGlIndicator: 'F' })))
      .rejects.toThrow('is a down-payment request indicator');

    const first = await postCustomerDownPayment(receipt({
      requestAllocations: [{ requestNumber }],
    }));
    let [view] = await getCustomerDownPaymentRequests(c, 'C10000', '1000');
    expect(view).toMatchObject({ fulfilledAmount: 2000, remainingAmount: 3000, status: 'PARTIAL' });

    const links = await withTenant(c, (tx) => tx.execute(sql`
      select actual_document_number as doc, fulfilled_amount::text as amount, status
      from down_payment_request_fulfillment
      where client = ${c} and request_number = ${requestNumber}
    `));
    const rows = links as unknown as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ doc: first.journalDocumentNumber, amount: '2000.0000', status: 'ACTIVE' });

    // Over-fulfillment and wrong-indicator fulfillment are refused.
    await expect(postCustomerDownPayment(receipt({
      amount: 4000, requestAllocations: [{ requestNumber, amount: 3500 }],
    }))).rejects.toThrow('exceeds the remaining');
    await expect(postCustomerDownPayment(receipt({
      specialGlIndicator: 'B', requestAllocations: [{ requestNumber }],
    }))).rejects.toThrow('expects indicator A at fulfillment');

    await postCustomerDownPayment(receipt({
      amount: 3000, requestAllocations: [{ requestNumber }],
    }));
    [view] = await getCustomerDownPaymentRequests(c, 'C10000', '1000');
    expect(view).toMatchObject({ fulfilledAmount: 5000, remainingAmount: 0, status: 'FULFILLED' });

    await expect(postCustomerDownPayment(receipt({
      amount: 10, requestAllocations: [{ requestNumber }],
    }))).rejects.toThrow('already stands fulfilled');
  });
});
