import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  MB1A_SCENARIOS,
  MIGO_ISSUE_SCENARIOS,
  GoodsIssueError,
  postGoodsIssue,
  type PostGoodsIssueInput,
} from '../src/modules/inventory/goods-issue';
import {
  createProductionOrder,
  releaseProductionOrder,
} from '../src/modules/inventory/production-orders';
import { technicallyCompleteProductionOrder } from '../src/modules/production/production-order-change';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * SCR-139 / MIGO 261 — the component issue a production order consumes.
 *
 * One posting engine, two screens: MB1A posts 201 and 551, MIGO posts 261 against a
 * released order's component. Stock falls, inventory is credited, production consumption
 * is debited on a P&L account (no settlement exists to relieve WIP), the order is named
 * on the line and in the journal, and an over-issue is refused naming what remains.
 */
const ACTOR = 'SCR139_MIGO_TEST';
const PLANT = 'QM01';
const COMPANY = '1000';

describe('SCR-139 MIGO 261 goods issue to a production order', () => {
  let fx: TestTenant;
  let client = '';
  let orderNumber = '';

  const input = (overrides: Partial<PostGoodsIssueInput> = {}): PostGoodsIssueInput => ({
    client, changedBy: ACTOR, movementTypeCode: '261',
    postingDate: '2026-10-15', documentDate: '2026-10-15',
    headerText: 'Issue to the order',
    lines: [{
      materialNumber: 'MIGO-RM', plant: PLANT, storageLocation: 'SM01', quantity: 10,
      productionOrderNumber: orderNumber, productionOrderItem: 10,
    }],
    requestKey: `migo-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });

  beforeAll(async () => {
    fx = await createTenant('scr139-migo');
    client = fx.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MIGO-FG', 'Order output', 'FIN', 'PC', ${ACTOR}),
               (${client}, 'MIGO-RM', 'Order component', 'RAW', 'PC', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'MIGO plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} order by company_code limit 1) c
        on conflict (client, plant) do update set company_code = excluded.company_code
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, v.n, ${PLANT}, ${ACTOR}
        from (values ('MIGO-FG'), ('MIGO-RM')) as v(n)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, ${PLANT}, 'SM01', 'MIGO store', true, false, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${client}, 'MIGO-RM', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD', 100, 1000, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${client}, 'MIGO-RM', ${PLANT}, 'SM01', 'UNRESTRICTED', 100, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = 100
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        select ${client}, c.company_code, 2026, 10, 2026, 9, true, ${ACTOR}
        from (select company_code from company_code where client = ${client} order by company_code limit 1) c
        on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
      `);
      // The P&L account the consumption lands on, and its determination.
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
        select ${client}, c.chart_of_accounts, v.n, v.d, v.t,
               v.balance, false, null, false, false, 'GENL', v.kind, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values
          ('510950', 'Production consumption', 'EXPENSE', false, 'PL_STATEMENT'),
          ('120950', 'Component inventory', 'ASSET', true, 'BALANCE_SHEET')
        ) as v(n, d, t, balance, kind)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, c.chart_of_accounts, v.e, 'RAW_INVENTORY', '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values ('PRODUCTION_CONSUMPTION', '510950'), ('INVENTORY', '120950')) as v(e, a)
        on conflict do nothing
      `);
    });
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
      await defineRange(tx, {
        client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL',
        fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
      });
    });
    const order = await createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'MIGO-FG', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: [{ materialNumber: 'MIGO-RM', plant: PLANT, storageLocation: 'SM01', requiredQuantity: 25 }],
    });
    orderNumber = order.orderNumber;
    await releaseProductionOrder({ client, orderNumber, releasedBy: ACTOR });
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
  }, 180_000);

  it('offers 261 on MIGO alone: MB1A keeps its two movements', () => {
    expect(MIGO_ISSUE_SCENARIOS.map((s) => s.code)).toEqual(['261']);
    expect(MB1A_SCENARIOS.map((s) => s.code)).toEqual(['201', '551']);
  });

  it('issues a component against the released order: stock, value, journal and the order reference', async () => {
    const view = await postGoodsIssue(input(), 'MIGO');
    expect(view.lines).toHaveLength(1);
    expect(Number(view.totalValue)).toBe(100);

    const state = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select quantity::text from stock_quantity
            where client = ${client} and material_number = 'MIGO-RM' and plant = ${PLANT}
              and storage_location = 'SM01' and stock_type = 'UNRESTRICTED') as stock,
          (select stock_value::text from material_valuation
            where client = ${client} and material_number = 'MIGO-RM' and valuation_area = ${PLANT}) as valued,
          (select production_order_number from material_document_line
            where client = ${client} and material_document_number = ${view.materialDocumentNumber} and line_number = 1) as ondoc,
          (select production_order_item from material_document_line
            where client = ${client} and material_document_number = ${view.materialDocumentNumber} and line_number = 1) as onitem
      `) as unknown as Array<{ stock: string; valued: string; ondoc: string; onitem: number }>;
      return rows[0];
    });
    expect(Number(state.stock)).toBe(90);
    expect(Number(state.valued)).toBe(900);
    expect(state.ondoc).toBe(orderNumber);
    expect(state.onitem).toBe(10);
  });

  it('debits production consumption and credits inventory, naming the order on the journal line', async () => {
    const view = await postGoodsIssue(input({ lines: [{
      materialNumber: 'MIGO-RM', plant: PLANT, storageLocation: 'SM01', quantity: 5,
      productionOrderNumber: orderNumber, productionOrderItem: 10,
    }] }), 'MIGO');
    const rows = await withTenant(client, async (tx) => {
      const journal = view.journalDocumentNumber!;
      const result = await tx.execute(sql`
        select gl_account, debit_credit, amount_local::text as amount, production_order
        from journal_entry_line
        where client = ${client} and document_number = ${journal}
        order by line_number
      `) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string; production_order: string | null }>;
      return result;
    });
    const debit = rows.find((r) => r.debit_credit === 'S');
    const credit = rows.find((r) => r.debit_credit === 'H');
    expect(debit?.gl_account).toBe('510950');
    expect(credit?.gl_account).toBe('120950');
    expect(Number(debit?.amount)).toBe(50);
    expect(debit?.production_order).toBe(orderNumber);
  });

  it('refuses an over-issue by name, quoting what the component still requires', async () => {
    // 25 required, 15 already issued: ten remain.
    const error = await postGoodsIssue(input({ lines: [{
      materialNumber: 'MIGO-RM', plant: PLANT, storageLocation: 'SM01', quantity: 11,
      productionOrderNumber: orderNumber, productionOrderItem: 10,
    }] }), 'MIGO').catch((e: unknown) => e as GoodsIssueError);
    expect(error.message).toMatch(/still requires 10\.000 PC of MIGO-RM/);
    expect(error.remedy).toMatch(/tolerance master does not stand in canon/);
  });

  it('refuses an order that is not released, and one that does not exist', async () => {
    const order = await createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'MIGO-FG', plant: PLANT, orderQuantity: 5,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: [{ materialNumber: 'MIGO-RM', plant: PLANT, requiredQuantity: 5 }],
    });
    const unreleased = await postGoodsIssue(input({ lines: [{
      materialNumber: 'MIGO-RM', plant: PLANT, storageLocation: 'SM01', quantity: 1,
      productionOrderNumber: order.orderNumber, productionOrderItem: 10,
    }] }), 'MIGO').catch((e: unknown) => e as GoodsIssueError);
    expect(unreleased.message).toMatch(/stands created, and only a released order may be charged/);

    const missing = await postGoodsIssue(input({ lines: [{
      materialNumber: 'MIGO-RM', plant: PLANT, storageLocation: 'SM01', quantity: 1,
      productionOrderNumber: 'PRD9999999', productionOrderItem: 10,
    }] }), 'MIGO').catch((e: unknown) => e as GoodsIssueError);
    expect(missing.message).toMatch(/Production order PRD9999999 does not exist/);
  });

  it('refuses a component item the order does not carry, and a material that is not that item', async () => {
    const wrongItem = await postGoodsIssue(input({ lines: [{
      materialNumber: 'MIGO-RM', plant: PLANT, storageLocation: 'SM01', quantity: 1,
      productionOrderNumber: orderNumber, productionOrderItem: 99,
    }] }), 'MIGO').catch((e: unknown) => e as GoodsIssueError);
    expect(wrongItem.message).toMatch(/carries no component item 99/);

    const wrongMaterial = await postGoodsIssue(input({ lines: [{
      materialNumber: 'MIGO-FG', plant: PLANT, storageLocation: 'SM01', quantity: 1,
      productionOrderNumber: orderNumber, productionOrderItem: 10,
    }] }), 'MIGO').catch((e: unknown) => e as GoodsIssueError);
    expect(wrongMaterial.message).toMatch(/item 10 requires MIGO-RM in plant/);
  });

  it('refuses a 261 line that names no order, and an order on a 201 line', async () => {
    const noOrder = await postGoodsIssue(input({ lines: [{
      materialNumber: 'MIGO-RM', plant: PLANT, quantity: 1,
    }] }), 'MIGO').catch((e: unknown) => e as GoodsIssueError);
    expect(noOrder.message).toMatch(/consumes for a production order, and none was named/);

    const orderOn201 = await postGoodsIssue(input({ movementTypeCode: '201', lines: [{
      materialNumber: 'MIGO-RM', plant: PLANT, quantity: 1, costCenter: '',
      productionOrderNumber: orderNumber,
    }] })).catch((e: unknown) => e as GoodsIssueError);
    expect(orderOn201.message).toMatch(/consumes for no production order/);
  });

  it('refuses 261 posted from the MB1A screen', async () => {
    const error = await postGoodsIssue(input()).catch((e: unknown) => e as GoodsIssueError);
    expect(error.message).toMatch(/Movement 261 is posted from MIGO/);
  });

  it('still issues a component after technical completion and does not change the status', async () => {
    const draft = await createProductionOrder({
      orderType: 'PP01',
      client, createdBy: ACTOR,
      materialNumber: 'MIGO-FG', plant: PLANT, orderQuantity: 2,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: [{ materialNumber: 'MIGO-RM', plant: PLANT, requiredQuantity: 2 }],
    });
    await releaseProductionOrder({ client, orderNumber: draft.orderNumber, releasedBy: ACTOR });
    const [standing] = await withTenant(client, (tx) => tx.execute(sql`
      select version from production_order where client = ${client} and order_number = ${draft.orderNumber}
    `)) as unknown as Array<{ version: number }>;
    await technicallyCompleteProductionOrder({
      client, changedBy: ACTOR, orderNumber: draft.orderNumber, expectedVersion: Number(standing?.version),
      held: ['PROD.ORDER.CHANGE'], confirmed: true,
    });
    const posted = await postGoodsIssue(input({
      requestKey: 'migo-after-teco',
      lines: [{
        materialNumber: 'MIGO-RM', plant: PLANT, storageLocation: 'SM01', quantity: 1,
        productionOrderNumber: draft.orderNumber, productionOrderItem: 10,
      }],
    }), 'MIGO');
    expect(posted.materialDocumentNumber).toBeTruthy();
    const [after] = await withTenant(client, (tx) => tx.execute(sql`
      select status from production_order where client = ${client} and order_number = ${draft.orderNumber}
    `)) as unknown as Array<{ status: string }>;
    expect(after?.status).toBe('TECHNICALLY_COMPLETED');
  });
});
