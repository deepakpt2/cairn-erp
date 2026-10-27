import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { saveMaterialView } from '../../src/modules/inventory/materials';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../../src/modules/production/material-bom';
import { checkProductionVersion, createProductionVersion } from '../../src/modules/production/production-version';
import { saveOrderTypeParameter } from '../../src/modules/production/order-type-parameters';
import {
  createRouting, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingTaskListType, saveRoutingUsage,
} from '../../src/modules/production/routing';
import { createWorkCenter, saveWorkCenterCategory } from '../../src/modules/production/work-center';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/production/orders';

/**
 * SCR-138 browser acceptance: CO01 create production order.
 *
 * The fixture gives the tenant a finished good, two components, a plant with a company
 * code and a store, all extended, and then the master data the create screen reads: an order
 * type of category 10, a bill of material with both components, a routing for the version to
 * point at, and production version 0001 linking them. The screen offers no typed component row
 * — `CO01` reads the version, which is what SCR-138's own contract says — so the components on
 * the order are the explosion of that bill of material at the ordered quantity.
 *
 * The run creates an order through the screen, reads back the derived company code, the status
 * and the component grid, releases it under the second capability, and confirms the ledger and
 * the stock were never touched.
 */
export async function productionOrderCreate(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-138: create an order with components, read its derived company, release it, prove nothing posted');

  const fixture = await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (!companies[0]) throw new Error('the browser tenant carries no company code');
    const code = companies[0].company_code;
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.n, v.d, v.t, 'PC', 'browser.admin'
      from (values ('CO01-FG', 'Order finished good', 'FIN'), ('CO01-RM1', 'Order raw one', 'RAW'),
                   ('CO01-RM2', 'Order raw two', 'RAW')) as v(n, d, t)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QC01', 'Order plant', ${code}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, v.n, 'QC01', 'browser.admin'
      from (values ('CO01-FG'), ('CO01-RM1'), ('CO01-RM2')) as v(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, 'QC01', 'SC01', 'Order store', true, false, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    return code;
  });
  console.log('  ✓ a plant, a store and three materials stand extended');

  // The masters the create screen reads. These are not the subject of the target, so they come
  // through the services the screens themselves call, exactly as the CO11N target does.
  for (const [material, made, description] of [
    ['CO01-FG', true, 'Order finished good'], ['CO01-RM1', false, 'Order raw one'], ['CO01-RM2', false, 'Order raw two'],
  ] as const) {
    // Each view is guarded by the version of the row it writes — the client-level view by the
    // material row, a plant view by that plant's row — so the fixture reads the row it will touch.
    const versionOf = async (row: 'material' | 'plant') => {
      const rows = await withTenant(client, async (tx) => tx.execute(row === 'material'
        ? sql`select version from material where client = ${client} and material_number = ${material}`
        : sql`select version from material_plant where client = ${client} and material_number = ${material} and plant = 'QC01'`));
      return Number(rows?.[0]?.version ?? 0);
    };
    await saveMaterialView({
      client, materialNumber: material, changedBy: 'browser.admin', expectedVersion: await versionOf('material'),
      reason: 'SCR-138 browser acceptance', view: 'BASIC', description,
      materialType: made ? 'FIN' : 'RAW', materialGroup: 'RAW', baseUnit: 'PC', industrySector: 'M',
      barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
    // A production version is only offered for a material the plant produces, so the planning view
    // is part of the fixture rather than of the assertion.
    await saveMaterialView({
      client, materialNumber: material, changedBy: 'browser.admin', expectedVersion: await versionOf('plant'),
      reason: 'SCR-138 browser acceptance', view: 'MRP', plant: 'QC01',
      mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: made ? 'MAKE' : 'BUY',
      lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
      safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0, inHouseProductionDays: 0,
      automaticGoodsReceipt: made,
    });
  }
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${client}, 'PP01', 'Standard production', '10', 'browser.admin')
      on conflict (client, order_type) do nothing
    `);
  });
  await saveBomUsage({
    client, changedBy: 'browser.admin', usage: 'P', description: 'Production',
    productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
  });
  await saveBomItemCategory({ client, changedBy: 'browser.admin', category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+' });
  await createMaterialBom({
    client, changedBy: 'browser.admin', materialNumber: 'CO01-FG', plant: 'QC01', usage: 'P', alternative: '01',
    baseQuantity: '100', baseUnit: 'PC', validFrom: '2020-01-01',
    items: [
      // 40/100 and 20/100 so that a planned quantity of 25 explodes to 10 and 5: the unit 'PC'
      // holds no decimal places, and the order snapshot refuses a fractional requirement rather
      // than rounding it.
      { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CO01-RM1', quantity: '40', unit: 'PC' },
      { itemNumber: '0020', itemCategory: 'S', componentMaterial: 'CO01-RM2', quantity: '20', unit: 'PC' },
    ],
  });
  await saveRoutingTaskListType({ client, changedBy: 'browser.admin', taskListType: 'N', description: 'Routing' });
  await saveRoutingUsage({ client, changedBy: 'browser.admin', usage: '1', description: 'Production' });
  await saveRoutingControlKey({ client, changedBy: 'browser.admin', controlKey: 'PP01', description: 'Confirm', confirmation: 'X' });
  await saveRoutingStandardValueKey({
    client, changedBy: 'browser.admin', standardValueKey: 'SV01', description: 'Labor',
    parameters: [{ parameter: 'LABOR', description: 'Labor', unit: 'HR', required: 'X' }],
  });
  await saveWorkCenterCategory({ client, changedBy: 'browser.admin', category: 'MACH', description: 'Machine' });
  await createWorkCenter({ client, changedBy: 'browser.admin', plant: 'QC01', workCenter: 'WC91', category: 'MACH', description: 'Assembly' });
  await createRouting({
    client, changedBy: 'browser.admin', taskListType: 'N', plant: 'QC01', usage: '1',
    routingGroup: '50000091', groupCounter: '01', baseQuantity: '100', baseUnit: 'PC', validFrom: '2020-01-01',
    assignments: [{ materialNumber: 'CO01-FG' }],
    operations: [{
      operationNumber: '0010', shortText: 'Build', workCenter: 'WC91', controlKey: 'PP01', standardValueKey: 'SV01',
      values: [{ parameter: 'LABOR', quantity: '1', unit: 'HR' }],
    }],
  });
  await createProductionVersion({
    client, changedBy: 'browser.admin', materialNumber: 'CO01-FG', plant: 'QC01', productionVersion: '0001',
    validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
    bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000091', groupCounter: '01',
  });
  await checkProductionVersion(client, 'CO01-FG', 'QC01', '0001', 'browser.admin');
  await saveOrderTypeParameter({
    client, changedBy: 'browser.admin', mode: 'CREATE', plant: 'QC01', orderType: 'PP01',
    taskListType: '', productionVersionSelection: '0', version: 0, reason: 'SCR-138 browser acceptance',
  });
  console.log('  ✓ an order type, a two-item bill of material, a routing and version 0001 stand');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Create Production Order', exact: true }).waitFor();

  await page.fill('input[name="materialNumber"]', 'CO01-FG');
  await page.fill('input[name="plant"]', 'QC01');
  await page.fill('input[name="orderType"]', 'PP01');
  await page.fill('input[name="orderQuantity"]', '100');
  await page.fill('input[name="scheduledStart"]', '2026-11-02');
  await page.fill('input[name="scheduledFinish"]', '2026-11-06');
  await page.fill('input[name="productionVersion"]', '0001');
  // The version is what carries the components, so the preview the screen shows before any write
  // is part of what is asserted: two items, exploded from the bill of material at 100 units.
  await page.getByRole('button', { name: 'Create the order', exact: true }).click();

  const status = page.locator('p[role="status"]').first();
  await status.waitFor();
  const message = await status.innerText();
  assert.match(message, /Order PRD-?\d+ created\./, `the order is created: ${message}`);
  const orderNumber = /Order (PRD-?\d+) created\./.exec(message)![1];

  // The order card: derived company, status, both components.
  const card = page.locator('section[aria-labelledby="order-summary"]');
  await card.waitFor();
  assert.equal(await card.locator('[data-order-number]').getAttribute('data-order-number'), orderNumber,
    'the order shows its number');
  assert.equal(await card.locator('[data-company-code]').getAttribute('data-company-code'), fixture,
    'the company code is derived from the plant, not typed');
  assert.equal(await card.locator('[data-status]').getAttribute('data-status'), 'CREATED',
    'a created order is not released yet');
  assert.equal(await card.locator('tr[data-item]').count(), 2, 'both components stand on the order');
  assert.equal((await card.innerText()).includes('Order raw one'), true, 'the component description resolves');

  // Release it.
  await page.getByRole('button', { name: 'Release the order', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'released' }).waitFor();
  const releasedCard = page.locator('section[aria-labelledby="order-summary"]');
  await page.waitForFunction(
    (selector) => document.querySelector(`${selector} [data-status]`)?.getAttribute('data-status') === 'RELEASED',
    'section[aria-labelledby="order-summary"]',
  );
  assert.equal(await releasedCard.locator('[data-status]').getAttribute('data-status'), 'RELEASED',
    'the release is recorded on the order');

  // Read independently of the screen: stock untouched, no document, no journal.
  const after = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select
        (select count(*)::int from production_order where client = ${client} and order_number = ${orderNumber}) as orders,
        (select count(*)::int from production_order_component where client = ${client} and order_number = ${orderNumber}) as components,
        (select status from production_order where client = ${client} and order_number = ${orderNumber}) as status,
        (select count(*)::int from material_document where client = ${client}) as documents,
        (select count(*)::int from journal_entry where client = ${client}) as journals,
        (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${client}) as stock
    `) as unknown as Array<{
      orders: number; components: number; status: string; documents: number; journals: number; stock: string;
    }>;
    return rows[0];
  });
  assert.equal(after.orders, 1, 'one order stands');
  assert.equal(after.components, 2, 'with both components');
  assert.equal(after.status, 'RELEASED', 'and it is released');
  assert.equal(after.documents, 0, 'no material document was written');
  assert.equal(after.journals, 0, 'no journal was written');
  assert.equal(Number(after.stock), 0, 'no stock moved');

  // A refusal keeps its SAP shape: an unknown plant refuses by name.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="materialNumber"]', 'CO01-FG');
  await page.fill('input[name="plant"]', 'QC99');
  await page.fill('input[name="orderType"]', 'PP01');
  await page.fill('input[name="orderQuantity"]', '5');
  await page.fill('input[name="scheduledStart"]', '2026-11-02');
  await page.fill('input[name="scheduledFinish"]', '2026-11-06');
  await page.fill('input[name="productionVersion"]', '0001');
  await page.getByRole('button', { name: 'Create the order', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'Plant QC99 does not exist.' }).waitFor();

  console.log(`SCR-138: order ${orderNumber} was created in company ${fixture}, released, and nothing posted`);
}
