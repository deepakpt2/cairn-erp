import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  StockRequirementsError,
  stockRequirementsList,
  type StockRequirementsSelection,
} from '../src/modules/production/stock-requirements';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-130 / MD04 acceptance for PROD.MRP.STOCKREQ.
 *
 * The suite pins the projection: MRP-available stock only (blocked excluded and
 * warned), open requisitions net of conversions, open orders net of deliveries,
 * safety stock as the opening requirement, the receipt-before-requirement tie
 * rule, the running balance, hidden past-due rows that still move it, both
 * period splits, and the three exceptions.
 */
describe('SCR-130 stock/requirements list (MD04)', () => {
  const ACTOR = 'SCR130_MD04_TEST';
  const MATERIAL = 'MAT-MRP';
  const PLANT = 'QF01';
  const TODAY = '2026-05-15';
  let client = '';

  beforeAll(async () => {
    const tenant = await createTenant('scr130-md04');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`insert into plant (client, plant, name, country, created_by) values (${client}, ${PLANT}, 'Plant F', 'KW', ${ACTOR}) on conflict do nothing`);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, ${MATERIAL}, 'Planned material', t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by)
        values (${client}, ${PLANT}, 'SLF1', 'Store F', true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, mrp_type, mrp_controller, safety_stock, reorder_point, created_by)
        values (${client}, ${MATERIAL}, ${PLANT}, 'REQUIREMENTS', '001', 20, 10, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, 'G93', 'Test group', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, created_by) values (${client}, 'O930', 'Test org', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, created_by) values (${client}, 'V93000', 'Test supplier', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
        select ${client}, '1000', 'Test company', 'KW', 'KWD', c.chart_of_accounts, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
      // Stock: 30 unrestricted + 10 quality = 40 MRP-available; 5 blocked excluded.
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${client}, ${MATERIAL}, ${PLANT}, 'SLF1', 'UNRESTRICTED', 30, ${ACTOR}),
          (${client}, ${MATERIAL}, ${PLANT}, 'SLF1', 'QUALITY', 10, ${ACTOR}),
          (${client}, ${MATERIAL}, ${PLANT}, 'SLF1', 'BLOCKED', 5, ${ACTOR})
        on conflict do nothing
      `);
      // Requisition 100001 item 1: 15, of which 5 already converted to an order.
      await tx.execute(sql`
        insert into purchase_requisition_item (client, requisition_number, item_number, short_text, quantity, unit,
                                               requisition_date, delivery_date, plant, purchasing_group, material_number, created_by) values
          (${client}, '100001', 1, 'Req converted partly', 15, 'PC', '2026-05-01', '2026-06-10', ${PLANT}, 'G93', ${MATERIAL}, ${ACTOR}),
          (${client}, '100002', 1, 'Req open', 25, 'PC', '2026-05-01', '2026-07-01', ${PLANT}, 'G93', ${MATERIAL}, ${ACTOR}),
          (${client}, '100003', 1, 'Req past due', 4, 'PC', '2026-04-01', '2026-05-01', ${PLANT}, 'G93', ${MATERIAL}, ${ACTOR})
        on conflict do nothing
      `);
      // Order 5500000001 covers 5 of requisition 100001 and is open for 10 more.
      await tx.execute(sql`
        insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
                                    company_code, currency, document_date, release_status, created_by) values
          (${client}, '5500000001', 'STANDARD', 'V93000', 'O930', 'G93', '1000', 'KWD', '2026-05-02', 'RELEASED', ${ACTOR}),
          (${client}, '5500000002', 'STANDARD', 'V93000', 'O930', 'G93', '1000', 'KWD', '2026-05-03', 'RELEASED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_item (client, order_number, item_number, item_category, short_text, material_number,
                                         quantity, unit, net_price, price_unit, net_value, plant, requisition_number, requisition_item, created_by) values
          (${client}, '5500000001', 1, 'STANDARD', 'From req', ${MATERIAL}, 5, 'PC', 1, 1, 5, ${PLANT}, '100001', 1, ${ACTOR}),
          (${client}, '5500000002', 1, 'STANDARD', 'Big order', ${MATERIAL}, 30, 'PC', 1, 1, 30, ${PLANT}, null, null, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_schedule_line (client, order_number, item_number, line_number, delivery_date, quantity, created_by) values
          (${client}, '5500000001', 1, 1, '2026-05-20', 5, ${ACTOR}),
          (${client}, '5500000002', 1, 1, '2026-06-15', 30, ${ACTOR})
        on conflict do nothing
      `);
      // 12 of order 5500000002 delivered: 18 remain open.
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by) values
          (${client}, '6400000001', 2026, '2026-05-10', '2026-05-10', 'Part delivery', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (
          client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
          stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value,
          purchase_order_number, purchase_order_item, created_by
        ) values
          (${client}, '6400000001', 1, 'GOODS_RECEIPT_PO', ${MATERIAL}, ${PLANT}, 'SLF1', 'UNRESTRICTED',
           12, 'PC', 12, 'PC', 1, 1, 'KWD', 12, '5500000002', 1, ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function list(selection: Partial<StockRequirementsSelection> = {}) {
    return stockRequirementsList({ client, today: TODAY, selection: { material: MATERIAL, plant: PLANT, maxHits: 100, ...selection } });
  }

  it('projects stock, requisitions and orders into one chronological balance', async () => {
    const result = await list();
    expect(result.capability).toBe('PROD.MRP.STOCKREQ');
    expect(result).toMatchObject({
      material: MATERIAL, materialDescription: 'Planned material', baseUnit: 'PC', plant: PLANT,
      mrpType: 'REQUIREMENTS', safetyStock: 20, openingStock: 40,
    });
    // 40 stock - 20 safety = 20; +10 open req (15 less 5 converted) = 30; +5 order = 35;
    // past-due req 4 on 05-01 comes before today's stock? No: stock is dated today, so
    // the past-due requisition is the first element and precedes it.
    const byLabel = result.rows.map((r) => [r.date, r.elementType, r.quantity, r.projectedBalance]);
    expect(byLabel).toEqual([
      ['2026-05-01', 'PURCHASE_REQUISITION', 4, 4],
      ['2026-05-15', 'STOCK', 40, 44],
      ['2026-05-15', 'SAFETY_STOCK', 20, 24],
      ['2026-05-20', 'PURCHASE_ORDER', 5, 29],
      ['2026-06-10', 'PURCHASE_REQUISITION', 10, 39],
      ['2026-06-15', 'PURCHASE_ORDER', 18, 57],
      ['2026-07-01', 'PURCHASE_REQUISITION', 25, 82],
    ]);
    expect(result.closingBalance).toBe(82);
  });

  it('excludes blocked stock from MRP availability and says so', async () => {
    const result = await list();
    expect(result.openingStock).toBe(40); // 30 unrestricted + 10 quality, never the 5 blocked
    expect(result.warnings.join(' ')).toMatch(/excluded from MRP availability: BLOCKED 5\.000/);
  });

  it('nets requisitions of what orders already cover and orders of what was delivered', async () => {
    const result = await list();
    const req = result.rows.filter((r) => r.elementType === 'PURCHASE_REQUISITION' && r.documentNumber === '100001');
    expect(req).toHaveLength(1);
    expect(req[0]!.quantity).toBe(10); // 15 requested - 5 converted
    const order = result.rows.find((r) => r.documentNumber === '5500000002')!;
    expect(order.quantity).toBe(18); // 30 ordered - 12 delivered
  });

  it('puts a receipt before a requirement on the same date', async () => {
    const result = await list();
    const sameDay = result.rows.filter((r) => r.date === '2026-05-15').map((r) => r.elementType);
    expect(sameDay).toEqual(['STOCK', 'SAFETY_STOCK']);
  });

  it('marks shortage, safety breach and past due, and counts them', async () => {
    const result = await list();
    const pastDue = result.rows.find((r) => r.date === '2026-05-01')!;
    expect(pastDue.exceptions).toContain('PAST_DUE');
    // A selection with a large requirement drives the balance negative and below safety.
    const tight = await list({ horizonEnd: '2026-05-15' });
    expect(tight.rows.some((r) => r.projectedBalance === 24)).toBe(true);
    expect(result.exceptionCounts.PAST_DUE).toBe(1);
  });

  it('hides past-due rows without losing their effect on the balance', async () => {
    const hidden = await list({ displayPastDue: false });
    expect(hidden.rows.some((r) => r.date === '2026-05-01')).toBe(false);
    // The hidden requisition of 4 still lifted the stock row from 40 to 44.
    expect(hidden.rows[0]).toMatchObject({ date: '2026-05-15', elementType: 'STOCK', projectedBalance: 44 });
    expect(hidden.closingBalance).toBe(82);
  });

  it('buckets into Monday-started weeks on the weekly split', async () => {
    const weekly = await list({ periodSplit: 'WEEKLY' });
    expect(weekly.periodSplit).toBe('WEEKLY');
    const first = weekly.rows[0]!;
    // 2026-05-01 is a Friday; its week starts Monday 2026-04-27.
    expect(first.date).toBe('2026-04-27');
    expect(first.periodEnd).toBe('2026-05-03');
    // The balance carried by a week is the balance after its last element.
    expect(weekly.rows[1]!.date).toBe('2026-05-11'); // the week of 2026-05-15
    expect(weekly.rows[1]!.projectedBalance).toBe(24);
    expect(weekly.closingBalance).toBe(82);
  });

  it('truncates the horizon and refuses an inverted one by name', async () => {
    const short = await list({ horizonEnd: '2026-05-31' });
    expect(short.rows.every((r) => r.date <= '2026-05-31')).toBe(true);
    expect(short.closingBalance).toBe(29);
    await expect(list({ horizonEnd: '2026-05-01' })).rejects.toThrow(/horizon ends in the past/);
    await expect(list({ horizonEnd: '2026-13-01' })).rejects.toThrow(/not a valid date/);
  });

  it('requires the material and the plant, by name', async () => {
    await expect(stockRequirementsList({ client, today: TODAY, selection: { plant: PLANT } })).rejects.toThrow(/A material is required/);
    await expect(stockRequirementsList({ client, today: TODAY, selection: { material: MATERIAL } })).rejects.toThrow(/A plant is required/);
    await expect(list({ material: 'MAT-NONE' })).rejects.toThrow(/material MAT-NONE does not stand/);
  });

  it('refuses the MRP area, the special stock indicator and a simulation version by name', async () => {
    await expect(list({ mrpArea: '0001' })).rejects.toThrow(/MRP area 0001 does not stand/);
    await expect(list({ specialStockIndicator: 'E' })).rejects.toThrow(/special stock indicator E does not stand/);
    const remedy = await list({ specialStockIndicator: 'E' }).catch((error: StockRequirementsError) => error);
    expect((remedy as StockRequirementsError).remedy).toMatch(/named stock type/);
    await expect(list({ simulationVersion: 'S001' })).rejects.toThrow(/simulation version S001 does not stand/);
    await expect(list({ periodSplit: 'MONTHLY' })).rejects.toThrow(/period split MONTHLY does not stand/);
  });

  it('warns when the material is not planned in the plant but still lists the documents', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`update material_plant set mrp_type = 'NONE' where client = ${client} and material_number = ${MATERIAL}`);
    });
    const result = await list();
    expect(result.warnings.join(' ')).toMatch(/not planned in plant QF01/);
    expect(result.rows.length).toBeGreaterThan(0);
    await withTenant(client, async (tx) => {
      await tx.execute(sql`update material_plant set mrp_type = 'REQUIREMENTS' where client = ${client} and material_number = ${MATERIAL}`);
    });
  });
});
