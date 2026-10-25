import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { expect, type Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { saveMaterialView } from '../../src/modules/inventory/materials';
import { postProductionReceipt } from '../../src/modules/inventory/production-receipt';
import { reverseMaterialDocument } from '../../src/modules/inventory/material-document-reversal';
import { createProductionOrder, releaseProductionOrder } from '../../src/modules/inventory/production-orders';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../../src/modules/production/material-bom';
import { saveOrderTypeParameter } from '../../src/modules/production/order-type-parameters';
import { checkProductionVersion, createProductionVersion } from '../../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingTaskListType, saveRoutingUsage } from '../../src/modules/production/routing';
import { insertOrderOperationSnapshot, resolveOrderOperationSnapshot } from '../../src/modules/production/order-operation-snapshot';
import { movementRequestKey } from '../../src/modules/production/confirmation-movements';
import { createWorkCenter, saveWorkCenterCategory } from '../../src/modules/production/work-center';
import type { BrowserTarget } from './targets';

const PASSWORD = 'browser-check-2026';

type Context = { page: Page; base: string; target: BrowserTarget };

const TICKET = '/production/time-ticket';
const ACTOR = 'browser.admin';
const PLANT = 'QG01';
const LOCATION = 'SG01';
const ROUTING_GROUP = '50000091';
const REPLAY_KEY = 'co11n-browser-replay';

/**
 * CO11N browser acceptance: a confirmation and the goods movements it causes.
 *
 * The screen is the subject, so every judgement below is read off what the browser was shown
 * and then confirmed against the rows the server actually wrote. Nothing here asserts on
 * source text.
 *
 * The order is ten units and takes twenty of the component, so four units of yield owe eight.
 * Three finished goods are received by hand first, which is what makes an over-receipt
 * reachable, and the plant carries a default storage location, which is what a receipt with no
 * location of its own is expected to fall back to.
 */
export async function co11nMovement(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('CO11N: confirm an order and watch the withdrawal, the receipt, the replay, and the refusal');

  const { code: company, currency } = await withTenant(client, async (tx) => {
    const [found] = await tx.execute(sql`
      select company_code, currency from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    if (!found) throw new Error('the browser tenant carries no company code');
    const code = found.company_code;
    const currency = found.currency;

    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, default_storage_location, created_by)
      values (${client}, ${PLANT}, 'Confirmation plant', ${code}, 'KW', ${LOCATION}, ${ACTOR})
      on conflict (client, plant) do update set company_code = excluded.company_code,
        default_storage_location = excluded.default_storage_location
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, ${PLANT}, ${LOCATION}, 'Confirmation store', true, false, ${ACTOR})
      on conflict (client, plant, storage_location) do update set is_active = true, allow_negative_stock = false
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, ${code}, 2026, 10, 2026, 9, true, ${ACTOR})
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
    return { code, currency };
  });

  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'PRODCONF', subObject: '*', prefix: 'CNF', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8, createdBy: ACTOR });
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: company, subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: ACTOR,
    });
    await tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${client}, 'PP01', 'Standard production', '10', ${ACTOR})
      on conflict (client, order_type) do nothing
    `);
  });

  for (const [material, made] of [['CO11-FG', true], ['CO11-RM', false]] as const) {
    await saveMaterialView({
      client, materialNumber: material, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO11N browser acceptance', view: 'BASIC', description: material, materialType: made ? 'FIN' : 'RAW',
      materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    await saveMaterialView({
      client, materialNumber: material, changedBy: ACTOR, expectedVersion: 0,
      reason: 'CO11N browser acceptance', view: 'PURCHASING', plant: PLANT,
      purchasingGroup: '001', orderUnit: 'PC',
      overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
    await saveMaterialView({
      client, materialNumber: material, changedBy: ACTOR, expectedVersion: 1,
      reason: 'CO11N browser acceptance', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: made ? 'MAKE' : 'BUY',
      lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
      safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
      // Only the finished good is marked from here; the component's mark is entered on the
      // screen below, because maintaining the mark on that screen is part of what is tested.
      automaticGoodsReceipt: made,
    });
  }

  // Valuation and stock come after the material: their foreign key is the material row itself.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, 'CO11-FG', ${PLANT}, 'FINISHED_INVENTORY', 'STANDARD', 40, 40, 1, ${currency}, 0, 0, ${ACTOR}),
             (${client}, 'CO11-RM', ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, ${currency}, 100, 1000, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, 'CO11-RM', ${PLANT}, ${LOCATION}, 'UNRESTRICTED', 100, ${ACTOR})
      on conflict (client, material_number, plant, storage_location, stock_type, batch_number) do update set quantity = 100
    `);
  });

  await saveBomUsage({
    client, changedBy: ACTOR, usage: 'P', description: 'Production',
    productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
  });
  await saveBomItemCategory({ client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+' });
  await createMaterialBom({
    client, changedBy: ACTOR, materialNumber: 'CO11-FG', plant: PLANT, usage: 'P', alternative: '01',
    baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
    items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CO11-RM', quantity: '2', unit: 'PC' }],
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
    routingGroup: ROUTING_GROUP, groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
    assignments: [{ materialNumber: 'CO11-FG' }],
    operations: [{
      operationNumber: '0010', shortText: 'Build', workCenter: 'WC91', controlKey: 'PP01', standardValueKey: 'SV01',
      values: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    }],
  });
  await createProductionVersion({
    client, changedBy: ACTOR, materialNumber: 'CO11-FG', plant: PLANT, productionVersion: '0001',
    validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
    bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: ROUTING_GROUP, groupCounter: '01',
  });
  await checkProductionVersion(client, 'CO11-FG', PLANT, '0001', ACTOR);
  await saveOrderTypeParameter({
    client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
    taskListType: '', productionVersionSelection: '0', version: 0, reason: 'CO11N browser acceptance',
  });

  /** An order of ten units needing twenty of the component, with the operation the ticket confirms. */
  async function makeOrder(requestKey: string): Promise<string> {
    const created = await createProductionOrder({
      orderType: 'PP01', client, createdBy: ACTOR,
      materialNumber: 'CO11-FG', plant: PLANT, orderQuantity: 10,
      scheduledStart: '2026-10-24', scheduledFinish: '2026-10-25', requestKey,
      components: [{ materialNumber: 'CO11-RM', plant: PLANT, storageLocation: LOCATION, requiredQuantity: 20 }],
    });
    await withTenant(client, async (tx) => {
      const copied = await resolveOrderOperationSnapshot(tx, {
        client, plant: PLANT, finishDate: '2026-10-25',
        taskListType: 'N', routingGroup: ROUTING_GROUP, groupCounter: '01', productionVersion: '0001',
      });
      await insertOrderOperationSnapshot(tx, { client, orderNumber: created.orderNumber, createdBy: ACTOR, operations: copied.operations });
    });
    await releaseProductionOrder({ client, orderNumber: created.orderNumber, releasedBy: ACTOR });
    return created.orderNumber;
  }

  /** Set the component mark the way the MRP view does: the same typed view save the screen posts. */
  async function markBackflush() {
    await saveMaterialView({
      client, materialNumber: 'CO11-RM', changedBy: ACTOR, expectedVersion: 2,
      reason: 'Components are to be drawn by a confirmation', view: 'MRP', plant: PLANT,
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: 'BUY',
      lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
      safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
      backflush: true, automaticGoodsReceipt: false,
    });
  }

  /**
   * The ticket as a user states it: the type, the date, the yield, and the required activity.
   * Every submit restates it, because the form is drawn again by the server after each one.
   */
  async function fillTicket(type: 'PARTIAL' | 'FINAL', yieldQuantity: string, final = false) {
    await page.selectOption('select[name="confirmationType"]', type);
    await page.fill('input[name="postingDate"]', '2026-10-24');
    await page.fill('input[name="yieldQuantity"]', yieldQuantity);
    await page.fill('input[aria-label="LABOR"]', '1');
    if (final) await page.locator('input[name="confirmFinal"]').check();
  }

  const ticketUrlFor = (orderNumber: string) => `${base}${TICKET}?order=${encodeURIComponent(orderNumber)}&operation=0010`;
  const order = await makeOrder('co11n-browser-order');
  console.log(`  ✓ order ${order} stands released with 20 of CO11-RM required`);

  /** The acknowledgement is React state, so its rendered state is what the button sees. */
  async function expectChecked(locator: { isChecked(): Promise<boolean> }, expected: boolean) {
    await expect.poll(async () => await locator.isChecked(), { timeout: 15_000 }).toBe(expected);
  }
  /**
   * The reason and the acknowledgement are React state, so a value set before the screen has
   * hydrated reaches the DOM only and the submit control never comes alive — and in development
   * the route is compiled after the first byte of HTML arrives, which is exactly when a smoke run
   * types. Both fields are restated until the screen itself reports them.
   */
  async function armCancellation(reason: string) {
    const field = page.locator('[name="reason"]');
    const box = page.locator('input[name="confirmCancel"]');
    const button = page.locator('[data-co13-cancel]');
    await expect.poll(async () => {
      if (await field.inputValue() !== reason) await field.fill(reason);
      if (await button.isEnabled()) return true;
      // One click moves the box; if React has not taken it the DOM still reads unchecked after
      // the click, so the click is repeated. Either way the run ends on the checked state.
      await box.evaluate((element: HTMLInputElement) => {
        element.click();
        if (!element.checked) element.click();
      });
      return await button.isEnabled();
    }, { timeout: 120_000, intervals: [500] }).toBe(true);
    if (await field.inputValue() !== reason) await field.fill(reason);
    await expectChecked(box, true);
  }

  const ticketUrl = ticketUrlFor(order);
  const quantityOf = async (material: string) => withTenant(client, async (tx) => {
    const [row] = await tx.execute(sql`
      select quantity::text as quantity from stock_quantity
       where client = ${client} and material_number = ${material} and plant = ${PLANT}
         and storage_location = ${LOCATION} and stock_type = 'UNRESTRICTED'
    `) as unknown as Array<{ quantity: string }>;
    return Number(row?.quantity ?? '0');
  });
  const stored = async <T,>(query: ReturnType<typeof sql>) => withTenant(client, async (tx) => await tx.execute(query) as unknown as T[]);
  const confirmationsOn = (orderNumber: string) => stored<{ n: string }>(sql`
    select count(*)::text as n from production_confirmation where client = ${client} and order_number = ${orderNumber}
  `).then((rows) => Number(rows[0]!.n));
  const documentsOn = (orderNumber: string) => stored<{ n: string }>(sql`
    select count(distinct d.material_document_number)::text as n
      from material_document_line l
      join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
     where l.client = ${client} and l.production_order_number = ${orderNumber}
  `).then((rows) => Number(rows[0]!.n));

  // 1 · Nothing is marked yet, so the screen says so before a quantity is entered, and a
  //     confirmation that would owe a withdrawal writes none.
  await page.goto(ticketUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Enter time ticket', exact: true }).waitFor();
  const configNote = page.locator('[data-co11n-movement-config]');
  await configNote.filter({ hasText: /No component line is marked for backflush/ }).waitFor();
  await configNote.filter({ hasText: /A final confirmation does not clear a reservation/ }).waitFor();

  await fillTicket('PARTIAL', '4');
  await page.locator('[data-co11n-check]').evaluate((element) => (element as HTMLButtonElement).click());
  await page.locator('[data-co11n-movements]').waitFor();
  await page.getByText('Goods movements this confirmation would cause', { exact: true }).waitFor();
  await page.getByText('No goods movement stands behind this confirmation. Stock was not changed.', { exact: true }).waitFor();
  assert.equal(await confirmationsOn(order), 0, 'a check writes nothing');
  assert.equal(await quantityOf('CO11-RM'), 100, 'and no stock moves');
  console.log('  ✓ an unmarked material is refused its withdrawal, by the screen and by the rows');

  // 2 · The mark is maintained on the material, on its MRP view, and that same view is where a
  //     planner reads it. Both halves are checked: the row the view wrote, and the two fields the
  //     screen shows when the material is opened.
  await markBackflush();
  const marks = await stored<{ backflush: boolean; automatic: boolean }>(sql`
    select p.backflush, p.automatic_goods_receipt as automatic
      from material_plant p where p.client = ${client} and p.material_number = 'CO11-RM' and p.plant = ${PLANT}
  `);
  assert.equal(marks[0]!.backflush, true, 'the MRP view saved the mark');
  assert.equal(marks[0]!.automatic, false, 'and no receipt mark crept in with it');
  console.log('  ✓ the mark is maintained on the material, on its MRP view, and stored on the plant data');

  // 3 · The same confirmation now states the withdrawal it would cause, and causes exactly that
  //     one when it is saved.
  await page.goto(ticketUrl, { waitUntil: 'domcontentloaded' });
  await configNote.filter({ hasText: /1 of 1 component line is marked for backflush/ }).waitFor();
  await configNote.filter({ hasText: /The finished good is marked to be received by a final confirmation/ }).waitFor();
  await fillTicket('PARTIAL', '4');
  await page.locator('[data-co11n-check]').evaluate((element) => (element as HTMLButtonElement).click());
  const preview = page.locator('[data-co11n-movement="ISSUE"]');
  await preview.waitFor();
  assert.match(await preview.innerText(), /Goods issue 261/);
  assert.match(await preview.innerText(), /8\.000 PC/);
  assert.match(await preview.innerText(), /0\.000 already issued of 20\.000 required\. 20\.000 is open\./);
  assert.match(await preview.innerText(), /not posted yet/);
  assert.equal(await quantityOf('CO11-RM'), 100, 'the check wrote nothing');
  assert.equal(await confirmationsOn(order), 0);

  await fillTicket('PARTIAL', '4');
  await page.locator('[data-co11n-save]').evaluate((element) => (element as HTMLButtonElement).click());
  await page.getByText('Goods movements posted with this confirmation', { exact: true }).waitFor();
  const posted = await preview.innerText();
  assert.match(posted, /8\.000 PC/);
  assert.doesNotMatch(posted, /not posted yet/);
  const savedBlock = page.locator('[data-co11n-confirmation]');
  await savedBlock.waitFor();
  const confirmationNumber = String(await savedBlock.getAttribute('data-co11n-confirmation'));
  assert.match(confirmationNumber, /^CNF-\d+$/, 'the screen names the confirmation it stored');
  assert.equal(await quantityOf('CO11-RM'), 92, 'the component stock fell by the eight the confirmation owed');
  assert.equal(await confirmationsOn(order), 1);
  assert.equal(await documentsOn(order), 1);

  const movementRows = await stored<{ key: string; quantity: string; movement: string; sloc: string | null; item: string }>(sql`
    select d.request_key as key, l.base_quantity::text as quantity, l.movement_type as movement,
           l.storage_location::text as sloc, l.production_order_item::text as item
      from material_document d
      join material_document_line l on l.client = d.client and l.material_document_number = d.material_document_number
     where d.client = ${client} and d.request_key = ${await storedRequestKey(confirmationNumber, client)}
  `);
  assert.equal(movementRows.length, 1, 'one movement, one document line');
  assert.equal(movementRows[0]!.quantity, '8.000');
  assert.equal(movementRows[0]!.movement, 'PROD_ISSUE_ORDER');
  assert.equal(movementRows[0]!.sloc, LOCATION, 'the storage location is the one the component carries on the order');
  assert.ok(movementRows[0]!.item, 'and the line names the order item it was drawn for');
  assert.ok(String(movementRows[0]!.key).endsWith('-BF'), 'the document carries the key this confirmation derived');

  // The document the row links to is the tenant's own and shows the same movement.
  const link = await preview.locator('a').first().getAttribute('href');
  assert.ok(link && link.includes('document='), 'the movement links to its material document');
  await page.goto(`${base}${link}`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/CO11-RM/).first().waitFor();
  console.log('  ✓ a marked component is withdrawn by the confirmation, once, in the open amount');

  // 4 · A request key already saved is shown as saved, and nothing is posted a second time.
  await page.goto(ticketUrl, { waitUntil: 'domcontentloaded' });
  for (const attempt of [1, 2]) {
    await fillTicket('PARTIAL', '1');
    await page.evaluate((value) => {
      const field = document.querySelector('input[name="requestKey"]') as HTMLInputElement | null;
      if (field) field.value = value;
    }, REPLAY_KEY);
    await page.locator('[data-co11n-save]').evaluate((element) => (element as HTMLButtonElement).click());
    if (attempt === 1) {
      await page.getByText('Goods movements posted with this confirmation', { exact: true }).waitFor();
      assert.equal(await confirmationsOn(order), 2, 'the first posting of the key stored a confirmation');
      assert.equal(await quantityOf('CO11-RM'), 90, 'and drew two more of the component');
      await page.goto(ticketUrl, { waitUntil: 'domcontentloaded' });
    } else {
      await page.locator('[data-co11n-replay]').waitFor();
      await page.getByText('This request was already saved.', { exact: false }).first().waitFor();
      assert.equal(await confirmationsOn(order), 2, 'the replay stored nothing');
      assert.equal(await documentsOn(order), 2, 'and caused no second document');
      assert.equal(await quantityOf('CO11-RM'), 90, 'and did not withdraw the component twice');
    }
  }
  console.log('  ✓ the same request key twice is one confirmation and one movement');

  // 5 · A receipt is caused only by a final confirmation, and the over-receipt guard is the
  //     ceiling it is posted under. A confirmation that would pass the ceiling is refused whole,
  //     and the withdrawal it also owed goes back with it. This runs on a second order, because
  //     the yield a first order still allows can no longer overrun a receipt posted mostly by
  //     hand, and a refusal that cannot be reached is not a refusal tested.
  const order2 = await makeOrder('co11n-browser-order-2');
  const ticketUrl2 = ticketUrlFor(order2);
  await postProductionReceipt({
    client, changedBy: ACTOR, orderNumber: order2, postingDate: '2026-10-24', documentDate: '2026-10-24',
    headerText: 'Received by hand', requestKey: 'co11n-browser-hand-receipt',
    lines: [{ storageLocation: LOCATION, quantity: 8 }],
  });
  assert.equal(await quantityOf('CO11-FG'), 8, 'eight finished goods stand received against the second order');
  assert.equal(await quantityOf('CO11-RM'), 90, 'the component has moved only by what the first order confirmed');

  await page.goto(ticketUrl2, { waitUntil: 'domcontentloaded' });
  await fillTicket('FINAL', '4', true);
  await page.locator('[data-co11n-check]').evaluate((element) => (element as HTMLButtonElement).click());
  const receiptRow = page.locator('[data-co11n-movement="RECEIPT"]');
  await receiptRow.waitFor();
  assert.match(await receiptRow.innerText(), /Goods receipt 101/, 'a final confirmation states a receipt');
  assert.match(await receiptRow.innerText(), /Plant default/, 'and no storage location but the plant default');
  assert.match(await page.locator('[data-co11n-movement="ISSUE"]').innerText(), /8\.000 PC/, 'with the withdrawal its yield owes');

  await fillTicket('FINAL', '4', true);
  await page.locator('[data-co11n-save]').evaluate((element) => (element as HTMLButtonElement).click());
  const refused = page.locator('p[role="status"]').filter({ hasText: /still expects/ }).first();
  await refused.waitFor();
  assert.match(await refused.innerText(), /CO11-FG/, 'the refusal names the material the receipt service stopped');
  assert.equal(await confirmationsOn(order2), 0, 'and the refused confirmation left no row behind');
  assert.equal(await documentsOn(order2), 1, 'its withdrawal went back with it: only the hand receipt stands');
  assert.equal(await quantityOf('CO11-RM'), 90, 'no component was drawn by the attempt that failed');
  assert.equal(await quantityOf('CO11-FG'), 8, 'and no finished good was received');
  console.log('  ✓ a receipt over the order is refused, and the withdrawal it also owed is rolled back');

  // 6 · Within the ceiling the same final confirmation posts both movements. The receipt is this
  //     confirmation yield, at the plant default location, valued by the movement service at the
  //     material price the valuation view holds.
  await page.goto(ticketUrl2, { waitUntil: 'domcontentloaded' });
  await fillTicket('FINAL', '2', true);
  await page.locator('[data-co11n-save]').evaluate((element) => (element as HTMLButtonElement).click());
  await page.getByText('Goods movements posted with this confirmation', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-co11n-movement]').count(), 2, 'one withdrawal and one receipt');
  assert.equal(await quantityOf('CO11-FG'), 10, 'the order is now received in full');
  assert.equal(await quantityOf('CO11-RM'), 86, 'and four of the component went out, which is all two of the order owed');
  const finalConfirmation = await lastConfirmation(order2, client);
  const receiptRows = await stored<{ movement: string; quantity: string; sloc: string; price: string; value: string }>(sql`
    select l.movement_type as movement, l.base_quantity::text as quantity, l.storage_location::text as sloc,
           l.unit_price::text as price, l.value::text as value
      from material_document d
      join material_document_line l on l.client = d.client and l.material_document_number = d.material_document_number
      join production_confirmation c on c.client = d.client and d.request_key = upper(c.request_key) || '-GR'
     where d.client = ${client} and c.confirmation_number = ${finalConfirmation}
  `);
  assert.equal(receiptRows.length, 1, 'the final confirmation caused one receipt');
  assert.equal(receiptRows[0]!.movement, 'PROD_RECEIPT_ORDER');
  assert.equal(receiptRows[0]!.quantity, '2.000', 'the receipt is the confirmation yield, not the order quantity');
  assert.equal(receiptRows[0]!.sloc, LOCATION, 'and it fell back to the plant default location');
  assert.equal(Number(receiptRows[0]!.price), 40, 'valued at the material price the valuation view holds');
  assert.equal(Number(receiptRows[0]!.value), 80, 'two units at forty');
  console.log('  ✓ the final confirmation receives its yield at the plant default and the material price');

  // 7 · A cancellation is refused while a document the confirmation caused still stands, and the
  //     reversal screen is named as the way round it. Once nothing stands, the same screen goes
  //     through, and the ticket says the operation was cancelled.
  const caused = await stored<{ number: string; year: string }>(sql`
    select d.material_document_number as number, d.document_year::text as year
      from material_document d join production_confirmation c on c.client = d.client and d.request_key = upper(c.request_key) || '-BF'
     where d.client = ${client} and c.confirmation_number = ${finalConfirmation}
     union all
    select d.material_document_number, d.document_year::text
      from material_document d join production_confirmation c on c.client = d.client and d.request_key = upper(c.request_key) || '-GR'
     where d.client = ${client} and c.confirmation_number = ${finalConfirmation}
  `);
  assert.equal(caused.length, 2, 'the final confirmation caused two documents, one per movement');

  await page.goto(`${base}/production/confirmation-cancel?confirmation=${encodeURIComponent(finalConfirmation)}`, { waitUntil: 'domcontentloaded' });
  // A click on a disabled control would prove nothing, so the screen is armed until it reports
  // the acknowledgement itself.
  await armCancellation('Wrong confirmation');
  await page.locator('[data-co13-cancel]').click();
  const message = page.locator('[data-co13-message]');
  await message.waitFor();
  const refusal = await message.innerText();
  assert.match(refusal, /and it still stands\. Nothing was cancelled\./);
  assert.match(refusal, new RegExp(String(caused[0]!.number)), 'the refusal names the withdrawal it caused');
  assert.match(refusal, new RegExp(String(caused[1]!.number)), 'and the receipt it caused');
  assert.match(refusal, /Reverse the goods movement on the material-document screen/, 'and names the reversal workflow as the way round it');
  assert.equal(await stored<{ n: string }>(sql`
    select count(*)::text as n from production_confirmation_cancellation where client = ${client} and confirmation_number = ${finalConfirmation}
  `).then((rows) => Number(rows[0]!.n)), 0, 'the refusal came before anything was written');

  for (const document of caused) {
    await reverseMaterialDocument({
      client, changedBy: ACTOR, materialDocumentNumber: document.number, fiscalYear: Number(document.year),
      postingDate: '2026-10-24', documentDate: '2026-10-24', requestKey: `co11n-browser-reverse-${document.number}`,
    });
  }
  assert.equal(await quantityOf('CO11-RM'), 90, 'the reversal put the component back');
  assert.equal(await quantityOf('CO11-FG'), 8, 'and took the receipt back out');

  // The reversals ran through the reversal service, so CO13 is opened again from the database:
  // what is asserted is that the screen no longer refuses, not that a form left on screen works.
  await page.goto(`${base}/production/confirmation-cancel?confirmation=${encodeURIComponent(finalConfirmation)}`, { waitUntil: 'domcontentloaded' });
  await armCancellation('Reversed and cancelled');
  await page.locator('[data-co13-cancel]').click();
  await page.locator('[data-co13-cancellation]').waitFor();
  assert.equal(await stored<{ n: string }>(sql`
    select count(*)::text as n from production_confirmation_cancellation where client = ${client} and confirmation_number = ${finalConfirmation}
  `).then((rows) => Number(rows[0]!.n)), 1, 'and the cancellation is a row, not only a message on a screen');
  await page.goto(ticketUrl2, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-co11n-cancellation]').waitFor();
  console.log('  ✓ CO13 waits for the reversal, then cancels, and the ticket states the cancellation');
}

/** The request key stored with a confirmation, which is what the movement keys are drawn from. */
async function storedRequestKey(confirmationNumber: string, client: string): Promise<string> {
  const rows = await withTenant(client, async (tx) => await tx.execute(sql`
    select request_key from production_confirmation where client = ${client} and confirmation_number = ${confirmationNumber}
  `) as unknown as Array<{ request_key: string }>);
  const key = rows[0]?.request_key ?? '';
  return await movementRequestKey(key, 'ISSUE') ?? key;
}

/** The confirmation a browser run last wrote for an order, read from the row and not from the page. */
async function lastConfirmation(orderNumber: string, client: string): Promise<string> {
  const rows = await withTenant(client, async (tx) => await tx.execute(sql`
    select confirmation_number from production_confirmation
     where client = ${client} and order_number = ${orderNumber}
     order by confirmation_number desc limit 1
  `) as unknown as Array<{ confirmation_number: string }>);
  return String(rows[0]?.confirmation_number ?? '');
}
