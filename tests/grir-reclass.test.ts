import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { executeGrIrAnalysis } from '../src/modules/finance/grir-reclass';
import { createTenant, defineTestRanges, destroyTenant, seedAccounts } from './helpers';

const ACTOR = 'GRIR-TEST';
let client = '';
let company = '';

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

function selection(overrides: Record<string, unknown> = {}) {
  return {
    companyCode: company, keyDate: '2026-04-30', testRun: true, createAccruals: false,
    requestKey: `grir-${Math.random().toString(36).slice(2)}`,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeAll(async () => {
  const fx = await createTenant('grir-reclass');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await seedAccounts(fx, ['191000', '191100']);
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for PO', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR}),
             (${client}, 'RECEIPT_REVERSAL', 'Reversal of goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '191100', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V100', 'ORGANIZATION', 'Test vendor', ${ACTOR}) on conflict do nothing
    `);
    for (const po of ['PO-1', 'PO-2']) {
      await tx.execute(sql`
        insert into purchase_order (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
        values (${client}, ${po}, 'V100', '1000', '001', ${company}, 'USD', '2026-04-01', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_order_item (client, order_number, item_number, short_text, quantity, unit, net_price, net_value, plant, created_by)
        values (${client}, ${po}, 1, 'Test item', 10, 'EA', 100, 1000, '1000', ${ACTOR})
      `);
    }
    // PO-1: 10 received, 6 invoiced. PO-2: 5 received, 5 invoiced at a higher value.
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, 'MD-1', 2026, '2026-04-05', '2026-04-05', 'POSTED', ${ACTOR}),
             (${client}, 'MD-2', 2026, '2026-04-06', '2026-04-06', 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, material_number, plant, entry_quantity, entry_unit, base_quantity, base_unit, purchase_order_number, purchase_order_item, created_by)
      values (${client}, 'MD-1', 1, 'GOODS_RECEIPT_PO', 'MAT1', '1000', 10, 'EA', 10, 'EA', 'PO-1', 1, ${ACTOR}),
             (${client}, 'MD-2', 1, 'GOODS_RECEIPT_PO', 'MAT1', '1000', 5, 'EA', 5, 'EA', 'PO-2', 1, ${ACTOR})
    `);
    await tx.execute(sql`
      insert into supplier_invoice (client, invoice_number, fiscal_year, category, supplier_number, company_code, purchase_order_number, invoice_date, posting_date, supplier_reference, currency, gross_amount, status, created_by)
      values (${client}, 'INV-1', 2026, 'INVOICE', 'V100', ${company}, 'PO-1', '2026-04-10', '2026-04-10', 'REF-1', 'USD', 600, 'POSTED', ${ACTOR}),
             (${client}, 'INV-2', 2026, 'INVOICE', 'V100', ${company}, 'PO-2', '2026-04-11', '2026-04-11', 'REF-2', 'USD', 550, 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into supplier_invoice_item (client, invoice_number, line_number, purchase_order_number, purchase_order_item, quantity, unit, net_amount, expected_amount, created_by)
      values (${client}, 'INV-1', 1, 'PO-1', 1, 6, 'EA', 600, 600, ${ACTOR}),
             (${client}, 'INV-2', 1, 'PO-2', 1, 5, 'EA', 550, 500, ${ACTOR})
    `);
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-099 GR/IR analysis F.19 (R-147)', () => {
  it('classifies open items on quantity and value in test mode, posting nothing', async () => {
    const journals = await journalCount();
    const result = await executeGrIrAnalysis({ client, changedBy: ACTOR, selection: selection() });
    const po1 = result.items.find((i) => i.purchaseOrder === 'PO-1');
    const po2 = result.items.find((i) => i.purchaseOrder === 'PO-2');
    expect(po1).toMatchObject({
      receivedQuantity: 10, invoicedQuantity: 6, openQuantity: 4,
      receivedValue: 1000, invoicedValue: 600, openValue: 400,
      classification: 'GOODS_RECEIVED_NOT_INVOICED',
    });
    expect(po2).toMatchObject({
      openQuantity: 0, openValue: -50, classification: 'VALUE_DIFFERENCE',
    });
    expect(result.totalOpenValue).toBe(350);
    expect(result.accrualDocument).toBeNull();
    expect(await journalCount()).toBe(journals);
  });

  it('accrues live with reversal, re-accrues after reversal, then refuses duplicates', async () => {
    const journals = await journalCount();
    const live = await executeGrIrAnalysis({
      client, changedBy: ACTOR,
      selection: selection({
        testRun: false, createAccruals: true, postingDate: '2026-04-30',
        accrualDocumentType: 'SA', accrualAccount: '191000', reversalDate: '2026-05-01',
      }),
    });
    expect(live.status).toBe('REVERSED');
    expect(live.accrualDocument).toBeTruthy();
    expect(live.reversalDocument).toBeTruthy();
    expect(live.items.every((i) => i.status === 'ACCRUED')).toBe(true);
    expect(await journalCount()).toBe(journals + 2);

    const again = await executeGrIrAnalysis({
      client, changedBy: ACTOR,
      selection: selection({
        testRun: false, createAccruals: true, postingDate: '2026-04-30',
        accrualDocumentType: 'SA', accrualAccount: '191000',
      }),
    });
    expect(again.status).toBe('COMPLETED');

    const third = await executeGrIrAnalysis({
      client, changedBy: ACTOR,
      selection: selection({
        testRun: false, createAccruals: true, postingDate: '2026-04-30',
        accrualDocumentType: 'SA', accrualAccount: '191000',
      }),
    });
    expect(third.items.every((i) => i.status === 'SKIPPED')).toBe(true);
    expect(third.accrualDocument).toBeNull();
  });

  it('keeps analysis and posting separate, and refuses half-specified accruals', async () => {
    const journals = await journalCount();
    const analysisOnly = await executeGrIrAnalysis({
      client, changedBy: ACTOR,
      selection: selection({ testRun: false, createAccruals: false }),
    });
    expect(analysisOnly.accrualDocument).toBeNull();
    expect(await journalCount()).toBe(journals);

    await expect(executeGrIrAnalysis({
      client, changedBy: ACTOR,
      selection: selection({ testRun: false, createAccruals: true }),
    })).rejects.toThrow('requires a posting date');
    await expect(executeGrIrAnalysis({
      client, changedBy: ACTOR, selection: selection({ purchaseOrderFrom: 'PO-2', purchaseOrderTo: 'PO-1', postingDateFrom: '2026-05-01', postingDateTo: '2026-04-01' }),
    })).rejects.toThrow('starts after it ends');
  });
});
