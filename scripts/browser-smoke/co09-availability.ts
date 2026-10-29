import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import {
  assignCheckingGroup,
  saveCheckingGroup,
  saveCheckingRule,
  saveScopeOfCheck,
} from '../../src/modules/production/availability-check';
import { listCheckingControls, saveCheckingControl } from '../../src/modules/production/checking-control';
import { changeMaterialBom, createMaterialBom, saveBomItemCategory, saveBomUsage } from '../../src/modules/production/material-bom';
import { createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '../../src/modules/production/routing';
import { createWorkCenter, saveWorkCenterCategory } from '../../src/modules/production/work-center';
import { planSingleItem } from '../../src/modules/production/mrp-run';
import { convertPlannedOrder } from '../../src/modules/production/planned-order-conversion';
import { saveOrderTypeParameter } from '../../src/modules/production/order-type-parameters';
import { changeProductionOrder } from '../../src/modules/production/production-order-change';
import { checkProductionVersion, createProductionVersion } from '../../src/modules/production/production-version';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/production/order-availability';
const ACTOR = 'browser.admin';
const PLANT = 'QG01';
const GROUP = 'ZT';
const RULE = 'PP';
const TYPE_CHECKED = 'PP01';
const TYPE_UNCONTROLLED = 'PP02';
const ROUTING_GROUP = '50000909';

/**
 * The scope the check can answer with. `includeRestrictedUse` is the scope's "Include
 * restricted-use batches" switch — the label the maintaining form carries and the label
 * `availability-check.ts` validates it under — and the stock/requirements list draws
 * unrestricted-use and quality-inspection stock as one opening element with no
 * restricted-use element at all. So the scenario below is built with that switch blank:
 * blank asks for exactly what the ledger counts. `'X'` is its own leg, refused by name.
 */
const SCOPE = {
  includeSafetyStock: ' ',
  includeQualityStock: 'X',
  includeBlockedStock: ' ',
  includeRestrictedUse: ' ',
  purchaseOrders: ' ',
  purchaseRequisitions: 'X',
  plannedOrders: ' ',
  productionOrders: ' ',
  dependentRequirements: ' ',
  reservations: ' ',
  receiptsInPast: ' ',
} as const;

const shift = (iso: string, offset: number) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

export interface Co09Fixture {
  /** The order whose components the check answers for. */
  order: string;
  /** A second order, on a type with no checking control of its own. */
  orderUncontrolled: string;
  /** The requirement date conversion left on the checked component. */
  requirementDay: string;
}

/**
 * The fixture, standing on the writers a tenant stands on.
 *
 * No order row is inserted here. An order component carries a requirement date only when
 * conversion copied one from a matching dependent requirement, so the shortage is planned
 * by single-item planning, each proposal is converted by planned-order conversion, and
 * the date the check reads is the date conversion stored — read back off the order, not
 * chosen by this file. The two
 * marks the screen reports as refusals are applied the way a tenant applies them after the
 * fact: the bulk mark is set on the bill of material after conversion, because creating the
 * order refuses a bulk item outright rather than dropping it silently, and the undated line
 * is added by the change screen, because a component the bill does not carry has no
 * dependent requirement to date it. The component materials are left out of the planning
 * candidate set on purpose: their own MRP view is not created, so the run proposes nothing
 * below the finished good and the requisitions below are the only supply the check can see.
 */
export async function co09AvailabilityFixture(client: string): Promise<Co09Fixture> {
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
    // The number ranges the supported writers allocate from: a planned order, an MRP run,
    // and the order itself. Nothing here picks an order number by hand.
    await defineRange(tx, { client, objectCode: 'PLANORD', subObject: '*', prefix: 'QP', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'MRPRUN', subObject: '*', prefix: 'QR', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'PRODORDER', subObject: '*', prefix: 'QA', numberLength: 7, createdBy: ACTOR });
    // The materials, counted in a unit the ledger carries to three places. A piece is held
    // with no decimals, and a quantity read back out of a numeric column arrives as 1.000,
    // which the version's lot check then refuses: so a planned order for a piece-measured
    // material cannot be converted at all. The counting here stands on the unit the planning
    // and availability tests already use.
    // The checking group is not among them: it is assigned through the
    // availability-check service below, because an unassigned group must refuse.
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, v.number, v.name, t.material_type, 'KG', ${ACTOR}
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      cross join (values
        ('CO09-GOOD', 'Assembled good'),
        ('CO09-OTHER', 'Second assembled good'),
        ('CO09-PART', 'Checked component'),
        ('CO09-BULK', 'Bulk component'),
        ('CO09-FREE', 'Component without a checking group'),
        ('CO09-NONE', 'Component with nothing counted')
      ) as v(number, name)
      on conflict do nothing
    `);
    // The two finished goods stand in the planning candidate set, one unit of safety stock
    // deep, with no lead time. The four components deliberately do not: their MRP view is
    // not created, so the run stops below the finished good.
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, mrp_type, safety_stock, reorder_point,
                                  mrp_status, procurement_type, lot_sizing, in_house_production_days, planned_delivery_days, created_by)
      values
        (${client}, 'CO09-GOOD', ${PLANT}, 'REQUIREMENTS', 1, 0, 'CREATED', 'MAKE', 'EXACT', 0, 0, ${ACTOR}),
        (${client}, 'CO09-OTHER', ${PLANT}, 'REQUIREMENTS', 1, 0, 'CREATED', 'MAKE', 'EXACT', 0, 0, ${ACTOR}),
        (${client}, 'CO09-PART', ${PLANT}, 'REQUIREMENTS', 0, 0, 'NOT_CREATED', 'BUY', 'EXACT', 0, 0, ${ACTOR}),
        (${client}, 'CO09-BULK', ${PLANT}, 'REQUIREMENTS', 0, 0, 'NOT_CREATED', 'BUY', 'EXACT', 0, 0, ${ACTOR}),
        (${client}, 'CO09-FREE', ${PLANT}, 'REQUIREMENTS', 0, 0, 'NOT_CREATED', 'BUY', 'EXACT', 0, 0, ${ACTOR}),
        (${client}, 'CO09-NONE', ${PLANT}, 'REQUIREMENTS', 0, 0, 'NOT_CREATED', 'BUY', 'EXACT', 0, 0, ${ACTOR})
      on conflict (client, material_number, plant) do nothing
    `);
  });

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
    baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01',
    items: [
      { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CO09-PART', quantity: '20', unit: 'KG' },
      { itemNumber: '0020', itemCategory: 'S', componentMaterial: 'CO09-BULK', quantity: '3', unit: 'KG' },
      { itemNumber: '0030', itemCategory: 'S', componentMaterial: 'CO09-FREE', quantity: '7', unit: 'KG' },
    ],
  });
  await createMaterialBom({
    client, changedBy: ACTOR, materialNumber: 'CO09-OTHER', plant: PLANT, usage: 'P', alternative: '01',
    baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01',
    items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CO09-PART', quantity: '2', unit: 'KG' }],
  });
  console.log('  ✓ the bill of material the planning run explodes is maintained through its own screen');
  // The production version requires a task list, so the routing the order snapshot copies is
  // maintained here too. One routing, assigned to both finished goods, and no standard value
  // key: nothing in this target confirms a ticket.
  await saveRoutingTaskListType({ client, changedBy: ACTOR, taskListType: 'N', description: 'Availability routing' });
  await saveRoutingUsage({ client, changedBy: ACTOR, usage: '1', description: 'Production' });
  await saveRoutingControlKey({ client, changedBy: ACTOR, controlKey: 'PP01', description: 'Production step' });
  await saveWorkCenterCategory({ client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
  await createWorkCenter({ client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC91', category: 'MACH', description: 'Assembly' });
  await createRouting({
    client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
    routingGroup: ROUTING_GROUP, groupCounter: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01',
    assignments: [{ materialNumber: 'CO09-GOOD' }, { materialNumber: 'CO09-OTHER' }],
    operations: [{ operationNumber: '0010', shortText: 'Build', workCenter: 'WC91', controlKey: 'PP01' }],
  });
  for (const number of ['CO09-GOOD', 'CO09-OTHER']) {
    await createProductionVersion({
      client, changedBy: ACTOR, materialNumber: number, plant: PLANT, productionVersion: 'V01',
      validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01',
      taskListType: 'N', routingGroup: ROUTING_GROUP, groupCounter: '01',
    });
    await checkProductionVersion(client, number, PLANT, 'V01', ACTOR);
    await saveOrderTypeParameter({
      client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT,
      orderType: number === 'CO09-GOOD' ? TYPE_CHECKED : TYPE_UNCONTROLLED,
      taskListType: '', productionVersionSelection: '0', version: 0, reason: 'CO09 browser fixture',
    });
  }

  // Each order is planned and converted, which is the only supported way a component of
  // this order comes to carry a requirement date at all.
  const proposed: Array<{ orderType: string; plannedOrder: string }> = [];
  for (const [material, orderType] of [['CO09-GOOD', TYPE_CHECKED], ['CO09-OTHER', TYPE_UNCONTROLLED]] as const) {
    const run = await planSingleItem({
      client, requestedBy: ACTOR, requestKey: `co09-plan-${material}`, materialNumber: material, plant: PLANT,
      processingKey: 'NEUPL', confirmRegenerative: true,
    });
    const proposal = run.proposals.find((row) => row.materialNumber === material && row.proposalType === 'PLANNED_ORDER' && row.documentNumber);
    assert.ok(proposal, `planning ${material} proposed no planned order. Run ${run.runNumber} planned ${run.materialsPlanned} of ${run.materialsSelected}.`);
    proposed.push({ orderType, plannedOrder: String(proposal.documentNumber) });
  }
  const orders: string[] = [];
  for (const proposal of proposed) {
    const converted = await convertPlannedOrder({
      client, changedBy: ACTOR, orderNumber: proposal.plannedOrder, orderType: proposal.orderType,
    });
    assert.equal(converted.status, 'CONVERTED', `planned order ${proposal.plannedOrder} did not convert`);
    assert.equal(converted.reconciliation, 'COMPLETE', `conversion left demand unreconciled on ${proposal.plannedOrder}`);
    assert.ok(converted.productionOrderNumber, `conversion of ${proposal.plannedOrder} named no order`);
    orders.push(String(converted.productionOrderNumber));
  }
  const [order, orderUncontrolled] = orders;

  // The component the bill does not carry, added where a component is added: no bill
  // identity, so no dependent requirement, so no date. The check answers that as UDATED.
  await changeProductionOrder({
    client, changedBy: ACTOR, orderNumber: order, expectedVersion: 1,
    components: [{ materialNumber: 'CO09-NONE', requiredQuantity: '6', unit: 'KG' }],
  });
  // The bulk mark is set on the bill after conversion, because an order snapshot refuses a
  // bulk item instead of dropping it. The check reads the mark off the standing bill, so the
  // line is excluded while the date conversion stored stays.
  await changeMaterialBom({
    client, changedBy: ACTOR, materialNumber: 'CO09-GOOD', plant: PLANT, usage: 'P', alternative: '01',
    baseQuantity: '1', baseUnit: 'KG', validFrom: '2020-01-01', version: 1,
    items: [
      { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'CO09-PART', quantity: '20', unit: 'KG' },
      { itemNumber: '0020', itemCategory: 'S', componentMaterial: 'CO09-BULK', quantity: '3', unit: 'KG', bulkMaterial: 'X' },
      { itemNumber: '0030', itemCategory: 'S', componentMaterial: 'CO09-FREE', quantity: '7', unit: 'KG' },
    ],
  });
  const [dated] = await withTenant(client, (tx) => tx.execute(sql`
    select coalesce(requirement_date::text, '') as day
      from production_order_component
     where client = ${client} and order_number = ${order} and item_number = 10
  `)) as unknown as Array<{ day: string }>;
  if (!dated?.day) throw new Error('the converted order carries no requirement date on its first component');
  const requirementDay = dated.day;

  // The supply the scope counts, dated against the date the order actually carries: one
  // receipt inside the horizon and one that fell due before it.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, 'CO09-PART', ${PLANT}, 'SG01', 'UNRESTRICTED', 5, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_requisition_item (client, requisition_number, item_number, short_text, quantity, unit,
                                            requisition_date, delivery_date, plant, purchasing_group, material_number, created_by)
      values (${client}, '950001', 1, 'Open for the checked requirement', 25, 'KG', ${shift(requirementDay, -20)}, ${shift(requirementDay, -4)}, ${PLANT}, 'G95', 'CO09-PART', ${ACTOR}),
             (${client}, '950002', 1, 'Past due', 4, 'KG', ${shift(requirementDay, -26)}, ${shift(requirementDay, -13)}, ${PLANT}, 'G95', 'CO09-PART', ${ACTOR})
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
  await saveCheckingControl({
    client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: TYPE_CHECKED, businessFunction: '1',
    noCheck: ' ', checkingRule: RULE, checkOnSave: ' ', version: 0, reason: 'CO09 browser fixture',
  });
  return { order, orderUncontrolled, requirementDay };
}

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

  const fixture = await co09AvailabilityFixture(client);
  const { order: ORDER, orderUncontrolled: ORDER_UNCONTROLLED, requirementDay: requirement } = fixture;

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
  // Each of those figures reached the balance in the material's own base unit: a row standing in
  // another unit is converted by the material's conversion or it refuses the line outright.
  const elementUnits = await elementRows('10').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-co09-element-unit')));
  assert.deepEqual(elementUnits, ['KG', 'KG', 'KG'], 'every counted element carries the base unit of the material it is checked for');
  console.log('  ✓ three dated elements stand behind the requirement, each in the base unit, and the excluded kind is absent by the scope’s rule');

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

  // ── A scope that asks for restricted-use batches is refused, not approximated ──
  // One switch changed against the scope that answered 34.000 above, so the refusal can
  // only come from the flag. The screen must say which switch it could not honour, and
  // it must show no quantity beside that answer.
  await saveScopeOfCheck({
    client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: GROUP, checkingRule: RULE,
    ...SCOPE, includeRestrictedUse: 'X', version: 3, reason: 'CO09 browser fixture',
  });
  await page.goto(`${base}${ROUTE}?order=${ORDER}&item=10`, { waitUntil: 'domcontentloaded' });
  await covered.waitFor();
  assert.equal(await covered.getAttribute('data-co09-outcome'), 'UNSUPPORTED', 'restricted-use inclusion is a stock split the ledger cannot carry');
  const refusedStock = await page.locator('[data-co09-message="10"]').innerText();
  assert.match(refusedStock, /restricted-use batches/, 'the switch that cannot be honoured is named');
  assert.match(refusedStock, /The refusal is the answer; an approximate quantity is not/);
  assert.equal(await page.locator('tr[data-co09-component="10"] td[data-co09-atp]:not([data-co09-atp=""])').count(), 0, 'no cumulated figure is published for a refused scope');
  assert.equal(await page.locator('tr[data-co09-component="10"] td[data-co09-covered]:not([data-co09-covered=""])').count(), 0, 'no cover either');
  assert.equal(await elementRows('10').count(), 0, 'the refused line carries no element list');
  console.log('  ✓ a scope that includes restricted-use batches is refused by name, with no quantity beside it');

  await saveScopeOfCheck({
    client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: GROUP, checkingRule: RULE,
    ...SCOPE, version: 4, reason: 'CO09 browser fixture',
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
    select (select count(*)::text from production_order where client = ${client} and status = 'CREATED') as untouched_orders,
           (select version::text from production_order where client = ${client} and order_number = ${ORDER}) as order_version,
           (select version::text from production_order where client = ${client} and order_number = ${ORDER_UNCONTROLLED}) as uncontrolled_version,
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
  assert.equal(facts.untouched_orders, '2', 'both orders still stand created');
  assert.equal(facts.order_version, '2', 'the fixture added one component to the checked order; the check did not');
  assert.equal(facts.uncontrolled_version, '1', 'the other order was never touched after conversion');
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
