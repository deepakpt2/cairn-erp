import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry, reverseJournalEntry } from '../src/platform/posting';
import { closeDb, createTenant, destroyTenant, defineTestRanges } from './helpers';
import { createProductionActor, refreshActorPlants, PRODUCTION_ACTOR_CAPABILITIES } from './helpers/production-actor';
import {
  saveAllocationStructure,
  saveAllocationStructureAssignment,
  saveSettlementProfile,
} from '../src/modules/foundation/settlement-configuration-masters';
import {
  assignProductionOrderTypeSettlementProfile,
  saveProductionOrderSettlementConfiguration,
} from '../src/modules/production/settlement-configuration';
import {
  createProductionOrder,
  releaseProductionOrder,
} from '../src/modules/inventory/production-orders';
import { saveProductionOrderType } from '../src/modules/production/production-order-type';
import { settleProductionOrderForProvisioning as settleProductionOrder } from '../src/modules/production/order-settlement';
import { getProductionOrderCostReport } from './helpers/cost-report-authorized';
import { technicallyCompleteProductionOrder } from '../src/modules/production/production-order-change';
import { calculateWip, postedWip, runWip, WIP_METHOD } from '../src/modules/production/order-wip';

/**
 * Financial WIP — actual-cost net balance, delta postings, unwind at final settlement.
 *
 * Real postings, real ledger: costs and output are journal documents citing the order, and every assertion reads the
 * journal, the WIP ledger and the order cost report back. The method is stated in order-wip.ts; this file proves it.
 */

const ACTOR = 'PROD_WIP_TEST';
const PLANT = 'QO01';
const ORDER_TYPE = 'PP01';

const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

interface Place {
  client: string;
  area: string;
  company: string;
  currency: string;
  periods: number;
}

async function standing(seed: string): Promise<Place> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  await defineTestRanges(tenant);
  const place: Place = { client: tenant.client, area: '', company: '', currency: '', periods: 0 };
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, {
      client: tenant.client,
      objectCode: 'PRODORDER',
      subObject: '*',
      prefix: 'PRD',
      numberLength: 7,
      createdBy: ACTOR,
    });
    // RF_BELEG range is defined via defineTestRanges (companyCode-scoped, subObject GENERAL)
    // to match what postJournalEntry allocates against.
    await tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${tenant.client}, ${ORDER_TYPE}, 'Standard production', '10', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      update production_order_type set wip_method = 'ACTUAL_COST_NET_BALANCE' where client = ${tenant.client} and order_type = ${ORDER_TYPE}
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      select ${tenant.client}, ${PLANT}, 'Order plant', c.company_code, 'KW', ${ACTOR}
      from (select company_code from company_code where client = ${tenant.client} order by company_code limit 1) c
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${tenant.client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
      from (values ('FG01', 'Finished good'), ('RM01', 'Raw material one')) as v(n, d)
      cross join (select material_type from material_type where client = ${tenant.client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${tenant.client}, v.n, ${PLANT}, ${ACTOR}
      from (values ('FG01'), ('RM01')) as v(n)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${tenant.client}, ${PLANT}, 'SO01', 'Order store', true, false, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      select ${tenant.client}, a.controlling_area, 'CC1000', '2020-01-01', '9999-12-31', 'Settlement receiver', 'PRODUCTION', c.company_code, ${ACTOR}
      from controlling_area_company a
      join company_code c on c.client = a.client and c.company_code = a.company_code
      where a.client = ${tenant.client}
      limit 1
      on conflict do nothing
    `);
    const [areaRow] = await tx.execute(sql`
      select c.controlling_area as area, c.currency, c.fiscal_year_variant as fv
        from controlling_area c
       where c.client = ${tenant.client}
       limit 1
    `) as unknown as Array<{ area: string; currency: string; fv: string }>;
    if (!areaRow) {
      throw new Error(`No controlling area found for tenant ${tenant.client}`);
    }
    place.area = areaRow.area;
    place.company = tenant.companyCode;
    place.currency = areaRow.currency.trim();
    // Look up periods from fiscal_year_variant
    const [fvRow] = await tx.execute(sql`
      select v.regular_periods as periods
        from fiscal_year_variant v
       where v.client = ${tenant.client} and v.variant = ${areaRow.fv}
       limit 1
    `) as unknown as Array<{ periods: number }>;
    place.periods = fvRow ? Number(fvRow.periods) : 12;
  });
  // Set up settlement masters for production orders (profile, structure, type assignment),
  // mirroring ensureSettlementMasters but using production order type instead of internal IO01.
  await saveAllocationStructure({
    client: place.client,
    changedBy: ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    structureCode: 'AS01',
    description: 'Original account',
  });
  for (const sourceAccount of ['410000', '420000']) {
    await saveAllocationStructureAssignment({
      client: place.client,
      changedBy: ACTOR,
      expectedVersion: 0,
      structureCode: 'AS01',
      sourceAccount,
      receiverCategory: 'COST_CENTER',
      byOriginalAccount: true,
      settlementAccount: '',
    });
  }
  await saveSettlementProfile({
    client: place.client,
    changedBy: ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    profileCode: 'SP01',
    description: 'Order settlement',
    allocationStructure: 'AS01',
    documentType: 'SA',
    percentageAllowed: true,
    equivalenceAllowed: true,
    amountAllowed: true,
    isActive: true,
  });
  await assignProductionOrderTypeSettlementProfile({
    client: place.client,
    changedBy: ACTOR,
    orderType: ORDER_TYPE,
    profileCode: 'SP01',
  });
  Object.assign(PROD_ACTOR, await createProductionActor(place.client));

  return place;
}

async function makeOrder(place: Place, orderType = ORDER_TYPE) {
  const view = await createProductionOrder({
    client: place.client,
    createdBy: ACTOR,
    materialNumber: 'FG01',
    plant: PLANT,
    orderQuantity: 100,
    scheduledStart: '2026-11-02',
    scheduledFinish: '2026-11-06',
    components: [
      { materialNumber: 'RM01', plant: PLANT, storageLocation: 'SO01', requiredQuantity: 50 },
    ],
    orderType,
  }, { authorization: await authority(place.client) });
  await releaseProductionOrder({
    client: place.client,
    orderNumber: view.orderNumber,
    releasedBy: ACTOR,
  }, { authorization: await authority(place.client) });
  return view;
}


async function postCost(place: Place, orderNumber: string, amount: string, account = '410000') {
  await withTenant(place.client, (tx) => postJournalEntry(tx, {
    client: place.client,
    companyCode: place.company,
    documentType: 'SA',
    documentDate: '2026-01-15',
    postingDate: '2026-01-15',
    fiscalYear: 2026,
    postingPeriod: 1,
    currency: place.currency,
    localCurrency: place.currency,
    headerText: 'Order cost',
    postedBy: ACTOR,
    lines: [
      { glAccount: account, debitCredit: 'S', amount, productionOrder: orderNumber },
      { glAccount: '100000', debitCredit: 'H', amount },
    ],
  }));
}

function settlementRule(place: Place, orderNumber: string, receiver: string, percentage = '100') {
  return saveProductionOrderSettlementConfiguration({
    client: place.client,
    changedBy: ACTOR,
    orderNumber,
    receiverCategory: 'COST_CENTER',
    receiver,
    percentage,
    settlementType: 'PER',
    validFromYear: 2026,
    validFromPeriod: 1,
    validToYear: 2026,
    validToPeriod: 12,
  });
}

/** The signed-in user the production services act for. Filled in by the suite's own setup. */
const PROD_ACTOR = { userId: '', sessionId: '', authorization: { userId: '', sessionId: '' } };

/**
 * The authority a production service is handed.
 *
 * The actor is signed in the first time a service is called, and its Company Code
 * and Plant reach is refreshed on every call: a suite builds its masters in
 * `beforeAll` and often adds a plant after the tenant exists, and a service asked
 * before that plant was granted would answer that the actor's reach does not cover
 * it — which is the rule working, not a test failing for the wrong reason.
 */
let ACTOR_READY: Promise<void> | null = null;
let ACTOR_TENANT = '';

async function authority(client: string) {
  // Keyed on the tenant as well as the user: a suite that stands two tenants up
  // needs a session in each, and a session from one is not a session in the other.
  if (!PROD_ACTOR.userId || ACTOR_TENANT !== client) {
    ACTOR_TENANT = client;
    ACTOR_READY = createProductionActor(client).then((actor) => { Object.assign(PROD_ACTOR, actor); });
    await ACTOR_READY;
  }
  await refreshActorPlants(client, PROD_ACTOR);
  return PROD_ACTOR.authorization;
}


// ── The WIP fixture ───────────────────────────────────────────────────────────────────────────────────────────

const WIP = '125000';
const CHANGE = '410400';
const OUTPUT = '410500';

async function wipAccounts(place: Place, options: { configured?: boolean; sharedOutput?: boolean } = {}) {
  await withTenant(place.client, async (tx) => {
    await tx.execute(sql`
      insert into gl_account (client, chart_of_accounts, account_number, name, account_type, is_balance_sheet, is_open_item_managed,
                              reconciliation_type, requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
      select ${place.client}, c.chart_of_accounts, v.n, v.d, v.t, v.bs, false, null, v.rco, false, 'GENL', v.k, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${place.client} limit 1) c
       cross join (values
         ('125000', 'Work in process', 'ASSET', true, false, 'BALANCE_SHEET'),
         ('410400', 'Change in work in process', 'EXPENSE', false, false, 'PL_STATEMENT'),
         ('410500', 'Production output', 'EXPENSE', false, true, 'PL_STATEMENT')
       ) as v(n, d, t, bs, rco, k)
      on conflict do nothing
    `);
    const rows = options.configured === false
      ? [] // the cost-side events stand, the WIP events do not
      : [['PRODUCTION_WIP', WIP], ['PRODUCTION_WIP_CHANGE', CHANGE]];
    for (const [event, account, valuationClass] of [
      ['PRODUCTION_CONSUMPTION', '410000', ''], ['PRODUCTION_ACTIVITY', '420000', ''], ['PRODUCTION_OUTPUT', options.sharedOutput ? '410000' : OUTPUT, ''],
      ['INVENTORY', '120200', 'FINISHED_INVENTORY'], ...rows.map(([e, a]) => [e, a, ''])] as string[][]) {
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        select ${place.client}, c.chart_of_accounts, ${event}, ${valuationClass}, '', ${account}, ${ACTOR}
          from (select chart_of_accounts from chart_of_accounts where client = ${place.client} limit 1) c
        on conflict do nothing
      `);
    }
  });
  // The settlement can only distribute an account it has an allocation assignment for.
  for (const sourceAccount of [OUTPUT, '120200']) {
    await saveAllocationStructureAssignment({
      client: place.client, changedBy: ACTOR, expectedVersion: 0, structureCode: 'AS01', sourceAccount,
      receiverCategory: 'COST_CENTER', byOriginalAccount: true, settlementAccount: '',
    });
  }
}

type Line = { glAccount: string; debitCredit: 'S' | 'H'; amount: string; productionOrder?: string; costCenter?: string };

function post(place: Place, lines: Line[], date = '2026-01-15', period = 1, origin?: { documentClass: string; documentKey: string }) {
  return withTenant(place.client, (tx) => postJournalEntry(tx, {
    client: place.client, companyCode: place.company, documentType: 'SA', documentDate: date, postingDate: date, fiscalYear: 2026,
    postingPeriod: period, currency: place.currency, localCurrency: place.currency, headerText: 'Order posting', postedBy: ACTOR, lines, origin,
  }));
}
const material = (place: Place, order: string, amount: string, date?: string, period?: number) => post(place, [
  { glAccount: '410000', debitCredit: 'S', amount, productionOrder: order }, { glAccount: '120000', debitCredit: 'H', amount }], date, period);
const activity = (place: Place, order: string, amount: string, date?: string, period?: number) => post(place, [
  { glAccount: '420000', debitCredit: 'S', amount, productionOrder: order }, { glAccount: '420000', debitCredit: 'H', amount, costCenter: 'CC1000' }], date, period);
// A production receipt posts BOTH legs with the order: the inventory debit and the output credit.
const output = (place: Place, order: string, amount: string, date?: string, period?: number, account = OUTPUT) => post(place, [
  { glAccount: '120200', debitCredit: 'S', amount, productionOrder: order }, { glAccount: account, debitCredit: 'H', amount, productionOrder: order }], date, period);

async function wipActor(place: Place, capabilities: readonly string[] = [...PRODUCTION_ACTOR_CAPABILITIES, 'PROD.ORDER.SETTLE']) {
  const actor = await createProductionActor(place.client, { capabilities });
  await refreshActorPlants(place.client, actor);
  return actor.authorization;
}

const counts = (place: Place) => withTenant(place.client, async (tx) => {
  const [row] = await tx.execute(sql`
    select (select count(*)::int from journal_entry where client = ${place.client}) as journals,
           (select count(*)::int from production_order_wip_posting where client = ${place.client}) as wip
  `) as unknown as Array<{ journals: number; wip: number }>;
  return row!;
});

async function balance(place: Place, account: string): Promise<number> {
  return withTenant(place.client, async (tx) => {
    const [row] = await tx.execute(sql`
      select coalesce(sum(case when debit_credit = 'S' then amount_local else -amount_local end), 0)::text as net
        from journal_entry_line where client = ${place.client} and gl_account = ${account}
    `) as unknown as Array<{ net: string }>;
    return Number(row!.net);
  });
}

async function wipLines(place: Place, document: string) {
  return withTenant(place.client, async (tx) => tx.execute(sql`
    select gl_account, debit_credit, amount_local::text as amount, production_order, (select origin_class from journal_entry j where j.client = l.client and j.document_number = l.document_number and j.fiscal_year = l.fiscal_year) as origin_class
      from journal_entry_line l where client = ${place.client} and document_number = ${document} order by line_number
  `) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string; production_order: string | null; origin_class: string }>);
}

const run = (place: Place, auth: { userId: string; sessionId: string } | undefined, order: string, period: number, testRun: boolean, extra: Record<string, unknown> = {}) =>
  runWip({ client: place.client, by: ACTOR, authorization: auth, orderNumber: order, fiscalYear: 2026, period, testRun, ...extra });

describe('financial WIP (actual-cost net balance)', () => {
  it('previews without writing, then capitalises material 80 + activity 20 − output 60 = 40 once, on the delta', async () => {
    const p = await standing('wip-main');
    await wipAccounts(p);
    const auth = await wipActor(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '80.00');
    await activity(p, order, '20.00');
    await output(p, order, '60.00');

    const before = await counts(p);
    const preview = await run(p, auth, order, 1, true);
    expect(preview.testRun).toBe(true);
    expect(preview.method).toBe(WIP_METHOD);
    const calc = preview.orders[0]!;
    expect(calc).toMatchObject({ status: 'POST', costTotal: '100.0000', outputTotal: '60.0000', eligibleWip: '40.0000', previousPosted: '0.0000', delta: '40.0000', wipAccount: WIP, changeAccount: CHANGE, periodEnd: '2026-01-31' });
    expect(calc.components.map((c) => `${c.role}:${c.account}:${c.net}`)).toEqual(['INVENTORY:120200:60.0000', 'COST:410000:80.0000', 'OUTPUT:410500:-60.0000', 'COST:420000:20.0000']);
    // It reconciles to the order cost report: the net of every line the method read is the report's net.
    const report = await getProductionOrderCostReport({ client: p.client, orderNumber: order });
    // The order's journal net also carries the receipt's inventory leg (+60), so it is the cost (100), not the WIP.
    expect(report.totals[0]!.netLocal).toBe('100.0000');
    expect(calc.reportNet).toBe('100.0000');
    expect(await counts(p)).toEqual(before);

    const update = await run(p, auth, order, 1, false);
    expect(update.posted).toBe(1);
    const posted = update.orders[0]!;
    expect(posted.document).not.toBeNull();
    const lines = await wipLines(p, posted.document!.documentNumber);
    expect(lines.map((l) => `${l.debit_credit}:${l.gl_account}:${l.amount}`).sort()).toEqual([`H:${CHANGE}:40.0000`, `S:${WIP}:40.0000`]);
    expect(lines.every((l) => l.production_order === null && l.origin_class === 'production_order_wip')).toBe(true);
    expect(await balance(p, WIP)).toBe(40);
    expect(await balance(p, CHANGE)).toBe(-40);
    expect((await withTenant(p.client, (tx) => postedWip(tx, p.client, order))).cumulative).toBe(400000n);

    // The cost report lists the WIP posting but does not add it to the journal totals.
    const after = await getProductionOrderCostReport({ client: p.client, orderNumber: order });
    expect(after.wipPostings).toHaveLength(1);
    expect(after.totals[0]!.netLocal).toBe('100.0000');

    // A repeat, and concurrent runs, post nothing more.
    const again = await run(p, auth, order, 1, false);
    expect(again.posted).toBe(0);
    expect(again.orders[0]!.status).toBe('NO_CHANGE');
    const parallel = await Promise.all([run(p, auth, order, 1, false), run(p, auth, order, 1, false), run(p, auth, order, 1, false)]);
    expect(parallel.reduce((sum, r) => sum + r.posted, 0)).toBe(0);
    expect((await counts(p)).wip).toBe(1);
    expect(await balance(p, WIP)).toBe(40);
  });

  it('unwinds the prior WIP when later output completes the order, and refuses to rewrite an earlier period', async () => {
    const p = await standing('wip-unwind');
    await wipAccounts(p);
    const auth = await wipActor(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '80.00');
    await activity(p, order, '20.00');
    await output(p, order, '60.00');
    const first = (await run(p, auth, order, 1, false)).orders[0]!;
    expect(first.status).toBe('POST');

    // Period 2: more valid output brings the cumulative output credit to 100; eligible WIP is 0 and the 40 is unwound.
    await output(p, order, '40.00', '2026-02-10', 2);
    const next = await run(p, auth, order, 2, false);
    const unwind = next.orders[0]!;
    expect(unwind).toMatchObject({ status: 'UNWIND', costTotal: '100.0000', outputTotal: '100.0000', eligibleWip: '0.0000', previousPosted: '40.0000', delta: '-40.0000' });
    const lines = await wipLines(p, unwind.document!.documentNumber);
    expect(lines.map((l) => `${l.debit_credit}:${l.gl_account}:${l.amount}`).sort()).toEqual([`H:${WIP}:40.0000`, `S:${CHANGE}:40.0000`]);
    // The source ledger reconciles: WIP and change-in-WIP are back to zero, the original period-1 document is untouched.
    expect(await balance(p, WIP)).toBe(0);
    expect(await balance(p, CHANGE)).toBe(0);
    const history = await getProductionOrderCostReport({ client: p.client, orderNumber: order });
    expect(history.wipPostings.map((row) => `${row.seq}:${row.period}:${row.delta}:${row.cumulativeAfter}`)).toEqual(['1:1:40.0000:40.0000', '2:2:-40.0000:0.0000']);
    expect(history.wipPostings[1]!.previousPostingId).toBe(history.wipPostings[0]!.postingId);
    expect(history.wipPostings[1]!.explanation).toMatch(/Full unwind/);
    expect(history.totals[0]!.netLocal).toBe('100.0000');
    expect((await wipLines(p, first.document!.documentNumber)).map((l) => l.amount)).toEqual(['40.0000', '40.0000']);

    // Period 1 may not be recalculated now that period 2 carries a posting: history is not rewritten.
    const rerun = (await run(p, auth, order, 1, false)).orders[0]!;
    expect(rerun.status).toBe('REFUSED');
    expect(rerun.reasons.join(' ')).toMatch(/already posted for period 2/);
    expect((await counts(p)).wip).toBe(2);
  });

  it('adjusts by an explained delta for a late cost and for a cost reversal in the same period', async () => {
    const p = await standing('wip-late');
    await wipAccounts(p);
    const auth = await wipActor(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '100.00');
    await output(p, order, '60.00');
    expect((await run(p, auth, order, 1, false)).orders[0]).toMatchObject({ status: 'POST', delta: '40.0000' });

    const late = await material(p, order, '10.00', '2026-01-20');
    const up = (await run(p, auth, order, 1, false)).orders[0]!;
    expect(up).toMatchObject({ status: 'POST', previousPosted: '40.0000', eligibleWip: '50.0000', delta: '10.0000' });
    expect((await wipLines(p, up.document!.documentNumber)).map((l) => `${l.debit_credit}:${l.amount}`).sort()).toEqual(['H:10.0000', 'S:10.0000']);

    await withTenant(p.client, (tx) => reverseJournalEntry(tx, {
      client: p.client, documentNumber: late.documentNumber, fiscalYear: late.fiscalYear, reversalDate: '2026-01-25', reason: 'Wrong cost', reversedBy: ACTOR,
    }));
    const down = (await run(p, auth, order, 1, false)).orders[0]!;
    expect(down).toMatchObject({ status: 'POST', previousPosted: '50.0000', eligibleWip: '40.0000', delta: '-10.0000' });
    const history = (await getProductionOrderCostReport({ client: p.client, orderNumber: order })).wipPostings;
    expect(history.map((row) => row.explanation)).toEqual([
      expect.stringMatching(/First capitalisation/), expect.stringMatching(/Increase/), expect.stringMatching(/Decrease/),
    ]);
    expect(await balance(p, WIP)).toBe(40);
  });

  it('refuses what the method cannot calculate safely, naming the order and the remedy, and posts nothing', async () => {
    const p = await standing('wip-refuse');
    await wipAccounts(p);
    const auth = await wipActor(p);

    // A manual posting on an unclassified account.
    const manual = (await makeOrder(p)).orderNumber;
    await material(p, manual, '50.00');
    await post(p, [{ glAccount: '410100', debitCredit: 'S', amount: '5.00', productionOrder: manual }, { glAccount: '120000', debitCredit: 'H', amount: '5.00' }]);
    const unclassified = (await run(p, auth, manual, 1, true)).orders[0]!;
    expect(unclassified.status).toBe('UNSUPPORTED');
    expect(unclassified.reasons.join(' ')).toMatch(/Account 410100 .* neither a material\/activity cost account nor the production-output account/);
    expect((await run(p, auth, manual, 1, false)).posted).toBe(0);

    // Output above cost is a variance for settlement, not WIP.
    const variance = (await makeOrder(p)).orderNumber;
    await material(p, variance, '30.00');
    await output(p, variance, '50.00');
    const over = (await run(p, auth, variance, 1, false)).orders[0]!;
    expect(over.status).toBe('UNSUPPORTED');
    expect(over.reasons.join(' ')).toMatch(/exceed cost/);
    expect(over.remedy).toMatch(/Settle the order/);

    // A created order carries no actuals; a special period is refused; an unknown order is reported, not invented.
    const created = await withTenant(p.client, async (tx) => {
      const [row] = await tx.execute(sql`select order_number from production_order where client = ${p.client} and status = 'CREATED' limit 1`) as unknown as Array<{ order_number: string }>;
      return row?.order_number ?? null;
    });
    expect(created).toBeNull(); // makeOrder releases every order; a CREATED order is proved on the settlement side below
    expect((await run(p, auth, manual, 13, true)).orders[0]!.reasons.join(' ')).toMatch(/special period/);
    expect((await run(p, auth, 'NOSUCH', 1, true)).orders[0]).toMatchObject({ status: 'NOT_ELIGIBLE' });
    expect((await counts(p)).wip).toBe(0);
  });

  it('is not configured without explicit WIP accounts, and invents none', async () => {
    const p = await standing('wip-noaccounts');
    await wipAccounts(p, { configured: false });
    const auth = await wipActor(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '80.00');
    await output(p, order, '40.00');
    const calc = (await run(p, auth, order, 1, false)).orders[0]!;
    expect(calc.status).toBe('NOT_CONFIGURED');
    expect(calc.reasons.join(' ')).toMatch(/No account is determined for PRODUCTION_WIP/);
    expect(calc.remedy).toMatch(/account-determination/);
    expect((await counts(p)).wip).toBe(0);
  });

  it('refuses an unauthorised or out-of-tenant run, and a closed fiscal period, and posts once the period reopens', async () => {
    const p = await standing('wip-guard');
    await wipAccounts(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '80.00');
    await output(p, order, '40.00');
    const auth = await wipActor(p);

    const anonymous = (await run(p, undefined, order, 1, false)).orders[0]!;
    expect(anonymous.status).toBe('REFUSED');
    expect(anonymous.reasons.join(' ')).toMatch(/signed-in user/);
    const noCapability = await wipActor(p, PRODUCTION_ACTOR_CAPABILITIES);
    const denied = (await run(p, noCapability, order, 1, false)).orders[0]!;
    expect(denied.status).toBe('REFUSED');
    expect(denied.reasons.join(' ')).toMatch(/PROD\.ORDER\.SETTLE/);

    // Another tenant cannot see or post this order.
    const other = await standing('wip-guard-other');
    await wipAccounts(other);
    const otherAuth = await wipActor(other);
    expect((await run(other, otherAuth, order, 1, true)).orders[0]!.reasons.join(' ')).toMatch(/does not stand in this tenant/);

    await withTenant(p.client, (tx) => tx.execute(sql`update posting_period_rule set period_from = 2, period_to = 12 where client = ${p.client}`));
    const closed = (await run(p, auth, order, 1, false)).orders[0]!;
    expect(closed.status).toBe('REFUSED');
    expect(closed.reasons.join(' ')).toMatch(/closed/i);
    expect((await counts(p)).wip).toBe(0);
    await withTenant(p.client, (tx) => tx.execute(sql`update posting_period_rule set period_from = 1, period_to = 12 where client = ${p.client}`));
    expect((await run(p, auth, order, 1, false)).posted).toBe(1);
  });

  it('settles a completed order only after unwinding its WIP, so the balance is never capitalised and settled twice', async () => {
    const p = await standing('wip-settle');
    await wipAccounts(p);
    const auth = await wipActor(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '80.00');
    await activity(p, order, '20.00');
    await output(p, order, '60.00');
    await settlementRule(p, order, 'CC1000', '100');
    expect((await run(p, auth, order, 1, false)).posted).toBe(1);
    expect(await balance(p, WIP)).toBe(40);

    // A released (unfinished) order is not final-settled: that would clear its WIP as a variance.
    const refused = await settleProductionOrder({ ...runArgs(p, order), testRun: false });
    expect(refused.posted).toBe(false);
    expect(refused.orders[0]!.reasons.join(' ')).toMatch(/released and not technically completed/);
    expect(await balance(p, WIP)).toBe(40);

    const [version] = await withTenant(p.client, (tx) => tx.execute(sql`select version from production_order where client = ${p.client} and order_number = ${order}`)) as unknown as Array<{ version: number }>;
    await technicallyCompleteProductionOrder({
      authorization: await authority(p.client), client: p.client, changedBy: ACTOR, orderNumber: order, expectedVersion: Number(version!.version),
      held: ['PROD.ORDER.CHANGE'], confirmed: true,
    });
    // A TECO order has target WIP 0: the WIP run proposes the unwind, and the test run of the settlement says so.
    expect((await run(p, auth, order, 1, true)).orders[0]).toMatchObject({ status: 'UNWIND', eligibleWip: '0.0000', delta: '-40.0000' });
    const simulated = await settleProductionOrder({ ...runArgs(p, order), testRun: true });
    expect(simulated.orders[0]!.reasons.join(' ')).toMatch(/WIP of 40\.0000 stands on this order and would be unwound/);
    expect(await balance(p, WIP)).toBe(40);

    const settled = await settleProductionOrder({ ...runArgs(p, order), testRun: false });
    expect(settled.posted).toBe(true);
    expect(settled.orders[0]!.reasons.join(' ')).toMatch(/WIP of 40\.0000 was unwound by /);
    // The WIP is gone, the change-in-WIP is back to zero, the order balance is settled to the receiver — each exactly once.
    expect(await balance(p, WIP)).toBe(0);
    expect(await balance(p, CHANGE)).toBe(0);
    const report = await getProductionOrderCostReport({ client: p.client, orderNumber: order });
    expect(report.totals[0]!.netLocal).toBe('0.0000');
    expect(report.wipPostings.map((row) => row.cumulativeAfter)).toEqual(['40.0000', '0.0000']);
    expect((await withTenant(p.client, (tx) => postedWip(tx, p.client, order))).cumulative).toBe(0n);
    // And WIP is not calculated for an order that stands settled.
    const afterwards = (await run(p, auth, order, 1, true)).orders[0]!;
    expect(afterwards.status).toBe('UNSUPPORTED');
    expect(afterwards.reasons.join(' ')).toMatch(/already carries a settlement posting/);
  });

  it('blocks final settlement when the unwind cannot be posted, and rolls the settlement back with it', async () => {
    const p = await standing('wip-settle-blocked');
    await wipAccounts(p);
    const auth = await wipActor(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '80.00');
    await output(p, order, '30.00');
    await settlementRule(p, order, 'CC1000', '100');
    expect((await run(p, auth, order, 1, false)).posted).toBe(1);
    const [version] = await withTenant(p.client, (tx) => tx.execute(sql`select version from production_order where client = ${p.client} and order_number = ${order}`)) as unknown as Array<{ version: number }>;
    await technicallyCompleteProductionOrder({
      authorization: await authority(p.client), client: p.client, changedBy: ACTOR, orderNumber: order, expectedVersion: Number(version!.version),
      held: ['PROD.ORDER.CHANGE'], confirmed: true,
    });
    // Close the settlement period: the unwind cannot post, so nothing is settled and the WIP still stands.
    await withTenant(p.client, (tx) => tx.execute(sql`update posting_period_rule set period_from = 2, period_to = 12 where client = ${p.client}`));
    const blocked = await settleProductionOrder({ ...runArgs(p, order), testRun: false });
    expect(blocked.posted).toBe(false);
    expect(blocked.orders[0]!.outcome).toBe('FAILED');
    expect(await balance(p, WIP)).toBe(50);
    const report = await getProductionOrderCostReport({ client: p.client, orderNumber: order });
    expect(report.totals[0]!.netLocal).toBe('80.0000');
    await withTenant(p.client, (tx) => tx.execute(sql`update posting_period_rule set period_from = 1, period_to = 12 where client = ${p.client}`));
  });

  it('posts exactly once when the first run is raced, and replays a request key without a second document', async () => {
    const p = await standing('wip-race');
    await wipAccounts(p);
    const auth = await wipActor(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '90.00');
    await output(p, order, '50.00');
    const raced = await Promise.all([1, 2, 3, 4].map(() => run(p, auth, order, 1, false)));
    expect(raced.reduce((sum, r) => sum + r.posted, 0)).toBe(1);
    expect((await counts(p)).wip).toBe(1);
    expect(await balance(p, WIP)).toBe(40);

    // A new request key on a changed calculation adjusts; the same key again returns the first document and posts nothing.
    await material(p, order, '5.00', '2026-01-21');
    const keyed = await run(p, auth, order, 1, false, { requestKey: 'wip-key-1' });
    expect(keyed.posted).toBe(1);
    const replay = await run(p, auth, order, 1, false, { requestKey: 'wip-key-1' });
    expect(replay.posted).toBe(0);
    expect(replay.orders[0]!.reasons.join(' ')).toMatch(/already posted as/);
    expect(replay.orders[0]!.document!.documentNumber).toBe(keyed.orders[0]!.document!.documentNumber);
    expect(await balance(p, WIP)).toBe(45);
  });

  it('is off per order type until the type enables it, and the type screen service validates the method', async () => {
    const p = await standing('wip-switch');
    await wipAccounts(p);
    const auth = await wipActor(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '80.00');
    await output(p, order, '40.00');
    await withTenant(p.client, (tx) => tx.execute(sql`update production_order_type set wip_method = '' where client = ${p.client}`));
    const off = (await run(p, auth, order, 1, false)).orders[0]!;
    expect(off.status).toBe('NOT_ELIGIBLE');
    expect(off.reasons.join(' ')).toMatch(/not enabled for order type PP01/);
    expect(off.remedy).toMatch(/production-order-types/);
    expect((await counts(p)).wip).toBe(0);
    await expect(saveProductionOrderType({
      client: p.client, changedBy: ACTOR, mode: 'CHANGE', orderType: ORDER_TYPE, description: 'Standard production', wipMethod: 'PERCENT_COMPLETE', version: 1, reason: 'x',
    })).rejects.toThrow(/does not stand/);
    const saved = await saveProductionOrderType({
      client: p.client, changedBy: ACTOR, mode: 'CHANGE', orderType: ORDER_TYPE, description: 'Standard production', wipMethod: 'ACTUAL_COST_NET_BALANCE', version: 1, reason: 'Enable WIP',
    });
    expect(saved?.wipMethod).toBe('ACTUAL_COST_NET_BALANCE');
    expect((await run(p, auth, order, 1, false)).posted).toBe(1);
  });

  it('does not capitalise a created order and targets zero for a technically completed one', async () => {
    const p = await standing('wip-status');
    await wipAccounts(p);
    const auth = await wipActor(p);
    const created = await createProductionOrder({
      client: p.client, createdBy: ACTOR, materialNumber: 'FG01', plant: PLANT, orderQuantity: 10, scheduledStart: '2026-11-02', scheduledFinish: '2026-11-06',
      components: [{ materialNumber: 'RM01', plant: PLANT, storageLocation: 'SO01', requiredQuantity: 5 }], orderType: ORDER_TYPE,
    }, { authorization: await authority(p.client) });
    const calc = (await run(p, auth, created.orderNumber, 1, true)).orders[0]!;
    expect(calc.status).toBe('NOT_ELIGIBLE');
    expect(calc.reasons.join(' ')).toMatch(/only created/);

    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '30.00');
    const [version] = await withTenant(p.client, (tx) => tx.execute(sql`select version from production_order where client = ${p.client} and order_number = ${order}`)) as unknown as Array<{ version: number }>;
    await technicallyCompleteProductionOrder({
      authorization: await authority(p.client), client: p.client, changedBy: ACTOR, orderNumber: order, expectedVersion: Number(version!.version),
      held: ['PROD.ORDER.CHANGE'], confirmed: true,
    });
    const teco = (await run(p, auth, order, 1, true)).orders[0]!;
    expect(teco).toMatchObject({ status: 'NO_CHANGE', eligibleWip: '0.0000', costTotal: '30.0000' });
    expect(teco.reasons.join(' ')).toMatch(/technically completed/);
  });

  it('reads a tenant whose consumption and output meet on one account by that account\'s net', async () => {
    const p = await standing('wip-shared');
    await wipAccounts(p, { sharedOutput: true });
    const auth = await wipActor(p);
    const order = (await makeOrder(p)).orderNumber;
    await material(p, order, '80.00');
    await output(p, order, '60.00', '2026-01-15', 1, '410000');
    const calc = (await run(p, auth, order, 1, true)).orders[0]!;
    expect(calc.status).toBe('POST');
    expect(calc.eligibleWip).toBe('20.0000');
    expect(calc.components.find((c) => c.account === '410000')).toMatchObject({ role: 'NET', debit: '80.0000', credit: '60.0000', net: '20.0000' });
    expect(calc.reasons.join(' ')).toMatch(/serves both production consumption and production output/);
  });
});

function runArgs(place: Place, orderNumber: string) {
  return { client: place.client, changedBy: ACTOR, orderNumber, controllingArea: place.area, fiscalYear: 2026, settlementPeriod: 1, testRun: true };
}

void calculateWip;
