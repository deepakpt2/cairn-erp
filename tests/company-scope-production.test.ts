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
