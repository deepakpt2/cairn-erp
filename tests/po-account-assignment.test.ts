import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  PoAccountAssignError,
  purchaseOrdersByAccountAssignment,
  type PoAccountAssignSelection,
} from '../src/modules/purchasing/po-account-assignment';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-129 / ME2K acceptance for PROC.PO.ACCOUNTASSIGN.
 *
 * The suite pins the commitment arithmetic (item net value split by percentage,
 * rounded at the line, groups summing back), the scope of selection over the
 * SCR-124 delivered/invoiced derivation, refusal by name for the categories this
 * canon cannot carry, and the two drills.
 */
describe('SCR-129 purchase orders by account assignment (ME2K)', () => {
  const ACTOR = 'SCR129_ME2K_TEST';
  let client = '';

  beforeAll(async () => {
    const tenant = await createTenant('scr129-me2k');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
        select ${client}, '1000', 'Test company', 'KW', 'KWD', c.chart_of_accounts, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by) values (${client}, 'QD01', 'Plant D', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, created_by) values (${client}, 'O910', 'Test org', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, 'G91', 'Test group', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, created_by) values (${client}, 'V91000', 'Test supplier', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
        select ${client}, ca.controlling_area, v.code, '2026-01-01', '2026-12-31', v.name, 'ADMINISTRATION', '1000', ${ACTOR}
        from (select controlling_area from controlling_area where client = ${client} limit 1) ca
        cross join (values ('CC1000', 'Cost centre 1000'), ('CC2000', 'Cost centre 2000')) as v(code, name)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
                                    company_code, currency, document_date, release_status, created_by) values
          (${client}, '4700000001', 'STANDARD', 'V91000', 'O910', 'G91', '1000', 'KWD', '2026-02-10', 'RELEASED', ${ACTOR}),
          (${client}, '4700000002', 'STANDARD', 'V91000', 'O910', 'G91', '1000', 'KWD', '2026-03-15', 'RELEASED', ${ACTOR})
        on conflict do nothing
      `);
      // Order 1: item 10 of 100 split 60/40 across two cost centres.
      // Order 2: item 20 of 50 wholly on CC2000.
      await tx.execute(sql`
        insert into purchase_order_item (client, order_number, item_number, item_category, account_assignment_category,
                                         short_text, quantity, unit, net_price, price_unit, net_value, plant, created_by) values
          (${client}, '4700000001', 10, 'STANDARD', 'COST_CENTER', 'Split item', 10, 'PC', 10, 1, 100, 'QD01', ${ACTOR}),
          (${client}, '4700000002', 20, 'STANDARD', 'COST_CENTER', 'Whole item', 5, 'PC', 10, 1, 50, 'QD01', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_assignment (client, order_number, item_number, line_number, gl_account, cost_center, distribution_percentage, created_by) values
          (${client}, '4700000001', 10, 1, '500000', 'CC1000', 60, ${ACTOR}),
          (${client}, '4700000001', 10, 2, '500000', 'CC2000', 40, ${ACTOR}),
          (${client}, '4700000002', 20, 1, '500000', 'CC2000', 100, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_schedule_line (client, order_number, item_number, line_number, delivery_date, quantity, created_by) values
          (${client}, '4700000001', 10, 1, '2026-03-01', 10, ${ACTOR}),
          (${client}, '4700000002', 20, 1, '2026-04-01', 5, ${ACTOR})
        on conflict do nothing
      `);
      // Order 1 is fully delivered and invoiced; order 2 is not.
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'ME2K-MAT', 'Assigned material', t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
          (${client}, '6300000002', 2026, '2026-03-02', '2026-03-02', 'Other receipt', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
          (${client}, '6300000001', 2026, '2026-03-02', '2026-03-02', 'Receipt for order 1', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value,
          purchase_order_number, purchase_order_item, created_by
        ) values
          (${client}, '6300000001', 1, 'GOODS_RECEIPT_PO', 'ME2K-MAT', 'QD01', null, 'UNRESTRICTED', 10, 'PC', 10, 'PC', 10, 1, 'KWD', 100,
           '4700000001', 10, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_invoice (client, invoice_number, fiscal_year, category, supplier_number, company_code,
                                      purchase_order_number, invoice_date, posting_date, supplier_reference, currency,
                                      gross_amount, tax_amount, status, created_by) values
          (${client}, '5100000001', 2026, 'INVOICE', 'V91000', '1000', '4700000001', '2026-03-05', '2026-03-05', 'REF-5100000001', 'KWD',
           100, 0, 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_invoice_item (client, invoice_number, line_number, purchase_order_number, purchase_order_item,
                                           material_number, plant, quantity, unit, net_amount, expected_amount, created_by) values
          (${client}, '5100000001', 1, '4700000001', 10, null, 'QD01', 10, 'PC', 100, 100, ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function report(selection: Partial<PoAccountAssignSelection> = {}) {
    return purchaseOrdersByAccountAssignment({ client, selection: { maxHits: 100, ...selection } });
  }

  it('distributes each item by its assignment percentages and rounds at the line', async () => {
    const result = await report();
    expect(result.capability).toBe('PROC.PO.ACCOUNTASSIGN');
    expect(result.rows).toHaveLength(3);
    const [first, second, third] = result.rows;
    expect(first).toMatchObject({
      orderNumber: '4700000001', itemNumber: 10, assignmentLine: 1, costCenter: 'CC1000',
      glAccount: '500000', quantity: 10, unit: 'PC', netValue: 100, distributionPercentage: 60,
      assignedValue: 60, deliveryDate: '2026-03-01', releaseStatus: 'RELEASED', supplierNumber: 'V91000',
      currency: 'KWD',
    });
    expect(second).toMatchObject({ costCenter: 'CC2000', distributionPercentage: 40, assignedValue: 40 });
    expect(third).toMatchObject({ orderNumber: '4700000002', costCenter: 'CC2000', assignedValue: 50 });
    // The split always adds back to the item it came from.
    expect(first.assignedValue + second.assignedValue).toBe(first.netValue);
  });

  it('groups by assigned object and the group totals sum to the lines', async () => {
    const result = await report();
    expect(result.groups).toEqual([
      { costCenter: 'CC1000', assignedValue: 60, lineCount: 1 },
      { costCenter: 'CC2000', assignedValue: 90, lineCount: 2 },
    ]);
    expect(result.groupCount).toBe(2);
    expect(result.totalAssignedValue).toBe(150);
    expect(Number(result.groups.reduce((sum, g) => sum + g.assignedValue, 0).toFixed(2))).toBe(result.totalAssignedValue);
  });

  it('applies the scope of selection over the delivered and invoiced quantities', async () => {
    const open = await report({ scope: 'STILL_TO_BE_DELIVERED' });
    // Only order 2 is short of its quantity.
    expect(open.rows.map((r) => r.orderNumber)).toEqual(['4700000002']);

    const toInvoice = await report({ scope: 'STILL_TO_BE_INVOICED' });
    // Order 1 is delivered 10 and invoiced 10; order 2 delivered 0, invoiced 0 -> not delivered>invoiced.
    expect(toInvoice.rows).toHaveLength(0);

    const completed = await report({ scope: 'COMPLETED' });
    expect(completed.rows.map((r) => [r.orderNumber, r.costCenter])).toEqual([
      ['4700000001', 'CC1000'], ['4700000001', 'CC2000'],
    ]);
    const all = await report({ scope: 'ALL' });
    expect(all.rows).toHaveLength(3);
  });

  it('narrows on the cost-centre range and on the other ranges', async () => {
    const only1000 = await report({ costCenterFrom: 'CC1000', costCenterTo: 'CC1000' });
    expect(only1000.rows.map((r) => r.costCenter)).toEqual(['CC1000']);
    const byDate = await report({ documentDateFrom: '2026-03-01', documentDateTo: '2026-03-31' });
    expect(byDate.rows.map((r) => r.orderNumber)).toEqual(['4700000002']);
    const bySupplier = await report({ supplierFrom: 'V91000', supplierTo: 'V91000' });
    expect(bySupplier.rows).toHaveLength(3);
  });

  it('requires the scope of list and the scope of selection, refusing unknown ones by name', async () => {
    expect((await report()).scopeOfList).toBe('ALV');
    expect((await report({ scopeOfList: 'standard' })).scopeOfList).toBe('STANDARD');
    await expect(report({ scopeOfList: 'HIERARCHY' })).rejects.toThrow(/scope of list HIERARCHY does not stand/);
    await expect(report({ scope: 'SOMETHING' })).rejects.toThrow(/scope of selection SOMETHING does not stand/);
  });

  it('refuses the asset, WBS and internal-order categories by name', async () => {
    await expect(report({ accountAssignmentCategory: 'A' })).rejects.toThrow(/category A \(asset\) is not carried/);
    await expect(report({ accountAssignmentCategory: 'P' })).rejects.toThrow(/category P \(WBS element\) is not carried/);
    await expect(report({ accountAssignmentCategory: 'F' })).rejects.toThrow(/category F \(internal order\) is not carried/);
    const remedy = await report({ accountAssignmentCategory: 'P' }).catch((error: PoAccountAssignError) => error);
    expect((remedy as PoAccountAssignError).remedy).toMatch(/cost centres only/);
    // The one this canon carries is accepted, both by name and by SAP code.
    expect((await report({ accountAssignmentCategory: 'K' })).rows).toHaveLength(3);
    expect((await report({ accountAssignmentCategory: 'COST_CENTER' })).rows).toHaveLength(3);
  });

  it('refuses keys that do not stand and impossible dates, by name', async () => {
    await expect(report({ costCenterFrom: 'CC9999' })).rejects.toThrow(/cost centre CC9999/);
    await expect(report({ plantFrom: 'QD99' })).rejects.toThrow(/plant QD99/);
    await expect(report({ supplierFrom: 'V99999' })).rejects.toThrow(/supplier V99999/);
    await expect(report({ documentDateTo: '2026-02-30' })).rejects.toThrow(/not a valid date/);
    await expect(report({ costCenterFrom: 'CC2000', costCenterTo: 'CC1000' })).rejects.toThrow(/cost centre range is inverted/);
    await expect(report({ maxHits: 0 })).rejects.toThrow(/Maximum hits/);
  });

  it('gives each row its order and cost-centre drills', async () => {
    const result = await report();
    expect(result.rows[0]!.orderDrillDown).toBe('/purchasing/orders?order=4700000001');
    expect(result.rows[0]!.costCenterDrillDown).toBe('/controlling/cost-center-report?costCenter=CC1000');
  });

  it('truncates at the maximum hits and says so', async () => {
    const result = await report({ maxHits: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/truncated at 2 hits/);
    expect(result.totalAssignedValue).toBe(100);
  });
});
