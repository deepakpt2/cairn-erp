/**
 * Standard cost estimate (CK11N / CK13N).
 *
 * What is worth proving: the roll-up is bottom-up (a made component costs what its own components and
 * operations cost, never its standard price); the lot size is applied before the division (a
 * fixed-quantity item makes cost-one-and-multiply wrong); the cache is keyed on quantity as well as
 * material; every refusal names its object; nothing but the estimate is written — above all never
 * `standardPrice`; a second estimate supersedes rather than deletes; and the authority is judged by the
 * service. Numbers are asserted through the service's own arithmetic (`materialAmount`,
 * `activityAmount`, `componentRequirementQuantity`), not hand-worked constants, except where the
 * constant is the point.
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { toScaled } from '../src/platform/posting/decimal';
import { explodeBom } from '../src/modules/production/bom-explosion';
import {
  activityAmount, COST_ESTIMATE_CAPABILITY, CostEstimateError, createCostEstimate, getCostEstimate, listCostEstimates, materialAmount,
  type CostEstimateInput, type CostEstimateView,
} from '../src/modules/production/cost-estimate';
import { createMaterialBomForProvisioning as createMaterialBom, saveBomItemCategory, saveBomStatus, saveBomUsage } from '../src/modules/production/material-bom';
import { componentRequirementQuantity, SCALE } from '../src/modules/production/mrp-explosion';
import { createProductionVersion, selectProductionVersion } from '../src/modules/production/production-version';
import { createRouting, saveRoutingControlKey, saveRoutingStatus, saveRoutingTaskListType, saveRoutingUsage } from '../src/modules/production/routing';
import { createWorkCenter, saveWorkCenterCategory } from '../src/modules/production/work-center';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const ACTOR = 'CK11N-TEST';
const PLANT = '1000';
const DATE = '2026-03-15';
const YEAR = 2026;
let tenant: TestTenant;
let client = '';
let costing: FinanceActor;
let outsider: FinanceActor;
let currency = '';

async function expectRefusal(promise: Promise<unknown>, fragment: string | RegExp): Promise<CostEstimateError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(CostEstimateError);
    expect((error as Error).message).toMatch(fragment);
    expect((error as CostEstimateError).remedy, 'a refusal names what to do next').toBeTruthy();
    return error as CostEstimateError;
  }
  throw new Error(`Expected a CostEstimateError matching ${fragment}, nothing was thrown.`);
}

const q3 = (v: string) => toScaled(v, SCALE);
const m4 = (v: string) => toScaled(v, 4);
const shown3 = (v: bigint) => (Number(v) / 1000).toFixed(3);
const required = (parent: string, item: string, base: string, scrap: string | null = null, fixed = false) =>
  componentRequirementQuantity({ parentQuantity: q3(parent), itemQuantity: q3(item), baseQuantity: q3(base), scrapPercent: scrap, fixed })!;

async function material(code: string, procurement: 'MAKE' | 'BUY' | 'BOTH' = 'MAKE', baseUnit = 'PC') {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, ${code}, ${`Material ${code}`}, t.material_type, ${baseUnit}, ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing`);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
        fixed_lot_size, safety_stock, reorder_point, planned_delivery_days, in_house_production_days, purchasing_group, mrp_status, created_by)
      values (${client}, ${code}, ${PLANT}, 'REQUIREMENTS', '001', ${procurement}, 'EXACT', '0', '0', '0', 0, 0, '001', 'MAINTAINED', ${ACTOR})
      on conflict (client, material_number, plant) do update set procurement_type = excluded.procurement_type`);
  });
}

async function price(code: string, o: { control?: 'STANDARD' | 'MOVING_AVERAGE'; standard?: string; moving?: string; unit?: string; currency?: string } = {}) {
  await withTenant(client, (tx) => tx.execute(sql`
    insert into material_valuation (client, material_number, valuation_area, price_control, standard_price, moving_average_price, price_unit, currency, accounting_status, created_by)
    values (${client}, ${code}, ${PLANT}, ${o.control ?? 'STANDARD'}, ${o.standard ?? '0'}, ${o.moving ?? '0'}, ${o.unit ?? '1'}, ${o.currency ?? currency}, 'MAINTAINED', ${ACTOR})
    on conflict (client, material_number, valuation_area) do nothing`));
}

type Item = { component: string; quantity?: string; scrap?: string; fixed?: boolean; phantom?: boolean; coproduct?: boolean; special?: string };
type Op = { number?: string; workCenter?: string; quantity?: string; base?: string; controlKey?: string };

let routingGroup = 62000000;
/** A made material: BOM (usage P, alternative 01, released for costing), routing, and a production version. */
async function make(code: string, items: Item[], o: { base?: string; ops?: Op[]; bomStatus?: string; routingStatus?: string; procurement?: 'MAKE' | 'BOTH' } = {}) {
  await material(code, o.procurement ?? 'MAKE');
  await createMaterialBom({
    client, changedBy: ACTOR, materialNumber: code, plant: PLANT, usage: 'P', alternative: '01', status: o.bomStatus ?? '01', baseQuantity: o.base ?? '1', baseUnit: 'PC', validFrom: '2020-01-01',
    items: items.map((item, index) => ({
      itemNumber: String((index + 1) * 10).padStart(4, '0'), itemCategory: item.special ? 'X' : 'S', componentMaterial: item.component, quantity: item.quantity ?? '1', unit: 'PC',
      scrapPercent: item.scrap ?? null, fixedQuantity: item.fixed ? 'X' : ' ', phantom: item.phantom ? 'X' : ' ', coproduct: item.coproduct ? 'X' : ' ', specialProcurement: item.special ?? null,
    })),
  });
  let group = '';
  {
    group = String(++routingGroup);
    const ops = o.ops ?? [{}];
    await createRouting({
      client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1', status: o.routingStatus ?? '1', routingGroup: group, groupCounter: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01', assignments: [{ materialNumber: code }],
      operations: ops.map((op, i) => ({
        operationNumber: op.number ?? String((i + 1) * 10).padStart(4, '0'), shortText: `Op ${i + 1}`, workCenter: op.workCenter ?? 'WC01', controlKey: op.controlKey ?? 'PP01',
        operationQuantity: op.quantity ?? '1', operationUnit: 'H', baseQuantity: op.base ?? '1', baseUnit: 'PC',
      })),
    });
  }
  await createProductionVersion({
    client, changedBy: ACTOR, materialNumber: code, plant: PLANT, productionVersion: '0001', validFrom: '2020-01-01', lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
    bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: group, groupCounter: '01',
  });
}

const cost = (code: string, over: Partial<CostEstimateInput> = {}, actor: FinanceActor = costing): Promise<CostEstimateView> =>
  createCostEstimate({ client, materialNumber: code, plant: PLANT, costingDate: DATE, actor: ACTOR, ...over }, { authorization: actor.authorization });
const line = (view: CostEstimateView, component: string) => view.items.find((i) => i.componentMaterial === component && i.itemType === 'MATERIAL' && i.level === 1)!;
const sum = (view: CostEstimateView, pick: (i: CostEstimateView['items'][number]) => boolean = () => true) =>
  view.items.filter((i) => i.inTotal && pick(i)).reduce((t, i) => t + m4(i.amount), 0n);
const standardPrices = () => withTenant(client, async (tx) => (await tx.execute(sql`
  select material_number, standard_price::text as standard_price, moving_average_price::text as moving_average_price, version
    from material_valuation where client = ${client} order by material_number`)) as unknown as Array<Record<string, string>>);

beforeAll(async () => {
  tenant = await createTenant('ck11n-estimate');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: YEAR });
  await saveBomUsage({ client, changedBy: ACTOR, usage: 'P', description: 'Production', productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.' });
  await saveBomItemCategory({ client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+', allowPhantom: 'X', allowBulk: 'X', allowCoproduct: 'X', allowFixedQuantity: 'X' });
  await saveBomItemCategory({ client, changedBy: ACTOR, category: 'X', description: 'Stock, special procurement', materialEntry: '+', quantityEntry: '+', allowSpecialProcurement: 'X' });
  await saveBomStatus({ client, changedBy: ACTOR, status: '01', description: 'Released for costing', releasedForMrp: 'X', releasedForCosting: 'X', releasedForOrders: 'X' });
  await saveBomStatus({ client, changedBy: ACTOR, status: '02', description: 'Not for costing', releasedForMrp: 'X', releasedForCosting: ' ', releasedForOrders: 'X' });
  await saveRoutingTaskListType({ client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
  await saveRoutingUsage({ client, changedBy: ACTOR, usage: '1', description: 'Production' });
  await saveRoutingStatus({ client, changedBy: ACTOR, status: '1', description: 'Released', releasedForScheduling: 'X', releasedForCosting: 'X', releasedForOrders: 'X' });
  await saveRoutingStatus({ client, changedBy: ACTOR, status: '2', description: 'Not for costing', releasedForScheduling: 'X', releasedForCosting: ' ', releasedForOrders: 'X' });
  await saveRoutingControlKey({ client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal, costed', costing: 'X' });
  await saveRoutingControlKey({ client, changedBy: ACTOR, controlKey: 'PP02', description: 'Not costed', costing: ' ' });
  await saveRoutingControlKey({ client, changedBy: ACTOR, controlKey: 'PP03', description: 'External', costing: 'X', externalProcessing: 'X' });
  await saveWorkCenterCategory({ client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
  for (const wc of ['WC01', 'WC02', 'WC03', 'WC04', 'WC05']) await createWorkCenter({ client, changedBy: ACTOR, plant: PLANT, workCenter: wc, category: 'MACH', description: wc });

  // The controlling area, its currency, and the activity prices (plan version 000, March 2026).
  const [area] = (await withTenant(client, (tx) => tx.execute(sql`select currency from controlling_area where client = ${client} and controlling_area = 'A000'`))) as unknown as Array<{ currency: string }>;
  currency = String(area.currency).trim();
  await withTenant(client, async (tx) => {
    await tx.execute(sql`insert into controlling_area_company (client, controlling_area, company_code, created_by) values (${client}, 'A000', '1000', ${ACTOR}) on conflict do nothing`);
    for (const [wc, centre, type, line] of [['WC01', 'CC1000', 'LAB01', 1], ['WC02', 'CC2000', 'MACH2', 1], ['WC04', 'CC1000', 'LAB01', 1], ['WC04', 'CC2000', 'MACH2', 2], ['WC05', 'CC1000', null, 1]] as const) {
      await tx.execute(sql`
        insert into work_center_costing (client, plant, work_center, line_number, valid_from, valid_to, controlling_area, cost_center, activity_type, created_by)
        values (${client}, ${PLANT}, ${wc}, ${line}, '2020-01-01', '9999-12-31', 'A000', ${centre}, ${type}, ${ACTOR})`);
    }
    for (const [centre, type, fixed, variable, unit] of [['CC1000', 'LAB01', '10.00', '5.00', 1], ['CC2000', 'MACH2', '40.00', '0.00', 10]] as const) {
      await tx.execute(sql`
        insert into activity_rate (client, controlling_area, plan_version, fiscal_year, period, cost_center, activity_type, planned_quantity, fixed_price, variable_price, price_unit, created_by)
        values (${client}, 'A000', '000', ${YEAR}, 3, ${centre}, ${type}, 100, ${fixed}, ${variable}, ${unit}, ${ACTOR})`);
    }
  });

  // Components. RAW2 is moving-average with a different (wrong) standard price: the branch must be the stated one.
  for (const c of ['RAW1', 'RAW2', 'RAW3', 'RAW4', 'RAWF', 'RAWV', 'RAWZ']) await material(c, 'BUY');
  await material('RAWE', 'BUY');
  await price('RAW1', { standard: '2.00' });
  await price('RAW2', { control: 'MOVING_AVERAGE', standard: '99.00', moving: '1.50' });
  await price('RAW3', { standard: '120.00', unit: '1000' });
  await price('RAW4', { standard: '3.25' });
  await price('RAWF', { standard: '1.00' });
  await price('RAWV', { standard: '2.00' });
  await price('RAWZ', { standard: '0' });
  await price('RAWE', { standard: '5.00', currency: currency === 'EUR' ? 'JPY' : 'EUR' });

  // SUB: made from RAW2, one operation at WC02; its standard price is deliberately NOT its cost.
  await make('SUB', [{ component: 'RAW2', quantity: '4' }], { ops: [{ workCenter: 'WC02', quantity: '3', base: '1' }] });
  await price('SUB', { standard: '999.00' });
  // FG: the finished good, lot 10.
  await make('FG', [
    { component: 'SUB', quantity: '2' },
    { component: 'RAW1', quantity: '5', scrap: '10' },
    { component: 'RAW2', quantity: '3', fixed: true },
    { component: 'RAW3', quantity: '1' },
  ], { base: '10', ops: [{ workCenter: 'WC01', quantity: '3', base: '1' }] });
  await price('FG', { standard: '7.00' });
  // SUBF: a fixed item and a variable one; used twice by FGC at two quantities.
  await make('SUBF', [{ component: 'RAWF', quantity: '2', fixed: true }, { component: 'RAWV', quantity: '1' }], { ops: [{ workCenter: 'WC01', quantity: '1', base: '1' }] });
  await make('FGC', [{ component: 'SUBF', quantity: '2' }, { component: 'SUBF', quantity: '3' }]);
  // A BOTH component with no production version takes its price; a phantom rolls into its parent.
  await material('MIXB', 'BOTH');
  await price('MIXB', { standard: '4.00' });
  await make('PHAN', [{ component: 'RAW1', quantity: '2' }]);
  await make('FGP', [{ component: 'MIXB', quantity: '1' }, { component: 'PHAN', quantity: '1', phantom: true }]);

  costing = await createFinanceActor(client, { capabilities: [COST_ESTIMATE_CAPABILITY] });
  outsider = await createFinanceActor(client, { capabilities: ['PROD.BOM.DISPLAY'] });
}, 600_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('the quantity and the roll-up', () => {
  it('1. a single-level BOM costs to the sum of its components’ prices and the operation', async () => {
    await make('SIMP', [{ component: 'RAW1', quantity: '2' }, { component: 'RAW4', quantity: '1' }]);
    const view = await cost('SIMP');
    expect(view.costingLotSize).toBe('1.000');
    const expected = materialAmount(required('1', '2', '1'), m4('2.00'), q3('1')) + materialAmount(required('1', '1', '1'), m4('3.25'), q3('1'))
      + activityAmount(q3('1'), q3('1'), q3('1'), 1500n, 1n);
    expect(m4(view.totalCost)).toBe(expected);
    expect(sum(view)).toBe(expected);
  });

  it('2. a multi-level BOM is costed bottom-up: a made component costs its own components and operations, not its standard price', async () => {
    const view = await cost('FG');
    const subQuantity = required('10', '2', '10');                       // 2.000 at lot 10
    const subRaw2 = required(shown3(subQuantity), '4', '1');             // 8.000
    const subCost = materialAmount(subRaw2, m4('1.50'), q3('1'))          // RAW2 on its MOVING_AVERAGE price
      + activityAmount(q3('3'), q3('1'), subQuantity, 4000n, 10n);        // WC02: 40.00 per 10 → 4 per hour
    const rollUp = view.items.find((i) => i.componentMaterial === 'SUB' && i.level === 1)!;
    expect(rollUp).toMatchObject({ priceSource: 'COSTED', inTotal: true });
    expect(m4(rollUp.amount)).toBe(subCost);
    expect(m4(rollUp.amount)).not.toBe(materialAmount(subQuantity, m4('999.00'), q3('1')));
    // Its own lines follow it as explanation, one level down, and are not added twice.
    const explained = view.items.filter((i) => !i.inTotal);
    expect(explained.map((i) => i.componentMaterial ?? i.operationNumber)).toEqual(expect.arrayContaining(['RAW2', '0010']));
    expect(explained.every((i) => i.level >= 1)).toBe(true);
  });

  it('3. scrap increases a component’s costed quantity', async () => {
    const view = await cost('FG');
    const plain = required('10', '5', '10');
    const scrapped = required('10', '5', '10', '10');
    expect(scrapped).toBeGreaterThan(plain);
    expect(line(view, 'RAW1').quantity).toBe(shown3(scrapped));
    expect(m4(line(view, 'RAW1').amount)).toBe(materialAmount(scrapped, m4('2.00'), q3('1')));
  });

  it('4. a fixed-quantity item does not scale with the lot size', async () => {
    const small = await cost('FG', { costingLotSize: '10' });
    const large = await cost('FG', { costingLotSize: '1000' });
    expect(line(small, 'RAW2').quantity).toBe('3.000');
    expect(line(large, 'RAW2').quantity).toBe('3.000');
    expect(line(large, 'RAW1').quantity).not.toBe(line(small, 'RAW1').quantity);
  });

  it('5, 6. costing at lot 1 and multiplying by 100 differs from costing at lot 100; the second is right and unit cost = total / lot', async () => {
    const one = await cost('FGC', { costingLotSize: '1' });
    const hundred = await cost('FGC', { costingLotSize: '100' });
    const multiplied = m4(one.totalCost) * 100n;
    expect(m4(hundred.totalCost)).not.toBe(multiplied);
    // Rebuilt through the same arithmetic: SUBF at 200 and 300 units, the fixed item once per use.
    let expected = activityAmount(q3('1'), q3('1'), q3('100'), 1500n, 1n);   // FGC's own operation, at the lot
    for (const used of ['2', '3']) {
      const sub = required('100', used, '1');
      expected += materialAmount(required(shown3(sub), '2', '1', null, true), m4('1.00'), q3('1'))
        + materialAmount(required(shown3(sub), '1', '1'), m4('2.00'), q3('1'))
        + activityAmount(q3('1'), q3('1'), sub, 1500n, 1n);
    }
    expect(m4(hundred.totalCost)).toBe(expected);
    expect(m4(hundred.unitCost)).toBe((m4(hundred.totalCost) * 1000n + q3('100') / 2n) / q3('100'));
    expect(m4(one.unitCost)).toBe((m4(one.totalCost) * 1000n + q3('1') / 2n) / q3('1'));
  });

  it('5b. a component used twice at two quantities is costed at each (the cache is keyed on quantity)', async () => {
    const view = await cost('FGC', { costingLotSize: '1' });
    const uses = view.items.filter((i) => i.componentMaterial === 'SUBF' && i.level === 1);
    expect(uses.map((u) => u.quantity)).toEqual(['2.000', '3.000']);
    const perUnit = uses.map((u) => (m4(u.amount) * 1000n) / q3(u.quantity));
    expect(perUnit[0]).not.toBe(perUnit[1]);     // fixed items make cost per unit vary with quantity
    for (const use of uses) {
      const n = q3(use.quantity);
      expect(m4(use.amount), `use at ${use.quantity}`).toBe(
        materialAmount(q3('2'), m4('1.00'), q3('1')) + materialAmount(n, m4('2.00'), q3('1')) + activityAmount(q3('1'), q3('1'), n, 1500n, 1n));
    }
  });

  it('7, 8. an operation costs consumption × price, and the activity price unit is applied', async () => {
    const view = await cost('FG', { costingLotSize: '10' });
    const op = view.items.find((i) => i.itemType === 'ACTIVITY' && i.level === 0)!;
    expect(op).toMatchObject({ operationNumber: '0010', workCenter: 'WC01', costCenter: 'CC1000', activityType: 'LAB01', priceSource: 'ACTIVITY_PLAN' });
    expect(m4(op.amount)).toBe(activityAmount(q3('3'), q3('1'), q3('10'), 1500n, 1n));
    const sub = view.items.find((i) => i.itemType === 'ACTIVITY' && i.workCenter === 'WC02')!;
    expect(sub).toMatchObject({ costCenter: 'CC2000', activityType: 'MACH2', priceUnit: '10.000', price: '40.0000' });
    expect(m4(sub.amount)).toBe(activityAmount(q3('3'), q3('1'), q3('2'), 4000n, 10n));
  });

  it('component price follows the price control and is divided by the price unit, the branch stated on every line', async () => {
    const view = await cost('FG');
    expect(line(view, 'RAW2')).toMatchObject({ priceSource: 'MOVING_AVERAGE', price: '1.5000' });
    expect(line(view, 'RAW1').priceSource).toBe('STANDARD');
    expect(line(view, 'RAW3')).toMatchObject({ priceSource: 'STANDARD', priceUnit: '1000.000' });
    expect(m4(line(view, 'RAW3').amount)).toBe(materialAmount(required('10', '1', '10'), m4('120.00'), q3('1000')));
  });

  it('a BOTH component with no production version takes its price; a phantom is costed from its BOM and rolled up', async () => {
    const view = await cost('FGP');
    expect(line(view, 'MIXB')).toMatchObject({ priceSource: 'STANDARD', price: '4.0000' });
    const phantom = view.items.find((i) => i.componentMaterial === 'PHAN' && i.level === 1)!;
    expect(phantom.priceSource).toBe('COSTED');
    expect(m4(phantom.amount)).toBe(materialAmount(required('1', '2', '1'), m4('2.00'), q3('1')));
    expect(view.items.filter((i) => i.itemType === 'ACTIVITY' && i.workCenter !== null && i.itemText?.includes('PHAN'))).toHaveLength(0);
  });

  it('16. the split: material + activity + overhead (zero) = total, by origin across levels', async () => {
    const view = await cost('FG');
    expect(view.overheadCost).toBe('0.0000');
    expect(view.overheadNote).toMatch(/no costing sheet/);
    expect(m4(view.materialCost) + m4(view.activityCost) + m4(view.overheadCost)).toBe(m4(view.totalCost));
    expect(sum(view)).toBe(m4(view.totalCost));
    // Both operations (FG’s and SUB’s) are activity; every bought component at every level is material.
    const operations = view.items.filter((i) => i.itemType === 'ACTIVITY').reduce((t, i) => t + m4(i.amount), 0n);
    expect(m4(view.activityCost)).toBe(operations);
  });

  it('an operation whose control key is not relevant for costing is listed and not costed', async () => {
    await make('NOCOST', [{ component: 'RAW1' }], { ops: [{ controlKey: 'PP02' }, { number: '0020', workCenter: 'WC01', quantity: '1', base: '1' }] });
    const view = await cost('NOCOST');
    const skipped = view.items.find((i) => i.priceSource === 'NOT_COSTED')!;
    expect(skipped).toMatchObject({ operationNumber: '0010', amount: '0.0000' });
    expect(skipped.itemText).toMatch(/not relevant for costing/);
  });
});

describe('refusals, each naming its object', () => {
  it('9. a work centre with two costing lines is refused, naming both activity types', async () => {
    await make('TWOLINE', [{ component: 'RAW1' }], { ops: [{ workCenter: 'WC04' }] });
    const error = await expectRefusal(cost('TWOLINE'), /Work centre WC04 has 2 costing lines/);
    expect(error.message).toMatch(/LAB01, MACH2/);
  });

  it('a work centre costing line without an activity type, or no line at all, is refused by name', async () => {
    await make('NOTYPE', [{ component: 'RAW1' }], { ops: [{ workCenter: 'WC05' }] });
    await expectRefusal(cost('NOTYPE'), /costing line of work centre WC05 has no activity type/);
    await make('NOLINE', [{ component: 'RAW1' }], { ops: [{ workCenter: 'WC03' }] });
    await expectRefusal(cost('NOLINE'), /Work centre WC03 \(plant 1000\) has no costing line/);
  });

  it('no activity rate for the period is refused, naming cost centre, activity type and period', async () => {
    await expectRefusal(cost('SIMP', { costingDate: '2026-07-15' }), /cost centre CC1000, activity type LAB01, period 7\/2026/);
    await expectRefusal(cost('SIMP', { planVersion: 'ZZ1' }), /plan version ZZ1/);
  });

  it('10. a zero price is refused, naming the component; a missing valuation row too', async () => {
    await make('ZEROP', [{ component: 'RAWZ' }]);
    await expectRefusal(cost('ZEROP'), /Component RAWZ has a standard price of zero/);
    await material('NOVAL', 'BUY');
    await make('NOVALP', [{ component: 'NOVAL' }]);
    await expectRefusal(cost('NOVALP'), /Component NOVAL has no valuation row/);
  });

  it('11. a co-product in the BOM is refused', async () => {
    await make('COPROD', [{ component: 'RAW1' }, { component: 'RAW4', coproduct: true }]);
    await expectRefusal(cost('COPROD'), /\(RAW4\) of COPROD is a co-product/);
  });

  it('12. special procurement on a BOM item is refused, and so is external processing on an operation', async () => {
    await make('SPECP', [{ component: 'RAW1', special: '30' }]);
    await expectRefusal(cost('SPECP'), /\(RAW1\) of SPECP carries special procurement 30/);
    await make('EXTOP', [{ component: 'RAW1' }], { ops: [{ controlKey: 'PP03' }] });
    await expectRefusal(cost('EXTOP'), /Operation 0010 of EXTOP uses control key PP03/);
  });

  it('13. mixed currencies are refused, naming every currency', async () => {
    await make('MIXCUR', [{ component: 'RAWE' }]);
    const error = await expectRefusal(cost('MIXCUR'), /The currencies differ/);
    expect(error.message).toContain(currency);
    expect(error.message).toContain(currency === 'EUR' ? 'JPY' : 'EUR');
    expect(error.message).toMatch(/company code 1000/);
    expect(error.message).toMatch(/controlling area A000/);
    expect(error.message).toMatch(/valuation area 1000 \(RAWE\)/);
  });

  it('14. a cycle is refused, naming the path', async () => {
    await material('CYA'); await material('CYB');
    await make('CYB', [{ component: 'CYA' }]);
    await make('CYA', [{ component: 'CYB' }]);
    await expectRefusal(cost('CYA'), /cycle: CYA → CYB → CYA/);
  });

  it('15. a bought material is refused, naming its procurement type', async () => {
    await expectRefusal(cost('RAW1'), /Material RAW1 has procurement type BUY in plant 1000/);
  });

  it('a material, a plant or a production version that does not stand is refused by name', async () => {
    await expectRefusal(cost('NOSUCH'), /Material NOSUCH does not stand/);
    await material('NOPLANT', 'MAKE');
    await withTenant(client, (tx) => tx.execute(sql`delete from material_plant where client = ${client} and material_number = 'NOPLANT'`));
    await expectRefusal(cost('NOPLANT'), /Material NOPLANT is not maintained in plant 1000/);
    await expectRefusal(cost('FG', { plant: '9999' }), /Plant scope does not cover plant 9999/);
    await material('NOVERS', 'MAKE');
    await expectRefusal(cost('NOVERS'), /No production version resolves for NOVERS in plant 1000 on 2026-03-15/);
  });

  it('a made component whose routing has no operation is refused; a BOM or routing not released for costing is refused', async () => {
    await make('NOROUT', [{ component: 'RAW1' }], { ops: [] });
    await make('USESNR', [{ component: 'NOROUT' }]);
    await expectRefusal(cost('USESNR'), /Routing N\/\d+\/01 of NOROUT has no operation valid on 2026-03-15/);
    await make('BOMNR', [{ component: 'RAW1' }], { bomStatus: '02' });
    await expectRefusal(cost('BOMNR'), /BOM P\/01 of BOMNR \(status 02\) is not released for costing/);
    await make('ROUTNR', [{ component: 'RAW1' }], { routingStatus: '2' });
    await expectRefusal(cost('ROUTNR'), /Routing N\/\d+\/01 of ROUTNR \(status 2\) is not released for costing/);
  });

  it('a lot size that is not a positive number is refused', async () => {
    await expectRefusal(cost('FG', { costingLotSize: '0' }), /not positive/);
    await expectRefusal(cost('FG', { costingLotSize: 'ten' }), /not a number/);
    await expectRefusal(cost('FG', { costingDate: '2026-02-30' }), /not a calendar date/);
  });
});

describe('what is saved', () => {
  it('17. a second estimate on the same date supersedes the first: SUPERSEDED, not deleted, both displayable', async () => {
    await make('SUPER', [{ component: 'RAW1' }]);
    const first = await cost('SUPER');
    const second = await cost('SUPER');
    expect([first.costingVersion, second.costingVersion]).toEqual(['01', '02']);
    const listed = await listCostEstimates({ client, materialNumber: 'SUPER', plant: PLANT }, { authorization: costing.authorization });
    expect(listed.map((e) => [e.costingVersion, e.status])).toEqual([['02', 'SAVED'], ['01', 'SUPERSEDED']]);
    const old = await getCostEstimate({ client, materialNumber: 'SUPER', plant: PLANT, costingDate: DATE, costingVersion: '01' }, { authorization: costing.authorization });
    expect(old.status).toBe('SUPERSEDED');
    expect(old.items).toEqual(first.items);
    const current = await getCostEstimate({ client, materialNumber: 'SUPER', plant: PLANT, costingDate: DATE }, { authorization: costing.authorization });
    expect(current.costingVersion).toBe('02');
    // A named version that already stands is refused, not overwritten.
    await expectRefusal(cost('SUPER', { costingVersion: '01' }), /Costing version 01 already stands/);
  });

  it('18. the estimate is saved with a full itemization and reads back identically', async () => {
    const created = await cost('FG', { costingDate: '2026-03-20', costingVersion: 'A1' });
    const read = await getCostEstimate({ client, materialNumber: 'FG', plant: PLANT, costingDate: '2026-03-20', costingVersion: 'A1' }, { authorization: costing.authorization });
    expect(read).toEqual({ ...created, replayed: false });
    expect(read.items.length).toBeGreaterThanOrEqual(7);
    expect(read).toMatchObject({ materialNumber: 'FG', plant: PLANT, status: 'SAVED', currency, productionVersion: '0001', controllingArea: 'A000', planVersion: '000' });
    expect(read.items.map((i) => i.lineNumber)).toEqual(read.items.map((_, i) => i + 1));
  });

  it('19. standardPrice (and the whole valuation row) is unchanged by a run', async () => {
    const before = await standardPrices();
    await cost('FG', { costingDate: '2026-03-21' });
    await cost('FGC', { costingLotSize: '50' });
    expect(await standardPrices()).toEqual(before);
    expect(before.find((r) => r.material_number === 'FG')).toMatchObject({ standard_price: '7.0000' });
  });

  it('20. a double submit does not create two versions', async () => {
    const first = await cost('SIMP', { costingDate: '2026-03-22', requestKey: 'ck11n-double-submit' });
    const again = await cost('SIMP', { costingDate: '2026-03-22', requestKey: 'ck11n-double-submit' });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.costingVersion).toBe(first.costingVersion);
    const listed = (await listCostEstimates({ client, materialNumber: 'SIMP', plant: PLANT }, { authorization: costing.authorization })).filter((e) => e.costingDate === '2026-03-22');
    expect(listed).toHaveLength(1);
    await expectRefusal(cost('FG', { costingDate: '2026-03-22', requestKey: 'ck11n-double-submit' }), /already created the estimate of SIMP/);
  });
});

describe('authority', () => {
  it('21. an actor without the capability is refused by the service, for create, display and list', async () => {
    await expectRefusal(cost('SIMP', {}, outsider), /do not hold PROD\.COST\.ESTIMATE\.CREATE/);
    await expectRefusal(createCostEstimate({ client, materialNumber: 'SIMP', plant: PLANT, costingDate: DATE, actor: ACTOR }), /signed-in user/);
    await expectRefusal(getCostEstimate({ client, materialNumber: 'SIMP', plant: PLANT, costingDate: DATE }, { authorization: outsider.authorization }), /do not hold/);
    await expectRefusal(listCostEstimates({ client, materialNumber: 'SIMP', plant: PLANT }, { authorization: outsider.authorization }), /do not hold/);
  });
});

describe('the COSTING refusal is gone and nothing regressed', () => {
  it('22. selectProductionVersion with context COSTING succeeds, as for PLANNING; the explosion still agrees', async () => {
    const input = { materialNumber: 'FG', plant: PLANT, keyDate: DATE, quantity: '10', unit: 'PC' };
    const costingVersion = await selectProductionVersion(client, { ...input, context: 'COSTING' });
    expect(costingVersion).toMatchObject({ productionVersion: '0001', bomUsage: 'P', bomAlternative: '01' });
    expect(costingVersion).toEqual(await selectProductionVersion(client, { ...input, context: 'PLANNING' }));
    expect(costingVersion).toEqual(await selectProductionVersion(client, { ...input, context: 'ORDER' }));
    expect(costingVersion).toEqual(await selectProductionVersion(client, input));
    const reader = await createFinanceActor(client, { capabilities: ['PROD.BOM.DISPLAY'] });
    const view = await explodeBom({ client, materialNumber: 'FG', plant: PLANT, keyDate: DATE, depth: 'MULTI' }, { authorization: reader.authorization });
    expect(view.rows.map((r) => r.materialNumber)).toEqual(expect.arrayContaining(['SUB', 'RAW1', 'RAW2', 'RAW3']));
  });
});

describe('the boundary, the registry and the screen', () => {
  const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

  it('the service never writes the valuation row (the CK24 boundary) and applies no overhead', () => {
    const service = source('src/modules/production/cost-estimate.ts');
    expect(service).not.toMatch(/\b(update|insert\s+into|delete\s+from)\s+(public\.)?material_valuation\b/i);
    expect(service).not.toMatch(/standardPrice|standard_price\s*=/);
    expect(service).toMatch(/overhead_cost[\s\S]*?, 0,/);
  });

  it('the capability is registered, granted to no role, and CK11N / CK13N find the screen', async () => {
    const found = await withTenant(client, async (tx) => ({
      capability: (await tx.execute(sql`select module, action, is_posting_relevant from capability where code = ${COST_ESTIMATE_CAPABILITY}`)) as unknown as Array<Record<string, unknown>>,
      term: (await tx.execute(sql`
        select r.route_path, r.coverage_tier, r.conformance_tier, array_agg(a.alias order by a.alias) as aliases
          from term_registry r join term_alias a on a.term_id = r.id and a.external_system = 'REFERENCE_ERP' and a.usage = 'SEARCH_ONLY'
         where r.our_code = ${COST_ESTIMATE_CAPABILITY} group by 1, 2, 3`)) as unknown as Array<Record<string, unknown>>,
    }));
    // Granted to no role, as CO.PLAN.COSTCENTER.MAINTAIN is: neither the migration nor the seed grants it.
    expect(source('drizzle/9288_standard_cost_estimate.sql')).not.toMatch(/role_capability/);
    expect(source('scripts/seed.ts').split('\n').filter((l) => l.includes('PROD.COST.ESTIMATE.CREATE') && /role/i.test(l))).toEqual([]);
    expect(found.capability[0]).toMatchObject({ module: 'PROD', action: 'CREATE', is_posting_relevant: false });
    expect(found.term[0]).toMatchObject({ route_path: '/production/cost-estimate', coverage_tier: 'TIER_1_BUILT', conformance_tier: 'B', aliases: ['CK11N', 'CK13N'] });
    expect(source('scripts/seed.ts')).toContain("code: 'PROD.COST.ESTIMATE.CREATE'");
    expect(source('src/ui/shell/screen-catalog.ts')).toMatch(/path: "\/production\/cost-estimate",[\s\S]*?code: "PROD\.COST\.ESTIMATE\.CREATE",[\s\S]*?title: "Standard cost estimate",[\s\S]*?accepts: \[\]/);
  });

  it('the screen reads the FormData names, calls the service for both writes and reads, and states the rules', () => {
    const actions = source('src/app/production/cost-estimate/actions.ts');
    for (const name of ['materialNumber', 'plant', 'costingDate', 'costingLotSize', 'costingVersion']) expect(actions).toContain(`text(form, '${name}')`);
    expect(actions).toContain('createCostEstimate(');
    expect(actions).toContain('CostEstimateError');
    const page = source('src/app/production/cost-estimate/page.tsx');
    expect(page).toContain('getCostEstimate(');
    expect(page).toContain('listCostEstimates(');
    expect(page).toContain('estimate.overheadNote');
    expect(page).toMatch(/superseded/);
    expect(page).toMatch(/not released: the material price is unchanged/);
    expect(page).not.toMatch(/from '@\/platform\/db\/client'[\s\S]*insert|update material_valuation/);
  });
});
