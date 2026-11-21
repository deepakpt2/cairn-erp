/**
 * Company-scope authorization for production (adversarial): planned orders (display, list, create, change).
 * Production is keyed by plant; a plant belongs to one company. Two companies (A 1000, B 2000), a plant that
 * names no company, a second tenant, and actors who hold the capability but not the company, no scope, no
 * capability, or a Plant scope. A capability alone must never reach another company's planned orders.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createPlannedOrder } from '../src/modules/production/planned-order-create';
import {
  enterOrderConfirmation, loadOrderConfirmation, previewOrderConfirmation,
} from '../src/modules/production/order-confirmation';
import { enterTimeTicket, getTimeTicket, loadTimeTicket, previewTimeTicket } from '../src/modules/production/time-ticket';
import { settleProductionOrder, settleProductionOrdersCollective } from '../src/modules/production/order-settlement';
import { getProductionOrderDisplay, listProductionOrders } from '../src/modules/production/production-order-display';
import { changeProductionOrder } from '../src/modules/production/production-order-change';
import {
  cancelMrpRun, getMrpRun, listMrpRuns, planMaterials, planSingleItem,
} from '../src/modules/production/mrp-run';
import { getMrpRunProgress, submitMrpBackgroundRun } from '../src/modules/production/mrp-background';
import {
  saveBomItemCategory, saveBomStatus, saveBomUsage,
  changeMaterialBom, createMaterialBom, createMaterialBomForProvisioning, getMaterialBom, listMaterialBoms, resolveMaterialBom,
} from '../src/modules/production/material-bom';
import {
  changeWorkCenter, createWorkCenter, getWorkCenter, listWorkCenters, saveWorkCenterCategory,
} from '../src/modules/production/work-center';
import {
  changeRouting, createRouting, createRoutingForProvisioning, getRouting, listRoutings, resolveRouting,
  saveRoutingStatus, saveRoutingTaskListType, saveRoutingUsage,
} from '../src/modules/production/routing';
import {
  changeProductionVersion, checkProductionVersion, copyProductionVersion, createProductionVersion,
  deleteProductionVersion, getProductionVersion, listProductionVersions, lockProductionVersion,
} from '../src/modules/production/production-version';
import { changePlannedOrder } from '../src/modules/production/planned-order-change';
import { getPlannedOrder, listPlannedOrders } from '../src/modules/production/planned-order-display';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const A = '1000';
const B = '2000';
const SEED = 'SCOPE_PROD_SEED';
const CAPS = ['PROD.PLANNEDORDER.DISPLAY', 'PROD.PLANNEDORDER.CREATE', 'PROD.PLANNEDORDER.CHANGE'];

let tenant: TestTenant;
let other: TestTenant;
let client = '';
let onlyA: FinanceActor;
let onlyB: FinanceActor;
let both: FinanceActor;
let noCapability: FinanceActor;
let noScope: FinanceActor;
let plantA: FinanceActor;
let otherTenantActor: FinanceActor;
let confA: FinanceActor;
let confB: FinanceActor;
let confPlantA: FinanceActor;
let confNoCap: FinanceActor;
let confNoScope: FinanceActor;
let confOther: FinanceActor;
let tickA: FinanceActor;
let tickB: FinanceActor;
let tickPlantA: FinanceActor;
let tickNoCap: FinanceActor;
let tickNoScope: FinanceActor;
let tickOther: FinanceActor;
let setA: FinanceActor;
let setB: FinanceActor;
let setPlantA: FinanceActor;
let setNoCap: FinanceActor;
let setNoScope: FinanceActor;
let setOther: FinanceActor;
let poA: FinanceActor;
let poB: FinanceActor;
let poPlantA: FinanceActor;
let poNoCap: FinanceActor;
let poNoScope: FinanceActor;
let poOther: FinanceActor;
let mA: FinanceActor;
let mB: FinanceActor;
let mPlantA: FinanceActor;
let mNoCap: FinanceActor;
let mNoScope: FinanceActor;
let mOther: FinanceActor;
let mBoth: FinanceActor;
let bA: FinanceActor;
let bB: FinanceActor;
let bPlantA: FinanceActor;
let bNoCap: FinanceActor;
let bNoScope: FinanceActor;
let bOther: FinanceActor;

type Auth = FinanceActor['authorization'] | undefined;
const ask = (p: Promise<unknown>) => p.then(() => 'done', (e: Error) => e.message);
const mask = (m: string, ...v: string[]) => v.reduce((t, x) => t.replaceAll(x, '#'), m);
const show = (n: string, a: Auth) => getPlannedOrder(client, n, a);
const create = (a: Auth, plant: string, key: string, reference = '') => createPlannedOrder({
  client, changedBy: 'someone-else', requestKey: key, materialNumber: 'SCMK', plant, quantity: '5', finishDate: '2026-10-24',
  referenceOrder: reference, authorization: a,
});
const change = (a: Auth, n: string) => changePlannedOrder({
  client, changedBy: 'someone-else', orderNumber: n, expectedVersion: 1, quantity: '9', authorization: a,
});

beforeAll(async () => {
  tenant = await createTenant('scope-prod');
  client = tenant.client;
  other = await createTenant('scope-prod-2');
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by)
      select client, ${B}, 'B company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${SEED}
        from company_code where client = ${client} and company_code = ${A} on conflict do nothing`);
    for (const [plant, company] of [['PLA1', A], ['PLB1', B], ['PLN1', null]] as const) {
      await tx.execute(sql`insert into plant (client, plant, name, company_code, country, created_by) values (${client}, ${plant}, ${plant}, ${company}, 'US', ${SEED}) on conflict do nothing`);
    }
    await tx.execute(sql`insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'SCMK', 'Scope make', t.material_type, 'PC', ${SEED}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t on conflict do nothing`);
    await tx.execute(sql`insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'SCMC', 'Scope comp', t.material_type, 'PC', ${SEED}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t on conflict do nothing`);
    for (const plant of ['PLA1', 'PLB1', 'PLN1']) {
      await tx.execute(sql`insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${client}, 'SCMC', ${plant}, 'BUY', ${SEED}) on conflict do nothing`);
    }
    for (const plant of ['PLA1', 'PLB1', 'PLN1']) {
      await tx.execute(sql`insert into material_plant (client, material_number, plant, procurement_type, in_house_production_days, created_by)
        values (${client}, 'SCMK', ${plant}, 'MAKE', 1, ${SEED}) on conflict do nothing`);
    }
    for (const [n, plant] of [['PL-A', 'PLA1'], ['PL-B', 'PLB1'], ['PL-N', 'PLN1']] as const) {
      await tx.execute(sql`insert into planned_order (client, order_number, material_number, plant, quantity, unit, start_date, finish_date, request_key, created_by)
        values (${client}, ${n}, 'SCMK', ${plant}, 5, 'PC', '2026-10-23', '2026-10-24', ${`seed-${n}`}, ${SEED})`);
    }
    for (const [n, plant] of [['PO-A', 'PLA1'], ['PO-B', 'PLB1'], ['PO-N', 'PLN1']] as const) {
      await tx.execute(sql`insert into production_order (client, order_number, material_number, plant, order_quantity, unit_of_measure, scheduled_start, scheduled_finish, created_by)
        values (${client}, ${n}, 'SCMK', ${plant}, 5, 'PC', '2026-10-23', '2026-10-24', ${SEED})`);
    }
    await tx.execute(sql`insert into production_order_component (client, order_number, item_number, material_number, plant, required_quantity, unit_of_measure, created_by)
      values (${client}, 'PO-A', 10, 'SCMK', 'PLA1', 1, 'PC', ${SEED})`);
    await defineRange(tx, { client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: SEED });
    await defineRange(tx, { client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: SEED });
  });
  onlyA = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A] });
  onlyB = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [B] });
  both = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B] });
  noCapability = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
  noScope = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [] });
  plantA = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  const CCAPS = ['PROD.CONFIRM.ORDER'];
  confA = await createFinanceActor(client, { capabilities: CCAPS, companyScopes: [A] });
  confB = await createFinanceActor(client, { capabilities: CCAPS, companyScopes: [B] });
  confPlantA = await createFinanceActor(client, { capabilities: CCAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  confNoCap = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B] });
  confNoScope = await createFinanceActor(client, { capabilities: CCAPS, companyScopes: [] });
  confOther = await createFinanceActor(other.client, { capabilities: CCAPS });
  const TCAPS = ['PROD.CONFIRM.ENTER'];
  tickA = await createFinanceActor(client, { capabilities: TCAPS, companyScopes: [A] });
  tickB = await createFinanceActor(client, { capabilities: TCAPS, companyScopes: [B] });
  tickPlantA = await createFinanceActor(client, { capabilities: TCAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  tickNoCap = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B] });
  tickNoScope = await createFinanceActor(client, { capabilities: TCAPS, companyScopes: [] });
  tickOther = await createFinanceActor(other.client, { capabilities: TCAPS });
  const SCAPS = ['PROD.ORDER.SETTLE'];
  setA = await createFinanceActor(client, { capabilities: SCAPS, companyScopes: [A] });
  setB = await createFinanceActor(client, { capabilities: SCAPS, companyScopes: [B] });
  setPlantA = await createFinanceActor(client, { capabilities: SCAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  setNoCap = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B] });
  setNoScope = await createFinanceActor(client, { capabilities: SCAPS, companyScopes: [] });
  setOther = await createFinanceActor(other.client, { capabilities: SCAPS });
  const PCAPS = ['PROD.ORDER.DISPLAY', 'PROD.ORDER.CHANGE'];
  poA = await createFinanceActor(client, { capabilities: PCAPS, companyScopes: [A] });
  poB = await createFinanceActor(client, { capabilities: PCAPS, companyScopes: [B] });
  poPlantA = await createFinanceActor(client, { capabilities: PCAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  poNoCap = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B] });
  poNoScope = await createFinanceActor(client, { capabilities: PCAPS, companyScopes: [] });
  poOther = await createFinanceActor(other.client, { capabilities: PCAPS });
  const MCAPS = ['PROD.MRP.RUN', 'PROD.MRP.REGENERATE'];
  mA = await createFinanceActor(client, { capabilities: MCAPS, companyScopes: [A] });
  mB = await createFinanceActor(client, { capabilities: MCAPS, companyScopes: [B] });
  mPlantA = await createFinanceActor(client, { capabilities: MCAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  mBoth = await createFinanceActor(client, { capabilities: ['PROD.MRP.RUN', 'PROD.MRP.REGENERATE'], companyScopes: [A, B] });
  mNoCap = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B] });
  mNoScope = await createFinanceActor(client, { capabilities: MCAPS, companyScopes: [] });
  mOther = await createFinanceActor(other.client, { capabilities: MCAPS });
  await saveBomUsage({
    client, changedBy: SEED, usage: 'P', description: 'Production',
    productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
  });
  await saveBomItemCategory({
    client, changedBy: SEED, category: 'S', description: 'Stock',
    materialEntry: '+', quantityEntry: '+', allowFixedQuantity: 'X', allowBulk: 'X', allowPhantom: 'X',
  });
  await saveBomStatus({ client, changedBy: SEED, status: '1', description: 'Active', releasedForCosting: 'X', releasedForOrders: 'X' });
  const BCAPS = ['PROD.BOM.DISPLAY', 'PROD.BOM.CREATE', 'PROD.BOM.CHANGE', 'PROD.WORKCENTER.DISPLAY', 'PROD.WORKCENTER.CREATE', 'PROD.WORKCENTER.CHANGE', 'PROD.ROUTING.DISPLAY', 'PROD.ROUTING.CREATE', 'PROD.ROUTING.CHANGE', 'PROD.VERSION.DISPLAY', 'PROD.VERSION.CREATE', 'PROD.VERSION.CHANGE', 'PROD.VERSION.CHECK', 'PROD.VERSION.LOCK', 'PROD.VERSION.DELETE'];
  bA = await createFinanceActor(client, { capabilities: BCAPS, companyScopes: [A] });
  bB = await createFinanceActor(client, { capabilities: BCAPS, companyScopes: [B] });
  bPlantA = await createFinanceActor(client, { capabilities: BCAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  bNoCap = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B] });
  bNoScope = await createFinanceActor(client, { capabilities: BCAPS, companyScopes: [] });
  bOther = await createFinanceActor(other.client, { capabilities: BCAPS });
  otherTenantActor = await createFinanceActor(other.client, { capabilities: CAPS });
}, 240_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 240_000);

describe('planned orders: display and list', () => {
  it('shows and lists only orders at plants inside the reach', async () => {
    expect((await show('PL-A', onlyA.authorization))?.plant).toBe('PLA1');
    expect((await show('PL-B', onlyB.authorization))?.plant).toBe('PLB1');
    expect((await show('PL-B', both.authorization))?.plant).toBe('PLB1');
    expect((await show('PL-A', plantA.authorization))?.plant).toBe('PLA1');
    const nums = async (a: Auth) => (await listPlannedOrders(client, { materialNumber: 'SCMK' }, a)).rows.map((r) => r.orderNumber).sort();
    expect(await nums(onlyA.authorization)).toEqual(['PL-A']);
    expect(await nums(onlyB.authorization)).toEqual(['PL-B']);
    expect(await nums(both.authorization)).toEqual(['PL-A', 'PL-B']);
    expect(await nums(plantA.authorization)).toEqual(['PL-A']);
    expect((await listPlannedOrders(client, { materialNumber: 'SCMK' }, onlyA.authorization)).total).toBe(1);
  });

  it('answers another company, a no-company plant and a plant outside the Plant scope as a missing order', async () => {
    expect(await show('PL-B', onlyA.authorization)).toBeNull();
    expect(await show('PL-N', onlyA.authorization)).toBeNull();
    expect(await show('PL-N', both.authorization)).toBeNull();
    expect(await show('PL-B', plantA.authorization)).toBeNull();
    expect(await show('PL-GONE', onlyA.authorization)).toBeNull();
    const missing = mask(await ask(listPlannedOrders(client, { plant: 'PLZZ' }, onlyA.authorization)), 'PLZZ');
    expect(mask(await ask(listPlannedOrders(client, { plant: 'PLB1' }, onlyA.authorization)), 'PLB1')).toBe(missing);
    expect(mask(await ask(listPlannedOrders(client, { plant: 'PLN1' }, onlyA.authorization)), 'PLN1')).toBe(missing);
  });

  it('refuses no session, no capability, no scope and another tenant', async () => {
    for (const bad of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      expect(await ask(show('PL-A', bad))).not.toBe('done');
      expect(await ask(listPlannedOrders(client, { plant: 'PLA1' }, bad))).not.toBe('done');
    }
  });
});

describe('planned orders: create and change', () => {
  it('creates at a reachable plant and records the session user', async () => {
    const made = await create(onlyA.authorization, 'PLA1', 'k-a1');
    expect(made.order.plant).toBe('PLA1');
    const rows = await withTenant(client, async (tx) => (await tx.execute(sql`
      select created_by from planned_order where client = ${client} and order_number = ${made.order.orderNumber}`)) as unknown as Array<{ created_by: string }>);
    expect(rows[0]?.created_by).toBe(onlyA.username);
  });

  it('refuses a create at another company, a no-company plant or by copying an order out of reach; writes nothing', async () => {
    const count = () => withTenant(client, async (tx) => Number(((await tx.execute(sql`select count(*) as n from planned_order where client = ${client}`)) as unknown as Array<{ n: string }>)[0]!.n));
    const before = await count();
    const missing = mask(await ask(create(onlyA.authorization, 'PLZZ', 'k-x0')), 'PLZZ');
    expect(mask(await ask(create(onlyA.authorization, 'PLB1', 'k-x1')), 'PLB1')).toBe(missing);
    expect(mask(await ask(create(onlyA.authorization, 'PLN1', 'k-x2')), 'PLN1')).toBe(missing);
    expect(mask(await ask(create(plantA.authorization, 'PLB1', 'k-x3')), 'PLB1')).toBe(missing);
    expect(await ask(create(onlyA.authorization, '', 'k-x4', 'PL-B'))).toMatch(/does not stand/);
    expect(await ask(create(plantA.authorization, '', 'k-x5', 'PL-B'))).toMatch(/does not stand/);
    for (const bad of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      expect(await ask(create(bad, 'PLA1', 'k-x6'))).not.toBe('done');
    }
    expect(await count()).toBe(before);
  });

  it('refuses a change of an order out of reach as a missing one, changes nothing, records the session user', async () => {
    const missing = mask(await ask(change(onlyA.authorization, 'PL-GONE')), 'PL-GONE');
    for (const n of ['PL-B', 'PL-N']) expect(mask(await ask(change(onlyA.authorization, n)), n)).toBe(missing);
    expect(mask(await ask(change(plantA.authorization, 'PL-B')), 'PL-B')).toBe(missing);
    for (const bad of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      expect(await ask(change(bad, 'PL-A'))).not.toBe('done');
    }
    const quantityOf = (n: string) => withTenant(client, async (tx) => ((await tx.execute(sql`
      select quantity::text as q, changed_by from planned_order where client = ${client} and order_number = ${n}`)) as unknown as Array<{ q: string; changed_by: string | null }>)[0]!);
    expect((await quantityOf('PL-B')).q).toBe('5.000');
    await change(onlyA.authorization, 'PL-A');
    const row = await quantityOf('PL-A');
    expect(row.q).toBe('9.000');
    expect(row.changed_by).toBe(onlyA.username);
  });
});

describe('order confirmation', () => {
  const enter = (a: Auth, n: string, key = `k-${n}`) => enterOrderConfirmation(client, {
    requestedBy: 'someone-else', requestKey: key, orderNumber: n, confirmationType: 'PARTIAL', yieldQuantity: '1',
    postingDate: '2026-10-24', expectedVersion: 1,
  }, a);
  const confirmations = () => withTenant(client, async (tx) => Number(((await tx.execute(sql`
    select count(*)::int as n from production_confirmation where client = ${client}`)) as unknown as Array<{ n: number }>)[0]!.n));

  it('answers an order at another company, a no-company plant or outside the Plant scope as a missing order', async () => {
    const missing = mask(await ask(loadOrderConfirmation(client, { orderNumber: 'PO-GONE' }, confA.authorization)), 'PO-GONE');
    expect(missing).toContain('does not stand');
    for (const n of ['PO-B', 'PO-N']) expect(mask(await ask(loadOrderConfirmation(client, { orderNumber: n }, confA.authorization)), n)).toBe(missing);
    expect(mask(await ask(loadOrderConfirmation(client, { orderNumber: 'PO-B' }, confPlantA.authorization)), 'PO-B')).toBe(missing);
    expect(mask(await ask(previewOrderConfirmation(client, { orderNumber: 'PO-B', confirmationType: 'PARTIAL', postingDate: '2026-10-24' } as never, confA.authorization)), 'PO-B')).toBe(missing);
    expect(mask(await ask(loadOrderConfirmation(client, { orderNumber: 'PO-A' }, confB.authorization)), 'PO-A')).toBe(missing);
    expect(await ask(loadOrderConfirmation(client, { orderNumber: 'PO-A' }, confA.authorization))).not.toContain('does not stand');
  });

  it('refuses an entry out of reach and writes nothing; refuses no session, capability, scope or tenant', async () => {
    const before = await confirmations();
    const missing = mask(await ask(enter(confA.authorization, 'PO-GONE')), 'PO-GONE');
    for (const n of ['PO-B', 'PO-N']) expect(mask(await ask(enter(confA.authorization, n)), n)).toBe(missing);
    expect(mask(await ask(enter(confPlantA.authorization, 'PO-B')), 'PO-B')).toBe(missing);
    for (const bad of [undefined, confNoCap.authorization, confNoScope.authorization, confOther.authorization]) {
      expect(await ask(enter(bad, 'PO-A'))).not.toBe('done');
    }
    expect(await confirmations()).toBe(before);
  });
});

describe('time ticket (CO11N)', () => {
  const enter = (a: Auth, n: string) => enterTimeTicket(client, {
    requestedBy: 'someone-else', requestKey: `t-${n}`, orderNumber: n, operationNumber: '0010', confirmationType: 'PARTIAL',
    yieldQuantity: '1', postingDate: '2026-10-24', expectedVersion: 1, authorization: a,
  });
  const tickets = () => withTenant(client, async (tx) => Number(((await tx.execute(sql`
    select count(*)::int as n from production_confirmation where client = ${client}`)) as unknown as Array<{ n: number }>)[0]!.n));

  it('answers an order out of reach as a missing order for load, check and get', async () => {
    const load = (a: Auth, n: string) => loadTimeTicket(client, { orderNumber: n }, a);
    const missing = mask(await ask(load(tickA.authorization, 'PO-GONE')), 'PO-GONE');
    expect(missing).toContain('does not stand');
    for (const n of ['PO-B', 'PO-N']) expect(mask(await ask(load(tickA.authorization, n)), n)).toBe(missing);
    expect(mask(await ask(load(tickPlantA.authorization, 'PO-B')), 'PO-B')).toBe(missing);
    expect(mask(await ask(load(tickB.authorization, 'PO-A')), 'PO-A')).toBe(missing);
    expect(mask(await ask(previewTimeTicket(client, {
      orderNumber: 'PO-B', operationNumber: '0010', confirmationType: 'PARTIAL', postingDate: '2026-10-24', expectedVersion: 1,
    }, tickA.authorization)), 'PO-B')).toBe(missing);
    expect(await ask(load(tickA.authorization, 'PO-A'))).not.toContain('does not stand');
    for (const bad of [undefined, tickNoCap.authorization, tickNoScope.authorization, tickOther.authorization]) {
      expect(await ask(load(bad, 'PO-A'))).not.toBe('done');
      expect(await ask(getTimeTicket(client, 'X', bad))).not.toBe('done');
    }
  });

  it('refuses an entry out of reach, with no session, capability, scope or tenant; writes nothing', async () => {
    const before = await tickets();
    const missing = mask(await ask(enter(tickA.authorization, 'PO-GONE')), 'PO-GONE');
    for (const n of ['PO-B', 'PO-N']) expect(mask(await ask(enter(tickA.authorization, n)), n)).toBe(missing);
    expect(mask(await ask(enter(tickPlantA.authorization, 'PO-B')), 'PO-B')).toBe(missing);
    for (const bad of [undefined, tickNoCap.authorization, tickNoScope.authorization, tickOther.authorization]) {
      expect(await ask(enter(bad, 'PO-A'))).not.toBe('done');
    }
    expect(await tickets()).toBe(before);
  });
});

describe('production order settlement', () => {
  const base = { fiscalYear: 2026, settlementPeriod: 10, testRun: true };
  const one = (a: Auth, n: string) => settleProductionOrder({ client, changedBy: 'someone-else', orderNumber: n, ...base }, a);
  const many = (a: Auth) => settleProductionOrdersCollective({ client, changedBy: 'someone-else', orderFrom: 'PO-A', orderTo: 'PO-N', ...base }, a);

  it('answers an order out of reach as a missing order and leaves it out of a collective selection', async () => {
    const missing = await one(setA.authorization, 'PO-GONE');
    expect(missing.outcome).toBe('INVALID_SELECTION');
    const norm = (r: { message: string }, n: string) => r.message.replaceAll(n, '#');
    for (const n of ['PO-B', 'PO-N']) {
      const r = await one(setA.authorization, n);
      expect(r.outcome).toBe('INVALID_SELECTION');
      expect(norm(r, n)).toBe(norm(missing, 'PO-GONE'));
    }
    expect((await one(setPlantA.authorization, 'PO-B')).outcome).toBe('INVALID_SELECTION');
    expect((await one(setB.authorization, 'PO-A')).outcome).toBe('INVALID_SELECTION');
    expect((await one(setA.authorization, 'PO-A')).outcome).not.toBe('INVALID_SELECTION');
    const listed = (r: { orders: Array<{ orderNumber: string }> }) => r.orders.map((o) => o.orderNumber).sort();
    expect(listed(await many(setA.authorization))).toEqual(['PO-A']);
    expect(listed(await many(setB.authorization))).toEqual(['PO-B']);
    expect(listed(await many(setPlantA.authorization))).toEqual(['PO-A']);
  });

  it('refuses no session, capability, scope or tenant', async () => {
    for (const bad of [undefined, setNoCap.authorization, setNoScope.authorization, setOther.authorization]) {
      expect(await ask(one(bad, 'PO-A'))).not.toBe('done');
      expect(await ask(many(bad))).not.toBe('done');
    }
  });
});

describe('production order display and change', () => {
  const show = (a: Auth, n: string) => getProductionOrderDisplay(client, n, a);
  const list = (a: Auth, plant: string) => listProductionOrders(client, { plant }, a);
  const chg = (a: Auth, n: string) => changeProductionOrder({
    client, changedBy: 'someone-else', orderNumber: n, expectedVersion: 1, quantity: '7',
  }, a);

  it('shows and lists only orders at plants in reach; a named plant out of reach does not stand', async () => {
    expect((await show(poA.authorization, 'PO-A'))?.orderNumber).toBe('PO-A');
    for (const n of ['PO-B', 'PO-N', 'PO-GONE']) expect(await show(poA.authorization, n)).toBeNull();
    expect(await show(poPlantA.authorization, 'PO-B')).toBeNull();
    expect(await show(poB.authorization, 'PO-A')).toBeNull();
    expect((await list(poA.authorization, 'PLA1')).rows.map((r) => r.orderNumber)).toEqual(['PO-A']);
    expect((await list(poB.authorization, 'PLB1')).total).toBe(1);
    const missing = mask(await ask(list(poA.authorization, 'PLZZ')), 'PLZZ');
    for (const p of ['PLB1', 'PLN1']) expect(mask(await ask(list(poA.authorization, p)), p)).toBe(missing);
    expect(await ask(list(poPlantA.authorization, 'PLB1'))).not.toBe('done');
    for (const bad of [undefined, poNoCap.authorization, poNoScope.authorization, poOther.authorization]) {
      expect(await ask(show(bad, 'PO-A'))).not.toBe('done');
      expect(await ask(list(bad, 'PLA1'))).not.toBe('done');
    }
  });

  it('refuses a change out of reach as a missing order, changes nothing, records the session user', async () => {
    const missing = mask(await ask(chg(poA.authorization, 'PO-GONE')), 'PO-GONE');
    for (const n of ['PO-B', 'PO-N']) expect(mask(await ask(chg(poA.authorization, n)), n)).toBe(missing);
    expect(mask(await ask(chg(poPlantA.authorization, 'PO-B')), 'PO-B')).toBe(missing);
    for (const bad of [undefined, poNoCap.authorization, poNoScope.authorization, poOther.authorization]) {
      expect(await ask(chg(bad, 'PO-A'))).not.toBe('done');
    }
    const read = (n: string) => withTenant(client, async (tx) => ((await tx.execute(sql`
      select order_quantity::text as q, changed_by from production_order where client = ${client} and order_number = ${n}`)) as unknown as Array<{ q: string; changed_by: string | null }>)[0]!);
    expect((await read('PO-B')).q).toBe('5.000');
    expect(await ask(chg(poA.authorization, 'PO-A'))).toBe('done');
    const row = await read('PO-A');
    expect(row.q).toBe('7.000');
    expect(row.changed_by).toBe(poA.username);
  });
});

describe('MRP run', () => {
  let key = 0;
  const plan = (a: Auth, from: string, to = from) => planMaterials({
    client, requestedBy: 'someone-else', requestKey: `mrp-${++key}`, processingKey: 'NEUPL', plantFrom: from, plantTo: to,
    confirmRegenerative: true, simulationOnly: true,
  }, a);
  const requestedBy = (run: string) => withTenant(client, async (tx) => ((await tx.execute(sql`
    select requested_by from mrp_run where client = ${client} and run_number = ${run}`)) as unknown as Array<{ requested_by: string }>)[0]!.requested_by);
  const runs = () => withTenant(client, async (tx) => Number(((await tx.execute(sql`
    select count(*)::int as n from mrp_run where client = ${client}`)) as unknown as Array<{ n: number }>)[0]!.n));
  let runA = '';
  let runBoth = '';

  it('plans a range wholly in reach, records the session user, and refuses a range holding a plant out of reach as a whole', async () => {
    const run = await plan(mA.authorization, 'PLA1');
    runA = run.runNumber;
    expect(await requestedBy(run.runNumber)).toBe(mA.username);
    const before = await runs();
    const missing = mask(await ask(plan(mA.authorization, 'PLZZ')), 'PLZZ');
    expect(mask(await ask(plan(mA.authorization, 'PLB1')), 'PLB1')).toBe(missing);
    expect(mask(await ask(plan(mA.authorization, 'PLN1')), 'PLN1')).toBe(missing);
    expect(mask(await ask(plan(mPlantA.authorization, 'PLB1')), 'PLB1')).toBe(missing);
    for (const [who, from, to] of [[mA, 'PLA1', 'PLN1'], [mB, 'PLA1', 'PLB1'], [mPlantA, 'PLA1', 'PLB1']] as const) {
      expect(await ask(plan(who.authorization, from, to))).toContain('holds a plant outside your scope');
    }
    expect(await runs()).toBe(before);
    const both = await plan(mBoth.authorization, 'PLA1', 'PLB1');
    runBoth = both.runNumber;
    expect(await requestedBy(both.runNumber)).toBe(mBoth.username);
    expect(await ask(planSingleItem({
      client, requestedBy: 'x', requestKey: `si-${++key}`, materialNumber: 'SCMK', plant: 'PLB1', processingKey: 'NEUPL', confirmRegenerative: true, simulationOnly: true,
    }, mA.authorization))).toContain('does not stand');
    for (const bad of [undefined, mNoCap.authorization, mNoScope.authorization, mOther.authorization]) {
      expect(await ask(plan(bad, 'PLA1'))).not.toBe('done');
    }
  });

  it('shows, lists, reads progress of and cancels a run only when its whole range is in reach', async () => {
    expect((await getMrpRun(client, runA, mA.authorization))?.runNumber).toBe(runA);
    expect(await getMrpRun(client, runA, mB.authorization)).toBeNull();
    expect(await getMrpRun(client, runBoth, mA.authorization)).toBeNull();
    expect(await getMrpRun(client, runBoth, mPlantA.authorization)).toBeNull();
    expect((await getMrpRun(client, runBoth, mBoth.authorization))?.runNumber).toBe(runBoth);
    const listed = async (a: Auth) => (await listMrpRuns(client, a)).map((r) => r.runNumber);
    expect(await listed(mA.authorization)).toEqual([runA]);
    expect(await listed(mBoth.authorization)).toEqual(expect.arrayContaining([runA, runBoth]));
    expect(await listed(mB.authorization)).toEqual([]);
    expect(await getMrpRunProgress(client, runBoth, mA.authorization)).toBeNull();
    expect(await getMrpRunProgress(client, runA, mA.authorization)).not.toBeNull();
    expect(mask(await ask(cancelMrpRun(client, runBoth, 'x', mA.authorization)), runBoth)).toBe(mask(await ask(cancelMrpRun(client, 'MR-GONE', 'x', mA.authorization)), 'MR-GONE'));
    for (const bad of [undefined, mNoCap.authorization, mNoScope.authorization, mOther.authorization]) {
      expect(await ask(getMrpRun(client, runA, bad))).not.toBe('done');
      expect(await ask(listMrpRuns(client, bad))).not.toBe('done');
    }
  });

  it('refuses a background submission whose plants or company scope are out of reach', async () => {
    const submit = (a: FinanceActor, from: string, to = from) => submitMrpBackgroundRun({
      client, requestedBy: a.username, actorUserId: a.authorization.userId, requestKey: `bg-${++key}`, processingKey: 'NEUPL',
      plantFrom: from, plantTo: to, confirmRegenerative: true, simulationOnly: true,
    });
    const before = await runs();
    expect(await ask(submit(mNoScope, 'PLA1'))).toContain('no longer holds');
    expect(await ask(submit(mA, 'PLB1'))).toContain('no longer holds');
    expect(await ask(submit(mA, 'PLA1', 'PLB1'))).toContain('no longer holds');
    expect(await ask(submit(mPlantA, 'PLB1'))).toContain('no longer holds');
    expect(await runs()).toBe(before);
  });
});

describe('material BOM', () => {
  const bom = (plant: string, requestKey = '') => ({
    client, changedBy: 'someone-else', materialNumber: 'SCMK', plant, usage: 'P', alternative: '01',
    baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01', requestKey,
    items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'SCMC', quantity: '1', unit: 'PC' }],
  });
  const count = () => withTenant(client, async (tx) => Number(((await tx.execute(sql`
    select count(*)::int as n from material_bom where client = ${client}`)) as unknown as Array<{ n: number }>)[0]!.n));

  it('creates at a plant in reach, records the session user, and refuses a plant out of reach as a missing plant', async () => {
    const before = await count();
    const missing = mask(await ask(createMaterialBom(bom('PLZZ'), bA.authorization)), 'PLZZ');
    for (const p of ['PLB1', 'PLN1']) expect(mask(await ask(createMaterialBom(bom(p), bA.authorization)), p)).toBe(missing);
    expect(mask(await ask(createMaterialBom(bom('PLB1'), bPlantA.authorization)), 'PLB1')).toBe(missing);
    for (const bad of [undefined, bNoCap.authorization, bNoScope.authorization, bOther.authorization]) {
      expect(await ask(createMaterialBom(bom('PLA1'), bad))).not.toBe('done');
    }
    expect(await count()).toBe(before);
    expect(await ask(createMaterialBom(bom('PLA1'), bA.authorization))).toBe('done');
    expect(await ask(createMaterialBom(bom('PLB1'), bB.authorization))).toBe('done');
    const by = await withTenant(client, async (tx) => (await tx.execute(sql`
      select plant, created_by from material_bom where client = ${client} order by plant`)) as unknown as Array<{ plant: string; created_by: string }>);
    expect(by.find((r) => r.plant === 'PLA1')?.created_by).toBe(bA.username);
  });

  it('shows, resolves and lists only BOMs at plants in reach; a change out of reach is refused', async () => {
    expect((await getMaterialBom(client, 'SCMK', 'PLA1', 'P', '01', null, bA.authorization))?.plant).toBe('PLA1');
    expect(await getMaterialBom(client, 'SCMK', 'PLB1', 'P', '01', null, bA.authorization)).toBeNull();
    expect(await getMaterialBom(client, 'SCMK', 'PLB1', 'P', '01', null, bPlantA.authorization)).toBeNull();
    expect(await resolveMaterialBom(client, 'SCMK', 'PLB1', 'P', null, null, bA.authorization).catch((e: Error) => e.message)).toContain('does not stand');
    expect((await listMaterialBoms(client, { materialNumber: 'SCMK' }, bA.authorization)).map((r) => r.plant)).toEqual(['PLA1']);
    expect((await listMaterialBoms(client, { materialNumber: 'SCMK' }, bB.authorization)).map((r) => r.plant)).toEqual(['PLB1']);
    expect(await ask(listMaterialBoms(client, { plant: 'PLB1' }, bPlantA.authorization))).toContain('does not stand');
    const changeOf = (p: string, a: Auth) => changeMaterialBom({ ...bom(p), version: 1, headerText: 'x' } as never, a);
    expect(await ask(changeOf('PLB1', bA.authorization))).toContain('does not stand');
    for (const bad of [undefined, bNoCap.authorization, bNoScope.authorization, bOther.authorization]) {
      expect(await ask(listMaterialBoms(client, {}, bad))).not.toBe('done');
      expect(await ask(changeOf('PLA1', bad))).not.toBe('done');
    }
  });
});

describe('work center', () => {
  const wc = (plant: string, key: string, extra: Record<string, unknown> = {}) => ({
    client, changedBy: 'someone-else', plant, workCenter: key, category: 'MACH', description: 'Machine', ...extra,
  });
  const exists = (key: string) => withTenant(client, async (tx) => (await tx.execute(sql`
    select plant, created_by from work_center where client = ${client} and work_center = ${key}`)) as unknown as Array<{ plant: string; created_by: string }>);

  it('creates, changes, reads and lists only inside reach, and refuses a plant out of reach as a missing plant', async () => {
    await saveWorkCenterCategory({ client, changedBy: 'SETUP', category: 'MACH', description: 'Machine' });
    expect(await ask(createWorkCenter(wc('PLA1', 'WCA'), bA.authorization))).toBe('done');
    expect(await ask(createWorkCenter(wc('PLB1', 'WCB'), bB.authorization))).toBe('done');
    expect((await exists('WCA'))[0]?.created_by).toBe(bA.username);

    const missing = mask(await ask(createWorkCenter(wc('PLZZ', 'WCX'), bA.authorization)), 'PLZZ');
    for (const p of ['PLB1', 'PLN1']) expect(mask(await ask(createWorkCenter(wc(p, 'WCX'), bA.authorization)), p)).toBe(missing);
    expect(await exists('WCX')).toHaveLength(0);

    expect((await getWorkCenter(client, 'PLA1', 'WCA', bA.authorization))?.plant).toBe('PLA1');
    expect(await getWorkCenter(client, 'PLB1', 'WCB', bA.authorization)).toBeNull();
    expect((await listWorkCenters(client, bA.authorization)).map((r) => r.workCenter)).toEqual(['WCA']);

    const before = await getWorkCenter(client, 'PLB1', 'WCB', bB.authorization);
    expect(await ask(changeWorkCenter({ ...wc('PLB1', 'WCB', { description: 'Hijack' }), version: before!.version }, bA.authorization))).not.toBe('done');
    expect((await getWorkCenter(client, 'PLB1', 'WCB', bB.authorization))?.description).toBe('Machine');
    // Copying from a plant out of reach is refused too.
    expect(await ask(createWorkCenter(wc('PLA1', 'WCC', { copyFrom: { plant: 'PLB1', workCenter: 'WCB' } }), bA.authorization))).not.toBe('done');
  });

  it('refuses a missing session, a missing capability, no scope, a plant scope that excludes the plant, and another tenant', async () => {
    for (const bad of [undefined, { userId: 'nobody', sessionId: 'nothing' }, bNoCap.authorization, bNoScope.authorization, bPlantA.authorization, bOther.authorization]) {
      const plant = bad === bPlantA.authorization ? 'PLB1' : 'PLA1';
      if (bad === bPlantA.authorization) expect(await ask(createWorkCenter(wc(plant, 'WCQ'), bad))).not.toBe('done');
      else {
        expect(await ask(createWorkCenter(wc(plant, 'WCQ'), bad))).not.toBe('done');
        expect(await ask(listWorkCenters(client, bad))).not.toBe('done');
      }
    }
    expect(await exists('WCQ')).toHaveLength(0);
  });
});

describe('routing', () => {
  const rt = (plant: string, group: string, extra: Record<string, unknown> = {}) => ({
    client, changedBy: 'someone-else', taskListType: 'N', routingGroup: group, groupCounter: '1', plant,
    description: 'Standard', usage: '1', status: '4', baseQuantity: '1', baseUnit: 'PC', validFrom: '2026-01-01',
    operations: [], ...extra,
  });
  const rows = (group: string) => withTenant(client, async (tx) => (await tx.execute(sql`
    select plant, created_by from routing where client = ${client} and routing_group = ${group}`)) as unknown as Array<{ plant: string; created_by: string }>);

  it('creates, changes, reads, lists and resolves only inside reach, and refuses a plant out of reach as a missing plant', async () => {
    await saveRoutingTaskListType({ client, changedBy: 'SETUP', taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client, changedBy: 'SETUP', usage: '1', description: 'Production' });
    await saveRoutingStatus({ client, changedBy: 'SETUP', status: '4', description: 'Released', releasedForScheduling: 'X', releasedForCosting: 'X', releasedForOrders: 'X' });
    expect(await ask(createRouting(rt('PLA1', 'RA'), bA.authorization))).toBe('done');
    expect(await ask(createRouting(rt('PLB1', 'RB'), bB.authorization))).toBe('done');
    expect((await rows('RA'))[0]?.created_by).toBe(bA.username);

    const missing = mask(await ask(createRouting(rt('PLZZ', 'RX'), bA.authorization)), 'PLZZ');
    for (const p of ['PLB1', 'PLN1']) expect(mask(await ask(createRouting(rt(p, 'RX'), bA.authorization)), p)).toBe(missing);
    expect(await rows('RX')).toHaveLength(0);

    expect((await getRouting(client, 'N', 'RA', '1', null, bA.authorization))?.plant).toBe('PLA1');
    expect(await getRouting(client, 'N', 'RB', '1', null, bA.authorization)).toBeNull();
    expect((await listRoutings(client, {}, bA.authorization)).map((r) => r.routingGroup)).toEqual(['RA']);
    expect(await ask(listRoutings(client, { plant: 'PLB1' }, bA.authorization))).toContain('does not exist');
    expect(await resolveRouting(client, { taskListType: 'N', routingGroup: 'RB', groupCounter: '1' }, bA.authorization)).toBeNull();

    const standing = await getRouting(client, 'N', 'RB', '1', null, bB.authorization);
    expect(await ask(changeRouting(rt('PLB1', 'RB', { description: 'Hijack', version: standing!.version }), bA.authorization))).not.toBe('done');
    expect((await getRouting(client, 'N', 'RB', '1', null, bB.authorization))?.description).toBe('Standard');
    expect(await ask(createRouting(rt('PLA1', 'RC', { copyFrom: { taskListType: 'N', routingGroup: 'RB', groupCounter: '1' } }), bA.authorization))).not.toBe('done');
  });

  it('refuses a missing session, a missing capability, no scope, a plant scope that excludes the plant, and another tenant', async () => {
    for (const bad of [undefined, { userId: 'nobody', sessionId: 'nothing' }, bNoCap.authorization, bNoScope.authorization, bOther.authorization]) {
      expect(await ask(createRouting(rt('PLA1', 'RQ'), bad))).not.toBe('done');
      expect(await ask(listRoutings(client, {}, bad))).not.toBe('done');
    }
    expect(await ask(createRouting(rt('PLB1', 'RQ'), bPlantA.authorization))).not.toBe('done');
    expect(await rows('RQ')).toHaveLength(0);
  });
});

describe('production version', () => {
  const pv = (plant: string, code: string, extra: Record<string, unknown> = {}) => ({
    client, changedBy: 'someone-else', materialNumber: 'SCMK', plant, productionVersion: code, description: 'Standard',
    validFrom: '2026-01-01', lotFrom: '0', lotTo: '100', lotUnit: 'PC', bomUsage: 'P', bomAlternative: '02', taskListType: 'N',
    routingGroup: plant === 'PLA1' ? 'VA' : 'VB', groupCounter: '01', ...extra,
  });
  const rows = (code: string) => withTenant(client, async (tx) => (await tx.execute(sql`
    select plant, created_by from production_version where client = ${client} and production_version = ${code}`)) as unknown as Array<{ plant: string; created_by: string }>);

  it('creates, copies, reads, lists, checks, locks and deletes only inside reach, and refuses a plant out of reach as a missing one', async () => {
    await saveRoutingTaskListType({ client, changedBy: 'SETUP', taskListType: 'N', description: 'Routing' });
    await saveRoutingUsage({ client, changedBy: 'SETUP', usage: '1', description: 'Production' });
    await saveRoutingStatus({ client, changedBy: 'SETUP', status: '4', description: 'Released', releasedForScheduling: 'X', releasedForCosting: 'X', releasedForOrders: 'X' });
    for (const [plant, group] of [['PLA1', 'VA'], ['PLB1', 'VB']] as const) {
      await createMaterialBomForProvisioning({
        client, changedBy: 'SETUP', materialNumber: 'SCMK', plant, usage: 'P', alternative: '02', baseQuantity: '1', baseUnit: 'PC', validFrom: '2020-01-01',
        items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'SCMC', quantity: '1', unit: 'PC' }],
      });
      await createRoutingForProvisioning({
        client, changedBy: 'SETUP', taskListType: 'N', routingGroup: group, groupCounter: '01', plant, description: 'Std', usage: '1', status: '4',
        baseQuantity: '1', baseUnit: 'PC', validFrom: '2026-01-01', assignments: [{ materialNumber: 'SCMK' }], operations: [],
      });
    }
    expect(await ask(createProductionVersion(pv('PLA1', '0001'), bA.authorization))).toBe('done');
    expect(await ask(createProductionVersion(pv('PLB1', '0001'), bB.authorization))).toBe('done');
    expect((await rows('0001')).find((r) => r.plant === 'PLA1')?.created_by).toBe(bA.username);

    const missing = mask(await ask(createProductionVersion(pv('PLZZ', '0009'), bA.authorization)), 'PLZZ');
    for (const p of ['PLB1', 'PLN1']) expect(mask(await ask(createProductionVersion(pv(p, '0009'), bA.authorization)), p)).toBe(missing);
    expect(await rows('0009')).toHaveLength(0);

    expect((await getProductionVersion(client, 'SCMK', 'PLA1', '0001', bA.authorization))?.plant).toBe('PLA1');
    expect(await getProductionVersion(client, 'SCMK', 'PLB1', '0001', bA.authorization)).toBeNull();
    expect((await listProductionVersions(client, { plant: 'PLA1' }, bA.authorization)).total).toBe(1);
    expect((await listProductionVersions(client, { plant: 'PLB1' }, bA.authorization)).total).toBe(0);

    const absent = mask(await ask(checkProductionVersion(client, 'SCMK', 'PLZZ', '0001', 'x', bA.authorization)), 'PLZZ');
    expect(mask(await ask(checkProductionVersion(client, 'SCMK', 'PLB1', '0001', 'x', bA.authorization)), 'PLB1')).toBe(absent);
    expect(await ask(lockProductionVersion(client, 'SCMK', 'PLB1', '0001', 'x', true, 1, bA.authorization))).toBe(absent.replace('PLZZ', 'PLB1'));
    expect(await ask(deleteProductionVersion(client, 'SCMK', 'PLB1', '0001', 'x', 1, bA.authorization))).toBe(absent.replace('PLZZ', 'PLB1'));
    expect(await ask(copyProductionVersion({ ...pv('PLB1', '0001'), newProductionVersion: '0002' }, bA.authorization))).not.toBe('done');
    const standing = await getProductionVersion(client, 'SCMK', 'PLB1', '0001', bB.authorization);
    expect(standing?.lockIndicator).not.toBe('1');
    expect(await ask(changeProductionVersion({ ...pv('PLB1', '0001', { description: 'Hijack' }), version: standing!.version }, bA.authorization))).not.toBe('done');
    expect((await getProductionVersion(client, 'SCMK', 'PLB1', '0001', bB.authorization))?.description).toBe('Standard');

    // Inside reach the same calls work and record the session user.
    expect(await ask(checkProductionVersion(client, 'SCMK', 'PLA1', '0001', 'x', bA.authorization))).toBe('done');
    expect(await ask(copyProductionVersion({ ...pv('PLA1', '0001'), newProductionVersion: '0002' }, bA.authorization))).toBe('done');
    const own = await getProductionVersion(client, 'SCMK', 'PLA1', '0001', bA.authorization);
    expect(await ask(lockProductionVersion(client, 'SCMK', 'PLA1', '0001', 'x', true, own!.version, bA.authorization))).toBe('done');
  });

  it('refuses a missing session, a missing capability, no scope, a plant scope that excludes the plant, and another tenant', async () => {
    for (const bad of [undefined, { userId: 'nobody', sessionId: 'nothing' }, bNoCap.authorization, bNoScope.authorization, bOther.authorization]) {
      expect(await ask(createProductionVersion(pv('PLA1', '0077'), bad))).not.toBe('done');
      expect(await ask(listProductionVersions(client, { plant: 'PLA1' }, bad))).not.toBe('done');
      expect(await ask(checkProductionVersion(client, 'SCMK', 'PLA1', '0001', 'x', bad))).not.toBe('done');
    }
    expect(await ask(createProductionVersion(pv('PLB1', '0077'), bPlantA.authorization))).not.toBe('done');
    expect(await rows('0077')).toHaveLength(0);
  });
});
