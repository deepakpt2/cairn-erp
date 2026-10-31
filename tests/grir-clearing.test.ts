import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { checkPostingAllowed, derivePosition, getCompanyCode } from '../src/platform/periods';

import { reverseGoodsReceipt, postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { createOrder } from '../src/modules/purchasing/orders';
import { postSupplierInvoice } from '../src/modules/purchasing/invoice-verification';
import {
  listGrIrResiduals,
  postGrIrClearing,
  previewGrIrClearing,
  reverseGrIrClearing,
} from '../src/modules/purchasing/grir-clearing';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'SCR163_MR11_TEST';

/**
 * SCR-163 — a GR/IR clearing posts the residual that the receipt and the
 * invoice left on the account. It does not move stock. A price variance
 * that already left the account is not cleared again.
 */
describe('SCR-163 maintain GR/IR clearing', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr163-grir-clearing');
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
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${client}, '001', 'Buyer', ${ACTOR}) on conflict do nothing
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
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'GR/IR clearing acceptance',
    });
    return client;
  }

  async function counts(c: string) {
    return withTenant(c, async (tx) => {
      const [journals] = await tx.execute(sql`select count(*)::text as n from journal_entry where client = ${c}`) as unknown as Array<{ n: string }>;
      const [documents] = await tx.execute(sql`select count(*)::text as n from material_document where client = ${c}`) as unknown as Array<{ n: string }>;
      const [stock] = await tx.execute(sql`select coalesce(sum(quantity), 0)::text as n from stock_quantity where client = ${c}`) as unknown as Array<{ n: string }>;
      const [links] = await tx.execute(sql`select count(*)::text as n from gr_ir_maintenance_link where client = ${c}`) as unknown as Array<{ n: string }>;
      return { journals: journals.n, documents: documents.n, stock: stock.n, links: links.n };
    });
  }

  it('refuses a delivery cost, a consignment, and a stock movement by name', async () => {
    const c = await standingClient();
    await expect(postGrIrClearing({
      client: c, changedBy: ACTOR, orderNumber: 'PO-1', itemNumber: 10, keyDate: '2026-10-18',
      postingDate: '2026-10-18', fingerprint: '1', comment: 'not a delivery cost', requestKey: 'named-1',
      named: { deliveryCost: '1' },
    })).rejects.toThrow('delivery cost');
    await expect(previewGrIrClearing({
      client: c, orderNumber: 'PO-1', itemNumber: 10, keyDate: '2026-10-18', named: { consignment: '1' },
    })).rejects.toThrow('Consignment');
    await expect(reverseGrIrClearing({
      client: c, changedBy: ACTOR, documentNumber: '1000/2026/1', fiscalYear: 2026,
      reversalDate: '2026-10-18', comment: 'not stock', requestKey: 'named-2', named: { stock: '1' },
    })).rejects.toThrow('Stock is not changed');
    expect((await counts(c)).links).toBe('0');
  });

  it('clears the posted quantity residual, and not a price variance that already left GR/IR', async () => {
    const c = await standingClient();
    const order = await createOrder({
      client: c, changedBy: ACTOR,
      supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [
        {
          materialNumber: 'MAT-10001', shortText: 'Open quantity', quantity: 5, unit: 'PC',
          netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
          markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }], assignments: [],
        },
        {
          materialNumber: 'MAT-10001', shortText: 'Price only', quantity: 2, unit: 'PC',
          netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
          markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 2 }], assignments: [],
        },
      ],
    });
    await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-10-18', postingDate: '2026-10-18', requestKey: 'gr-mr11-1',
      lines: [{ itemNumber: 10, quantity: 5 }, { itemNumber: 20, quantity: 2 }],
    });
    await postSupplierInvoice({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-MR11-1', invoiceDate: '2026-10-18', postingDate: '2026-10-18',
      grossAmount: 550, requestKey: 'iv-mr11-1',
      lines: [
        { itemNumber: 10, quantity: 3, netAmount: 300 },
        { itemNumber: 20, quantity: 2, netAmount: 250 },
      ],
    });

    const before = await counts(c);
    const listed = await listGrIrResiduals({
      client: c, companyFrom: '1000', keyDate: '2026-10-18',
    });
    expect(listed.map((row) => row.itemNumber)).toEqual([10]);
    expect(listed[0]).toMatchObject({
      surplus: 'DELIVERY', category: 'QUANTITY', remaining: 200, openQuantity: 2, eligible: true,
    });
    expect(listed[0].furtherActivity).toMatch(/Further invoice/);

    const preview = await previewGrIrClearing({
      client: c, orderNumber: order.orderNumber, itemNumber: 10, keyDate: '2026-10-18',
    });
    expect(preview.wouldWrite).toBe(false);
    expect(preview.message).toMatch(/Nothing was written/);
    expect(await counts(c)).toEqual(before);

    await expect(postGrIrClearing({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, itemNumber: 10,
      keyDate: '2026-10-18', postingDate: '2026-10-18', fingerprint: 'stale',
      comment: 'stale proposal', requestKey: 'stale-1', acknowledgeFurtherActivity: true,
    })).rejects.toThrow('stale');
    await expect(postGrIrClearing({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, itemNumber: 10,
      keyDate: '2026-10-18', postingDate: '2026-10-18', fingerprint: listed[0].fingerprint,
      comment: 'not confirmed', requestKey: 'unconfirmed',
    })).rejects.toThrow('not automatic');
    expect(await counts(c)).toEqual(before);

    const savedRules = await withTenant(c, async (tx) => {
      const rules = await tx.execute(sql`
        select variant, account_type, period_from, period_to
          from posting_period_rule where client = ${c}
      `) as unknown as Array<{ variant: string; account_type: string; period_from: number; period_to: number }>;
      await tx.execute(sql`
        update posting_period_rule
           set period_from = 12, period_to = 12, changed_by = ${ACTOR}, changed_at = now()
         where client = ${c} and account_type = 'S'
      `);
      const company = await getCompanyCode(tx, c, '1000');
      const position = await derivePosition(tx, c, company!.fiscalYearVariant, '2026-10-18');
      const closed = await checkPostingAllowed(tx, c, company!.postingPeriodVariant, 'S', position);
      expect(closed.allowed).toBe(false);
      expect(closed.reason).toContain('closed');
      return rules;
    });
    await expect(postGrIrClearing({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, itemNumber: 10,
      keyDate: '2026-10-18', postingDate: '2026-10-18', fingerprint: listed[0].fingerprint,
      comment: 'closed period', requestKey: 'closed-1', acknowledgeFurtherActivity: true,
    })).rejects.toThrow(/closed/i);
    await withTenant(c, async (tx) => {
      for (const rule of savedRules) {
        await tx.execute(sql`
          update posting_period_rule
             set period_from = ${rule.period_from}, period_to = ${rule.period_to},
                 changed_by = ${ACTOR}, changed_at = now()
           where client = ${c} and variant = ${rule.variant} and account_type = ${rule.account_type}
        `);
      }
    });
    expect((await counts(c)).journals).toBe(before.journals);

    const posted = await postGrIrClearing({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, itemNumber: 10,
      keyDate: '2026-10-18', postingDate: '2026-10-18', fingerprint: listed[0].fingerprint,
      comment: 'write off the open quantity', requestKey: 'post-1', acknowledgeFurtherActivity: true,
    });
    expect(posted.wrote).toBe(true);
    expect(posted.surplus).toBe('DELIVERY');
    const replay = await postGrIrClearing({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, itemNumber: 10,
      keyDate: '2026-10-18', postingDate: '2026-10-18', fingerprint: listed[0].fingerprint,
      comment: 'write off the open quantity', requestKey: 'post-1', acknowledgeFurtherActivity: true,
    });
    expect(replay.wrote).toBe(false);
    expect(replay.documentNumber).toBe(posted.documentNumber);
    const after = await counts(c);
    expect(Number(after.journals)).toBe(Number(before.journals) + 1);
    expect(after.documents).toBe(before.documents);
    expect(after.stock).toBe(before.stock);
    expect(after.links).toBe('1');
    expect(await listGrIrResiduals({ client: c, companyFrom: '1000', keyDate: '2026-10-18' })).toEqual([]);

    const [balanced] = await withTenant(c, async (tx) => tx.execute(sql`
      select sum(case when debit_credit = 'S' then amount_document else -amount_document end)::text as net,
             count(*)::text as lines
        from journal_entry_line
       where client = ${c} and document_number = ${posted.documentNumber}
    `)) as unknown as Array<{ net: string; lines: string }>;
    expect(Number(balanced.net)).toBe(0);
    expect(balanced.lines).toBe('2');

    await expect(postGrIrClearing({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, itemNumber: 10,
      keyDate: '2026-10-18', postingDate: '2026-10-18', fingerprint: listed[0].fingerprint,
      comment: 'again', requestKey: 'post-2', acknowledgeFurtherActivity: true,
    })).rejects.toThrow('No GR/IR residual');

    const reversed = await reverseGrIrClearing({
      client: c, changedBy: ACTOR, documentNumber: posted.documentNumber, fiscalYear: posted.fiscalYear,
      reversalDate: '2026-10-18', comment: 'put the residual back', requestKey: 'reverse-1',
    });
    expect(reversed.wrote).toBe(true);
    expect(reversed.documentNumber).not.toBe(posted.documentNumber);
    const restored = await listGrIrResiduals({ client: c, companyFrom: '1000', keyDate: '2026-10-18' });
    expect(restored).toHaveLength(1);
    expect(restored[0].remaining).toBe(200);
    const [original] = await withTenant(c, async (tx) => tx.execute(sql`
      select status, reversed_by from journal_entry
       where client = ${c} and document_number = ${posted.documentNumber}
    `)) as unknown as Array<{ status: string; reversed_by: string }>;
    expect(original.status).toBe('REVERSED');
    expect(original.reversed_by).toBe(reversed.documentNumber);
    expect((await counts(c)).stock).toBe(before.stock);
    expect((await counts(c)).documents).toBe(before.documents);
  });

  /**
   * The material is stocked in pieces, so an order line can only be placed in boxes with a
   * conversion standing: twelve pieces to a box. Inserted per test and removed again, because a
   * conversion left on the material would change what every later receipt in this file posts.
   */
  async function ensureBoxConversion(c: string): Promise<string> {
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into unit_of_measure (code, name) values ('BOX', 'Box') on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_uom_conversion (client, material_number, alternative_unit, base_unit,
                                            numerator, denominator, created_by)
        values (${c}, 'MAT-10001', 'BOX', 'PC', 12, 1, ${ACTOR})
        on conflict do nothing
      `);
    });
    return 'BOX';
  }

  it('clears an alternative-unit receipt at the order-unit value, not at the base quantity', async () => {
    const c = await standingClient();
    const box = await ensureBoxConversion(c);
    try {
      const order = await createOrder({
        client: c, changedBy: ACTOR,
        supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
        items: [{
          materialNumber: 'MAT-10001', shortText: 'Boxed steel', quantity: 3, unit: box,
          netPrice: 40, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
          markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 3 }], assignments: [],
        }],
      });
      await postGoodsReceipt({
        client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
        documentDate: '2026-10-18', postingDate: '2026-10-18', requestKey: 'gr-alt-1',
        lines: [{ itemNumber: 10, quantity: 3 }],
      });
      await postSupplierInvoice({
        client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
        supplierReference: 'INV-ALT-1', invoiceDate: '2026-10-18', postingDate: '2026-10-18',
        grossAmount: 80, requestKey: 'iv-alt-1',
        lines: [{ itemNumber: 10, quantity: 2, netAmount: 80 }],
      });

      // The document keeps what the posting converted: three boxes entered, thirty-six pieces
      // of stock. Read as text the scale of the column would leak into the assertion, so the
      // figures are compared as numbers.
      const [line] = await withTenant(c, async (tx) => tx.execute(sql`
        select l.entry_quantity::float8 as entered, l.entry_unit, l.base_quantity::float8 as based,
               l.base_unit, l.unit_price::float8 as unit_price, l.price_unit::float8 as price_unit
          from material_document_line l
         where l.client = ${c} and l.purchase_order_number = ${order.orderNumber} and l.purchase_order_item = 10
      `)) as unknown as Array<{
        entered: number; entry_unit: string; based: number; base_unit: string; unit_price: number; price_unit: number;
      }>;
      expect(line).toEqual({ entered: 3, entry_unit: box, based: 36, base_unit: 'PC', unit_price: 40, price_unit: 1 });

      const listed = await listGrIrResiduals({
        client: c, companyFrom: '1000', keyDate: '2026-10-18',
        orderFrom: order.orderNumber, orderTo: order.orderNumber,
      });
      expect(listed.map((row) => row.itemNumber)).toEqual([10]);
      // Three boxes received, two invoiced: the residual is one box at the order price. Priced
      // on the base quantity the same documents would say thirty-six boxes and a value of 1440.
      expect(listed[0]).toMatchObject({
        unit: box, orderedQuantity: 3, receivedQuantity: 3, invoicedQuantity: 2, openQuantity: 1,
        grIrValue: 40, remaining: 40, surplus: 'DELIVERY', category: 'QUANTITY', eligible: true,
      });
      expect(listed[0].furtherActivity).toMatch(/Further invoice/);

      const before = await counts(c);
      const posted = await postGrIrClearing({
        client: c, changedBy: ACTOR, orderNumber: order.orderNumber, itemNumber: 10,
        keyDate: '2026-10-18', postingDate: '2026-10-18', fingerprint: listed[0].fingerprint,
        comment: 'clear the open box', requestKey: 'alt-post-1', acknowledgeFurtherActivity: true,
      });
      expect(posted.wrote).toBe(true);
      const ledger = await withTenant(c, async (tx) => tx.execute(sql`
        select sum(case when debit_credit = 'S' then amount_document else -amount_document end)::float8 as net,
               count(*)::int as lines, max(amount_document)::float8 as amount
          from journal_entry_line
         where client = ${c} and document_number = ${posted.documentNumber}
      `)) as unknown as Array<{ net: number; lines: number; amount: number }>;
      expect(ledger[0]).toEqual({ net: 0, lines: 2, amount: 40 });
      const after = await counts(c);
      expect(Number(after.journals)).toBe(Number(before.journals) + 1);
      expect(after.documents).toBe(before.documents);
      expect(after.stock).toBe(before.stock);
    } finally {
      await withTenant(c, async (tx) => {
        await tx.execute(sql`
          delete from material_uom_conversion where client = ${c} and material_number = 'MAT-10001' and alternative_unit = ${box}
        `);
      });
    }
  });

  it('nets a reversed alternative-unit receipt to no residual at all', async () => {
    const c = await standingClient();
    const box = await ensureBoxConversion(c);
    try {
      const order = await createOrder({
        client: c, changedBy: ACTOR,
        supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
        items: [{
          materialNumber: 'MAT-10001', shortText: 'Reboxed steel', quantity: 3, unit: box,
          netPrice: 40, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
          markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 3 }], assignments: [],
        }],
      });
      const reversedOut = await postGoodsReceipt({
        client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
        documentDate: '2026-10-18', postingDate: '2026-10-18', requestKey: 'gr-altrev-1',
        lines: [{ itemNumber: 10, quantity: 2 }],
      });
      await reverseGoodsReceipt({
        client: c, changedBy: ACTOR, materialDocumentNumber: reversedOut.materialDocumentNumber,
        documentDate: '2026-10-18', postingDate: '2026-10-18', requestKey: 'gr-altrev-rev',
      });
      await postGoodsReceipt({
        client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
        documentDate: '2026-10-19', postingDate: '2026-10-19', requestKey: 'gr-altrev-2',
        lines: [{ itemNumber: 10, quantity: 3 }],
      });
      await postSupplierInvoice({
        client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
        supplierReference: 'INV-ALTREV-1', invoiceDate: '2026-10-19', postingDate: '2026-10-19',
        grossAmount: 120, requestKey: 'iv-altrev-1',
        lines: [{ itemNumber: 10, quantity: 3, netAmount: 120 }],
      });

      // Two boxes received and reversed, then three received against an invoice of three: the
      // account is square. The reversal copied its original's pair, so it nets only if the
      // order unit is read off the lines rather than assumed from the material's base.
      const rows = await listGrIrResiduals({
        client: c, companyFrom: '1000', keyDate: '2026-10-19',
        orderFrom: order.orderNumber, orderTo: order.orderNumber,
      });
      expect(rows).toEqual([]);
      const [totals] = await withTenant(c, async (tx) => tx.execute(sql`
        select sum(l.base_quantity)::float8 as base, sum(l.entry_quantity)::float8 as entered
          from material_document_line l
         where l.client = ${c} and l.purchase_order_number = ${order.orderNumber} and l.purchase_order_item = 10
      `)) as unknown as Array<{ base: number; entered: number }>;
      // 2 + 2 + 3 boxes entered against 24 + 24 + 36 pieces stored: the documents stand as posted.
      expect(totals).toEqual({ base: 84, entered: 7 });
    } finally {
      await withTenant(c, async (tx) => {
        await tx.execute(sql`
          delete from material_uom_conversion where client = ${c} and material_number = 'MAT-10001' and alternative_unit = ${box}
        `);
      });
    }
  });
});
