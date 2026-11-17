/**
 * Printable purchase order, request for quotation and sales quotation (PDF on demand).
 * Rows are inserted directly: these tests prove what is printed and refused, not how the documents are created.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { PdfDownloadError } from '../src/modules/output/download-pdf';
import { purchaseOrderPdf, rfqPdf } from '../src/modules/purchasing/document-print';
import { salesQuotationPdf } from '../src/modules/sales/quotation-print';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'DOCPRINT';
let client = '';
let other = '';

const PO_CAP = ['PROC.PO.DISPLAY'];
const RFQ_CAP = ['PROC.RFQ.CREATE'];
const SQ_CAP = ['SALES.QUOTATION.CREATE'];

const text = (pdf: { base64: string }) => Buffer.from(pdf.base64, 'base64');

beforeAll(async () => {
  client = (await createTenant('docprint-a')).client;
  other = (await createTenant('docprint-b')).client;
  await withTenant(client, async (tx) => {
    await tx.execute(sql`update company_code set name = 'Print Co' where client = ${client} and company_code = '1000'`);
    await tx.execute(sql`insert into unit_of_measure (code, name) values ('BX', 'Box') on conflict do nothing`);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, general_status, created_by)
      values (${client}, 'V-PRINT', 'ORGANIZATION', 'Print supplier', 'CREATED', ${ACTOR}),
             (${client}, 'C-PRINT', 'ORGANIZATION', 'Print customer', 'CREATED', ${ACTOR})
    `);
    await tx.execute(sql`insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V-PRINT', 'SUPPLIER', ${ACTOR}), (${client}, 'C-PRINT', 'CUSTOMER', ${ACTOR})`);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, '1000', 'Print plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, release_status, created_by)
      values (${client}, 'PO-REL', 'V-PRINT', '1000', '001', '1000', 'USD', '2026-11-01', 'RELEASED', ${ACTOR}),
             (${client}, 'PO-UNREL', 'V-PRINT', '1000', '001', '1000', 'USD', '2026-11-01', 'UNRELEASED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchase_order_item (client, order_number, item_number, short_text, quantity, unit, net_price, net_value, plant, created_by)
      values (${client}, 'PO-REL', 10, 'Flour sack', 4, 'BX', 25, 100, '1000', ${ACTOR}),
             (${client}, 'PO-UNREL', 10, 'Flour sack', 1, 'BX', 25, 25, '1000', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchasing_rfq_event (client, event_number, purchasing_org, purchasing_group, rfq_date, quotation_deadline, currency, created_by)
      values (${client}, 'EV-1', '1000', '001', '2026-11-01', '2026-11-15', 'USD', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchasing_rfq_event_item (client, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
      values (${client}, 'EV-1', 10, 'Sugar', 5, 'BX', '1000', '2026-12-01', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchasing_rfq (client, rfq_number, event_number, partner_number, created_by)
      values (${client}, 'RQ-1', 'EV-1', 'V-PRINT', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into purchasing_rfq_item (client, rfq_number, event_number, item_number, short_text, quantity, unit, plant, delivery_date, created_by)
      values (${client}, 'RQ-1', 'EV-1', 10, 'Sugar', 5, 'BX', '1000', '2026-12-01', ${ACTOR})
    `);
  });
});

afterAll(async () => {
  await destroyTenant(client);
  await destroyTenant(other);
});

describe('purchase order PDF', () => {
  it('prints a released order as a PDF', async () => {
    const pdf = await purchaseOrderPdf({ client, orderNumber: 'PO-REL', capabilities: PO_CAP });
    expect(pdf.fileName).toBe('Purchase-order-PO-REL.pdf');
    expect(text(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.pageCount).toBeGreaterThanOrEqual(1);
  });
  it('refuses an unreleased order, a missing one, another tenant and a session without the capability', async () => {
    await expect(purchaseOrderPdf({ client, orderNumber: 'PO-UNREL', capabilities: PO_CAP })).rejects.toBeInstanceOf(PdfDownloadError);
    await expect(purchaseOrderPdf({ client, orderNumber: 'NOPE', capabilities: PO_CAP })).rejects.toBeInstanceOf(PdfDownloadError);
    await expect(purchaseOrderPdf({ client: other, orderNumber: 'PO-REL', capabilities: PO_CAP })).rejects.toBeInstanceOf(PdfDownloadError);
    await expect(purchaseOrderPdf({ client, orderNumber: 'PO-REL', capabilities: [] })).rejects.toBeInstanceOf(PdfDownloadError);
  });
});

describe('request for quotation PDF', () => {
  it('prints one request, and refuses another tenant and no capability', async () => {
    const pdf = await rfqPdf({ client, rfqNumber: 'RQ-1', capabilities: RFQ_CAP });
    expect(pdf.fileName).toBe('Request-for-quotation-RQ-1.pdf');
    expect(text(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    await expect(rfqPdf({ client: other, rfqNumber: 'RQ-1', capabilities: RFQ_CAP })).rejects.toBeInstanceOf(PdfDownloadError);
    await expect(rfqPdf({ client, rfqNumber: 'RQ-1', capabilities: [] })).rejects.toBeInstanceOf(PdfDownloadError);
  });
});

describe('sales quotation PDF', () => {
  it('prints an open quotation and refuses a rejected one', async () => {
    await withTenant(client, async (tx) => {
      const [area] = (await tx.execute(sql`select sales_org, distribution_channel, division from sales_area where client = ${client} limit 1`)) as unknown as Array<{ sales_org: string; distribution_channel: string; division: string }>;
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'Q-MAT', 'Quoted material', t.material_type, 'EA', ${ACTOR}
          from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into sales_quotation (client, quotation_number, sales_org, distribution_channel, division, customer_number, company_code, currency, quotation_date, valid_to, status, rejection_reason, created_by)
        values (${client}, 'Q-OPEN', ${area.sales_org}, ${area.distribution_channel}, ${area.division}, 'C-PRINT', '1000', 'USD', '2026-11-01', '2026-12-01', 'OPEN', null, ${ACTOR}),
               (${client}, 'Q-REJ', ${area.sales_org}, ${area.distribution_channel}, ${area.division}, 'C-PRINT', '1000', 'USD', '2026-11-01', '2026-12-01', 'REJECTED', '01', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into sales_quotation_line (client, quotation_number, line_number, material_number, plant, quotation_quantity, quantity_unit, base_quantity, condition_number, created_by)
        values (${client}, 'Q-OPEN', 10, 'Q-MAT', '1000', 2, 'EA', 2, 'COND-1', ${ACTOR})
      `);
    });
    const pdf = await salesQuotationPdf({ client, quotationNumber: 'Q-OPEN', capabilities: SQ_CAP });
    expect(pdf.fileName).toBe('Quotation-Q-OPEN.pdf');
    expect(text(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    await expect(salesQuotationPdf({ client, quotationNumber: 'Q-REJ', capabilities: SQ_CAP })).rejects.toBeInstanceOf(PdfDownloadError);
  });
  it('refuses a missing quotation and a session without the capability', async () => {
    await expect(salesQuotationPdf({ client, quotationNumber: 'NOPE', capabilities: SQ_CAP })).rejects.toBeInstanceOf(PdfDownloadError);
    await expect(salesQuotationPdf({ client, quotationNumber: 'NOPE', capabilities: [] })).rejects.toBeInstanceOf(PdfDownloadError);
  });
});
