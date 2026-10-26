/**
 * The contract between an internal-order settlement and the general reversal screen.
 *
 * A settlement posts a journal *and* stores a settlement document that points at it, and the order's
 * stored rule is then frozen against rewrites. Reversing that journal from the general screen mirrors
 * the amounts back and returns the balance to the order, while the settlement document keeps standing
 * and the rule stays frozen — the same shape the reversal screen already refuses for asset
 * acquisitions and asset retirements, whose journals own records of their own. These cases pin the
 * refusal, what it leaves standing, and that a journal which merely cites an order is still reversible.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { closeDb, createTenant, defineTestRanges, destroyTenant, sql, withTenant } from './helpers';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry } from '../src/platform/posting';
import { createInternalOrder } from '../src/modules/foundation/internal-order';
import { settleOrder } from '../src/modules/foundation/order-settlement';
import { saveOrderSettlementConfiguration } from '../src/modules/foundation/settlement-configuration';
import { reverseDocument } from '../src/modules/finance/document-reversal';

const ACTOR = 'REVS_TEST';
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
  await withTenant(place.client, (tx) => tx.execute(sql`
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

function cost(tenant: Place, orderNumber: string, amount = '80.0000') {
  return withTenant(tenant.client, (tx) => postJournalEntry(tx, {
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

function rule(tenant: Place, orderNumber: string) {
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
    receiver: 'CC100',
    percentage: '100',
    settlementType: 'PER',
    validFromYear: 2026,
    validFromPeriod: 1,
    validToYear: 2026,
    validToPeriod: 12,
  });
}

function settle(tenant: Place, orderNumber: string) {
  return settleOrder({
    client: tenant.client,
    changedBy: ACTOR,
    orderNumber,
    fiscalYear: 2026,
    settlementPeriod: 1,
    testRun: false,
  });
}

/** The reversal screen's own call, with the reason the standard package seeds as active. */
function reverse(tenant: Place, documentNumber: string, requestKey: string) {
  return reverseDocument({
    client: tenant.client,
    changedBy: ACTOR,
    companyCode: tenant.company,
    documentNumber,
    fiscalYear: 2026,
    reasonCode: '01',
    documentDate: '2026-01-31',
    postingDate: '2026-01-31',
    confirmed: true,
    requestKey,
  });
}

async function journalState(client: string, documentNumber: string) {
  const [row] = await withTenant(client, async (tx) => tx.execute(sql`
    select status, reversed_by, origin_class,
           (select count(*)::int from accounting_reversal_link
             where client = ${client} and original_document_number = ${documentNumber}) as links
      from journal_entry
     where client = ${client} and document_number = ${documentNumber} and fiscal_year = 2026
  `)) as unknown as Array<{ status: string; reversed_by: string | null; origin_class: string | null; links: number }>;
  return row;
}

async function settlementRows(client: string, orderNumber: string) {
  const [row] = await withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as documents,
           coalesce(bool_and(j.status = 'POSTED'), false) as all_posted
      from settlement_document d
      join journal_entry j
        on j.client = d.client and j.document_number = d.document_number and j.fiscal_year = d.fiscal_year
     where d.client = ${client} and d.order_number = ${orderNumber}
  `)) as unknown as Array<{ documents: number; all_posted: boolean }>;
  return row;
}

/** An order with a cost and a rule, settled once. Returns the order number and its document. */
async function settled(tenant: Place, description: string) {
  const saved = await createInternalOrder(order(tenant, description));
  await cost(tenant, saved.orderNumber);
  await rule(tenant, saved.orderNumber);
  const result = await settle(tenant, saved.orderNumber);
  expect(result.posted).toBe(true);
  const documentNumber = result.documents[0]?.documentNumber ?? '';
  return { orderNumber: saved.orderNumber, documentNumber };
}

describe('a settlement document and the general reversal screen', () => {
  it('is refused, because the settlement record it stands on would be left behind', async () => {
    const tenant = await standing('ko88-reverse-refused');
    const { orderNumber, documentNumber } = await settled(tenant, 'Settled then reversed');
    const state = await journalState(tenant.client, documentNumber);
    expect(state.origin_class).toBe('order_settlement');

    await expect(reverse(tenant, documentNumber, 'rev-settle')).rejects.toThrow(/orphan its settlement document/);

    // Nothing moved: the journal still stands posted, no reversal pair exists, and the settlement
    // document still points at a live posting.
    const after = await journalState(tenant.client, documentNumber);
    expect(after).toMatchObject({ status: 'POSTED', reversed_by: null, links: 0 });
    expect(await settlementRows(tenant.client, orderNumber)).toMatchObject({ documents: 1, all_posted: true });
  });

  it('leaves the order settled, its balance cleared and its rule frozen, which is what the freeze assumes', async () => {
    const tenant = await standing('ko88-reverse-state');
    const { orderNumber, documentNumber } = await settled(tenant, 'Refused reversal state');
    await expect(reverse(tenant, documentNumber, 'rev-settle-2')).rejects.toThrow(/settlement/);

    // The balance is still settled, so a further run posts nothing, and the stored rule is still
    // frozen by the settlement document that stands — the two now agree with each other.
    const again = await settle(tenant, orderNumber);
    expect(again.outcome).toBe('NOTHING_TO_SETTLE');
    expect(again.documents).toEqual([]);
    await expect(rule(tenant, orderNumber)).rejects.toThrow(/already has settlement document/);
    expect(await settlementRows(tenant.client, orderNumber)).toMatchObject({ documents: 1, all_posted: true });
  });

  it('still reverses an ordinary journal that only cites the order', async () => {
    const tenant = await standing('ko88-reverse-ordinary');
    const saved = await createInternalOrder(order(tenant, 'Cost reversed instead'));
    const posted = await cost(tenant, saved.orderNumber, '30.0000');
    await rule(tenant, saved.orderNumber);

    // A primary cost is not a settlement document: it is reversed here, the balance returns to zero,
    // and the settlement run follows the balance rather than the order number.
    const reversal = await reverse(tenant, posted.documentNumber, 'rev-cost');
    expect(reversal.reversalDocumentNumber).toBeTruthy();
    const original = await journalState(tenant.client, posted.documentNumber);
    expect(original.status).toBe('REVERSED');
    expect(original.links).toBe(1);

    const run = await settle(tenant, saved.orderNumber);
    expect(run.outcome).toBe('NOTHING_TO_SETTLE');
    expect(run.posted).toBe(false);
    expect(await settlementRows(tenant.client, saved.orderNumber)).toMatchObject({ documents: 0 });
  });
});
