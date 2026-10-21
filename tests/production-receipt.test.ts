import { sql } from 'drizzle-orm';
import { defineUomConversion } from '../src/modules/inventory/unit-conversion';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  PRODUCTION_RECEIPT_CAPABILITY,
  PRODUCTION_RECEIPT_SCENARIO,
  ProductionReceiptError,
  postProductionReceipt,
  receivedQuantityFor,
} from '../src/modules/inventory/production-receipt';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * SCR-140 / MIGO 101 + R08 — the finished good comes back from the order.
 *
 * The receipt puts stock up, values it at the material's own price, debits inventory and
 * credits production output — never the consumption account — names the order on the line,
 * and refuses an over-receipt quoting what the order still expects.
 */
const ACTOR = 'SCR140_GR_TEST';
const PLANT = 'QG01';
const COMPANY = '1000';

describe('SCR-140 production order goods receipt (MIGO 101)', () => {
  let fx: TestTenant;
  let client = '';
  let orderNumber = '';

  const input = (overrides: Record<string, unknown> = {}) => ({
    client, changedBy: ACTOR, orderNumber,
    postingDate: '2026-10-16', documentDate: '2026-10-16',
    headerText: 'Output of the order',
    lines: [{ storageLocation: 'SG01', quantity: 6 }],
    requestKey: `gr-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });

  beforeAll(async () => {
    fx = await createTenant('scr140-gr');
    client = fx.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
        from (values ('GR-FG', 'Finished good'), ('GR-RM', 'Component')) as v(n, d)
        cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${client}, ${PLANT}, 'Receipt plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${client} order by company_code limit 1) c
        on conflict (client, plant) do update set company_code = excluded.company_code
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        select ${client}, v.n, ${PLANT}, ${ACTOR}
        from (values ('GR-FG'), ('GR-RM')) as v(n)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, ${PLANT}, 'SG01', 'Finished store', true, false, ${ACTOR})
        on conflict do nothing
      `);
      // The finished good is standard-priced at 40 per unit: ten units are worth 400.
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${client}, 'GR-FG', ${PLANT}, 'FINISHED_INVENTORY', 'STANDARD', 40, 40, 1, 'USD', 0, 0, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${client}, 'GR-RM', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD', 100, 1000, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${client}, 'GR-RM', ${PLANT}, 'SG01', 'UNRESTRICTED', 100, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type) do update set quantity = 100
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${client}, ${COMPANY}, 2026, 10, 2026, 9, true, ${ACTOR})
        on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
        select ${client}, c.chart_of_accounts, v.n, v.d, v.t,
               v.balance, false, null, false, false, 'GENL', v.kind, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values
          ('121000', 'Finished goods inventory', 'ASSET', true, 'BALANCE_SHEET'),
          ('122000', 'Component inventory', 'ASSET', true, 'BALANCE_SHEET'),
          ('590000', 'Production output', 'EXPENSE', false, 'PL_STATEMENT'),
          ('510900', 'Production consumption', 'EXPENSE', false, 'PL_STATEMENT')
        ) as v(n, d, t, balance, kind)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${client}, c.chart_of_accounts, v.e, v.vc, '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        cross join (values
          ('INVENTORY', 'FINISHED_INVENTORY', '121000'),
          ('PRODUCTION_OUTPUT', 'FINISHED_INVENTORY', '590000'),
          ('INVENTORY', 'RAW_INVENTORY', '122000'),
          ('PRODUCTION_CONSUMPTION', 'RAW_INVENTORY', '510900')
        ) as v(e, vc, a)
        on conflict do nothing
      `);
    });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: ACTOR });
      await defineRange(tx, {
        client, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL',
        fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
      });
    });
    const order = await createProductionOrder({
      client, createdBy: ACTOR,
      materialNumber: 'GR-FG', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: [{ materialNumber: 'GR-RM', plant: PLANT, storageLocation: 'SG01', requiredQuantity: 20 }],
    });
    orderNumber = order.orderNumber;
    await releaseProductionOrder({ client, orderNumber, releasedBy: ACTOR });
  }, 180_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
  }, 180_000);

  it('names its capability and its movement', () => {
    expect(PRODUCTION_RECEIPT_CAPABILITY).toBe('PROD.ORDER.GR');
    expect(PRODUCTION_RECEIPT_SCENARIO.code).toBe('101');
    expect(PRODUCTION_RECEIPT_SCENARIO.movementType).toBe('PROD_RECEIPT_ORDER');
    expect(PRODUCTION_RECEIPT_SCENARIO.reversalMovementType).toBe('PROD_RECEIPT_ORD_REV');
  });

  it('receives the finished good: stock up, valuation up, value at the material’s price', async () => {
    const view = await postProductionReceipt(input());
    expect(Number(view.totalValue)).toBe(240);
    expect(view.orderNumber).toBe(orderNumber);
    expect(view.receivedAfter).toBe('6.000');

    const state = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select quantity::text from stock_quantity
            where client = ${client} and material_number = 'GR-FG' and plant = ${PLANT}
              and storage_location = 'SG01' and stock_type = 'UNRESTRICTED') as stock,
          (select stock_value::text from material_valuation
            where client = ${client} and material_number = 'GR-FG' and valuation_area = ${PLANT}) as value,
          (select production_order_number from material_document_line
            where client = ${client} and material_document_number = ${view.materialDocumentNumber} and line_number = 1) as ondoc,
          (select line_direction from material_document_line
            where client = ${client} and material_document_number = ${view.materialDocumentNumber} and line_number = 1) as direction
      `) as unknown as Array<{ stock: string; value: string; ondoc: string; direction: string }>;
      return rows[0];
    });
    expect(Number(state.stock)).toBe(6);
    expect(Number(state.value)).toBe(240);
    expect(state.ondoc).toBe(orderNumber);
    expect(state.direction).toBe('RECEIPT');
  });

  it('debits inventory and credits production output — never the consumption account', async () => {
    const view = await postProductionReceipt(input({ lines: [{ storageLocation: 'SG01', quantity: 1 }] }));
    const rows = await withTenant(client, async (tx) => {
      const journal = view.journalDocumentNumber!;
      return await tx.execute(sql`
        select gl_account, debit_credit, amount_local::text as amount, production_order
        from journal_entry_line
        where client = ${client} and document_number = ${journal}
        order by line_number
      `) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string; production_order: string }>;
    });
    const debit = rows.find((r) => r.debit_credit === 'S');
    const credit = rows.find((r) => r.debit_credit === 'H');
    expect(debit?.gl_account).toBe('121000');
    expect(credit?.gl_account).toBe('590000');
    expect(credit?.gl_account).not.toBe('510900');
    expect(Number(debit?.amount)).toBe(40);
    expect(debit?.production_order).toBe(orderNumber);
  });

  it('refuses an over-receipt quoting what the order still expects', async () => {
    // Seven of ten received: three remain.
    const error = await postProductionReceipt(input({ lines: [{ storageLocation: 'SG01', quantity: 4 }] }))
      .catch((e: unknown) => e as ProductionReceiptError);
    expect(error.message).toMatch(/still expects 3\.000 PC of GR-FG/);
    expect(error.remedy).toMatch(/over-receipt tolerance/);
  });

  it('refuses an order that is not released, and one that does not exist', async () => {
    const draft = await createProductionOrder({
      client, createdBy: ACTOR,
      materialNumber: 'GR-FG', plant: PLANT, orderQuantity: 5,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: [{ materialNumber: 'GR-RM', plant: PLANT, requiredQuantity: 5 }],
    });
    const unreleased = await postProductionReceipt(input({ orderNumber: draft.orderNumber }))
      .catch((e: unknown) => e as ProductionReceiptError);
    expect(unreleased.message).toMatch(/stands created, and only a released order receives output/);

    const missing = await postProductionReceipt(input({ orderNumber: 'PRD9999999' }))
      .catch((e: unknown) => e as ProductionReceiptError);
    expect(missing.message).toMatch(/Production order PRD9999999 does not exist/);
  });

  it('refuses a storage location of another plant, and an empty receipt', async () => {
    const wrongLocation = await postProductionReceipt(input({ lines: [{ storageLocation: 'ZZZZ', quantity: 1 }] }))
      .catch((e: unknown) => e as ProductionReceiptError);
    expect(wrongLocation.message).toMatch(/Storage location ZZZZ does not stand in plant QG01/);

    const empty = await postProductionReceipt(input({ lines: [{ storageLocation: 'SG01', quantity: 0 }] }))
      .catch((e: unknown) => e as ProductionReceiptError);
    expect(empty.message).toMatch(/No receipt quantity was entered/);
  });

  it('derives what the order has received from the documents, and never writes the order', async () => {
    expect(await receivedQuantityFor(client, orderNumber)).toBe(7);
    const rows = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from information_schema.columns
      where table_name = 'production_order' and column_name like '%received%'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
  });

  it('replays a request key instead of receiving twice', async () => {
    const key = 'gr-replay-1';
    const first = await postProductionReceipt(input({ lines: [{ storageLocation: 'SG01', quantity: 3 }], requestKey: key }));
    const second = await postProductionReceipt(input({ lines: [{ storageLocation: 'SG01', quantity: 3 }], requestKey: key }));
    expect(second.materialDocumentNumber).toBe(first.materialDocumentNumber);
    expect(second.totalValue).toBe(first.totalValue);
    expect(await receivedQuantityFor(client, orderNumber)).toBe(10);
  });

  it('refuses when production output resolves to the inventory account', async () => {
    const draft = await createProductionOrder({
      client, createdBy: ACTOR,
      materialNumber: 'GR-FG', plant: PLANT, orderQuantity: 1,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: [{ materialNumber: 'GR-RM', plant: PLANT, requiredQuantity: 1 }],
    });
    await releaseProductionOrder({ client, orderNumber: draft.orderNumber, releasedBy: ACTOR });
    await withTenant(client, (tx) => tx.execute(sql`
      update account_determination set gl_account = '121000'
      where client = ${client} and event = 'PRODUCTION_OUTPUT' and valuation_class = 'FINISHED_INVENTORY'
    `));
    // The order already received ten of ten, so a second order is needed to reach the check.
    const error = await postProductionReceipt({
      client, changedBy: ACTOR, orderNumber: draft.orderNumber,
      postingDate: '2026-10-16', documentDate: '2026-10-16',
      lines: [{ storageLocation: 'SG01', quantity: 1 }],
      requestKey: 'gr-same-account',
    }).catch((e: unknown) => e as ProductionReceiptError);
    expect(error.message).toMatch(/would net to nothing/);
    await withTenant(client, (tx) => tx.execute(sql`
      update account_determination set gl_account = '590000'
      where client = ${client} and event = 'PRODUCTION_OUTPUT' and valuation_class = 'FINISHED_INVENTORY'
    `));
  });

  it('converts a receipt entered in an alternative unit into the order\'s base quantity', async () => {
    await defineUomConversion({
      client, changedBy: ACTOR, materialNumber: 'GR-FG',
      alternativeUnit: 'BOX', numerator: 2, denominator: 1,
    });
    const draft = await createProductionOrder({
      client, createdBy: ACTOR,
      materialNumber: 'GR-FG', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: [{ materialNumber: 'GR-RM', plant: PLANT, storageLocation: 'SG01', requiredQuantity: 20 }],
    });
    await releaseProductionOrder({ client, orderNumber: draft.orderNumber, releasedBy: ACTOR });

    // Three boxes are six pieces: the order expects ten, so six is a receipt it can take.
    const receipt = await postProductionReceipt({
      client, changedBy: ACTOR, orderNumber: draft.orderNumber,
      postingDate: '2026-10-16', documentDate: '2026-10-16',
      lines: [{ storageLocation: 'SG01', quantity: 3, entryQuantity: 3, entryUnit: 'BOX' }],
      requestKey: 'gr-alt-unit',
    });
    expect(receipt.lines[0].quantity).toBe('6.000');
    expect(receipt.lines[0].unit).toBe('PC');
  });

  it('refuses a receipt in a unit with no conversion, naming the unit', async () => {
    const draft = await createProductionOrder({
      client, createdBy: ACTOR,
      materialNumber: 'GR-FG', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-01', scheduledFinish: '2026-10-20',
      components: [{ materialNumber: 'GR-RM', plant: PLANT, storageLocation: 'SG01', requiredQuantity: 20 }],
    });
    await releaseProductionOrder({ client, orderNumber: draft.orderNumber, releasedBy: ACTOR });
    const error = await postProductionReceipt({
      client, changedBy: ACTOR, orderNumber: draft.orderNumber,
      postingDate: '2026-10-16', documentDate: '2026-10-16',
      lines: [{ storageLocation: 'SG01', quantity: 1, entryQuantity: 1, entryUnit: 'GAL' }],
      requestKey: 'gr-no-unit',
    }).catch((e: unknown) => e as ProductionReceiptError);
    expect(error.message).toMatch(/carries no conversion from GAL to its base unit PC/);
    expect(error.remedy).toMatch(/INV\.STOCK\.UOM/);
  });
});
