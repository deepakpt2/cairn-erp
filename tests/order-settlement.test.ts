import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry } from '../src/platform/posting';
import { closeDb, createTenant, defineTestRanges, destroyTenant } from './helpers';
import { saveOrderSettlementConfiguration } from '../src/modules/foundation/settlement-configuration';
import { internalOrder } from '../src/modules/foundation/schema';
import { changeInternalOrder, createInternalOrder } from '../src/modules/foundation/internal-order';
import {
  OrderSettlementError,
  orderSettlementPosting,
  settleOrder,
  settleOrdersCollective,
} from '../src/modules/foundation/order-settlement';

const ACTOR = 'SETTLE_TEST';
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
  const place: Place = { client: tenant.client, area: '', company: '', currency: '', periods: 0 };
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, {
      client: tenant.client,
      objectCode: 'INTORDER',
      subObject: '*',
      prefix: 'IO',
      numberLength: 8,
      createdBy: ACTOR,
    });
    await tx.execute(sql`
      insert into internal_order_type (
        client, order_type, description, number_range_sub_object, statistical_default, created_by
      ) values
        (${tenant.client}, 'IO01', 'Internal order', '*', false, ${ACTOR}),
        (${tenant.client}, 'IO02', 'Second type', '*', false, ${ACTOR})
      on conflict do nothing
    `);
    const [assignment] = await tx.execute(sql`
      select a.controlling_area as area, a.company_code as company, c.currency, v.regular_periods as periods
        from controlling_area_company a
        join controlling_area c on c.client = a.client and c.controlling_area = a.controlling_area
        join fiscal_year_variant v on v.client = c.client and v.variant = c.fiscal_year_variant
       where a.client = ${tenant.client}
       limit 1
    `) as unknown as Array<{ area: string; company: string; currency: string; periods: number }>;
    place.area = assignment.area;
    place.company = assignment.company;
    place.currency = assignment.currency.trim();
    place.periods = Number(assignment.periods);
  });
  return place;
}

function order(tenant: Place, description = 'Plant overhead', orderType = 'IO01') {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    orderType,
    description,
    controllingArea: tenant.area,
    companyCode: tenant.company,
    startDate: '2026-04-01',
    endDate: '2027-03-31',
  };
}

function run(tenant: Place, orderNumber = '') {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    orderNumber,
    fiscalYear: 2026,
    settlementPeriod: 1,
    testRun: true,
  };
}

async function counts(client: string) {
  return withTenant(client, async (tx) => {
    const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    const [budgets] = await tx.execute(sql`select count(*)::int as n from internal_order_original_budget where client = ${client}`) as unknown as Array<{ n: number }>;
    const [rules] = await tx.execute(sql`
      select count(*)::int as n from settlement_distribution_rule where client = ${client}
    `) as unknown as Array<{ n: number }>;
    const [settlements] = await tx.execute(sql`
      select count(*)::int as n from settlement_document where client = ${client}
    `) as unknown as Array<{ n: number }>;
    return {
      journals: Number(journals.n),
      budgets: Number(budgets.n),
      rules: Number(rules.n),
      settlements: Number(settlements.n),
    };
  });
}

describe('order settlement', () => {
  it('does not post an individual or a repeated update', async () => {
    const tenant = await standing('ko88-one');
    const saved = await createInternalOrder(order(tenant));
    const before = await counts(tenant.client);
    const [stamp] = await withTenant(tenant.client, async (tx) => tx.select({
      changedAt: internalOrder.changedAt,
    }).from(internalOrder).where(and(
      eq(internalOrder.client, tenant.client),
      eq(internalOrder.orderNumber, saved.orderNumber),
    )));
    const simulated = await settleOrder(run(tenant, saved.orderNumber));
    const updated = await settleOrder({ ...run(tenant, saved.orderNumber), testRun: false });
    expect(orderSettlementPosting().posts).toBe(false);
    expect(simulated.posted).toBe(false);
    expect(simulated.transactionCode).toBe('KO88');
    expect(simulated.documents).toEqual([]);
    expect(simulated.settled).toBe(0);
    expect(simulated.eligible).toBe(0);
    expect(simulated.fiscalYear).toBe(2026);
    expect(simulated.settlementPeriod).toBe(1);
    expect(simulated.postingPeriod).toBeNull();
    expect(simulated.orders).toHaveLength(1);
    expect(simulated.orders[0]?.reasons.join(' ')).toMatch(/receiver and a percentage are not assumed/);
    expect(simulated.orders[0]).not.toHaveProperty('receiver');
    expect(updated.message).toMatch(/Update run/);
    expect(updated.posted).toBe(false);
    const again = await settleOrder({ ...run(tenant, saved.orderNumber), testRun: false });
    expect(again.documents).toEqual([]);
    const [left, right] = await Promise.all([
      settleOrder({ ...run(tenant, saved.orderNumber), testRun: false }),
      settleOrder({ ...run(tenant, saved.orderNumber), testRun: false }),
    ]);
    expect(left.posted).toBe(false);
    expect(right.posted).toBe(false);
    expect(await counts(tenant.client)).toEqual(before);
    const [after] = await withTenant(tenant.client, async (tx) => tx.select({
      changedAt: internalOrder.changedAt,
    }).from(internalOrder).where(and(
      eq(internalOrder.client, tenant.client),
      eq(internalOrder.orderNumber, saved.orderNumber),
    )));
    expect(after?.changedAt).toEqual(stamp?.changedAt);
  });

  it('keeps KO88 to one order and lets KO8G select without posting', async () => {
    const tenant = await standing('ko8g-many');
    const first = await createInternalOrder(order(tenant, 'First overhead'));
    const second = await createInternalOrder(order(tenant, 'Second overhead', 'IO02'));
    const individual = await settleOrder(run(tenant, first.orderNumber));
    expect(individual.orders.map((row) => row.orderNumber)).toEqual([first.orderNumber]);
    expect(individual.transactionCode).toBe('KO88');
    const collective = await settleOrdersCollective({
      ...run(tenant),
      orderNumber: '',
      controllingArea: tenant.area,
      orderFrom: first.orderNumber,
      orderTo: second.orderNumber,
      testRun: false,
    });
    expect(collective.transactionCode).toBe('KO8G');
    expect(collective.posted).toBe(false);
    expect(collective.orders.map((row) => row.orderNumber)).toEqual([first.orderNumber, second.orderNumber]);
    expect(collective.gaps.join(' ')).toMatch(/Maintenance orders are not configured/);
    expect(collective.gaps.join(' ')).toMatch(/CO88 is not this run/);
    const typed = await settleOrdersCollective({
      ...run(tenant),
      controllingArea: tenant.area,
      orderType: 'IO02',
    });
    expect(typed.orders.map((row) => row.orderNumber)).toEqual([second.orderNumber]);
    const empty = await settleOrdersCollective({
      ...run(tenant),
      controllingArea: tenant.area,
      orderFrom: 'ZZZZZZZZ',
      orderTo: 'ZZZZZZZZ',
    });
    expect(empty.outcome).toBe('NO_ELIGIBLE_ORDERS');
    expect(empty.message).toMatch(/not an invalid order number/);
    expect(empty.posted).toBe(false);
    const missing = await settleOrder(run(tenant, 'IO00000999'));
    expect(missing.outcome).toBe('INVALID_SELECTION');
    expect(missing.message).toMatch(/does not exist/);
    expect(missing.selected).toBe(0);
    await expect(settleOrder({ ...run(tenant, first.orderNumber), orderFrom: first.orderNumber })).rejects.toThrow(/collective selection/);
    await expect(settleOrdersCollective(run(tenant))).rejects.toThrow(/needs a selection/);
    expect((await counts(tenant.client)).journals).toBe(0);
  });

  it('refuses a statistical order, a bad period, and unconfigured run options', async () => {
    const tenant = await standing('ko88-stat');
    const saved = await createInternalOrder({ ...order(tenant), statistical: true });
    const statistical = await settleOrder(run(tenant, saved.orderNumber));
    expect(statistical.posted).toBe(false);
    expect(statistical.orders[0]?.reasons.join(' ')).toMatch(/statistical/);
    const marked = await createInternalOrder(order(tenant, 'Marked overhead'));
    await changeInternalOrder({ ...order(tenant, 'Marked overhead'), orderNumber: marked.orderNumber, markedForDeletion: true });
    const deleted = await settleOrder(run(tenant, marked.orderNumber));
    expect(deleted.orders[0]?.reasons.join(' ')).toMatch(/marked for deletion/);
    const locked = await createInternalOrder(order(tenant, 'Locked overhead'));
    await changeInternalOrder({ ...order(tenant, 'Locked overhead'), orderNumber: locked.orderNumber, isPostingLocked: true });
    const lockResult = await settleOrder(run(tenant, locked.orderNumber));
    expect(lockResult.orders[0]?.reasons.join(' ')).not.toMatch(/posting lock/i);
    await expect(settleOrder({
      ...run(tenant, saved.orderNumber),
      settlementPeriod: tenant.periods + 1,
    })).rejects.toThrow(/outside fiscal year variant/);
    await expect(settleOrder({ ...run(tenant, saved.orderNumber), processingType: 'AUTOMATIC' })).rejects.toThrow(/not assumed/);
    await expect(settleOrder({ ...run(tenant, saved.orderNumber), assetValueDate: '2026-04-30' })).rejects.toThrow(/Asset settlement/);
    await expect(settleOrder({ ...run(tenant, saved.orderNumber), background: true })).rejects.toThrow(/Background/);
    await expect(settleOrder({ ...run(tenant, saved.orderNumber), selectionVariant: 'SAP&KO8G' })).rejects.toThrow(/Selection variants/);
    await expect(settleOrder({ ...run(tenant, saved.orderNumber), orderGroup: 'GRP1' })).rejects.toThrow(/Order groups/);
    await expect(settleOrder({ ...run(tenant, saved.orderNumber), postingPeriod: 2 })).rejects.toThrow(/posting period/i);
    await expect(settleOrdersCollective({
      ...run(tenant),
      controllingArea: tenant.area,
      orderFrom: 'ZZZ',
      orderTo: 'AAA',
    })).rejects.toThrow(/not swapped/);
    expect((await counts(tenant.client)).journals).toBe(0);
    expect(new OrderSettlementError('x').name).toBe('OrderSettlementError');
  });

  it('does not read an order from another client', async () => {
    const tenant = await standing('ko88-hide');
    const other = await standing('ko88-miss');
    const saved = await createInternalOrder(order(tenant));
    const foreign = await settleOrder(run(other, saved.orderNumber));
    expect(foreign.outcome).toBe('INVALID_SELECTION');
    expect(foreign.posted).toBe(false);
    const hidden = await settleOrdersCollective({
      ...run(other),
      controllingArea: other.area,
      orderFrom: saved.orderNumber,
      orderTo: saved.orderNumber,
    });
    expect(hidden.outcome).toBe('NO_ELIGIBLE_ORDERS');
    expect(hidden.orders).toEqual([]);
    expect((await counts(tenant.client)).journals).toBe(0);
    expect((await counts(other.client)).journals).toBe(0);
  });
});

async function cost(tenant: Place, orderNumber: string, amount: string, account = '410000') {
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
      { glAccount: account, debitCredit: 'S', amount, internalOrder: orderNumber },
      { glAccount: '100000', debitCredit: 'H', amount },
    ],
  }));
}

function rule(tenant: Place, orderNumber: string, receiver: string, percentage = '100') {
  return saveOrderSettlementConfiguration({
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
}

describe('order settlement posting', () => {
  it('posts one balanced document from the stored rule and does not post again', async () => {
    const tenant = await standing('ko88-post');
    await defineTestRanges({ client: tenant.client, companyCode: tenant.company, currency: tenant.currency }, { fiscalYear: 2026 });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${tenant.client}, ${tenant.area}, 'CC100', '2020-01-01', '9999-12-31', 'Overhead', 'ADMINISTRATION', ${tenant.company}, ${ACTOR})
    `));
    const saved = await createInternalOrder({ ...order(tenant), costCenter: 'CC100' });
    const other = await createInternalOrder(order(tenant, 'Other overhead'));
    await cost(tenant, saved.orderNumber, '80.0000');
    await cost(tenant, other.orderNumber, '25.0000');
    const beforeRule = await settleOrder({ ...run(tenant, saved.orderNumber), testRun: false });
    expect(beforeRule.posted).toBe(false);
    expect((await counts(tenant.client)).settlements).toBe(0);
    await rule(tenant, saved.orderNumber, 'CC100');
    const simulated = await settleOrder(run(tenant, saved.orderNumber));
    expect(simulated.posted).toBe(false);
    expect(simulated.orders[0]?.amount).toBe('80.0000');
    expect(simulated.orders[0]?.receivers).toEqual([
      { receiverCategory: 'COST_CENTER', receiver: 'CC100', amount: '80.0000' },
    ]);
    expect((await counts(tenant.client)).journals).toBe(2);
    const updated = await settleOrder({ ...run(tenant, saved.orderNumber), testRun: false, requestKey: 'settle-once' });
    expect(updated.posted).toBe(true);
    expect(updated.transactionCode).toBe('KO88');
    expect(updated.documents).toHaveLength(1);
    expect(updated.documents[0]?.postingDate).toBe('2026-01-31');
    expect(updated.postingPeriod).toBeNull();
    const replay = await settleOrder({ ...run(tenant, saved.orderNumber), testRun: false, requestKey: 'settle-once' });
    expect(replay.posted).toBe(false);
    expect(replay.documents[0]?.documentNumber).toBe(updated.documents[0]?.documentNumber);
    const again = await settleOrder({ ...run(tenant, saved.orderNumber), testRun: false });
    expect(again.outcome).toBe('NOTHING_TO_SETTLE');
    expect(again.posted).toBe(false);
    const lines = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select l.gl_account, l.debit_credit, l.amount_local::text as amount, l.internal_order, l.cost_center
        from journal_entry_line l
       where l.client = ${tenant.client}
         and l.document_number = ${updated.documents[0]?.documentNumber}
         and l.fiscal_year = ${updated.documents[0]?.fiscalYear}
       order by l.line_number
    `)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string; internal_order: string | null; cost_center: string | null }>;
    const debit = lines.filter((line) => line.debit_credit === 'S').reduce((sum, line) => sum + Number(line.amount), 0);
    const credit = lines.filter((line) => line.debit_credit === 'H').reduce((sum, line) => sum + Number(line.amount), 0);
    expect(debit).toBe(credit);
    expect(lines.find((line) => line.debit_credit === 'H')?.internal_order).toBe(saved.orderNumber);
    expect(lines.find((line) => line.debit_credit === 'S')?.cost_center).toBe('CC100');
    expect(lines.every((line) => line.gl_account === '410000')).toBe(true);
    const otherSettlements = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from settlement_document
       where client = ${tenant.client} and order_number = ${other.orderNumber}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(otherSettlements[0]?.n)).toBe(0);
    expect((await counts(tenant.client)).journals).toBe(3);
    expect((await counts(tenant.client)).settlements).toBe(1);
    await expect(rule(tenant, saved.orderNumber, 'CC100')).rejects.toThrow(/already has settlement document/);
    expect((await counts(tenant.client)).journals).toBe(3);
  });

  it('does not post a partial percentage or an unmapped account', async () => {
    const tenant = await standing('ko88-share');
    await defineTestRanges({ client: tenant.client, companyCode: tenant.company, currency: tenant.currency }, { fiscalYear: 2026 });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${tenant.client}, ${tenant.area}, 'CC200', '2020-01-01', '9999-12-31', 'Share', 'ADMINISTRATION', ${tenant.company}, ${ACTOR})
    `));
    const partial = await createInternalOrder(order(tenant, 'Partial overhead'));
    await cost(tenant, partial.orderNumber, '40.0000');
    await rule(tenant, partial.orderNumber, 'CC200', '60');
    const refused = await settleOrder({ ...run(tenant, partial.orderNumber), testRun: false });
    expect(refused.posted).toBe(false);
    expect(refused.orders[0]?.reasons.join(' ')).toMatch(/not 100/);
    const unmapped = await createInternalOrder(order(tenant, 'Unmapped overhead'));
    await cost(tenant, unmapped.orderNumber, '15.0000', '500000');
    await rule(tenant, unmapped.orderNumber, 'CC200');
    const missed = await settleOrder({ ...run(tenant, unmapped.orderNumber), testRun: false });
    expect(missed.posted).toBe(false);
    expect(missed.orders[0]?.reasons.join(' ')).toMatch(/no allocation assignment/);
    expect((await counts(tenant.client)).settlements).toBe(0);
  });

  it('settles only the selected orders when KO8G calls the same posting', async () => {
    const tenant = await standing('ko88-pair2');
    await defineTestRanges({ client: tenant.client, companyCode: tenant.company, currency: tenant.currency }, { fiscalYear: 2026 });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${tenant.client}, ${tenant.area}, 'CC300', '2020-01-01', '9999-12-31', 'Collective', 'ADMINISTRATION', ${tenant.company}, ${ACTOR})
    `));
    const first = await createInternalOrder(order(tenant, 'First settled'));
    const second = await createInternalOrder(order(tenant, 'Second settled'));
    const third = await createInternalOrder(order(tenant, 'Raced settled'));
    await cost(tenant, first.orderNumber, '10.0000');
    await cost(tenant, second.orderNumber, '12.0000');
    await cost(tenant, third.orderNumber, '7.0000');
    await rule(tenant, first.orderNumber, 'CC300');
    await rule(tenant, second.orderNumber, 'CC300');
    await rule(tenant, third.orderNumber, 'CC300');
    const individual = await settleOrder({ ...run(tenant, first.orderNumber), testRun: false });
    expect(individual.posted).toBe(true);
    expect(individual.documents.map((document) => document.orderNumber)).toEqual([first.orderNumber]);
    const collective = await settleOrdersCollective({
      ...run(tenant),
      controllingArea: tenant.area,
      orderFrom: first.orderNumber,
      orderTo: second.orderNumber,
      testRun: false,
    });
    expect(collective.transactionCode).toBe('KO8G');
    expect(collective.documents.map((document) => document.orderNumber)).toEqual([second.orderNumber]);
    expect(collective.orders.find((row) => row.orderNumber === first.orderNumber)?.outcome).toBe('NOTHING_TO_SETTLE');
    const [left, right] = await Promise.all([
      settleOrder({ ...run(tenant, third.orderNumber), testRun: false }),
      settleOrder({ ...run(tenant, third.orderNumber), testRun: false }),
    ]);
    expect([left.posted, right.posted].filter(Boolean)).toHaveLength(1);
    expect((await counts(tenant.client)).settlements).toBe(3);
  });
});
