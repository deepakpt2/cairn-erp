import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { checkPostingAllowed, derivePosition, getCompanyCode } from '../src/platform/periods';
import { createOrder } from '../src/modules/purchasing/orders';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postSupplierInvoice } from '../src/modules/purchasing/invoice-verification';
import {
  activeBlockedInvoiceNumbers,
  listBlockedInvoices,
  placePaymentBlock,
  previewPaymentBlock,
  releasePaymentBlock,
} from '../src/modules/purchasing/blocked-invoice';
import {
  cancelPaymentRun, createPaymentRun, executePaymentRun, generateProposal,
} from '../src/modules/finance/payment-run';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR162_MRBR_TEST';

/**
 * SCR-162 — a manual hold is the only payment block that stands.
 * Invoice verification does not create one. The payment run reads the same row.
 * A release does not post, clear, or change the invoice amount.
 */
describe('SCR-162 release blocked invoices', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr162-blocked-invoice');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, payment_methods, created_by
        )
        values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', 'T', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into payment_method (client, country, method_code, description, allowed_direction, created_by)
        values (${client}, 'KW', 'T', 'Bank transfer', 'OUTGOING', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bank_master (bank_country, bank_key, name, created_by)
        values ('KW', 'NBK162', 'Test National Bank', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
        values (${client}, '1000', 'HB01', 'KW', 'NBK162', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
        values (${client}, '1000', 'HB01', 'MAIN', '12345678', 'USD', '101000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-10001', 'Industrial steel plate', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
        values (${client}, 'MAT-10001', '1000', 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, created_by
        )
        values (${client}, 'MAT-10001', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
               (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
               (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR})
        on conflict do nothing
      `);
    });
    await initializeMaterialPeriodControl({
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Blocked invoice acceptance',
    });
    return client;
  }

  async function counts(c: string, invoiceNumber: string) {
    return withTenant(c, async (tx) => {
      const [invoice] = await tx.execute(sql`
        select gross_amount::text as gross, journal_document_number
          from supplier_invoice
         where client = ${c} and invoice_number = ${invoiceNumber}
      `) as unknown as Array<{ gross: string; journal_document_number: string }>;
      const [journal] = await tx.execute(sql`
        select count(*)::text as documents from journal_entry where client = ${c}
      `) as unknown as Array<{ documents: string }>;
      const [lines] = await tx.execute(sql`
        select coalesce(sum(amount_local), 0)::text as amount, count(clearing_document)::text as cleared
          from journal_entry_line
         where client = ${c} and document_number = ${invoice.journal_document_number}
      `) as unknown as Array<{ amount: string; cleared: string }>;
      const [blocks] = await tx.execute(sql`
        select count(*)::text as n from supplier_invoice_payment_block where client = ${c}
      `) as unknown as Array<{ n: string }>;
      const [events] = await tx.execute(sql`
        select count(*)::text as n from supplier_invoice_payment_block_event where client = ${c}
      `) as unknown as Array<{ n: string }>;
      return {
        gross: invoice.gross,
        journal: invoice.journal_document_number,
        documents: journal.documents,
        lineAmount: lines.amount,
        cleared: lines.cleared,
        blocks: blocks.n,
        events: events.n,
      };
    });
  }

  it('refuses a price or quantity block, and a check writes nothing', async () => {
    const c = await standingClient();
    await expect(placePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: '5100000001', comment: 'not a price hold', requestKey: 'price', price: '1',
    })).rejects.toThrow('price block');
    await expect(releasePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: '5100000001', comment: 'not a quantity release', requestKey: 'qty', quantity: '1',
    })).rejects.toThrow('quantity block');
    await expect(placePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: '5100000001', comment: 'not quality', requestKey: 'quality', quality: '1',
    })).rejects.toThrow('quality block');
    const [blocks] = await withTenant(c, async (tx) => tx.execute(sql`
      select count(*)::text as n from supplier_invoice_payment_block where client = ${c}
    `)) as unknown as Array<{ n: string }>;
    expect(blocks.n).toBe('0');
  });

  it('holds an open posted invoice, keeps it out of the payment run, and releases without posting', async () => {
    const c = await standingClient();
    const order = await createOrder({
      client: c, changedBy: ACTOR,
      supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-10001', shortText: 'Industrial steel plate', quantity: 5, unit: 'PC',
        netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
        markedForDeletion: false,
        scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }],
        assignments: [],
      }],
    });
    await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-10-18', postingDate: '2026-10-18',
      requestKey: 'gr-mrbr-1', lines: [{ itemNumber: 10, quantity: 5 }],
    });
    const posted = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-MRBR-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 550, requestKey: 'iv-mrbr-1',
      lines: [{ itemNumber: 10, quantity: 5, netAmount: 550 }],
    });
    expect(posted.items[0].varianceAmount).not.toBe('0.0000');
    expect(await listBlockedInvoices({ client: c, companyFrom: '1000', fiscalYear: '2026' })).toEqual([]);

    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into parked_supplier_invoice (
          client, parked_number, fiscal_year, supplier_number, company_code, purchase_order_number,
          invoice_date, posting_date, supplier_reference, currency, gross_amount, tax_amount, request_key, created_by
        ) values (
          ${c}, 'PV-MRBR', 2026, 'V10000', '1000', ${order.orderNumber},
          '2026-10-18', '2026-10-18', 'PARK-MRBR', 'USD', 1, 0, 'park-mrbr', ${ACTOR}
        )
      `);
    });
    await expect(placePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: 'PV-MRBR', comment: 'a park is not posted', requestKey: 'park',
    })).rejects.toThrow('not a posted invoice');

    const preview = await previewPaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'hold for review', action: 'place',
    });
    expect(preview).toMatchObject({ wouldWrite: false, eligible: true, active: false });
    expect((await counts(c, posted.invoiceNumber)).blocks).toBe('0');

    const held = await placePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'hold for review', requestKey: 'place-1',
    });
    expect(held).toMatchObject({ active: true, wrote: true, outcome: 'HELD', version: 1 });
    const again = await placePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'hold for review', requestKey: 'place-1',
    });
    expect(again.wrote).toBe(false);
    expect((await counts(c, posted.invoiceNumber)).events).toBe('1');

    const listed = await listBlockedInvoices({ client: c, companyFrom: '1000', fiscalYear: '2026' });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      invoiceNumber: posted.invoiceNumber, active: true, paymentState: 'OPEN', createdBy: ACTOR,
    });
    expect(listed[0].varianceAmount).not.toBe('0');
    expect(listed[0].comment).toBe('hold for review');

    const before = await counts(c, posted.invoiceNumber);
    await withTenant(c, async (tx) => {
      const blocked = await activeBlockedInvoiceNumbers(tx, c);
      expect(blocked.has(posted.invoiceNumber)).toBe(true);
    });

    await createPaymentRun({
      client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'MRBR',
      postingDate: '2026-11-16', documentCutoffDate: '2026-10-18', nextPaymentDate: '2026-11-16',
      companies: [{ companyCode: '1000', payingCompanyCode: '1000' }],
      methods: ['T'],
    });
    const heldProposal = await generateProposal({ client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'MRBR' });
    expect(heldProposal.proposal.map((item) => item.invoiceNumber)).not.toContain(posted.invoiceNumber);

    const savedRules = await withTenant(c, async (tx) => {
      const rules = await tx.execute(sql`
        select variant, account_type, period_from, period_to
          from posting_period_rule
         where client = ${c}
      `) as unknown as Array<{ variant: string; account_type: string; period_from: number; period_to: number }>;
      await tx.execute(sql`
        update posting_period_rule
           set period_from = 12, period_to = 12, changed_by = ${ACTOR}, changed_at = now()
         where client = ${c}
      `);
      const company = await getCompanyCode(tx, c, '1000');
      const position = await derivePosition(tx, c, company!.fiscalYearVariant, '2026-10-18');
      const closed = await checkPostingAllowed(tx, c, company!.postingPeriodVariant, 'K', position);
      expect(closed.allowed).toBe(false);
      expect(closed.reason).toContain('closed');
      return rules;
    });
    await expect(releasePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'stale', requestKey: 'stale', expectedVersion: 9,
    })).rejects.toThrow('changed since it was read');
    const released = await releasePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'reviewed', requestKey: 'release-1', expectedVersion: 1,
    });
    expect(released).toMatchObject({ active: false, wrote: true, outcome: 'RELEASED' });
    const replayed = await releasePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'reviewed', requestKey: 'release-1',
    });
    expect(replayed.wrote).toBe(false);
    const after = await counts(c, posted.invoiceNumber);
    expect(after.gross).toBe(before.gross);
    expect(after.journal).toBe(before.journal);
    expect(after.documents).toBe(before.documents);
    expect(after.lineAmount).toBe(before.lineAmount);
    expect(after.cleared).toBe('0');
    expect(after.events).toBe('2');

    await withTenant(c, async (tx) => {
      for (const rule of savedRules) {
        await tx.execute(sql`
          update posting_period_rule
             set period_from = ${rule.period_from}, period_to = ${rule.period_to},
                 changed_by = ${ACTOR}, changed_at = now()
           where client = ${c} and variant = ${rule.variant} and account_type = ${rule.account_type}
        `);
      }
      const blocked = await activeBlockedInvoiceNumbers(tx, c);
      expect(blocked.has(posted.invoiceNumber)).toBe(false);
    });
    const openProposal = await generateProposal({ client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'MRBR' });
    expect(openProposal.proposal.map((item) => item.invoiceNumber)).toContain(posted.invoiceNumber);

    await executePaymentRun({
      client: c, changedBy: ACTOR, runDate: '2026-10-18', runId: 'MRBR',
      houseBankKey: 'HB01', bankAccountId: 'MAIN',
    });
    await expect(placePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'too late', requestKey: 'paid',
    })).rejects.toThrow('already paid');
  });

  it('refuses a hold while the invoice stands in a proposal, then places it again after release', async () => {
    const c = await standingClient();
    const order = await createOrder({
      client: c, changedBy: ACTOR,
      supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{
        materialNumber: 'MAT-10001', shortText: 'Industrial steel plate', quantity: 2, unit: 'PC',
        netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
        markedForDeletion: false,
        scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 2 }],
        assignments: [],
      }],
    });
    await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-10-18', postingDate: '2026-10-18',
      requestKey: 'gr-mrbr-2', lines: [{ itemNumber: 10, quantity: 2 }],
    });
    const posted = await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-MRBR-2', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 200, requestKey: 'iv-mrbr-2',
      lines: [{ itemNumber: 10, quantity: 2, netAmount: 200 }],
    });
    await createPaymentRun({
      client: c, changedBy: ACTOR, runDate: '2026-10-19', runId: 'MRB2',
      postingDate: '2026-11-16', documentCutoffDate: '2026-10-18', nextPaymentDate: '2026-11-16',
      companies: [{ companyCode: '1000', payingCompanyCode: '1000' }],
      methods: ['T'],
    });
    const proposed = await generateProposal({ client: c, changedBy: ACTOR, runDate: '2026-10-19', runId: 'MRB2' });
    expect(proposed.proposal.map((item) => item.invoiceNumber)).toContain(posted.invoiceNumber);
    await expect(placePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'too late for this run', requestKey: 'in-proposal',
    })).rejects.toThrow('payment proposal');
    await cancelPaymentRun({ client: c, changedBy: ACTOR, runDate: '2026-10-19', runId: 'MRB2' });
    const held = await placePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'hold after the proposal', requestKey: 'place-2',
    });
    expect(held.active).toBe(true);
    const released = await releasePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'released once', requestKey: 'release-2', expectedVersion: held.version,
    });
    expect(released.active).toBe(false);
    const again = await placePaymentBlock({
      client: c, changedBy: ACTOR, invoiceNumber: posted.invoiceNumber, comment: 'held again', requestKey: 'reblock-2', expectedVersion: released.version,
    });
    expect(again).toMatchObject({ active: true, wrote: true, outcome: 'HELD' });
    expect(again.version).toBe(released.version + 1);
  });
});
