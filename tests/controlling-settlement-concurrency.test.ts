/**
 * Concurrency around the Controlling runs that touch an internal order without editing its header:
 * the individual and collective actual settlement, the settlement rule that decides where a
 * settlement goes, and the plan-revaluation definition.
 *
 * Each of these writers already serialises itself against its own kind of run — settlement on the
 * order, year and period; the rule screen on the order; the definition on the controlling area — and
 * a settlement run reads the order's own header before its posting transaction opens, which is where
 * a header change can slip in. These tests hold a header change in flight across that boundary and
 * read the tables back, so both the protection and the boundary are observable rather than assumed.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { and, closeDb, createTenant, db, defineTestRanges, destroyTenant, eq, sql, withTenant } from './helpers';
import { type Tx } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry } from '../src/platform/posting';
import { changeInternalOrder, createInternalOrder } from '../src/modules/foundation/internal-order';
import { settleOrder, settleOrdersCollective } from '../src/modules/foundation/order-settlement';
import { createPlanRevaluationOrder } from '../src/modules/foundation/plan-revaluation';
import { saveOrderSettlementConfiguration } from '../src/modules/foundation/settlement-configuration';
import { internalOrder } from '../src/modules/foundation/schema';

const ACTOR = 'CONCUR_TEST';
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
}

async function standing(seed: string): Promise<Place> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const place: Place = { client: tenant.client, area: '', company: '', currency: '' };
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, {
      client: tenant.client,
      objectCode: 'INTORDER',
      subObject: '*',
      prefix: 'IO',
      numberLength: 8,
      createdBy: ACTOR,
    });
    await defineRange(tx, {
      client: tenant.client,
      objectCode: 'REVALORD',
      subObject: '*',
      prefix: 'RV',
      numberLength: 8,
      createdBy: ACTOR,
    });
    await tx.execute(sql`
      insert into internal_order_type (
        client, order_type, description, number_range_sub_object, statistical_default, created_by
      ) values
        (${tenant.client}, 'IO01', 'Internal order', '*', false, ${ACTOR})
      on conflict do nothing
    `);
    const [assignment] = await tx.execute(sql`
      select a.controlling_area as area, a.company_code as company, c.currency
        from controlling_area_company a
        join controlling_area c on c.client = a.client and c.controlling_area = a.controlling_area
       where a.client = ${tenant.client}
       limit 1
    `) as unknown as Array<{ area: string; company: string; currency: string }>;
    place.area = assignment.area;
    place.company = assignment.company;
    place.currency = assignment.currency.trim();
  });
  await defineTestRanges({ client: place.client, companyCode: place.company, currency: place.currency }, { fiscalYear: 2026 });
  await withTenant(tenant.client, (tx) => tx.execute(sql`
    insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
    values (${place.client}, ${place.area}, 'CC100', '2020-01-01', '9999-12-31', 'Overhead', 'ADMINISTRATION', ${place.company}, ${ACTOR})
  `));
  return place;
}

function order(tenant: Place, description: string) {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    orderType: 'IO01',
    description,
    controllingArea: tenant.area,
    companyCode: tenant.company,
    startDate: '2026-01-01',
    endDate: '2027-03-31',
  };
}

function run(tenant: Place, orderNumber: string, testRun = false) {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    orderNumber,
    fiscalYear: 2026,
    settlementPeriod: 1,
    testRun,
  };
}

/** An order with a primary cost on 410000 and a stored rule sending it to CC100. Ready to settle. */
async function settleable(tenant: Place, description: string, amount = '80.0000') {
  const saved = await createInternalOrder(order(tenant, description));
  await withTenant(tenant.client, (tx) => postJournalEntry(tx, {
    client: tenant.client,
    companyCode: tenant.company,
    documentType: 'SA',
    documentDate: '2026-01-15',
    postingDate: '2026-01-15',
    fiscalYear: 2026,
    postingPeriod: 1,
    currency: tenant.currency,
    localCurrency: tenant.currency,
    headerText: 'Order cost',
    postedBy: ACTOR,
    lines: [
      { glAccount: '410000', debitCredit: 'S', amount, internalOrder: saved.orderNumber },
      { glAccount: '100000', debitCredit: 'H', amount },
    ],
  }));
  await saveOrderSettlementConfiguration({
    client: tenant.client,
    changedBy: ACTOR,
    orderNumber: saved.orderNumber,
    profileCode: 'SP01',
    profileDescription: 'Order settlement',
    documentType: 'SA',
    structureCode: 'AS01',
    structureDescription: 'Original account',
    sourceAccount: '410000',
    byOriginalAccount: true,
    receiverCategory: 'COST_CENTER',
    receiver: 'CC100',
    percentage: '100',
    settlementType: 'PER',
    validFromYear: 2026,
    validFromPeriod: 1,
    validToYear: 2026,
    validToPeriod: 12,
  });
  return saved.orderNumber;
}

async function counts(client: string) {
  return withTenant(client, async (tx) => {
    const [settlements] = await tx.execute(sql`
      select count(*)::int as n from settlement_document where client = ${client}
    `) as unknown as Array<{ n: number }>;
    const [journals] = await tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client}
    `) as unknown as Array<{ n: number }>;
    const [rules] = await tx.execute(sql`
      select count(*)::int as n from settlement_distribution_rule where client = ${client}
    `) as unknown as Array<{ n: number }>;
    return { settlements: Number(settlements.n), journals: Number(journals.n), rules: Number(rules.n) };
  });
}

async function flags(client: string, orderNumber: string) {
  return withTenant(client, async (tx) => tx.select({
    statistical: internalOrder.statistical,
    markedForDeletion: internalOrder.markedForDeletion,
  }).from(internalOrder).where(and(
    eq(internalOrder.client, client),
    eq(internalOrder.orderNumber, orderNumber),
  ))).then((rows) => rows[0]);
}

function latch() {
  let release!: () => void;
  const armed = new Promise<void>((resolve) => { release = resolve; });
  let signal!: () => void;
  const written = new Promise<void>((resolve) => { signal = resolve; });
  return { armed, written, release, signal };
}

/**
 * Run `write` inside a transaction on its own connection, hold it open with an uncommitted change,
 * and hand back the lever that lets it commit. This is how a change "while the update runs" is made
 * deterministic instead of timed.
 */
async function holding(client: string, write: (tx: Tx) => Promise<unknown>) {
  const { armed, written, release, signal } = latch();
  const task = withTenant(client, async (tx) => {
    await write(tx);
    signal();
    await armed;
  }).catch((error) => {
    // A holder that failed must still wake the caller, or the caller waits for a change that never
    // comes and reports a timeout instead of the error.
    signal();
    throw error;
  });
  // Only once the change is applied and still uncommitted is the second session racing it.
  await written;
  return { task, commit: () => release() };
}

/**
 * Whether the settlement update is right now waiting on the order header. A pending row lock shows up
 * as a lock wait on the session running the locking read, so this is how the run is caught deciding
 * while the header change is still undecided. Without that wait the change might simply commit
 * first, and the run would be reading a settled state — which would prove nothing about the run.
 */
async function waitingOnTheHeader(secs = 6): Promise<boolean> {
  const attempts = Math.ceil((secs * 1000) / 20);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [row] = await db().execute(sql`
      select count(*)::int as n
        from pg_stat_activity
       where wait_event_type = 'Lock'
         and state = 'active'
         and query ilike '%internal_order%for share%'
    `) as unknown as Array<{ n: number }>;
    if (Number(row.n) > 0) return true;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  return false;
}

function headerChange(tenant: Place, orderNumber: string, change: Record<string, unknown> = {}) {
  return changeInternalOrder({
    ...order(tenant, 'Header changed during a settlement'),
    orderNumber,
    ...change,
  });
}

describe('settlement judged at the moment it posts', () => {
  it('refuses an order marked for deletion while the update is in flight', async () => {
    const tenant = await standing('ko88-race-delete');
    const number = await settleable(tenant, 'Marked while settling');
    const before = await counts(tenant.client);
    const held = await holding(tenant.client, (tx) => tx.execute(sql`
      update internal_order set marked_for_deletion = true
       where client = ${tenant.client} and order_number = ${number}
    `));
    const running = settleOrder(run(tenant, number));
    expect(await waitingOnTheHeader(), 'the update decided while the header change was still pending').toBe(true);
    held.commit();
    const result = await running;
    await held.task;

    expect(result.posted).toBe(false);
    expect(result.orders[0]?.outcome).toBe('NOT_SETTLED');
    expect(result.orders[0]?.reasons.join(' ')).toMatch(/marked for deletion/);
    expect(await counts(tenant.client)).toEqual(before);
    expect(await flags(tenant.client, number)).toMatchObject({ markedForDeletion: true });
  });

  it('refuses an order made statistical while the update is in flight', async () => {
    const tenant = await standing('ko88-race-stat');
    const number = await settleable(tenant, 'Statistical while settling');
    const held = await holding(tenant.client, (tx) => tx.execute(sql`
      update internal_order set statistical = true
       where client = ${tenant.client} and order_number = ${number}
    `));
    const running = settleOrder(run(tenant, number));
    expect(await waitingOnTheHeader(), 'the update decided while the header change was still pending').toBe(true);
    held.commit();
    const result = await running;
    await held.task;

    expect(result.posted).toBe(false);
    expect(result.orders[0]?.reasons.join(' ')).toMatch(/statistical/);
    expect((await counts(tenant.client)).settlements).toBe(0);
  });

  it('posts when a deletion mark is withdrawn while the update is in flight', async () => {
    const tenant = await standing('ko88-race-clear');
    const number = await settleable(tenant, 'Cleared while settling');
    await headerChange(tenant, number, { markedForDeletion: true });
    // The flag is withdrawn in a transaction that only commits while the run is deciding, so a run
    // that judged a stale copy would refuse an order that is open again.
    const held = await holding(tenant.client, (tx) => tx.execute(sql`
      update internal_order set marked_for_deletion = false
       where client = ${tenant.client} and order_number = ${number}
    `));
    const running = settleOrder(run(tenant, number));
    expect(await waitingOnTheHeader(), 'the update decided while the header change was still pending').toBe(true);
    held.commit();
    const result = await running;
    await held.task;

    expect(result.posted).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect((await counts(tenant.client)).settlements).toBe(1);
  });

  it('settles a range order by order, judging each one when its turn comes', async () => {
    const tenant = await standing('ko8g-race');
    const first = await settleable(tenant, 'First of the range');
    const second = await settleable(tenant, 'Second of the range');
    const held = await holding(tenant.client, (tx) => tx.execute(sql`
      update internal_order set marked_for_deletion = true
       where client = ${tenant.client} and order_number = ${second}
    `));
    const running = settleOrdersCollective({
      client: tenant.client,
      changedBy: ACTOR,
      controllingArea: tenant.area,
      orderFrom: first,
      orderTo: second,
      fiscalYear: 2026,
      settlementPeriod: 1,
      testRun: false,
    });
    expect(await waitingOnTheHeader(), 'the range decided the second order while its header change was still pending').toBe(true);
    held.commit();
    const result = await running;
    await held.task;

    expect(result.transactionCode).toBe('KO8G');
    expect(result.documents.map((document) => document.orderNumber)).toEqual([first]);
    expect(result.orders.find((row) => row.orderNumber === second)?.reasons.join(' ')).toMatch(/marked for deletion/);
    expect((await counts(tenant.client)).settlements).toBe(1);
  });

  it('takes a header lock the header save itself waits behind', async () => {
    const tenant = await standing('ko88-header-wait');
    const number = await settleable(tenant, 'Header waits behind the posting');
    // The lock the update now holds on the header is taken here directly, so that the price of it is
    // observable: a header save waits for the posting to finish rather than slipping between its
    // decision and its commit. The run itself is timed too loosely to be the one holding still.
    const held = await holding(tenant.client, (tx) => tx
      .select({ one: sql`1` }).from(internalOrder).where(and(
        eq(internalOrder.client, tenant.client),
        eq(internalOrder.orderNumber, number),
      )).for('share'));
    const changing = headerChange(tenant, number);
    const seen = await Promise.race([
      changing.then(() => 'finished'),
      new Promise<string>((resolve) => { setTimeout(() => resolve('waiting'), 750); }),
    ]);
    expect(seen).toBe('waiting');
    held.commit();
    await changing;
    await held.task;
    expect(await flags(tenant.client, number)).toMatchObject({
      markedForDeletion: false,
      statistical: false,
    });
  });
});

describe('settlement runs that overlap', () => {
  it('posts one document when two sessions settle the same order at once', async () => {
    const tenant = await standing('ko88-double');
    const number = await settleable(tenant, 'Two at once');
    const [left, right] = await Promise.all([
      settleOrder(run(tenant, number)),
      settleOrder(run(tenant, number)),
    ]);
    const posted = [left, right].filter((result) => result.posted);
    expect(posted).toHaveLength(1);
    expect((await counts(tenant.client)).settlements).toBe(1);
    const other = posted[0]?.documents[0]?.documentNumber;
    expect([left, right].find((result) => !result.posted)?.documents).toEqual([]);
    expect(other).toBeTruthy();
  });

  it('has nothing left to settle on a second run, and replays a repeated request onto the first document', async () => {
    const tenant = await standing('ko88-replay');
    const number = await settleable(tenant, 'Replayed request');
    const first = await settleOrder({ ...run(tenant, number), requestKey: 'settle-once' });
    expect(first.posted).toBe(true);
    const replay = await settleOrder({ ...run(tenant, number), requestKey: 'settle-once' });
    expect(replay.posted).toBe(false);
    expect(replay.documents[0]?.documentNumber).toBe(first.documents[0]?.documentNumber);
    expect(replay.orders[0]?.reasons.join(' ')).toMatch(/already posted/);
    // Without a token the second run is still safe: the posted settlement line cancels the balance
    // it settled, so there is nothing left to settle rather than a second document.
    const again = await settleOrder(run(tenant, number));
    expect(again.posted).toBe(false);
    expect(again.outcome).toBe('NOTHING_TO_SETTLE');
    expect((await counts(tenant.client)).settlements).toBe(1);
  });
});

describe('the rule and the definition that a settlement run reads', () => {
  it('keeps two rule saves for orders of one type apart in the rules themselves', async () => {
    const tenant = await standing('rule-two-orders');
    const first = await createInternalOrder(order(tenant, 'Rule first'));
    const second = await createInternalOrder(order(tenant, 'Rule second'));
    const save = (orderNumber: string, receiver: string, percentage: string) => saveOrderSettlementConfiguration({
      client: tenant.client,
      changedBy: ACTOR,
      orderNumber,
      profileCode: 'SP01',
      profileDescription: 'Order settlement',
      documentType: 'SA',
      structureCode: 'AS01',
      structureDescription: 'Original account',
      sourceAccount: '410000',
      byOriginalAccount: true,
      receiverCategory: 'COST_CENTER',
      receiver,
      percentage,
      settlementType: 'PER',
      validFromYear: 2026,
      validFromPeriod: 1,
      validToYear: 2026,
      validToPeriod: 12,
    });
    const [left, right] = await Promise.all([
      save(first.orderNumber, 'CC100', '100'),
      save(second.orderNumber, 'CC100', '60'),
    ]);
    expect(left.orderNumber).toBe(first.orderNumber);
    expect(right.orderNumber).toBe(second.orderNumber);
    const rules = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select order_number, percentage::text as percentage
        from settlement_distribution_rule
       where client = ${tenant.client}
       order by order_number
    `)) as unknown as Array<{ order_number: string; percentage: string }>;
    // Each order ends with exactly one rule, and with the share its own save asked for: the rule set
    // is written under the order's own lock, so a parallel save for another order cannot lose it.
    expect(rules).toEqual([
      { order_number: first.orderNumber, percentage: '100.0000' },
      { order_number: second.orderNumber, percentage: '60.0000' },
    ]);
    expect((await counts(tenant.client)).rules).toBe(2);
  });

  it('gives two overlapping revaluation definitions their own numbers and their own orders', async () => {
    const tenant = await standing('reval-concurrent');
    const first = await createInternalOrder(order(tenant, 'Defined once'));
    const second = await createInternalOrder(order(tenant, 'Defined twice'));
    const create = (orderNumber: string, requestKey: string) => createPlanRevaluationOrder({
      client: tenant.client,
      changedBy: ACTOR,
      controllingArea: tenant.area,
      fiscalYear: 2026,
      periodFrom: 1,
      periodTo: 1,
      planVersion: '000',
      description: 'Concurrency check',
      orderFrom: orderNumber,
      orderTo: orderNumber,
      requestKey,
    });
    const [left, right] = await Promise.all([create(first.orderNumber, 'reval-a'), create(second.orderNumber, 'reval-b')]);
    expect(left.revaluationNumber).toMatch(/^RV/);
    expect(left.revaluationNumber).not.toBe(right.revaluationNumber);
    expect(left.orders).toEqual([first.orderNumber]);
    expect(right.orders).toEqual([second.orderNumber]);
    const replay = await create(first.orderNumber, 'reval-a');
    expect(replay.revaluationNumber).toBe(left.revaluationNumber);
    expect(replay.orders).toEqual([first.orderNumber]);
    const rows = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as headers,
             (select count(*)::int from plan_revaluation_order_item where client = ${tenant.client}) as items
        from plan_revaluation_order where client = ${tenant.client}
    `)) as unknown as Array<{ headers: number; items: number }>;
    // A replayed request adds nothing: two definitions and two listed orders, no third of either.
    expect(rows[0]).toMatchObject({ headers: 2, items: 2 });
  });
});
