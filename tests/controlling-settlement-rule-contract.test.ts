/**
 * The contract between storing a settlement rule and running a settlement.
 *
 * An update posts only when three stored rows agree: the settlement profile assigned to the order
 * type, the allocation assignment that says how the source account is settled, and the distribution
 * rule that names the receiver and the share. They are one condition, written by one screen, and they
 * used to be read by a run without any of them being held still. These cases put a rule save and a
 * settlement update next to each other and read the posted journal back, so a run that mixed two
 * saves would be visible instead of plausible.
 *
 * The last two cases pin two rules the product already states rather than new ones: the settlement
 * date is the end of the settlement period the operator entered, not something the order's own
 * validity is consulted about; and a reversed settlement document returns the balance without
 * releasing the rule that was stored for it.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { closeDb, createTenant, db, defineTestRanges, destroyTenant, sql, withTenant } from './helpers';
import { type Tx } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry, reverseJournalEntry } from '../src/platform/posting';
import { createInternalOrder } from '../src/modules/foundation/internal-order';
import { settleOrder } from '../src/modules/foundation/order-settlement';
import { lockSettlementRuleForOrder, saveOrderSettlementConfiguration } from '../src/modules/foundation/settlement-configuration';

const ACTOR = 'RULE_TEST';
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
  /** The order validity this fixture hands out. It is deliberately not a settlement condition. */
  startDate: string;
}

async function standing(seed: string, startDate = '2026-01-01'): Promise<Place> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const place: Place = { client: tenant.client, area: '', company: '', currency: '', startDate };
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, { client: tenant.client, objectCode: 'INTORDER', subObject: '*', prefix: 'IO', numberLength: 8, createdBy: ACTOR });
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
  for (const [code, name] of [['CC100', 'Overhead'], ['CC200', 'Second receiver']] as const) {
    await withTenant(place.client, (tx) => tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${place.client}, ${place.area}, ${code}, '2020-01-01', '9999-12-31', ${name}, 'ADMINISTRATION', ${place.company}, ${ACTOR})
    `));
  }
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
    startDate: tenant.startDate,
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

function rule(tenant: Place, orderNumber: string, receiver: string) {
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
    percentage: '100',
    settlementType: 'PER',
    validFromYear: 2026,
    validFromPeriod: 1,
    validToYear: 2026,
    validToPeriod: 12,
  });
}

async function cost(tenant: Place, orderNumber: string, amount = '80.0000') {
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
      { glAccount: '410000', debitCredit: 'S', amount, internalOrder: orderNumber },
      { glAccount: '100000', debitCredit: 'H', amount },
    ],
  }));
}

/** An order with a primary cost and a rule sending it to CC100. */
async function settleable(tenant: Place, description: string) {
  const saved = await createInternalOrder(order(tenant, description));
  await cost(tenant, saved.orderNumber);
  await rule(tenant, saved.orderNumber, 'CC100');
  return saved.orderNumber;
}

/** The receiver the posted settlement document actually sent the balance to. */
function settledReceiver(client: string, orderNumber: string) {
  return withTenant(client, async (tx) => tx.execute(sql`
    select l.cost_center as receiver, j.posting_date::text as posting_date, j.status
      from journal_entry_line l
      join journal_entry j
        on j.client = l.client and j.document_number = l.document_number and j.fiscal_year = l.fiscal_year
      join settlement_document d
        on d.client = j.client and d.document_number = j.document_number and d.fiscal_year = j.fiscal_year
     where l.client = ${client}
       and d.order_number = ${orderNumber}
       and l.cost_center is not null
     order by j.document_number
  `) as unknown as Array<{ receiver: string; posting_date: string; status: string }>);
}

function storedReceiver(client: string, orderNumber: string) {
  return withTenant(client, async (tx) => tx.execute(sql`
    select receiver from settlement_distribution_rule
     where client = ${client} and order_number = ${orderNumber}
  `) as unknown as Array<{ receiver: string }>).then((rows) => rows[0]?.receiver ?? null);
}

/**
 * Whether a session is waiting on this order's rule key. `pg_advisory_xact_lock(bigint)` stores its
 * key as the two 32-bit halves shown in `pg_locks`, so the same expression the product uses is split
 * the same way here — an ungranted lock on this order's key is the run being held back, which is what
 * makes the sequence deterministic instead of lucky.
 */
async function waitingForTheRuleKey(client: string, orderNumber: string, secs = 6): Promise<boolean> {
  const key = `${client}/settlement-rule/${orderNumber}`;
  const attempts = Math.ceil((secs * 1000) / 20);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [row] = await db().execute(sql`
      select count(*)::int as n
        from pg_locks
       where locktype = 'advisory'
         and not granted
         and classid::bigint = ((hashtextextended(${key}, 0) >> 32) & 4294967295)
         and objid::bigint = (hashtextextended(${key}, 0) & 4294967295)
    `) as unknown as Array<{ n: number }>;
    if (Number(row.n) > 0) return true;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  return false;
}

async function holding(client: string, write: (tx: Tx) => Promise<unknown>) {
  let signal!: () => void;
  const written = new Promise<void>((resolve) => { signal = resolve; });
  let release!: () => void;
  const armed = new Promise<void>((resolve) => { release = resolve; });
  const task = withTenant(client, async (tx) => {
    await write(tx);
    signal();
    await armed;
  }).catch((error) => {
    signal();
    throw error;
  });
  await written;
  return { task, commit: () => release() };
}

describe('a settlement rule and the run that reads it', () => {
  it('waits while the rule for its order is being stored, then settles the stored rule', async () => {
    const tenant = await standing('ko88-rule-wait');
    const number = await settleable(tenant, 'Rule being rewritten');
    // A rule save, exactly as the rule screen makes one: the key first, the rule changed under it,
    // and the transaction left open so the run can only either wait or read past it.
    const save = await holding(tenant.client, async (tx) => {
      await lockSettlementRuleForOrder(tx, tenant.client, number);
      await tx.execute(sql`
        update settlement_distribution_rule set receiver = 'CC200'
         where client = ${tenant.client} and order_number = ${number}
      `);
    });
    const running = settleOrder(run(tenant, number));
    expect(await waitingForTheRuleKey(tenant.client, number), 'the update read the rule while it was being replaced').toBe(true);
    save.commit();
    const result = await running;
    await save.task;

    expect(result.posted).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect(await storedReceiver(tenant.client, number)).toBe('CC200');
    // The document went where the stored rule says, not where the earlier read said: one condition,
    // read once, under the key its writer holds.
    const lines = await settledReceiver(tenant.client, number);
    expect(lines.map((line) => line.receiver)).toEqual(['CC200']);
    expect(lines[0]?.posting_date).toBe('2026-01-31');
  });

  it('leaves a stored rule and a posted document agreeing when both are attempted together', async () => {
    const tenant = await standing('ko88-rule-race');
    const number = await settleable(tenant, 'Saved and settled at once');
    const [saved, settled] = await Promise.all([
      rule(tenant, number, 'CC200').then(() => 'stored' as const).catch(() => 'refused' as const),
      settleOrder(run(tenant, number)),
    ]);
    const stored = await storedReceiver(tenant.client, number);
    const lines = await settledReceiver(tenant.client, number);
    expect(settled.posted || saved === 'stored').toBe(true);
    if (settled.posted && saved === 'stored') {
      // The save that landed is the rule the document was posted from: no profile from one save with
      // a distribution rule from the next.
      expect(lines[0]?.receiver).toBe(stored);
    }
    if (settled.posted && saved === 'refused') {
      expect(lines[0]?.receiver).toBe('CC100');
      expect(stored).toBe('CC100');
    }
    expect(lines).toHaveLength(settled.posted ? 1 : 0);
  });

  it('keeps the shared rows consistent when two orders of one type are saved at once', async () => {
    const tenant = await standing('ko88-rule-shared');
    const first = await createInternalOrder(order(tenant, 'Shared first'));
    const second = await createInternalOrder(order(tenant, 'Shared second'));
    const [left, right] = await Promise.all([
      saveOrderSettlementConfiguration({
        client: tenant.client,
        changedBy: ACTOR,
        orderNumber: first.orderNumber,
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
      }),
      saveOrderSettlementConfiguration({
        client: tenant.client,
        changedBy: ACTOR,
        orderNumber: second.orderNumber,
        profileCode: 'SP02',
        profileDescription: 'Second profile',
        documentType: 'SA',
        structureCode: 'AS02',
        structureDescription: 'Second structure',
        sourceAccount: '410000',
        byOriginalAccount: true,
        receiverCategory: 'COST_CENTER',
        receiver: 'CC200',
        percentage: '100',
        settlementType: 'PER',
        validFromYear: 2026,
        validFromPeriod: 1,
        validToYear: 2026,
        validToPeriod: 12,
      }),
    ]);
    expect(left.orderNumber).toBe(first.orderNumber);
    expect(right.orderNumber).toBe(second.orderNumber);
    // Both orders keep their own rule, and whatever the shared rows end up saying, they say it about
    // something that exists: no assignment points at a profile or a structure that is not stored.
    const state = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select
        (select count(*)::int from settlement_distribution_rule where client = ${tenant.client}) as rules,
        (select count(*)::int from settlement_profile where client = ${tenant.client}) as profiles,
        (select count(*)::int from allocation_structure where client = ${tenant.client}) as structures,
        (select count(*)::int
           from internal_order_type_settlement_profile t
           join settlement_profile p on p.client = t.client and p.profile_code = t.profile_code
          where t.client = ${tenant.client}) as assigned_profiles,
        (select count(*)::int
           from settlement_profile p
           join allocation_structure a on a.client = p.client and a.structure_code = p.allocation_structure
          where p.client = ${tenant.client}) as profiles_with_structure
    `) as unknown as Array<{ rules: number; profiles: number; structures: number; assigned_profiles: number; profiles_with_structure: number }>);
    expect(state[0]).toMatchObject({
      rules: 2,
      profiles: 2,
      structures: 2,
      assigned_profiles: 1,
      profiles_with_structure: 2,
    });
  });

  it('settles on the period end it was given, which is not the order validity the budget follows', async () => {
    const tenant = await standing('ko88-date-rule', '2026-06-01');
    const number = await settleable(tenant, 'Order that starts later');
    const posted = await settleOrder(run(tenant, number));
    // The date of a settlement document is the end of the settlement period that was entered. The
    // order's own validity is not a settlement condition, while the original budget does refuse a year
    // outside that window — the difference is stated in both module contracts, so it is pinned here
    // rather than tidied away.
    expect(posted.posted).toBe(true);
    const lines = await settledReceiver(tenant.client, number);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.posting_date).toBe('2026-01-31');
    const [window] = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select start_date::text as start_date from internal_order
       where client = ${tenant.client} and order_number = ${number}
    `)) as unknown as Array<{ start_date: string }>;
    expect(window?.start_date).toBe('2026-06-01');
  });

  it('returns the balance when the settlement document is reversed and keeps the rule frozen', async () => {
    const tenant = await standing('ko88-rule-reversal');
    const number = await settleable(tenant, 'Reversed settlement');
    const first = await settleOrder(run(tenant, number));
    expect(first.posted).toBe(true);
    const document = first.documents[0];
    await withTenant(tenant.client, (tx) => reverseJournalEntry(tx, {
      client: tenant.client,
      documentNumber: document?.documentNumber ?? '',
      fiscalYear: document?.fiscalYear ?? 2026,
      reversalDate: '2026-01-31',
      reason: 'Settlement reversed',
      reversedBy: ACTOR,
    }));
    // Reversing the journal gives the balance back, so a later run settles the order again...
    const again = await settleOrder(run(tenant, number));
    expect(again.posted).toBe(true);
    expect(again.documents[0]?.documentNumber).not.toBe(document?.documentNumber);
    // ...while the rule stays frozen by the settlement document that was never removed. Whether a
    // reversed settlement should release the rule is the decision recorded in the step report.
    await expect(rule(tenant, number, 'CC200')).rejects.toThrow(/already has settlement document/);
    const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as n from settlement_document where client = ${tenant.client} and order_number = ${number}
    `) as unknown as Array<{ n: number }>);
    expect(Number(rows[0]?.n)).toBe(2);
  });
});
