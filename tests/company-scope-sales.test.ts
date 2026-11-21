/**
 * Company-scope authorization for the sales billing services (adversarial): invoice lists (due documents, display,
 * list, create, release, cancel) and credit memos (request, memo, post, billing-block release, request list).
 * Two companies (A 1000, B 2000) in one tenant, a second tenant, and actors who hold the capability but not the
 * company, no scope, no capability, or a plant limit. A capability alone must never reach another company's documents.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  cancelInvoiceList, createInvoiceList, getInvoiceList, invoiceListDueDocuments, listInvoiceLists, releaseInvoiceList,
} from '../src/modules/sales/invoice-list';
import {
  createCreditMemo, createCreditMemoRequest, listCreditMemoRequests, postCreditMemo, releaseBillingBlock,
} from '../src/modules/sales/credit-memo';
import { assignSalesAreaDimensions, closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';
import { FINANCE_ACTOR_CAPABILITIES, createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const A = '1000';
const B = '2000';
const SEED = 'SCOPE_SALES_SEED';
const DUE_A = 'BD00000001';
const DUE_B = 'BD00000002';
const LIST_A = 'BD00000011';
const LIST_B = 'BD00000012';
const INV_A = 'BD00000021';
const INV_B = 'BD00000022';
const ORDER_A = 'SO00000001';
const ORDER_B = 'SO00000002';
const GONE = 'BD99999999';

let tenant: TestTenant;
let other: TestTenant;
let client = '';
let onlyA: FinanceActor;
let onlyB: FinanceActor;
let both: FinanceActor;
let noCapability: FinanceActor;
let noScope: FinanceActor;
let plantLimited: FinanceActor;
let otherTenantActor: FinanceActor;

async function refused(p: Promise<unknown>, pattern: RegExp = /scope|Company Code|capabilit|authori|session|signed-in|not hold|No company/i) {
  let thrown: unknown;
  try { await p; } catch (error) { thrown = error; }
  expect(thrown, 'a refusal was expected').toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(pattern);
  expect((thrown as Error).message).not.toMatch(/does not (stand|exist)/);
}
const bad = () => [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization];
/** What the caller reads when it asks; the number is masked so two numbers compare. */
const ask = (p: Promise<unknown>, needle: string) => p.then(() => 'done', (e: Error) => e.message.replace(needle, '#'));

async function count(table: string): Promise<number> {
  return withTenant(client, async (tx) => Number(((await tx.execute(sql.raw(`select count(*)::int as n from ${table} where client = '${client}'`))) as unknown as Array<{ n: number }>)[0]!.n));
}
async function column(table: string, key: string, number: string, name: string): Promise<string | null> {
  return withTenant(client, async (tx) => ((await tx.execute(sql.raw(`select ${name}::text as v from ${table} where client = '${client}' and ${key} = '${number}'`))) as unknown as Array<{ v: string | null }>)[0]?.v ?? null);
}

beforeAll(async () => {
  tenant = await createTenant('scope-sales');
  client = tenant.client;
  other = await createTenant('scope-sales-2');
  await assignSalesAreaDimensions(tenant, '1000', [{ distributionChannel: '10', division: '01' }]);
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by)
      select client, ${B}, 'B company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${SEED}
        from company_code where client = ${client} and company_code = ${A} on conflict do nothing`);
    await tx.execute(sql`insert into sales_area (client, sales_org, distribution_channel, division, name, created_by) values (${client}, '1000', '10', '01', 'Area', ${SEED}) on conflict do nothing`);
    await tx.execute(sql`insert into sales_document_type (client, document_type, name, number_range_object, number_range_sub_object, pricing_procedure, created_by) values (${client}, 'IL', 'Invoice list', 'BILLING', 'IL', 'PR01', ${SEED}) on conflict do nothing`);
    for (const partner of ['SCUST1', 'SCUST2']) {
      await tx.execute(sql`insert into business_partner (client, partner_number, category, name, created_by) values (${client}, ${partner}, 'ORGANIZATION', ${partner}, ${SEED}) on conflict do nothing`);
    }
    // One billing document per company in each state the services judge.
    const bill = async (number: string, company: string, extra: { type?: string; status?: string; list?: string } = {}) => {
      await tx.execute(sql`
        insert into billing_document (client, billing_number, document_type, sales_org, distribution_channel, division,
          customer_number, company_code, currency, billing_date, status, net_value, gross_value, invoice_list_status, created_by)
        values (${client}, ${number}, ${extra.type ?? 'F2'}, '1000', '10', '01', 'SCUST1', ${company}, 'USD', '2026-03-31',
                ${extra.status ?? 'OPEN'}, 100, 100, ${extra.list ?? 'NOT_RELEVANT'}, ${SEED})`);
    };
    await bill(INV_A, A);
    await bill(INV_B, B);
    await bill(LIST_A, A, { type: 'IL', status: 'OPEN' });
    await bill(LIST_B, B, { type: 'IL', status: 'OPEN' });
    for (const [number, company, list] of [[DUE_A, A, 'DUE'], [DUE_B, B, 'DUE']] as const) {
      await bill(number, company, { status: 'OPEN', list });
      await tx.execute(sql`update billing_document set invoice_list_type = 'IL', invoice_list_date = '2026-03-31' where client = ${client} and billing_number = ${number}`);
      await tx.execute(sql`insert into sales_document_partner (client, document_category, document_number, function_code, partner_number, created_by) values (${client}, 'BILLING', ${number}, 'PY', 'SCUST1', ${SEED})`);
    }
    for (const [list, member] of [[LIST_A, INV_A], [LIST_B, INV_B]] as const) {
      await tx.execute(sql`insert into sales_invoice_list_item (client, invoice_list_number, item_number, billing_number, net_value, tax_value, gross_value, created_by) values (${client}, ${list}, 10, ${member}, 100, 0, 100, ${SEED})`);
    }
    for (const [number, company] of [[ORDER_A, A], [ORDER_B, B]] as const) {
      await tx.execute(sql`
        insert into sales_order (client, order_number, document_type, sales_org, distribution_channel, division, customer_number,
          company_code, currency, order_date, status, billing_block, created_by)
        values (${client}, ${number}, 'CR', '1000', '10', '01', 'SCUST1', ${company}, 'USD', '2026-03-31', 'OPEN', 'HELD', ${SEED})`);
    }
  });
  const caps = FINANCE_ACTOR_CAPABILITIES;
  onlyA = await createFinanceActor(client, { capabilities: caps, companyScopes: [A] });
  onlyB = await createFinanceActor(client, { capabilities: caps, companyScopes: [B] });
  both = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B] });
  noCapability = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
  noScope = await createFinanceActor(client, { capabilities: caps, companyScopes: [] });
  plantLimited = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B], plantScopes: ['PLA1'] });
  otherTenantActor = await createFinanceActor(other.client, { capabilities: caps });
}, 240_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 240_000);

describe('invoice lists', () => {
  const numbers = (rows: Array<{ billingNumber: string }>) => rows.map((r) => r.billingNumber).sort();

  it('shows due documents and lists only for the companies the session may read', async () => {
    const due = (a: FinanceActor['authorization'] | undefined) => invoiceListDueDocuments(client, {}, a);
    expect(numbers(await due(onlyA.authorization))).toEqual([DUE_A]);
    expect(numbers(await due(onlyB.authorization))).toEqual([DUE_B]);
    expect(numbers(await due(both.authorization))).toEqual([DUE_A, DUE_B]);
    expect(numbers(await due(plantLimited.authorization))).toEqual([DUE_A, DUE_B]);
    expect(numbers(await listInvoiceLists(client, {}, onlyA.authorization))).toEqual([LIST_A]);
    expect(numbers(await listInvoiceLists(client, {}, both.authorization))).toEqual([LIST_A, LIST_B]);
    for (const authorization of bad()) {
      await refused(due(authorization));
      await refused(listInvoiceLists(client, {}, authorization));
      await refused(getInvoiceList(client, LIST_A, authorization));
    }
  });

  it('answers another company\'s list as a missing one', async () => {
    expect((await getInvoiceList(client, LIST_A, onlyA.authorization))?.header.billingNumber).toBe(LIST_A);
    expect(await getInvoiceList(client, LIST_B, onlyA.authorization)).toBeNull();
    expect(await getInvoiceList(client, GONE, onlyA.authorization)).toBeNull();
  });

  it('creates only from documents inside the scope; another company\'s are missing, a selection is trimmed, nothing is written', async () => {
    const before = await count('billing_document');
    const create = (a: FinanceActor['authorization'] | undefined, billingNumbers?: string[], key = 'k') =>
      createInvoiceList({ client, authorization: a, changedBy: 'SPOOFED_NAME', billingNumbers, requestKey: `scope-il-${key}` });
    expect(await ask(create(onlyA.authorization, [DUE_B], '1'), DUE_B)).toBe(await ask(create(onlyA.authorization, [GONE], '2'), GONE));
    expect(await ask(create(onlyA.authorization, [DUE_B], '3'), DUE_B)).toMatch(/does not exist/);
    // A selection of "everything due" sees only the caller's company, so it is never a two-company group.
    // (it then stops at the number range this fixture does not define, proving it was a one-company group).
    expect(await ask(create(onlyA.authorization, undefined, '4'), 'x')).toMatch(/No number range is defined/);
    expect(await ask(create(both.authorization, undefined, '5'), 'x')).toMatch(/fall into 2 groups/);
    for (const authorization of bad()) await refused(create(authorization, [DUE_A], '6'));
    expect(await count('billing_document')).toBe(before);
  });

  it('answers a release or cancellation of another company\'s list as a missing list, changing nothing', async () => {
    const release = (a: FinanceActor['authorization'] | undefined, list: string) =>
      releaseInvoiceList({ client, authorization: a, changedBy: 'SPOOFED_NAME', invoiceListNumber: list });
    const cancel = (a: FinanceActor['authorization'] | undefined, list: string) =>
      cancelInvoiceList({ client, authorization: a, changedBy: 'SPOOFED_NAME', invoiceListNumber: list });
    expect(await ask(release(onlyA.authorization, LIST_B), LIST_B)).toBe(await ask(release(onlyA.authorization, GONE), GONE));
    expect(await ask(cancel(onlyA.authorization, LIST_B), LIST_B)).toBe(await ask(cancel(onlyA.authorization, GONE), GONE));
    expect(await ask(cancel(onlyA.authorization, LIST_B), LIST_B)).toMatch(/does not exist/);
    for (const authorization of bad()) {
      await refused(release(authorization, LIST_A));
      await refused(cancel(authorization, LIST_A));
    }
    expect(await column('billing_document', 'billing_number', LIST_B, 'status')).toBe('OPEN');
    // The company's own actor can cancel; the change is recorded under the session user, not the supplied name.
    const cancelled = await cancel(onlyA.authorization, LIST_A);
    expect(cancelled.header.status).toBe('CANCELLED');
    expect(await column('billing_document', 'billing_number', LIST_A, 'changed_by')).toBe(onlyA.username);
  });
});

describe('credit memos', () => {
  const memo = (a: FinanceActor['authorization'] | undefined, invoice: string, key: string) => ({
    client, authorization: a, changedBy: 'SPOOFED_NAME', requestKey: `scope-cm-${key}`, billingNumber: invoice,
    billingDate: '2026-04-01', items: [{ billingLineNumber: 10, quantity: 1 }],
  });

  it('answers a credit memo or request against another company\'s invoice as a missing invoice, writing nothing', async () => {
    const before = [await count('billing_document'), await count('sales_order')];
    const asMemo = (inv: string, key: string) => ask(createCreditMemo(memo(onlyA.authorization, inv, key)), inv);
    const asRequest = (inv: string, key: string) => ask(createCreditMemoRequest({
      client, authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME', requestKey: `scope-cr-${key}`, billingNumber: inv,
      orderDate: '2026-04-01', items: [{ billingLineNumber: 10, quantity: 1 }],
    }), inv);
    const hiddenMemo = await asMemo(INV_B, '1');
    expect(hiddenMemo).toBe(await asMemo(GONE, '2'));
    expect(hiddenMemo).toMatch(/does not stand|does not exist/);
    expect(await asRequest(INV_B, '1')).toBe(await asRequest(GONE, '2'));
    for (const authorization of bad()) {
      await refused(createCreditMemo(memo(authorization, INV_A, '3')));
      await refused(createCreditMemoRequest({
        client, authorization, changedBy: 'X', requestKey: 'scope-cr-3', billingNumber: INV_A,
        orderDate: '2026-04-01', items: [{ billingLineNumber: 10, quantity: 1 }],
      }));
    }
    expect([await count('billing_document'), await count('sales_order')]).toEqual(before);
  });

  it('answers posting another company\'s credit memo and lifting another company\'s billing block as missing, changing nothing', async () => {
    const post = (a: FinanceActor['authorization'] | undefined, number: string) =>
      postCreditMemo({ client, authorization: a, changedBy: 'X', billingNumber: number, expectedVersion: 1, postingDate: '2026-04-01', requestKey: `scope-post-${number}` });
    expect(await ask(post(onlyA.authorization, INV_B), INV_B)).toBe(await ask(post(onlyA.authorization, GONE), GONE));
    const lift = (a: FinanceActor['authorization'] | undefined, order: string) =>
      releaseBillingBlock({ client, authorization: a, changedBy: 'SPOOFED_NAME', orderNumber: order, expectedVersion: 1 });
    expect(await ask(lift(onlyA.authorization, ORDER_B), ORDER_B)).toBe(await ask(lift(onlyA.authorization, 'SO99999999'), 'SO99999999'));
    for (const authorization of bad()) {
      await refused(post(authorization, INV_A));
      await refused(lift(authorization, ORDER_A));
    }
    expect(await column('sales_order', 'order_number', ORDER_B, 'billing_block')).toBe('HELD');
    // The company's own actor lifts its own block; the change is recorded under the session user.
    expect(await lift(onlyA.authorization, ORDER_A)).toMatchObject({ orderNumber: ORDER_A, version: 2 });
    expect(await column('sales_order', 'order_number', ORDER_A, 'billing_block')).toBeNull();
    const by = await withTenant(client, async (tx) => (await tx.execute(sql`
      select changed_by from change_document where client = ${client} and object_key = ${ORDER_A} order by changed_at desc limit 1`)) as unknown as Array<{ changed_by: string }>);
    expect(by[0]?.changed_by).toBe(onlyA.username);
  });

  it('lists complaints only for the companies the session may read', async () => {
    // No complaint document type is configured here, so the list is judged on authority alone.
    for (const authorization of bad()) await refused(listCreditMemoRequests(client, {}, authorization));
    expect(await listCreditMemoRequests(client, {}, onlyA.authorization).then((rows) => rows.map((r) => r.orderNumber))).not.toContain(ORDER_B);
  });
});

describe('attention-only reads', () => {
  it('are not reachable from any page, action or route', async () => {
    const { execFileSync } = await import('node:child_process');
    let hits = '';
    try { hits = execFileSync('grep', ['-rlE', 'ForAttention', 'src/app'], { encoding: 'utf8' }); } catch { /* grep exits 1 when nothing matches */ }
    expect(hits.trim()).toBe('');
  });
});
