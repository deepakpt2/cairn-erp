import { sql } from 'drizzle-orm';
import { cancelSalesOrder, changeSalesOrder, getSalesOrder } from './helpers/sales-authorized';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { reverseMaterialDocument } from '../src/modules/inventory/material-document-reversal';
import {
  cancelDelivery, confirmDeliveryPicks, createDelivery, getDelivery, postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { planMaterials } from '../src/modules/production/mrp-run';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales, type TestTenant } from './helpers';
import { createSalesActor, refreshSalesActor } from './helpers/sales-actor';

/**
 * Sales-order demand in MD04 and MRP — one projection (`sales-demand.ts`), proved on the real chain.
 *
 * Nothing is mocked: orders, deliveries, picks, goods issues and their reversals are written by the services
 * the screens call, and every assertion reads MD04 (`stockRequirementsList`), the MRP run or the planning file.
 */
const ACTOR = 'SDP_DEMAND_TEST';
const AREA = 'CCA1';
const CUSTOMER = 'SDPCUST1';
const EXPOSED_CUSTOMER = 'SDPCUST2';
const MATERIAL = 'SDPMAT1';
const DATE = '2026-10-15';
const PLANT = '1000';
const STORE = '0001';
const FUTURE = '2027-03-15';
const LATER = '2027-04-20';

const base = {
  client: '', changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
  customerNumber: CUSTOMER, companyCode: '1000', currency: 'USD', orderDate: DATE,
};

let counter = 0;
const key = (what: string) => `sdp-${what}-${++counter}`;

const SALES_ACTOR = { username: '', userId: '', sessionId: '', authorization: { userId: '', sessionId: '' } };
let SALES_ACTOR_READY: Promise<void> | null = null;
let SALES_ACTOR_TENANT = '';
async function salesAuthority(client: string) {
  if (!SALES_ACTOR.userId || SALES_ACTOR_TENANT !== client) {
    SALES_ACTOR_TENANT = client;
    SALES_ACTOR_READY = createSalesActor(client).then((actor) => { Object.assign(SALES_ACTOR, actor); });
    await SALES_ACTOR_READY;
  }
  await refreshSalesActor(client, SALES_ACTOR);
  return SALES_ACTOR.authorization;
}

describe('sales-order demand in stock/requirements and MRP', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant('sdp-demand');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', numberLength: 7 },
        // What a returns delivery draws its number from (9229), for the same reason as S1 above.
        { objectCode: 'DELIVERY', subObject: 'LR', prefix: 'RT', numberLength: 7 },
        // What a returns order draws its number from (9230).
        { objectCode: 'SALESORD', subObject: 'RE', prefix: 'RO', numberLength: 7 },
        // What a credit memo draws its number from (9231).
        { objectCode: 'BILLING', subObject: 'G2', prefix: 'CM', numberLength: 7 },
        // What a credit memo request draws its number from (9232).
        { objectCode: 'SALESORD', subObject: 'CR', prefix: 'CR', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        // What a cancellation document draws its number from (9227). A fixture tenant does not go through
        // createTenant, so STANDARD_RANGES never ran for it: the interval is defined here, as the others are.
        { objectCode: 'BILLING', subObject: 'S1', prefix: 'CN', numberLength: 7 },
        { objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8 },
        { objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7 },
      ]) {
        await defineRange(tx, { client: tenant.client, createdBy: ACTOR, ...range });
      }
      await assignSalesAreaDimensions(tenant, '1000', [{ distributionChannel: '10', division: '01' }]);
      await tx.execute(sql`
        insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit)
        values ('UNT', 'Test counted unit', 'COUNT', 0, false)
        on conflict (code) do update set decimal_places = excluded.decimal_places
      `);
      await tx.execute(sql`
        insert into sales_org (client, sales_org, company_code, currency, created_by)
        values (${tenant.client}, '1000', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_org_text (client, sales_org, language_key, name, created_by)
        values (${tenant.client}, '1000', 'E', 'Test sales organization', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Test sales area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${PLANT}, 'Test shipping plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${tenant.client}, ${PLANT}, ${STORE}, 'Main store', true, false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      for (const partner of [CUSTOMER, EXPOSED_CUSTOMER]) {
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${tenant.client}, ${partner}, 'ORGANIZATION', ${`Test customer ${partner}`}, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${tenant.client}, ${partner}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into customer_sales_area (
            client, partner_number, role_code, sales_org, distribution_channel, division,
            pricing_procedure, is_blocked, sales_status, created_by
          )
          values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
          on conflict (client, partner_number, sales_org, distribution_channel, division)
          do update set sales_status = excluded.sales_status
        `);
        await tx.execute(sql`
          insert into customer_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${tenant.client}, ${partner}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
      }
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Fulfilled test material', 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD',
                100, 1000, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${STORE}, 'UNRESTRICTED', 100, ${ACTOR}) on conflict do nothing
      `);
      // The opening stock is backed by an opening document. A projection row with no material
      // document behind it is a ghost, and reconciliation treats it as drift — which is what it is.
      // A fixture that ghosts its own opening balance can never prove that a returns bucket
      // standing in the same plant leaves the reconciliation tying, so the balance is earned here.
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'OPENING_BALANCE', 'Opening balance', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, created_by)
        values (${tenant.client}, 'MD-OPEN001', 2026, ${DATE}, ${DATE}, 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type, line_direction,
                                            entry_quantity, entry_unit, base_quantity, base_unit, created_by)
        values (${tenant.client}, 'MD-OPEN001', 1, 'OPENING_BALANCE', ${MATERIAL}, ${PLANT}, ${STORE},
                'UNRESTRICTED', 'RECEIPT', 100, 'UNT', 100, 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${tenant.client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
      // The accounts the movement and the receivable post through. The chart the company code carries is the
      // standard one, so only the two sales-specific accounts have to be added to it.
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
        select ${tenant.client}, c.chart_of_accounts, v.n, v.d, 'EXPENSE',
               false, false, null, false, false, 'GENL', 'PL_STATEMENT', ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${tenant.client} limit 1) c
        cross join (values ('510300', 'Cost of goods sold'), ('120000', 'Raw materials inventory')) as v(n, d)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${tenant.client}, c.chart_of_accounts, v.e, v.vc, '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${tenant.client} limit 1) c
        cross join (values
          ('INVENTORY', 'RAW_INVENTORY', '120000'),
          ('SALES_ISSUE', 'RAW_INVENTORY', '510300'),
          ('SALES_REVENUE', '', '300000'),
          ('TAX', '', '240000')
        ) as v(e, vc, a)
        on conflict do nothing
      `);
    });
    // The material stands for sale in the sales area. The plant says the warehouse can carry it; the
    // sales view says it may be sold there, and an order is not raised without both.
    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'Test fixture credit data.',
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: EXPOSED_CUSTOMER, creditControlArea: AREA,
      creditLimit: '1.00', riskCategory: 'A', isBlocked: false, changeReason: 'Test fixture credit data.',
    });
  });


  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  const today = () => new Date().toISOString().slice(0, 10);

  /** A planned, valuated, saleable material with opening stock in the one store. */
  async function material(number: string, values: { stock?: number; procurement?: string; mrpType?: string; unit?: string } = {}) {
    const stock = values.stock ?? 0;
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${number}, ${number}, 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
                                    safety_stock, reorder_point, planned_delivery_days, in_house_production_days,
                                    purchasing_group, mrp_status, created_by)
        values (${tenant.client}, ${number}, ${PLANT}, ${values.mrpType ?? 'REQUIREMENTS'}, '001', ${values.procurement ?? 'BUY'},
                'EXACT', 0, 0, 3, 3, '001', 'MAINTAINED', ${ACTOR})
        on conflict (client, material_number, plant) do update set mrp_type = excluded.mrp_type,
          procurement_type = excluded.procurement_type, purchasing_group = '001', mrp_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${tenant.client}, ${number}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD',
                ${stock}, ${stock * 10}, ${ACTOR}) on conflict do nothing
      `);
      if (stock > 0) {
        await tx.execute(sql`
          insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
          values (${tenant.client}, ${number}, ${PLANT}, ${STORE}, 'UNRESTRICTED', ${stock}, ${ACTOR}) on conflict do nothing
        `);
      }
    });
    await maintainMaterialSales(tenant, { materialNumber: number, deliveringPlant: PLANT });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: number, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2030-12-31', supersedeStanding: false,
    });
  }

  async function order(lines: Array<{ material: string; quantity: number; unit?: string; date?: string }>, requestedDate = FUTURE) {
    const created = await createSalesOrder({
      ...base, requestKey: key('order'), requestedDate,
      lines: lines.map((line, index) => ({
        lineNumber: (index + 1) * 10, materialNumber: line.material, plant: PLANT, orderQuantity: line.quantity,
        quantityUnit: line.unit ?? 'UNT', taxCode: 'T10', requestedDeliveryDate: line.date,
      })),
    }, { authorization: await salesAuthority(tenant.client) });
    return { number: created.orderNumber, version: created.version };
  }

  async function deliver(orderNumber: string, quantity: number, lineNumber = 10, issue = true) {
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: lineNumber, quantity: String(quantity) }], requestKey: key('delivery'),
    }, { authorization: await salesAuthority(tenant.client) });
    if (!issue) return { deliveryNumber: built.deliveryNumber, issued: null };
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
      items: [{ lineNumber: 10, quantity: String(quantity), storageLocation: STORE }], requestKey: key('pick'),
    });
    const issued = await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: built.deliveryNumber,
      expectedVersion: (await getDelivery(tenant.client, built.deliveryNumber))!.version, postingDate: DATE,
    }, { authorization: await salesAuthority(tenant.client) });
    return { deliveryNumber: built.deliveryNumber, issued };
  }

  async function pick(orderDeliveryNumber: string, quantity: number) {
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: orderDeliveryNumber,
      items: [{ lineNumber: 10, quantity: String(quantity), storageLocation: STORE }], requestKey: key('pick'),
    });
  }

  const md04 = (number: string, canDisplaySalesOrders = true) => stockRequirementsList({
    client: tenant.client, today: today(), canDisplaySalesOrders, selection: { material: number, plant: PLANT },
  });
  const salesRows = (result: Awaited<ReturnType<typeof md04>>) => result.rows.filter((row) => row.elementType === 'SALES_ORDER');
  const demandOf = async (number: string) => salesRows(await md04(number)).reduce((sum, row) => sum + row.quantity, 0);

  async function stockOf(number: string): Promise<number> {
    return withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select coalesce(sum(quantity), 0)::text as q from stock_quantity
         where client = ${tenant.client} and material_number = ${number} and plant = ${PLANT} and stock_type = 'UNRESTRICTED'
      `) as unknown as Array<{ q: string }>;
      return Number(rows[0]!.q);
    });
  }

  async function planningFile(number: string) {
    return withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select net_change, reason, last_changed_at from planning_file
         where client = ${tenant.client} and material_number = ${number} and plant = ${PLANT}
      `) as unknown as Array<{ net_change: boolean; reason: string; last_changed_at: Date }>;
      return rows[0] ?? null;
    });
  }
  async function clearMarker(number: string) {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
        values (${tenant.client}, ${number}, ${PLANT}, false, 'Planned', ${ACTOR})
        on conflict (client, material_number, plant) do update set net_change = false, reason = 'Planned'
      `);
    });
  }

  it('shows a requested but unconfirmed order as dated demand and plans the buy shortage once', async () => {
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, { client: tenant.client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: tenant.client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
    });
    await material('SDP-SHORT', { stock: 100 });
    const placed = await order([{ material: 'SDP-SHORT', quantity: 150 }]);

    const list = await md04('SDP-SHORT');
    const rows = salesRows(list);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ documentNumber: placed.number, quantity: 150, date: FUTURE, direction: 'REQUIREMENT' });
    expect(rows[0]!.documentItem).toMatch(/^10/);
    expect(rows[0]!.drillDown).toContain(placed.number);
    expect(list.openingStock).toBe(100);
    expect(list.closingBalance).toBe(-50);
    expect(list.exceptionCounts.SHORTAGE).toBeGreaterThan(0);

    // The creation marked the planning file in the order's own transaction.
    expect(await planningFile('SDP-SHORT')).toMatchObject({ net_change: true });
    const run = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: key('run'), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'SDP-SHORT', materialTo: 'SDP-SHORT',
    });
    expect(run.proposalsCreated).toBe(1);
    expect(run.proposals[0]).toMatchObject({ proposalType: 'PURCHASE_REQUISITION', quantity: '50.000', materialNumber: 'SDP-SHORT', plant: PLANT });
    expect(String(run.proposals[0]!.receiptDate)).toBe(FUTURE);
    expect(await planningFile('SDP-SHORT')).toMatchObject({ net_change: false });
    // The proposal is adapted, never duplicated: the regenerative re-run creates nothing new.
    const again = await planMaterials({
      client: tenant.client, requestedBy: ACTOR, requestKey: key('rerun'), processingKey: 'NEUPL', confirmRegenerative: true, plantFrom: PLANT,
      materialFrom: 'SDP-SHORT', materialTo: 'SDP-SHORT',
    });
    expect(again.proposalsCreated).toBe(0);
    const count = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as n from purchase_requisition_item where client = ${tenant.client} and material_number = 'SDP-SHORT'
    `) as unknown as Array<{ n: number }>);
    expect(count[0]!.n).toBe(1);
  });

  it('keeps order demand while a delivery is unissued, falls with stock at goods issue and returns with the reversal', async () => {
    await material('SDP-INV', { stock: 100 });
    const placed = await order([{ material: 'SDP-INV', quantity: 100 }]);
    expect(await demandOf('SDP-INV')).toBe(100);

    // Created, then picked, but not goods-issued: the stock is still on the shelf, so the demand stays whole.
    const open = await deliver(placed.number, 30, 10, false);
    expect(await demandOf('SDP-INV')).toBe(100);
    await pick(open.deliveryNumber, 30);
    expect(await demandOf('SDP-INV')).toBe(100);
    expect(await stockOf('SDP-INV')).toBe(100);

    // Goods issue of 30: stock 70 and the order's outstanding demand 70, in the same transaction.
    await clearMarker('SDP-INV');
    const issueResult = await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: open.deliveryNumber,
      expectedVersion: (await getDelivery(tenant.client, open.deliveryNumber))!.version, postingDate: DATE,
    }, { authorization: await salesAuthority(tenant.client) });
    expect(await stockOf('SDP-INV')).toBe(70);
    expect(await demandOf('SDP-INV')).toBe(70);
    const afterIssue = await md04('SDP-INV');
    expect(afterIssue.openingStock).toBe(70);
    expect(afterIssue.closingBalance).toBe(0);
    expect(await planningFile('SDP-INV')).toMatchObject({ net_change: true });
    expect((await planningFile('SDP-INV'))!.reason).toMatch(/Goods issue of delivery/);

    // A second delivery that is cancelled before issue changes nothing; a second issued one counts.
    const cancelled = await deliver(placed.number, 10, 10, false);
    const cancelledView = await cancelDelivery({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: cancelled.deliveryNumber,
      expectedVersion: (await getDelivery(tenant.client, cancelled.deliveryNumber))!.version,
    });
    expect(cancelledView.status).toBe('CANCELLED');
    expect(await demandOf('SDP-INV')).toBe(70);
    await deliver(placed.number, 20);
    expect(await stockOf('SDP-INV')).toBe(50);
    expect(await demandOf('SDP-INV')).toBe(50);

    // Reversal of the first issue restores stock and demand together.
    await clearMarker('SDP-INV');
    await reverseMaterialDocument({
      client: tenant.client, changedBy: ACTOR, materialDocumentNumber: issueResult.materialDocumentNumber,
      fiscalYear: issueResult.materialDocumentYear, postingDate: DATE, documentDate: DATE,
      headerText: 'Shipment withdrawn', requestKey: key('reverse'),
    });
    expect(await stockOf('SDP-INV')).toBe(80);
    expect(await demandOf('SDP-INV')).toBe(80);
    expect(await planningFile('SDP-INV')).toMatchObject({ net_change: true });
    expect((await planningFile('SDP-INV'))!.reason).toMatch(/reversed/);
  });

  it('allocates issued quantity to the earliest schedule date and restores it on reversal', async () => {
    await material('SDP-SCH', { stock: 100 });
    const placed = await order([{ material: 'SDP-SCH', quantity: 100 }]);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into sales_order_schedule (client, order_number, order_line_number, schedule_number, requested_date, requested_quantity, created_by)
        values (${tenant.client}, ${placed.number}, 10, 10, ${FUTURE}, 40, ${ACTOR}),
               (${tenant.client}, ${placed.number}, 10, 11, ${LATER}, 60, ${ACTOR})
        on conflict (client, order_number, order_line_number, schedule_number)
        do update set requested_date = excluded.requested_date, requested_quantity = excluded.requested_quantity,
                      confirmed_quantity = 0, confirmed_date = null
      `);
    });
    const shape = async () => salesRows(await md04('SDP-SCH')).map((row) => `${row.documentItem}@${row.date}=${row.quantity}`);
    expect(await shape()).toEqual([`10/10@${FUTURE}=40`, `10/11@${LATER}=60`]);
    const { issued } = await deliver(placed.number, 50);
    expect(await shape()).toEqual([`10/11@${LATER}=50`]);
    expect(await demandOf('SDP-SCH')).toBe(50);
    await reverseMaterialDocument({
      client: tenant.client, changedBy: ACTOR, materialDocumentNumber: issued!.materialDocumentNumber,
      fiscalYear: issued!.materialDocumentYear, postingDate: DATE, documentDate: DATE,
      headerText: 'Shipment withdrawn', requestKey: key('reverse'),
    });
    expect(await shape()).toEqual([`10/10@${FUTURE}=40`, `10/11@${LATER}=60`]);
  });

  it('converts an alternate unit to base once and reports a unit it cannot trust', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit)
        values ('CRT', 'Carton', 'COUNT', 0, false) on conflict (code) do nothing
      `);
    });
    await material('SDP-ALT', { stock: 100 });
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material_uom_conversion (client, material_number, alternative_unit, base_unit, numerator, denominator, created_by)
        values (${tenant.client}, 'SDP-ALT', 'CRT', 'UNT', 12, 1, ${ACTOR}) on conflict do nothing
      `);
    });
    const placed = await order([{ material: 'SDP-ALT', quantity: 2, unit: 'CRT' }]);
    expect(await demandOf('SDP-ALT')).toBe(24);
    const { issued } = await deliver(placed.number, 1);
    expect(issued).not.toBeNull();
    expect(await stockOf('SDP-ALT')).toBe(88);
    expect(await demandOf('SDP-ALT')).toBe(12);

    // A goods issue standing in another unit than the item is not assumed equal: reported, not counted.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update delivery_line set quantity_unit = 'UNT' where client = ${tenant.client} and order_number = ${placed.number}`);
    });
    const blocked = await md04('SDP-ALT');
    expect(salesRows(blocked)).toHaveLength(0);
    expect(blocked.warnings.join(' ')).toMatch(/another unit than the item/);
  });

  it('leaves out rejected items, cancelled orders and the returns chain, and still counts an independent reservation', async () => {
    await material('SDP-EXC', { stock: 100 });
    // Item 10 is rejected on change; item 20 (another material) stays.
    const two = await order([{ material: 'SDP-EXC', quantity: 10 }, { material: MATERIAL, quantity: 5 }]);
    expect(await demandOf('SDP-EXC')).toBe(10);
    await clearMarker('SDP-EXC');
    await changeSalesOrder({
      ...base, orderNumber: two.number, expectedVersion: two.version, requestedDate: FUTURE,
      lines: [{ lineNumber: 20, materialNumber: MATERIAL, plant: PLANT, orderQuantity: 5, quantityUnit: 'UNT', taxCode: 'T10' }],
      rejectLines: [{ lineNumber: 10, reason: 'Z1' }],
    });
    expect(await demandOf('SDP-EXC')).toBe(0);
    expect(await planningFile('SDP-EXC')).toMatchObject({ net_change: true });

    const cancelled = await order([{ material: 'SDP-EXC', quantity: 7 }]);
    expect(await demandOf('SDP-EXC')).toBe(7);
    await clearMarker('SDP-EXC');
    await cancelSalesOrder({ client: tenant.client, changedBy: ACTOR, orderNumber: cancelled.number, expectedVersion: cancelled.version });
    expect(await demandOf('SDP-EXC')).toBe(0);
    expect(await planningFile('SDP-EXC')).toMatchObject({ net_change: true });

    // A returns order is not stock demand.
    const returned = await order([{ material: 'SDP-EXC', quantity: 4 }]);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update sales_order set document_type = 'RE' where client = ${tenant.client} and order_number = ${returned.number}`);
    });
    expect(await demandOf('SDP-EXC')).toBe(0);

    // An order that stands, plus an unrelated reservation: both are requirements, each once.
    const kept = await order([{ material: 'SDP-EXC', quantity: 5 }]);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'PROD_ISSUE_ORDER', 'Component issue for an order', 'ISSUE', 'RESERVATION', ${ACTOR})
        on conflict do nothing`);
      await tx.execute(sql`
        insert into reservation_header (client, reservation_number, movement_type, base_date, created_by)
        values (${tenant.client}, 'SDP-RES1', 'PROD_ISSUE_ORDER', ${FUTURE}, ${ACTOR}) on conflict do nothing`);
      await tx.execute(sql`
        insert into reservation_item (client, reservation_number, item_number, material_number, plant, required_quantity, unit_of_measure, created_by)
        values (${tenant.client}, 'SDP-RES1', 1, 'SDP-EXC', ${PLANT}, 5, 'UNT', ${ACTOR}) on conflict do nothing`);
    });
    const list = await md04('SDP-EXC');
    expect(salesRows(list).map((row) => `${row.documentNumber}=${row.quantity}`)).toEqual([`${kept.number}=5`]);
    expect(list.rows.filter((row) => row.elementType === 'RESERVATION').map((row) => row.quantity)).toEqual([5]);
    expect(list.totalRequirements).toBe(10);
  });

  it('marks both the old and the new material when an undelivered item moves, and a change after a run is not cleared by it', async () => {
    await material('SDP-OLD', { stock: 50 });
    await material('SDP-NEW', { stock: 50 });
    const placed = await order([{ material: 'SDP-OLD', quantity: 20 }]);
    await clearMarker('SDP-OLD');
    await clearMarker('SDP-NEW');
    await changeSalesOrder({
      ...base, orderNumber: placed.number, expectedVersion: placed.version, requestedDate: LATER,
      lines: [{ lineNumber: 10, materialNumber: 'SDP-NEW', plant: PLANT, orderQuantity: 25, quantityUnit: 'UNT', taxCode: 'T10', requestedDeliveryDate: LATER }],
      rejectLines: [],
    });
    expect(await planningFile('SDP-OLD')).toMatchObject({ net_change: true });
    expect(await planningFile('SDP-NEW')).toMatchObject({ net_change: true });
    expect(await demandOf('SDP-OLD')).toBe(0);
    const moved = salesRows(await md04('SDP-NEW'));
    expect(moved.map((row) => `${row.quantity}@${row.date}`)).toEqual([`25@${LATER}`]);

    // The run clears the marker only when the timestamp it read still stands (finishMaterial's guard).
    const read = (await planningFile('SDP-NEW'))!.last_changed_at;
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`select pg_sleep(0.01)`);
    });
    await changeSalesOrder({
      ...base, orderNumber: placed.number, expectedVersion: placed.version + 1, requestedDate: LATER,
      lines: [{ lineNumber: 10, materialNumber: 'SDP-NEW', plant: PLANT, orderQuantity: 26, quantityUnit: 'UNT', taxCode: 'T10', requestedDeliveryDate: LATER }],
      rejectLines: [],
    });
    const cleared = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      update planning_file set net_change = false, reason = 'Planned'
       where client = ${tenant.client} and material_number = 'SDP-NEW' and plant = ${PLANT}
         and net_change = true and last_changed_at = ${read}
      returning material_number
    `) as unknown as Array<unknown>);
    expect(cleared).toHaveLength(0);
    expect(await planningFile('SDP-NEW')).toMatchObject({ net_change: true });
  });

  it('keeps the demand of another tenant out and masks the sales document for a viewer without sales authority', async () => {
    const other = await createTenant('sdp-other');
    try {
      await expect(stockRequirementsList({
        client: other.client, today: today(), selection: { material: 'SDP-SHORT', plant: PLANT },
      })).rejects.toThrow(/does not stand/);
    } finally {
      await destroyTenant(other.client);
    }
    const masked = salesRows(await md04('SDP-SHORT', false));
    expect(masked).toHaveLength(1);
    expect(masked[0]).toMatchObject({ documentNumber: 'Sales order', documentItem: '', drillDown: null, quantity: 150 });
  });
});
