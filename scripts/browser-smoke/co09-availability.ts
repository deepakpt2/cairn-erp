import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import {
  assignCheckingGroup,
  saveCheckingGroup,
  saveCheckingRule,
  saveScopeOfCheck,
} from '../../src/modules/production/availability-check';
import { listCheckingControls, saveCheckingControl } from '../../src/modules/production/checking-control';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '../../src/modules/production/material-bom';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/production/order-availability';
const ACTOR = 'browser.admin';
const PLANT = 'QG01';
const GROUP = 'ZT';
const RULE = 'PP';
const TYPE_CHECKED = 'PP01';
const TYPE_UNCONTROLLED = 'PP02';
const ORDER = '910000001';
const ORDER_UNCONTROLLED = '910000002';

const day = (offset: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

const SCOPE = {
  includeSafetyStock: ' ',
  includeQualityStock: 'X',
  includeBlockedStock: ' ',
  includeRestrictedUse: 'X',
  purchaseOrders: ' ',
  purchaseRequisitions: 'X',
  plannedOrders: ' ',
  productionOrders: ' ',
  dependentRequirements: ' ',
  reservations: ' ',
  receiptsInPast: ' ',
} as const;

/**
 * CO09 slice 1 browser acceptance: the read-only availability check over one
 * production order's components.
 *
 * The screen is the subject, so every judgement is read off what the browser was
 * shown and then confirmed against the rows behind it. Three things are checked
 * hardest, because they are the three a viewer could otherwise misread:
 *
 *   the numbers come from the standing configuration — a group, a rule and a scope
 *   pair created through the maintaining services, with no default substituted;
 *   a shortage is a shortage, and a component the rule excludes is not reported as
 *   either covered or missing;
 *   a run writes nothing, which is proved by reading the tables the check could have
 *   touched before and after it, not by asserting that the button says "check".
 */
export async function co09Availability(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('CO09: check one order’s components against the configuration, and prove nothing was written');

  const requirement = day(7);
  const receipt = day(3);
  const past = day(-6);

  await withTenant(client, async (tx) => {
    const [company] = await tx.execute(sql`select company_code from company_code where client = ${client} order by company_code limit 1`) as unknown as Array<{ company_code: string }>;
    if (!company) throw new Error('the browser tenant carries no company code');
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, ${PLANT}, 'Availability plant', ${company.company_code}, 'KW', ${ACTOR})
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by)
      values (${client}, ${PLANT}, 'SG01', 'Availability store', true, ${ACTOR})
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by)
      values (${client}, 'G95', 'Availability group', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${client}, ${TYPE_CHECKED}, 'Availability production', '10', ${ACTOR}),
             (${client}, ${TYPE_UNCONTROLLED}, 'Uncontrolled production', '10', ${ACTOR})
      on conflict do nothing
    `);
    // The materials. The checking group is not among them: it is assigned through the
    // availability-check service below, because an unassigned group must refuse.
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.number, v.name, t.material_type, 'PC', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values
        ('CO09-GOOD', 'Assembled good'),
        ('CO09-PART', 'Checked component'),
        ('CO09-BULK', 'Bulk component'),
        ('CO09-FREE', 'Component without a checking group'),
        ('CO09-NONE', 'Component with nothing counted')
      ) as v(number, name)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, mrp_type, mrp_controller, safety_stock, reorder_point, created_by)
      values
        (${client}, 'CO09-GOOD', ${PLANT}, 'REQUIREMENTS', '001', 0, 0, ${ACTOR}),
        (${client}, 'CO09-PART', ${PLANT}, 'REQUIREMENTS', '001', 0, 0, ${ACTOR}),
        (${client}, 'CO09-BULK', ${PLANT}, 'REQUIREMENTS', '001', 0, 0, ${ACTOR}),
        (${client}, 'CO09-FREE', ${PLANT}, 'REQUIREMENTS', '001', 0, 0, ${ACTOR}),
        (${client}, 'CO09-NONE', ${PLANT}, 'REQUIREMENTS', '001', 0, 0, ${ACTOR})
      on conflict do nothing
    `);
    // The order and its component snapshot, in the state conversion leaves it: dated
    // lines that name the bill-of-material item they came from, and one undated line.
    await tx.execute(sql`
      insert into production_order (client, order_number, material_number, plant, order_quantity, unit_of_measure,
                                    scheduled_start, scheduled_finish, status, order_type, production_version, bom_usage, bom_alternative, created_by)
      values (${client}, ${ORDER}, 'CO09-GOOD', ${PLANT}, 4, 'PC', ${day(1)}, ${day(20)}, 'CREATED', ${TYPE_CHECKED}, 'V01', 'P', '01', ${ACTOR}),
             (${client}, ${ORDER_UNCONTROLLED}, 'CO09-GOOD', ${PLANT}, 1, 'PC', ${day(1)}, ${day(20)}, 'CREATED', ${TYPE_UNCONTROLLED}, 'V01', 'P', '01', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into production_order_component (client, order_number, item_number, material_number, plant,
                                              required_quantity, unit_of_measure, requirement_date, bom_item, source_material, created_by)
      values
        (${client}, ${ORDER}, 10, 'CO09-PART', ${PLANT}, 20, 'PC', ${requirement}, '0010', 'CO09-GOOD', ${ACTOR}),
        (${client}, ${ORDER}, 20, 'CO09-BULK', ${PLANT}, 3, 'PC', ${requirement}, '0020', 'CO09-GOOD', ${ACTOR}),
        (${client}, ${ORDER}, 30, 'CO09-FREE', ${PLANT}, 7, 'PC', ${requirement}, null, null, ${ACTOR}),
        (${client}, ${ORDER}, 40, 'CO09-NONE', ${PLANT}, 6, 'PC', null, null, null, ${ACTOR}),
        (${client}, ${ORDER_UNCONTROLLED}, 10, 'CO09-PART', ${PLANT}, 2, 'PC', ${requirement}, null, null, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, 'CO09-PART', ${PLANT}, 'SG01', 'UNRESTRICTED', 5, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_requisition_item (client, requisition_number, item_number, short_text, quantity, unit,
                                            requisition_date, delivery_date, plant, purchasing_group, material_number, created_by)
      values (${client}, '950001', 1, 'Open for the checked requirement', 25, 'PC', ${day(-20)}, ${receipt}, ${PLANT}, 'G95', 'CO09-PART', ${ACTOR}),
             (${client}, '950002', 1, 'Past due', 4, 'PC', ${day(-30)}, ${past}, ${PLANT}, 'G95', 'CO09-PART', ${ACTOR})
      on conflict do nothing
    `);
  });

  // The configuration, through the screens that own it. Nothing below writes a
  // checking row by hand, because a hand-written row is not what a tenant has.
  await saveCheckingRule({ client, changedBy: ACTOR, mode: 'CREATE', checkingRule: RULE, description: 'Production availability', version: 0, reason: 'CO09 browser fixture' });
  await saveCheckingGroup({ client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: GROUP, description: 'Checked in QG01', noCheck: ' ', version: 0, reason: 'CO09 browser fixture' });
  await saveScopeOfCheck({ client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: GROUP, checkingRule: RULE, ...SCOPE, version: 0, reason: 'CO09 browser fixture' });
  for (const number of ['CO09-GOOD', 'CO09-PART', 'CO09-BULK', 'CO09-NONE']) {
    await assignCheckingGroup({
      client, changedBy: ACTOR, materialNumber: number, plant: PLANT, checkingGroup: GROUP,
      expectedVersion: 1, reason: 'CO09 browser fixture',
    });
  }
  await saveBomUsage({
    client, changedBy: ACTOR, usage: 'P', description: 'Production availability',
    productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
  });
  // The item category decides which marks an item may carry at all, so the fixture
  // grants the phantom and bulk allowances through its own maintenance service.
  await saveBomItemCategory({
    client, changedBy: ACTOR, category: 'S', description: 'Stock item', materialEntry: '+', quantityEntry: '+',
    allowPhantom: 'X', allowBulk: 'X',
  });
  await createMaterialBom({
    client, changedBy: ACTOR, materialNumber: 'CO09-GOOD', plant: PLANT, usage: 'P', alternative: '01',
    baseQuantity: '1', baseUnit: 'PC', validFrom: '2026-01-01',
    items: [
      { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CO09-PART', quantity: '20', unit: 'PC' },
      { itemNumber: '0020', itemCategory: 'S', componentMaterial: 'CO09-BULK', quantity: '3', unit: 'PC', bulkMaterial: 'X' },
    ],
  });
  console.log('  ✓ the bill of material that carries the bulk mark is maintained through its own screen');
  await saveCheckingControl({
    client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: TYPE_CHECKED, businessFunction: '1',
    noCheck: ' ', checkingRule: RULE, checkOnSave: ' ', version: 0, reason: 'CO09 browser fixture',
  });

  // ── The initial state, and the limits stated before the run ──────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Availability check for an order', exact: true })
    .waitFor({ timeout: 60_000 });
  await page.locator('[data-co09-state="initial"]').waitFor();
  const gaps = await page.locator('[data-co09-refusals] li').count();
  assert.ok(gaps >= 9, `the screen states ${gaps} limits before the run`);
  assert.match(await page.locator('[data-co09-form]').innerText(), /No button here saves/);
  console.log(`  ✓ an unnamed order is answered with a prompt, ${gaps} stated limits, and no saved state`);

  // A figure sits on the cell that carries it, so it is read from the cell.
  const figure = async (item: string, name: string) =>
    await page.locator(`tr[data-co09-component="${item}"] td[data-co09-${name}]`).getAttribute(`data-co09-${name}`);
  const elementRows = (item: string, type?: string) =>
    page.locator(`[data-co09-elements="${item}"] tbody tr${type ? `[data-co09-element="${type}"]` : ''}`);

  // ── The covered component ────────────────────────────────────────────────
  await page.goto(`${base}${ROUTE}?order=${ORDER}`, { waitUntil: 'domcontentloaded' });
  const covered = page.locator('tr[data-co09-component="10"]');
  await covered.waitFor();
  assert.equal(await covered.getAttribute('data-co09-outcome'), 'AVAILABLE');
  assert.equal(await covered.getAttribute('data-co09-committed'), 'not-stored');
  assert.equal(await covered.getAttribute('data-co09-material'), 'CO09-PART');
  // 5 in stock plus the open requisition of 25 plus the past-due one of 4: the scope's
  // own switches pick the elements, and nothing else is added to them.
  assert.equal(await figure('10', 'atp'), '34.000');
  assert.equal(await figure('10', 'covered'), '20.000');
  assert.equal(await figure('10', 'shortage'), '0.000');
  assert.match(await covered.innerText(), new RegExp(requirement), 'the requirement date the order carries');
  console.log('  ✓ the covered line names the date, the cumulation, the cover — and no committed quantity');

  // The dated elements the scope counted, each traceable to the stock/requirements list.
  assert.equal(await elementRows('10', 'PURCHASE_REQUISITION').count(), 2, 'both requisitions count, the past-due one included, because the scope leaves receipts in the past open');
  assert.equal(await elementRows('10', 'PRODUCTION_COMPONENT').count(), 0, 'the scope excludes dependent requirements, so component demand is not counted against the line either');
  assert.equal(await elementRows('10').count(), 3, 'the three elements the scope counts, in date order');
  console.log('  ✓ three dated elements stand behind the requirement, and the excluded kind is absent by the scope’s rule');

  // ── A rule that excludes a component is not a shortage ───────────────────
  assert.equal(await page.locator('tr[data-co09-component="20"]').getAttribute('data-co09-outcome'), 'EXCLUDED');
  assert.match(await page.locator('[data-co09-message="20"]').innerText(), /bulk material/i, 'the bulk item is named as the reason');
  assert.equal(await page.locator('tr[data-co09-component="30"]').getAttribute('data-co09-outcome'), 'NO_GROUP');
  assert.match(await page.locator('[data-co09-message="30"]').innerText(), /No group is not a default group/);
  assert.equal(await page.locator('tr[data-co09-component="40"]').getAttribute('data-co09-outcome'), 'UNDATED');
  assert.match(await page.locator('[data-co09-message="40"]').innerText(), /bill-of-material date are each rejected/);
  console.log('  ✓ a bulk item, an unassigned group and an undated line are three different answers');

  // ── The scope decides, switch by switch ──────────────────────────────────
  // Dependent requirements switched on brings the component demand onto the list:
  // this line's own 20 units stay out of the balance they are checked against, while
  // the 2 units another order needs on the same day are counted against it.
  await saveScopeOfCheck({
    client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: GROUP, checkingRule: RULE,
    ...SCOPE, dependentRequirements: 'X', version: 1, reason: 'CO09 browser fixture',
  });
  await page.goto(`${base}${ROUTE}?order=${ORDER}&item=10`, { waitUntil: 'domcontentloaded' });
  await covered.waitFor();
  assert.equal(await figure('10', 'atp'), '32.000', '34 of supply less the other order’s 2 units of the same day');
  assert.equal(await figure('10', 'covered'), '20.000');
  assert.equal(await elementRows('10', 'PRODUCTION_COMPONENT').count(), 2, 'this line’s own demand and the other order’s demand on the same day');
  assert.equal(await elementRows('10').count(), 5, 'five dated elements once the scope counts component demand');
  console.log('  ✓ one switch adds the component demand, and the line is still not covered by its own requirement');

  // Requisitions off the same scope leaves the stock alone, less that same-day demand.
  await saveScopeOfCheck({
    client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: GROUP, checkingRule: RULE,
    ...SCOPE, dependentRequirements: 'X', purchaseRequisitions: ' ', version: 2, reason: 'CO09 browser fixture',
  });
  await page.goto(`${base}${ROUTE}?order=${ORDER}&item=10`, { waitUntil: 'domcontentloaded' });
  await covered.waitFor();
  assert.equal(await covered.getAttribute('data-co09-outcome'), 'SHORT');
  assert.equal(await figure('10', 'atp'), '3.000', 'the stock of 5, less the 2 units another order needs the same day');
  assert.equal(await figure('10', 'covered'), '3.000');
  assert.equal(await figure('10', 'shortage'), '17.000');
  assert.equal(await elementRows('10', 'PURCHASE_REQUISITION').count(), 0, 'the requisitions are no longer counted');
  assert.equal(await elementRows('10').count(), 3, 'the stock and the two component requirements');
  assert.match(await page.locator('[data-co09-message="10"]').innerText(), /Bring in supply the scope counts/);
  console.log('  ✓ switching requisitions off the scope turns the same requirement into a shortage of 17');

  await saveScopeOfCheck({
    client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: GROUP, checkingRule: RULE,
    ...SCOPE, version: 3, reason: 'CO09 browser fixture',
  });

  // ── A configuration that does not stand is refused, not defaulted ────────
  await page.goto(`${base}${ROUTE}?order=${ORDER_UNCONTROLLED}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-co09-state="incomplete-config"]').waitFor();
  assert.match(await page.locator('[data-co09-state="incomplete-config"]').innerText(), /No checking control stands/);
  assert.match(await page.locator('[data-co09-state="incomplete-config"]').innerText(), /Define Checking Control \(OPJK\)/);
  assert.equal(await page.locator('tr[data-co09-component="10"] td[data-co09-atp]:not([data-co09-atp=""])').count(), 0, 'no figure is shown beside a refusal');
  console.log('  ✓ an order type with no checking control is refused by plant, type and business function');

  // The no-check indicator is a different answer again.
  await saveCheckingControl({
    client, changedBy: ACTOR, mode: 'CHANGE', plant: PLANT, orderType: TYPE_CHECKED, businessFunction: '1',
    noCheck: 'X', checkingRule: RULE, checkOnSave: ' ', version: 1, reason: 'CO09 browser fixture',
  });
  await page.goto(`${base}${ROUTE}?order=${ORDER}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-co09-state="not-checked"]').waitFor();
  assert.match(await page.locator('[data-co09-state="not-checked"]').innerText(), /marks this combination as not checked/);
  assert.equal(await page.locator('[data-co09-component="10"]').getAttribute('data-co09-outcome'), 'NOT_CHECKED');
  await saveCheckingControl({
    client, changedBy: ACTOR, mode: 'CHANGE', plant: PLANT, orderType: TYPE_CHECKED, businessFunction: '1',
    noCheck: ' ', checkingRule: RULE, checkOnSave: ' ', version: 2, reason: 'CO09 browser fixture',
  });
  console.log('  ✓ a standing no-check is reported as not checked, with the indicator named as the remedy');

  // ── A selection that asks for more is refused before anything is read ────
  await page.goto(`${base}${ROUTE}?order=${ORDER}&commit=1&storageLocation=SG01`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-co09-state="unsupported"]').waitFor();
  const refused = await page.locator('[data-co09-state="unsupported"]').innerText();
  assert.match(refused, /Committing a quantity is not this screen/);
  assert.match(refused, /storage-location level check is not this screen/);
  assert.equal(await page.locator('[data-co09-component]').count(), 0, 'a refused selection reads nothing');
  console.log('  ✓ commit and storage-location selections are refused by name, with no result rendered');

  // ── Nothing is written, and a second run answers the same ────────────────
  const state = async () => withTenant(client, (tx) => tx.execute(sql`
    select (select count(*)::text from production_order where client = ${client} and status = 'CREATED' and version = 1) as untouched_orders,
           (select count(*)::text from production_order_component where client = ${client}) as components,
           (select count(*)::text from production_order_component where client = ${client} and requirement_date is null) as undated,
           (select count(*)::text from change_document where client = ${client}) as documents,
           (select count(*)::text from reservation_header where client = ${client}) as reservations,
           (select count(*)::text from material_document where client = ${client}) as movements,
           (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${client}) as stock
  `) as unknown as Promise<Array<Record<string, string | null>>>);
  const before = await state();
  await page.goto(`${base}${ROUTE}?order=${ORDER}`, { waitUntil: 'domcontentloaded' });
  await covered.waitFor();
  const first = await figure('10', 'atp');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await covered.waitFor();
  const second = await figure('10', 'atp');
  const after = await state();

  assert.equal(first, '34.000', 'the scope the screens left standing counts stock and both requisitions');
  assert.equal(second, first, 'the second run answers the same, because the first took nothing');
  assert.deepEqual(after, before, 'no order status, no component date, no document, no reservation, no stock');
  const facts = before[0] as Record<string, string>;
  assert.equal(facts.untouched_orders, '2', 'both orders still stand created at version 1');
  assert.equal(facts.components, '5');
  assert.equal(facts.undated, '1', 'the undated line was not backfilled with a date');
  // The configuration services that built this fixture do record change documents, and
  // the count stands untouched across both runs above: the measure would have moved if
  // the check had written anything, so it is not a vacuous zero.
  assert.ok(Number(facts.documents) > 0, `the tenant carries ${facts.documents} change documents from the fixture, and deepEqual above shows the check added none`);
  assert.equal(facts.reservations, '0', 'a check opens no reservation');
  assert.equal(facts.movements, '0', 'a check posts no goods movement');
  assert.equal(facts.stock, '5.000', 'the stock the check read is the stock it left');
  console.log('  ✓ two runs, identical answers, and every table the check reads left exactly as it was');

  // The drill-down the screen offers: the same elements on the list that computed them.
  await page.locator('[data-co09-component="10"] a[href*="stock-requirements"]').click();
  await page.waitForURL(/\/production\/stock-requirements\?material=CO09-PART/);
  await page.getByRole('heading', { level: 1, name: 'Stock/Requirements List', exact: true }).waitFor();
  console.log('  ✓ the component drills into the stock/requirements list that supplied its elements');

  // The configuration the check resolved is the configuration the screens left behind.
  const controls = await listCheckingControls(client);
  assert.equal(controls.controls.filter((row) => row.plant === PLANT).length, 1, 'one control row stands: the checked order type, and deliberately none for the uncontrolled one');
  assert.equal(controls.controls.find((row) => row.orderType === TYPE_CHECKED && row.businessFunction === '1')?.noCheck, ' ');
  assert.equal(controls.gaps.length > 0, true, 'the configuration screen still states its own limits');
  console.log('  ✓ the check resolved the configuration exactly as the maintaining screens left it');
}
