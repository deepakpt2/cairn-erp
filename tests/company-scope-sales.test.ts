/**
 * Adversarial tests: a capability alone must never reach another company's, sales area's or plant's sales documents.
 * Sales orders here; quotations, deliveries and the rest follow in the same file.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { authOrgRestriction } from '../src/platform/tables/security';
import {
  cancelSalesOrder, changeSalesOrder, getSalesOrder, listSalesOrderDocuments, releaseSalesOrderCredit, salesOrderChoices,
} from '../src/modules/sales/sales-order';
import { assignSalesAreaDimensions, closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const A = '1000';
const B = '2000';
const SEED = 'SCOPE_SALES_SEED';
const CAPS = ['SALES.ORDER.CREATE', 'SALES.ORDER.RELEASE'];
const SO_A = 'SOA0000001';
const SO_B = 'SOB0000001';
const SO_D2 = 'SOD0000002';
const GONE = 'SOZ9999999';

let tenant: TestTenant;
let other: TestTenant;
let client = '';
const actors: Record<string, FinanceActor> = {};
const ask = (p: Promise<unknown>) => p.then(() => 'done', (e: Error) => e.message);
const orderNumbers = (rows: Array<{ orderNumber: string }>) => rows.map((r) => r.orderNumber).sort();

async function addScopes(actor: FinanceActor, scopes: Array<[string, string]>) {
  await withTenant(client, async (tx) => {
    await tx.insert(authOrgRestriction).values(scopes.map(([scopeType, scopeValue]) => ({
      id: randomUUID(), client, userId: actor.userId, scopeType, scopeValue, createdBy: SEED,
    })));
  });
}

beforeAll(async () => {
  tenant = await createTenant('scope-sales');
  client = tenant.client;
  other = await createTenant('scope-sales-2');
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by)
      select client, ${B}, 'B company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${SEED}
        from company_code where client = ${client} and company_code = ${A} on conflict do nothing`);
    for (const [plant, company] of [['PSA1', A], ['PSB1', B]] as const) {
      await tx.execute(sql`insert into plant (client, plant, name, company_code, country, created_by) values (${client}, ${plant}, ${plant}, ${company}, 'US', ${SEED}) on conflict do nothing`);
    }
  });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit) values ('UNT', 'Unit', 'COUNT', 0, false) on conflict (code) do nothing`);
    for (const [org, company] of [['1000', A], ['2000', B]] as const) {
      await tx.execute(sql`insert into sales_org (client, sales_org, company_code, currency, created_by) values (${client}, ${org}, ${company}, 'USD', ${SEED}) on conflict do nothing`);
    }
  });
  await assignSalesAreaDimensions(tenant, '1000', [{ distributionChannel: '10', division: '01' }, { distributionChannel: '10', division: '02' }]);
  await assignSalesAreaDimensions(tenant, '2000', [{ distributionChannel: '10', division: '01' }]);
  await withTenant(client, async (tx) => {
    for (const [org, div] of [['1000', '01'], ['1000', '02'], ['2000', '01']] as const) {
      await tx.execute(sql`insert into sales_area (client, sales_org, distribution_channel, division, name, created_by) values (${client}, ${org}, '10', ${div}, 'area', ${SEED}) on conflict do nothing`);
    }
    await tx.execute(sql`insert into business_partner (client, partner_number, category, name, created_by) values (${client}, 'CUSTSC1', 'ORGANIZATION', 'Scope customer', ${SEED}) on conflict do nothing`);
    await tx.execute(sql`insert into material (client, material_number, description, material_type, base_unit, created_by) values (${client}, 'SCSM1', 'm', 'RAW', 'UNT', ${SEED}) on conflict do nothing`);
    await tx.execute(sql`insert into sales_condition_record (client, condition_number, sales_org, distribution_channel, division, material_number, currency, amount, validity_from, validity_to, created_by)
      values (${client}, 'COND', '1000', '10', '01', 'SCSM1', 'USD', 5, '2026-01-01', '2026-12-31', ${SEED})`);
    const orders: Array<[string, string, string, string, string]> = [
      [SO_A, '1000', '01', A, 'PSA1'], [SO_B, '2000', '01', B, 'PSB1'], [SO_D2, '1000', '02', A, 'PSA1'],
    ];
    for (const [no, org, div, company, plant] of orders) {
      await tx.execute(sql`insert into sales_order (client, order_number, sales_org, distribution_channel, division, customer_number, company_code, currency, order_date, created_by)
        values (${client}, ${no}, ${org}, '10', ${div}, 'CUSTSC1', ${company}, 'USD', '2026-04-05', ${SEED})`);
      await tx.execute(sql`insert into sales_order_line (client, order_number, line_number, material_number, plant, order_quantity, quantity_unit, base_quantity, condition_number, created_by)
        values (${client}, ${no}, 10, 'SCSM1', ${plant}, 1, 'UNT', 1, 'COND', ${SEED})`);
    }
  });
  actors.A = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A], plantScopes: [] });
  actors.B = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [B], plantScopes: [] });
  actors.both = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B], plantScopes: [] });
  actors.org1000 = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B], plantScopes: [] });
  await addScopes(actors.org1000, [['SALES_ORG', '1000']]);
  actors.div01 = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B], plantScopes: [] });
  await addScopes(actors.div01, [['DIVISION', '01']]);
  actors.plantA = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B], plantScopes: ['PSA1'] });
  actors.noCap = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B], plantScopes: [] });
  actors.noScope = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [], plantScopes: [] });
  actors.other = await createFinanceActor(other.client, { capabilities: CAPS });
}, 300_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 240_000);

const auth = (k: string) => actors[k]!.authorization;
const denied = ['noCap', 'noScope', 'other'] as const;

describe('sales orders', () => {
  it('reads an order only inside company, sales area and plant reach; the rest answer as missing', async () => {
    expect((await getSalesOrder(client, SO_A, auth('A')))?.orderNumber).toBe(SO_A);
    expect(await getSalesOrder(client, SO_B, auth('A'))).toBeNull();
    expect(await getSalesOrder(client, GONE, auth('A'))).toBeNull();
    expect((await getSalesOrder(client, SO_B, auth('both')))?.orderNumber).toBe(SO_B);
    // Sales Org scope 1000: company B's order (sales org 2000) is outside it.
    expect(await getSalesOrder(client, SO_B, auth('org1000'))).toBeNull();
    expect((await getSalesOrder(client, SO_D2, auth('org1000')))?.orderNumber).toBe(SO_D2);
    // Division scope 01: the division 02 order is outside it.
    expect(await getSalesOrder(client, SO_D2, auth('div01'))).toBeNull();
    expect((await getSalesOrder(client, SO_A, auth('div01')))?.orderNumber).toBe(SO_A);
    // Plant scope PSA1: the order shipping from PSB1 is outside it.
    expect(await getSalesOrder(client, SO_B, auth('plantA'))).toBeNull();
  });

  it('refuses no session, no capability, no scope and another tenant', async () => {
    expect(await ask(getSalesOrder(client, SO_A, undefined))).not.toBe('done');
    for (const k of denied) {
      expect(await ask(getSalesOrder(client, SO_A, auth(k)))).not.toBe('done');
      expect(await ask(listSalesOrderDocuments(client, {}, auth(k)))).not.toBe('done');
      expect(await ask(salesOrderChoices(client, auth(k)))).not.toBe('done');
    }
  });

  it('lists only reachable orders and offers only reachable areas, companies and plants', async () => {
    expect(orderNumbers(await listSalesOrderDocuments(client, {}, auth('A')))).toEqual([SO_A, SO_D2].sort());
    expect(orderNumbers(await listSalesOrderDocuments(client, {}, auth('both')))).toEqual([SO_A, SO_B, SO_D2].sort());
    expect(orderNumbers(await listSalesOrderDocuments(client, {}, auth('org1000')))).toEqual([SO_A, SO_D2].sort());
    expect(orderNumbers(await listSalesOrderDocuments(client, {}, auth('div01')))).toEqual([SO_A, SO_B].sort());
    expect(orderNumbers(await listSalesOrderDocuments(client, {}, auth('plantA')))).toEqual([SO_A, SO_D2].sort());
    const choices = await salesOrderChoices(client, auth('A'));
    expect(choices.companies.map((c) => c.companyCode)).toEqual([A]);
    expect(choices.plants.map((p) => p.plant)).toContain('PSA1');
    expect(choices.plants.map((p) => p.plant)).not.toContain('PSB1');
    expect([...new Set(choices.salesAreas.map((s) => s.salesOrg))]).toEqual(['1000']);
    expect((await salesOrderChoices(client, auth('div01'))).salesAreas.every((s) => s.division === '01')).toBe(true);
  });

  it("answers cancel, change and credit release of another scope's order as a missing one, and writes nothing", async () => {
    const cancel = (a: FinanceActor['authorization'] | undefined, n: string) => cancelSalesOrder({
      client, changedBy: 'FORGED', orderNumber: n, expectedVersion: 1, authorization: a });
    const miss = await ask(cancel(auth('A'), GONE));
    expect(miss).toMatch(/does not exist/);
    expect((await ask(cancel(auth('A'), SO_B))).replaceAll(SO_B, '#')).toBe(miss.replaceAll(GONE, '#'));
    expect((await ask(cancel(auth('plantA'), SO_B))).replaceAll(SO_B, '#')).toBe(miss.replaceAll(GONE, '#'));
    expect((await ask(cancel(auth('div01'), SO_D2))).replaceAll(SO_D2, '#')).toBe(miss.replaceAll(GONE, '#'));
    const change = await ask(changeSalesOrder({
      client, changedBy: 'FORGED', orderNumber: SO_B, expectedVersion: 1, salesOrg: '2000', distributionChannel: '10', division: '01',
      customerNumber: 'CUSTSC1', companyCode: B, currency: 'USD', orderDate: '2026-04-05', lines: [{ lineNumber: 10, materialNumber: 'SCSM1', orderQuantity: 1 }],
      rejectLines: [], authorization: auth('A') }));
    expect(change).toMatch(/does not exist/);
    const release = await ask(releaseSalesOrderCredit({ client, changedBy: 'FORGED', orderNumber: SO_B, canOverride: false, authorization: auth('A') }));
    expect(release).toMatch(/does not exist/);
    for (const k of denied) expect(await ask(cancel(auth(k), SO_A))).not.toMatch(/^done$|does not exist/);
    expect(await ask(cancel(undefined, SO_A))).not.toMatch(/^done$|does not exist/);
    const state = await withTenant(client, async (tx) => (await tx.execute(sql`select order_number, status, version from sales_order where client = ${client} order by order_number`)) as unknown as Array<{ status: string; version: number }>);
    expect(state.every((r) => r.status === 'OPEN' && r.version === 1)).toBe(true);
  });

  it('cancels an order inside the reach and records the session user, not the supplied name', async () => {
    await cancelSalesOrder({ client, changedBy: 'FORGED', orderNumber: SO_D2, expectedVersion: 1, authorization: auth('A') });
    const row = (await withTenant(client, async (tx) => (await tx.execute(sql`select status, changed_by from sales_order where client = ${client} and order_number = ${SO_D2}`)) as unknown as Array<{ status: string; changed_by: string }>))[0]!;
    expect(row.status).toBe('CANCELLED');
    expect(row.changed_by).toBe(actors.A!.username);
  });
});
