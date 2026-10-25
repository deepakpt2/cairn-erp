import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveMaterialView } from '../src/modules/inventory/materials';
import { postGoodsIssue } from '../src/modules/inventory/goods-issue';
import { postProductionReceipt } from '../src/modules/inventory/production-receipt';
import { reverseMaterialDocument } from '../src/modules/inventory/material-document-reversal';
import { createProductionOrder, releaseProductionOrder } from '../src/modules/inventory/production-orders';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../src/modules/production/material-bom';
import { saveOrderTypeParameter } from '../src/modules/production/order-type-parameters';
import { checkProductionVersion, createProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { insertOrderOperationSnapshot, resolveOrderOperationSnapshot } from '../src/modules/production/order-operation-snapshot';
import { cancelConfirmation } from '../src/modules/production/confirmation-cancel';
import { enterTimeTicket, loadTimeTicket, previewTimeTicket, rows } from '../src/modules/production/time-ticket';
import { movementConfiguration, movementRequestKey, postedMovements } from '../src/modules/production/confirmation-movements';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * CO11N and the goods movements a confirmation causes.
 *
 * The rule under test is narrow. A confirmation withdraws the share of a backflush-marked
 * component its own yield represents, receives the finished good only on a final confirmation
 * of a marked material, and posts both through the goods-movement services inside the
 * confirmation's own transaction. Nothing counts an issue: what is open is read from the
 * material documents that stand, so a posting made on MIGO is seen at once and so is a
 * reversal.
 *
 * Every order is ten units; the component requirement is twenty, so one unit of yield owes
 * two units of component. The component starts with 100 units of stock.
 */
const ACTOR = 'CO11N_MOVEMENT';
const PLANT = 'QG01';
const COMPANY = '1000';
const LOCATION = 'SG01';

describe('CO11N confirmation goods movement', () => {
  let tenant: TestTenant;
  let client = '';
  let orderA = '';
  let orderB = '';
  let orderC = '';
  let orderD = '';
  let componentItem = 0;
  let key = 0;
  const nextKey = () => `co11n-mv-${++key}`;

  async function extend(materialNumber: string, make: boolean) {
    await saveMaterialView({
      client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO11N movement', view: 'BASIC', description: materialNumber, materialType: make ? 'FIN' : 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO11N movement', view: 'PURCHASING', plant: PLANT,
      purchasingGroup: '001', orderUnit: 'PC',
      overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client, materialNumber, changedBy: ACTOR, expectedVersion: 1,
      reason: 'CO11N movement', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: make ? 'MAKE' : 'BUY',
      lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
      safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
    });
  }

  /** The marks are maintained on the material, on the view the screen offers. */
  async function mark(materialNumber: string, flags: { backflush?: boolean; automaticGoodsReceipt?: boolean }, make: boolean) {
    await saveMaterialView({
      client, materialNumber, changedBy: ACTOR, expectedVersion: 2,
      reason: 'A confirmation is to move this material', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: make ? 'MAKE' : 'BUY',
      lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
      safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
      backflush: flags.backflush === true,
      automaticGoodsReceipt: flags.automaticGoodsReceipt === true,
    });
  }

  async function quantityOf(materialNumber: string): Promise<number> {
    return withTenant(client, async (tx) => {
      const [row] = await rows(tx, sql`
        select quantity::text as quantity from stock_quantity
         where client = ${client} and material_number = ${materialNumber} and plant = ${PLANT}
           and storage_location = ${LOCATION} and stock_type = 'UNRESTRICTED'
      `);
      return Number(row?.quantity ?? '0');
    });
  }
  const componentStock = () => quantityOf('MV-RM');
  const finishedStock = () => quantityOf('MV-FG');

  async function confirmationsOn(orderNumber: string): Promise<number> {
    return withTenant(client, async (tx) => {
      const [row] = await rows(tx, sql`
        select count(*)::text as n from production_confirmation
         where client = ${client} and order_number = ${orderNumber}
      `);
      return Number(row?.n ?? '0');
    });
  }

  async function documentsOn(orderNumber: string): Promise<Array<Record<string, unknown>>> {
    return withTenant(client, async (tx) => rows(tx, sql`
      select distinct d.request_key as key, d.material_document_number as number
        from material_document_line l
        join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
       where l.client = ${client} and l.production_order_number = ${orderNumber}
       order by d.material_document_number
    `));
  }

  /** A second backflush-marked component, with the valuation and the stock its issue needs. */
  async function addRaw(materialNumber: string, stock: number) {
    await extend(materialNumber, false);
    await mark(materialNumber, { backflush: true }, false);
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${client}, ${materialNumber}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD',
                ${stock}, ${stock * 10}, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${client}, ${materialNumber}, ${PLANT}, ${LOCATION}, 'UNRESTRICTED', ${stock}, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
          do update set quantity = ${stock}
      `);
    });
  }

  /** A movement carries a journal, so a rolled-back confirmation must not leave one behind. */
  async function journals(): Promise<number> {
    return withTenant(client, async (tx) => {
      const [row] = await rows(tx, sql`select count(*)::text as n from journal_entry where client = ${client}`);
      return Number(row?.n ?? '0');
    });
  }

  async function orderVersion(orderNumber: string): Promise<number> {
    return withTenant(client, async (tx) => {
      const [row] = await rows(tx, sql`
        select version::text as version from production_order where client = ${client} and order_number = ${orderNumber}
      `);
      return Number(row?.version ?? '0');
    });
  }

  async function newOrder(
    requestKey: string,
    shape: {
      orderQuantity?: number;
      components?: Array<{ materialNumber: string; requiredQuantity: number }>;
    } = {},
  ): Promise<string> {
    const order = await createProductionOrder({
      orderType: 'PP01', client, createdBy: ACTOR,
      materialNumber: 'MV-FG', plant: PLANT, orderQuantity: shape.orderQuantity ?? 10,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey,
      components: (shape.components ?? [{ materialNumber: 'MV-RM', requiredQuantity: 20 }])
        .map((component) => ({ ...component, plant: PLANT, storageLocation: LOCATION })),
    });
    await withTenant(client, async (tx) => {
      const copied = await resolveOrderOperationSnapshot(tx, {
        client, plant: PLANT, finishDate: '2026-10-25',
        taskListType: 'N', routingGroup: '50000091', groupCounter: '01', productionVersion: '0001',
      });
      await insertOrderOperationSnapshot(tx, { client, orderNumber: order.orderNumber, createdBy: ACTOR, operations: copied.operations });
    });
    await releaseProductionOrder({ client, orderNumber: order.orderNumber, releasedBy: ACTOR });
    return order.orderNumber;
  }

  const ticket = (orderNumber: string, expectedVersion: number, extra: Record<string, unknown> = {}) => ({
    requestedBy: ACTOR, requestKey: nextKey(), orderNumber, operationNumber: '0010',
    confirmationType: 'PARTIAL', yieldQuantity: '4', postingDate: '2026-10-24',
    // The operation carries a required activity: a ticket states its own hours, because the
    // standard value is not substituted into a confirmation.
    activities: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    expectedVersion, ...extra,
  });

  /** A confirmation at the version the order carries now, which is what the screen sends. */
  async function save(orderNumber: string, extra: Record<string, unknown> = {}) {
    return enterTimeTicket(client, ticket(orderNumber, await orderVersion(orderNumber), extra));
  }
  async function check(orderNumber: string, extra: Record<string, unknown> = {}) {
    return previewTimeTicket(client, ticket(orderNumber, await orderVersion(orderNumber), extra));
  }
  async function issueManually(orderNumber: string, quantity: number) {
    return postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: '2026-10-24', documentDate: '2026-10-24',
      headerText: 'Manual component issue', requestKey: nextKey(),
      lines: [{ materialNumber: 'MV-RM', plant: PLANT, storageLocation: LOCATION, quantity, productionOrderNumber: orderNumber, productionOrderItem: componentItem }],
    }, 'MIGO');
  }

  beforeAll(async () => {
    tenant = await createTenant('co11n-movement');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PRODCONF', subObject: '*', prefix: 'CNF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: ACTOR });
      await defineRange(tx, {
        client, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL',
        fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into production_order_type (client, order_type, description, order_category, created_by)
        values (${client}, 'PP01', 'Standard production', '10', ${ACTOR})
        on conflict (client, order_type) do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, default_storage_location, created_by)
        values (${client}, ${PLANT}, 'Movement plant', ${COMPANY}, 'KW', ${LOCATION}, 'SYSTEM')
        on conflict (client, plant) do update set company_code = excluded.company_code, default_storage_location = excluded.default_storage_location
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${client}, ${PLANT}, ${LOCATION}, 'Store', true, false, ${ACTOR})
        on conflict do nothing
      `);
    });
    await saveOrderTypeParameter({
      client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      taskListType: '', productionVersionSelection: '0', version: 0, reason: 'Movement test',
    });
    await extend('MV-FG', true);
    await extend('MV-RM', false);
    // Valuation, stock, and the period are maintained after the material exists: their
    // foreign keys are the material itself.
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${client}, 'MV-FG', ${PLANT}, 'FINISHED_INVENTORY', 'STANDARD', 40, 40, 1, 'USD', 0, 0, ${ACTOR}),
               (${client}, 'MV-RM', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD', 100, 1000, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${client}, 'MV-RM', ${PLANT}, ${LOCATION}, 'UNRESTRICTED', 100, ${ACTOR})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
          do update set quantity = 100
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${client}, ${COMPANY}, 2026, 10, 2026, 9, true, ${ACTOR})
        on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10, allow_backposting = true
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
    await saveBomUsage({
      client, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    });
    await saveBomItemCategory({
      client, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+',
    });
    await createMaterialBom({
      client, changedBy: ACTOR, materialNumber: 'MV-FG', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'MV-RM', quantity: '2', unit: 'PC' }],
    });
    await saveRoutingTaskListType({ client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client, changedBy: ACTOR, usage: '1', description: 'Production' });
    await saveRoutingControlKey({ client, changedBy: ACTOR, controlKey: 'PP01', description: 'Confirm', confirmation: 'X' });
    await saveRoutingStandardValueKey({
      client, changedBy: ACTOR, standardValueKey: 'SV01', description: 'Labor',
      parameters: [{ parameter: 'LABOR', description: 'Labor', unit: 'HR', required: 'X' }],
    });
    await saveWorkCenterCategory({ client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    await createWorkCenter({ client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC91', category: 'MACH', description: 'Assembly' });
    await createRouting({
      client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000091', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
      assignments: [{ materialNumber: 'MV-FG' }],
      operations: [{
        operationNumber: '0010', shortText: 'Build', workCenter: 'WC91', controlKey: 'PP01', standardValueKey: 'SV01',
        values: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
      }],
    });
    await createProductionVersion({
      client, changedBy: ACTOR, materialNumber: 'MV-FG', plant: PLANT, productionVersion: '0001',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000091', groupCounter: '01',
    });
    await checkProductionVersion(client, 'MV-FG', PLANT, '0001', ACTOR);
    orderA = await newOrder('co11n-mv-order-a');
    orderB = await newOrder('co11n-mv-order-b');
    orderC = await newOrder('co11n-mv-order-c');
    orderD = await newOrder('co11n-mv-order-d');
    const [component] = await withTenant(client, (tx) => rows(tx, sql`
      select item_number from production_order_component where client = ${client} and order_number = ${orderA} order by item_number limit 1
    `));
    componentItem = Number(component?.item_number ?? 0);
    expect(componentItem).toBeGreaterThan(0);
  }, 300_000);

  afterAll(async () => {
    if (client) await destroyTenant(client);
    await closeDb();
  }, 180_000);

  it('derives one distinct request key per movement, never one key for both documents', () => {
    const issue = movementRequestKey('co11n-abc', 'ISSUE');
    const receipt = movementRequestKey('co11n-abc', 'RECEIPT');
    expect(issue).toBe('CO11N-ABC-BF');
    expect(receipt).toBe('CO11N-ABC-GR');
    expect(issue).not.toBe(receipt);
    expect(movementRequestKey('co11n-abc', 'ISSUE')).toBe(issue);
    expect(movementRequestKey('', 'ISSUE')).toBeNull();
    // A request key is capped at 64 characters: a long one is shortened, never cut, so two
    // different confirmations cannot land on the same document.
    for (const kind of ['ISSUE', 'RECEIPT'] as const) {
      const derived = movementRequestKey(`co11n-${'x'.repeat(70)}`, kind);
      expect(derived).not.toBeNull();
      expect((derived ?? '').length).toBeLessThanOrEqual(64);
    }
    expect(movementRequestKey('y'.repeat(64), 'ISSUE')).not.toBe(movementRequestKey(`${'y'.repeat(63)}z`, 'ISSUE'));
  });

  it('posts no movement while no material is marked, and says so before anything is entered', async () => {
    const loaded = await loadTimeTicket(client, { orderNumber: orderA, operationNumber: '0010', postingDate: '2026-10-24' });
    expect(loaded.movementConfig).toMatchObject({ componentLines: 1, markedLines: 0, automaticGoodsReceipt: false });
    expect(loaded.movementConfig.note).toMatch(/No component line is marked for backflush/);

    const preview = await check(orderA);
    expect(preview.movements).toEqual([]);
    expect(preview.movementsPosted).toBe(0);
    expect(preview.movementNote).toMatch(/no material on this order is marked for one/);

    const saved = await save(orderA);
    expect(saved.movementsPosted).toBe(0);
    expect(saved.movementNote).toBe('No goods movement was caused by this confirmation.');
    expect(await documentsOn(orderA)).toEqual([]);
    expect(await componentStock()).toBe(100);
  });

  it('draws the proportion the confirmation earned and leaves the order requirement alone', async () => {
    await mark('MV-RM', { backflush: true }, false);
    const loaded = await loadTimeTicket(client, { orderNumber: orderA, operationNumber: '0010', postingDate: '2026-10-24' });
    expect(loaded.movementConfig.markedLines).toBe(1);

    // Four of ten units of an order whose component needs twenty owes eight. The check states
    // it and writes nothing.
    const preview = await check(orderA, { yieldQuantity: '4' });
    expect(preview.movements).toHaveLength(1);
    expect(preview.movements[0]).toMatchObject({
      kind: 'ISSUE', movementCode: '261', materialNumber: 'MV-RM', plant: PLANT,
      storageLocation: LOCATION, quantity: '8.000', unit: 'PC', itemNumber: componentItem,
      requiredQuantity: '20.000', issuedQuantity: '0.000', openQuantity: '20.000',
      materialDocumentNumber: null, posted: false, standing: false,
    });
    expect(await componentStock()).toBe(100);
    expect(await confirmationsOn(orderA)).toBe(1);

    const saved = await save(orderA);
    expect(saved.movementsPosted).toBe(1);
    expect(saved.movements[0]).toMatchObject({ posted: true, standing: true, materialDocumentNumber: expect.any(String) });
    expect(saved.movementNote).toMatch(/material document .* was posted with this confirmation/);
    expect(await componentStock()).toBe(92);
    // The order's own requirement is untouched: the documents are the record of an issue.
    const [component] = await withTenant(client, (tx) => rows(tx, sql`
      select required_quantity::text as required from production_order_component
       where client = ${client} and order_number = ${orderA}
    `));
    expect(component?.required).toBe('20.000');
  });

  it('proposes only what stands open, seeing a MIGO posting made beside it', async () => {
    // Eight of the twenty are confirmed away. A manual 261 for three is seen by the next
    // confirmation, because the open amount is read from the documents that stand and never
    // from a counter this screen keeps.
    await issueManually(orderA, 11);
    expect(await componentStock()).toBe(81);

    // One more unit of yield would owe two, but only one is open on the component. The
    // proposal is capped by the open amount, so an automatic issue never over-issues.
    const capped = await check(orderA, { yieldQuantity: '1' });
    expect(capped.movements[0]).toMatchObject({ quantity: '1.000', issuedQuantity: '19.000', openQuantity: '1.000' });
    const posted = await save(orderA, { yieldQuantity: '1' });
    expect(posted.movements[0]?.quantity).toBe('1.000');
    expect(await componentStock()).toBe(80);
    expect(await documentsOn(orderA)).toHaveLength(3);
  });

  it('names what it will not move, and why, instead of inventing a quantity', async () => {
    // A confirmation of no yield owes nothing. The reason is stated; no quantity is invented
    // to make a movement appear.
    const zero = await check(orderB, { yieldQuantity: '0' });
    expect(zero.movements).toEqual([]);
    expect(zero.movementPlan?.markedComponents).toBe(1);
    expect(zero.movementPlan?.skipped).toHaveLength(1);
    expect(zero.movementPlan?.skipped[0]?.reason).toMatch(/yields nothing/);
    expect(await confirmationsOn(orderB)).toBe(0);

    // Order A is fully issued for its requirement. Its last confirmation still stands, and it
    // causes no movement: the requirement on the order is untouched at twenty.
    const done = await save(orderA, { yieldQuantity: '1' });
    expect(done.movementsPosted).toBe(0);
    expect(done.movementPlan).toBeNull();
    expect(done.movementNote).toBe('No goods movement was caused by this confirmation.');
    expect(await componentStock()).toBe(80);
    const owed = await check(orderA, { yieldQuantity: '0' });
    expect(owed.movementPlan?.skipped[0]?.reason).toMatch(/already stands issued/);
  });

  it('replays its request to the documents it already caused', async () => {
    const requestKey = nextKey();
    const before = await componentStock();
    const first = await save(orderB, { requestKey });
    expect(first.movementsPosted).toBe(1);
    const document = first.movements[0]?.materialDocumentNumber;
    expect(await componentStock()).toBe(before - 8);

    const again = await save(orderB, { requestKey });
    expect(again.replayed).toBe(true);
    expect(again.confirmationNumber).toBe(first.confirmationNumber);
    expect(again.movements.map((row) => row.materialDocumentNumber)).toEqual([document]);
    expect(again.movementNote).toMatch(/was posted with this confirmation/);
    expect(await componentStock()).toBe(before - 8);
    expect(await confirmationsOn(orderB)).toBe(1);
    expect(await documentsOn(orderB)).toHaveLength(1);

    // The same request with different quantities is refused, and the posted document is untouched.
    await expect(save(orderB, { requestKey, yieldQuantity: '5' })).rejects.toThrow(/already saved with different quantities/);
    expect(await componentStock()).toBe(before - 8);
    expect(await documentsOn(orderB)).toHaveLength(1);
  });

  it('refuses a stale record version before any movement is posted', async () => {
    const before = await componentStock();
    const current = await orderVersion(orderB);
    await expect(enterTimeTicket(client, ticket(orderB, current - 1, { yieldQuantity: '1' })))
      .rejects.toThrow(/changed|version/i);
    expect(await componentStock()).toBe(before);
    expect(await documentsOn(orderB)).toHaveLength(1);
  });

  it('receives the finished good on a final confirmation only, beside its issue', async () => {
    await mark('MV-FG', { backflush: true, automaticGoodsReceipt: true }, true);

    // A partial never receives, however the mark stands.
    const before = await componentStock();
    const preview = await check(orderC, { yieldQuantity: '4' });
    expect(preview.movementPlan?.automaticGoodsReceipt).toBe(true);
    expect(preview.movements.map((row) => row.kind)).toEqual(['ISSUE']);
    const previewReceiptLocation = preview.movements.find((row) => row.kind === 'RECEIPT')?.storageLocation ?? null;

    const partial = await save(orderC, { yieldQuantity: '4' });
    expect(partial.movements.map((row) => row.kind)).toEqual(['ISSUE']);
    expect(partial.movementsPosted).toBe(1);
    expect(await finishedStock()).toBe(0);

    // A final receives its own yield and withdraws its own proportion in one save, and the two
    // documents are distinct.
    const final = await save(orderC, { yieldQuantity: '6', confirmationType: 'FINAL', confirmFinal: true });
    expect(final.movements.map((row) => row.kind).sort()).toEqual(['ISSUE', 'RECEIPT']);
    expect(final.movementsPosted).toBe(2);
    const receipt = final.movements.find((row) => row.kind === 'RECEIPT')!;
    const issue = final.movements.find((row) => row.kind === 'ISSUE')!;
    expect(receipt.movementCode).toBe('101');
    expect(receipt.quantity).toBe('6.000');
    // The plan invents no location; the document names the one the receipt service chose,
    // which is the plant default a manual posting on MIGO would have received.
    expect(previewReceiptLocation).toBeNull();
    expect(receipt.storageLocation).toBe(LOCATION);
    expect(issue.movementCode).toBe('261');
    expect(issue.quantity).toBe('12.000');
    expect(receipt.materialDocumentNumber).not.toBeNull();
    expect(receipt.materialDocumentNumber).not.toBe(issue.materialDocumentNumber);
    expect(await finishedStock()).toBe(6);
    expect(await componentStock()).toBe(before - 8 - 12);
    expect(final.movementNote).toMatch(/material document/);
    // Three documents stand on this order: the partial's issue, the final's issue, and the
    // final's receipt. A confirmation never overwrites the document another one caused.
    expect(await documentsOn(orderC)).toHaveLength(3);
  });

  it('lets the receipt service refuse an over-receipt, and the confirmation falls with it', async () => {
    // Eight units were received against this order by hand, so the order still expects two. A
    // final confirmation of six is refused by the receipt service, and the backflush it also
    // owed is gone with it: both were one unit of work.
    await postProductionReceipt({
      client, changedBy: ACTOR, orderNumber: orderD, postingDate: '2026-10-24', documentDate: '2026-10-24',
      headerText: 'Manual receipt', requestKey: nextKey(),
      lines: [{ storageLocation: LOCATION, quantity: 8 }],
    });
    expect(await confirmationsOn(orderD)).toBe(0);
    const documents = await documentsOn(orderD);
    expect(documents).toHaveLength(1);
    const stock = await componentStock();
    const finished = await finishedStock();
    // The manual receipt left a journal behind, which is what the count below is a witness of:
    // a refused confirmation had a journal of its own to lose, and lost it.
    const written = await journals();
    expect(written).toBeGreaterThan(0);

    await expect(save(orderD, { yieldQuantity: '6', confirmationType: 'FINAL', confirmFinal: true }))
      .rejects.toThrow(/expects 2|still expects/i);

    expect(await confirmationsOn(orderD)).toBe(0);
    expect(await componentStock()).toBe(stock);
    expect(await finishedStock()).toBe(finished);
    expect(await journals()).toBe(written);
    // No document was left behind by the half-posted confirmation.
    expect(await documentsOn(orderD)).toEqual(documents);
  });

  it('applies the posting period the movement it causes is subject to', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update material_period_control set current_period = 12, previous_period = 11, allow_backposting = false
         where client = ${client} and company_code = ${COMPANY}
      `);
    });
    const confirmations = await confirmationsOn(orderB);
    const stock = await componentStock();
    await expect(save(orderB, { yieldQuantity: '2' })).rejects.toThrow(/period/i);
    expect(await confirmationsOn(orderB)).toBe(confirmations);
    expect(await componentStock()).toBe(stock);

    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update material_period_control set current_period = 10, previous_period = 9, allow_backposting = true
         where client = ${client} and company_code = ${COMPANY}
      `);
    });
    const reopened = await save(orderB, { yieldQuantity: '2' });
    expect(reopened.confirmationNumber).toBeTruthy();
  });

  it('refuses a cancellation while the document it caused still stands, and allows it after a reversal', async () => {
    const [stored] = await withTenant(client, async (tx) => rows(tx, sql`
      select c.confirmation_number, c.request_key from production_confirmation c
       where c.client = ${client} and c.order_number = ${orderB} and c.confirmation_level = 'OPERATION'
       order by c.confirmation_number limit 1
    `));
    const confirmationNumber = String(stored!.confirmation_number);
    const issueKey = await movementRequestKey(String(stored!.request_key), 'ISSUE');
    const [document] = await withTenant(client, async (tx) => rows(tx, sql`
      select material_document_number as number, document_year::text as year from material_document
       where client = ${client} and request_key = ${issueKey}
    `));
    expect(document).toBeTruthy();
    const documentNumber = String(document!.number);

    await expect(cancelConfirmation(client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber, confirmed: true,
      reason: 'Wrong quantity', capabilities: ['PROD.CONFIRM.CANCEL'],
    })).rejects.toThrow(new RegExp(`posted material document ${documentNumber}`));

    // The refusal came before anything was written: no cancellation row stands, and the
    // movement is untouched.
    const [rows1] = await withTenant(client, async (tx) => rows(tx, sql`
      select count(*)::text as n from production_confirmation_cancellation where client = ${client} and confirmation_number = ${confirmationNumber}
    `));
    expect(Number(rows1!.n)).toBe(0);
    const before = await componentStock();

    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: documentNumber, fiscalYear: Number(document!.year),
      postingDate: '2026-10-24', documentDate: '2026-10-24', requestKey: nextKey(),
    });
    // The reversal puts the requirement back in force: the open amount is read from documents,
    // not from a counter this screen keeps.
    expect(await componentStock()).toBe(before + 8);
    // The eight the confirmation caused are open again; the four another confirmation still
    // stands issued are not. Two units of yield therefore owe four of the component.
    const afterReversal = await check(orderB, { yieldQuantity: '2' });
    expect(afterReversal.movements[0]).toMatchObject({
      issuedQuantity: '4.000', openQuantity: '16.000', quantity: '4.000',
    });

    const cancellation = await cancelConfirmation(client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber, confirmed: true,
      reason: 'Wrong quantity', capabilities: ['PROD.CONFIRM.CANCEL'],
    });
    expect(cancellation.cancellationNumber).toBeTruthy();
    // The original confirmation stands as it was posted, and its reversed document is not undone.
    const [original] = await withTenant(client, async (tx) => rows(tx, sql`
      select yield_quantity::text as yield from production_confirmation
       where client = ${client} and confirmation_number = ${confirmationNumber}
    `));
    expect(original?.yield).toBe('4.000');
    const [status] = await withTenant(client, async (tx) => rows(tx, sql`
      select status from material_document where client = ${client} and material_document_number = ${documentNumber}
    `));
    expect(String(status!.status)).not.toBe('POSTED');
    const movement = await withTenant(client, (tx) => postedMovements(tx, client, String(stored!.request_key)));
    expect(movement).toHaveLength(1);
    expect(movement[0]).toMatchObject({ kind: 'ISSUE', posted: true, standing: false });
  });

  it('sees no movement and no mark of another tenant', async () => {
    const other = await createTenant('co11n-other');
    try {
      const inside = await withTenant(client, async (tx) => ({
        documents: await postedMovements(tx, other.client, 'CO11N-MV-1-BF'),
        config: await movementConfiguration(tx, other.client, { orderNumber: orderA, materialNumber: 'MV-FG', plant: PLANT }),
      }));
      expect(inside.documents).toEqual([]);
      expect(inside.config.componentLines).toBe(0);
      expect(inside.config.markedLines).toBe(0);
      const foreign = await withTenant(other.client, async (tx) => rows(tx, sql`
        select count(*)::text as n from material_plant where client = ${other.client} and backflush
      `));
      expect(Number(foreign[0]!.n)).toBe(0);
      // The other tenant cannot confirm this tenant's order at all.
      await expect(enterTimeTicket(other.client, ticket(orderA, 1))
        ).rejects.toThrow(/does not stand|not stand|does not exist|order/i);
    } finally {
      await destroyTenant(other.client);
    }
  });

  it('draws a share that does not divide at the scale the document keeps', async () => {
    // Ten of the component are required for an order of seven units, so a yield of three owes
    // three-sevenths: 4.285714, which the screen and the document both state as 4.285. Nothing
    // is rounded up, because a rounded-up withdrawal is a component the order never needed.
    const orderE = await newOrder(nextKey(), {
      orderQuantity: 7, components: [{ materialNumber: 'MV-RM', requiredQuantity: 10 }],
    });
    const before = await componentStock();

    const planned = await check(orderE, { yieldQuantity: '3' });
    expect(planned.movementPlan?.markedComponents).toBe(1);
    expect(planned.movements[0]).toMatchObject({
      quantity: '4.285', unit: 'PC', requiredQuantity: '10.000', openQuantity: '10.000',
    });

    // A quantity the unit cannot hold is refused rather than carried into a document.
    await expect(check(orderE, { yieldQuantity: '1.0005' })).rejects.toThrow(/decimal places/i);
    // A negative yield is refused before anything is read, so nothing can be moved by it.
    const owed = await confirmationsOn(orderE);
    await expect(save(orderE, { yieldQuantity: '-1' })).rejects.toThrow(/negative|not a number/i);
    expect(await confirmationsOn(orderE)).toBe(owed);
    expect(await componentStock()).toBe(before);

    const saved = await save(orderE, { yieldQuantity: '3' });
    expect(saved.movementsPosted).toBe(1);
    const issueKey = await movementRequestKey(saved.requestKey, 'ISSUE');
    const [line] = await withTenant(client, async (tx) => rows(tx, sql`
      select l.base_quantity::text as base, l.base_unit, l.entry_unit, l.entry_quantity::text as entry,
             l.movement_type, l.unit_price::text as price, l.value::text as value, l.production_order_item
        from material_document d
        join material_document_line l on l.client = d.client and l.material_document_number = d.material_document_number
       where d.client = ${client} and d.request_key = ${issueKey}
    `));
    expect(line).toBeTruthy();
    expect(line!.base).toBe('4.285');
    expect(line!.entry).toBe('4.285');
    expect(String(line!.base_unit)).toBe('PC');
    expect(String(line!.entry_unit)).toBe('PC');
    // The document stores the movement's own code; the screen states its external movement number.
    expect(String(line!.movement_type)).toBe('PROD_ISSUE_ORDER');
    expect(String(line!.movement_type)).not.toBe('101');
    expect(saved.movements[0]).toMatchObject({ movementCode: '261', posted: true, standing: true });
    // Valuation is the movement service's own work: it prices the withdrawal at the material's
    // own price, which this fixture sets at ten. The confirmation neither sets nor overrides it.
    expect(Number(line!.price)).toBe(10);
    expect(Number(line!.value)).toBeGreaterThan(0);

    // The order's own requirement is not rewritten by what a confirmation drew.
    const [component] = await withTenant(client, async (tx) => rows(tx, sql`
      select required_quantity::text as required, unit_of_measure from production_order_component
       where client = ${client} and order_number = ${orderE} and material_number = 'MV-RM'
    `));
    expect(Number(component!.required)).toBe(10);
    expect(String(component!.unit_of_measure)).toBe('PC');
    expect(await componentStock()).toBe(before - 4.285);
  });

  it('turns two postings of one request key into one confirmation and one document', async () => {
    // Two browsers, one key, at the same moment. The request key is the guard, so one of them
    // writes the confirmation and its withdrawal and the other is told it had been saved.
    const orderF = await newOrder(nextKey());
    const shared = nextKey();
    const version = await orderVersion(orderF);
    const before = await componentStock();

    const both = await Promise.all([
      enterTimeTicket(client, ticket(orderF, version, { requestKey: shared })),
      enterTimeTicket(client, ticket(orderF, version, { requestKey: shared })),
    ]);
    expect(both.filter((result) => result.replayed)).toHaveLength(1);
    // Both views show the one withdrawal that stands: the replay reports the document the
    // request caused, it does not cause another one.
    // Both browsers are shown the one confirmation; neither is told it wrote a second.
    expect(new Set(both.map((result) => result.confirmationNumber))).toHaveLength(1);
    expect(await confirmationsOn(orderF)).toBe(1);
    expect(await documentsOn(orderF)).toHaveLength(1);
    // Eight of the component, once. A second withdrawal of the same eight is the failure this
    // key exists to prevent.
    expect(await componentStock()).toBe(before - 8);
  });

  it('will not let two confirmations at once draw more than the order still needs', async () => {
    // Twenty are required. Four were drawn by hand, so sixteen remain, and the two confirmations
    // of six and four units owe their proportions: twelve and eight. That is twenty, four more
    // than the order still needs, so whichever confirmation is posted second is stopped at what
    // remains open, which it can only know because a confirmation is serialized against the order.
    // The yields stay within the order quantity: eleven of them would be refused as a yield
    // before a movement was ever considered.
    const orderG = await newOrder(nextKey());
    await issueManually(orderG, 4);
    const version = await orderVersion(orderG);
    const before = await componentStock();
    expect(await documentsOn(orderG)).toHaveLength(1);

    const both = await Promise.all([
      enterTimeTicket(client, ticket(orderG, version, { yieldQuantity: '6' })),
      enterTimeTicket(client, ticket(orderG, version, { yieldQuantity: '4' })),
    ]);
    expect(both.every((result) => result.movementsPosted === 1)).toBe(true);

    const drawn: string[] = [];
    for (const result of both) {
      const issueKey = await movementRequestKey(result.requestKey, 'ISSUE');
      const [row] = await withTenant(client, async (tx) => rows(tx, sql`
        select l.base_quantity::text as q
          from material_document d
          join material_document_line l on l.client = d.client and l.material_document_number = d.material_document_number
         where d.client = ${client} and d.request_key = ${issueKey}
      `));
      drawn.push(String(row!.q));
    }
    const quantities = drawn.map((text) => Number(text));
    // Whatever order the two took, together they draw exactly the sixteen that were open: the
    // later one is capped, and nothing is withdrawn twice.
    expect(quantities.reduce((sum, value) => sum + value, 0)).toBe(16);
    expect(Math.max(...quantities)).toBeLessThanOrEqual(12);
    expect(quantities.every((value) => value > 0)).toBe(true);
    // Quantities are held to three decimal places, so the stock is compared at that scale.
    expect(Math.abs((await componentStock()) - (before - 16))).toBeLessThan(0.0005);
    // Two confirmations, two documents, and the manual issue: three, never more.
    expect(await documentsOn(orderG)).toHaveLength(3);
  });

  it('will not let another posting reuse the key a confirmation derived', async () => {
    // The derived key belongs to the movement it stands for. A second posting under it, with
    // different content, is refused by the goods-movement service itself, which is the guard the
    // confirmation relies on and does not duplicate.
    const orderH = await newOrder(nextKey());
    const saved = await save(orderH, { yieldQuantity: '4' });
    const issueKey = await movementRequestKey(saved.requestKey, 'ISSUE');
    expect(issueKey).toBeTruthy();
    expect(await documentsOn(orderH)).toHaveLength(1);

    await expect(postGoodsIssue({
      client, changedBy: ACTOR, movementTypeCode: '261', postingDate: '2026-10-24', documentDate: '2026-10-24',
      headerText: 'A different posting', requestKey: issueKey!,
      lines: [{
        materialNumber: 'MV-RM', plant: PLANT, storageLocation: LOCATION, quantity: 3,
        productionOrderNumber: orderH, productionOrderItem: componentItem,
      }],
    }, 'MIGO')).rejects.toThrow(/already posted .*different posting/i);

    expect(await documentsOn(orderH)).toHaveLength(1);
    // The same key and the same content is a replay, not a second withdrawal.
    const again = await enterTimeTicket(client, ticket(orderH, await orderVersion(orderH), { requestKey: saved.requestKey }));
    expect(again.replayed).toBe(true);
    // The standing document is shown again, and no second one is caused by the replay.
    expect(again.movementsPosted).toBe(1);
    expect(again.movementPlan).toBeNull();
    expect(await documentsOn(orderH)).toHaveLength(1);
  });

  it('opens again only the component whose line was reversed', async () => {
    // One withdrawal of two components is one document of two lines. Reversing one line leaves
    // the document standing, so the confirmation that caused it is still not cancellable, and
    // only the reversed component is owed again by the next confirmation.
    await addRaw('MV-RM2', 40);
    const orderI = await newOrder(nextKey(), {
      components: [{ materialNumber: 'MV-RM', requiredQuantity: 20 }, { materialNumber: 'MV-RM2', requiredQuantity: 10 }],
    });
    const saved = await save(orderI, { yieldQuantity: '5' });
    // Two marked components are two movements, and they are withdrawn by one document.
    expect(saved.movementsPosted).toBe(2);
    expect(await documentsOn(orderI)).toHaveLength(1);

    const issueKey = await movementRequestKey(saved.requestKey, 'ISSUE');
    const lines = await withTenant(client, async (tx) => rows(tx, sql`
      select d.material_document_number as number, d.document_year::text as year, d.status,
             l.line_number, l.material_number
        from material_document d
        join material_document_line l on l.client = d.client and l.material_document_number = d.material_document_number
       where d.client = ${client} and d.request_key = ${issueKey}
       order by l.line_number
    `));
    expect(lines).toHaveLength(2);
    const [first, second] = lines as [Record<string, unknown>, Record<string, unknown>];
    const documentNumber = String(first.number);
    const fiscalYear = Number(first.year);

    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: documentNumber, fiscalYear,
      postingDate: '2026-10-24', documentDate: '2026-10-24', requestKey: nextKey(),
      lines: [Number(second.line_number)],
    });
    const [header] = await withTenant(client, async (tx) => rows(tx, sql`
      select status from material_document where client = ${client} and material_document_number = ${documentNumber}
    `));
    expect(String(header!.status)).toBe('PARTIALLY_REVERSED');

    // A document with a line still in force is a movement in force.
    await expect(cancelConfirmation(client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: saved.confirmationNumber,
      confirmed: true, reason: 'Wrong quantity', capabilities: ['PROD.CONFIRM.CANCEL'],
    })).rejects.toThrow(new RegExp(`posted material document ${documentNumber}`));

    const again = await check(orderI, { yieldQuantity: '5' });
    const owed = again.movements.find((row) => row.materialNumber === 'MV-RM2');
    const issued = again.movements.find((row) => row.materialNumber === 'MV-RM');
    // Ten of MV-RM stand issued, so ten remain open and the share is capped at them; MV-RM2 is
    // open again in full, so its share is drawn as though nothing had been withdrawn.
    expect(issued).toMatchObject({ requiredQuantity: '20.000', issuedQuantity: '10.000', openQuantity: '10.000', quantity: '10.000' });
    expect(owed).toMatchObject({ requiredQuantity: '10.000', issuedQuantity: '0.000', openQuantity: '10.000', quantity: '5.000' });
    expect(again.movementPlan?.skipped ?? []).toHaveLength(0);

    // With the second line reversed too, nothing the confirmation caused stands, and CO13 goes.
    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: documentNumber, fiscalYear,
      postingDate: '2026-10-24', documentDate: '2026-10-24', requestKey: nextKey(),
      lines: [Number(first.line_number)],
    });
    const cancelled = await cancelConfirmation(client, {
      requestedBy: ACTOR, requestKey: nextKey(), confirmationNumber: saved.confirmationNumber,
      confirmed: true, reason: 'Wrong quantity', capabilities: ['PROD.CONFIRM.CANCEL'],
    });
    expect(cancelled.cancellationNumber).toBeTruthy();
    const movement = await withTenant(client, (tx) => postedMovements(tx, client, saved.requestKey));
    expect(movement).toHaveLength(2);
    expect(movement.every((row) => row.posted && !row.standing)).toBe(true);
  });

  it('still refuses what this ERP does not do, now that a movement exists', async () => {
    const loaded = await loadTimeTicket(client, { orderNumber: orderA, operationNumber: '0010', postingDate: '2026-10-24' });
    const gaps = loaded.gaps.join(' ');
    expect(gaps).toMatch(/no order type switches a receipt on or off/);
    expect(gaps).toMatch(/reservation is not cleared/);
    expect(gaps).toMatch(/Scrap is not grossed/);
    await expect(check(orderA, { named: { personnel: '1001' } })).rejects.toThrow(/personnel number is not validated/);
    await expect(check(orderA, { named: { goodsMovement: 'X' } })).rejects.toThrow(/not entered on this screen/);
    await expect(check(orderA, { named: { clearOpenReservations: 'X' } })).rejects.toThrow(/no reservation/i);
  });
});
