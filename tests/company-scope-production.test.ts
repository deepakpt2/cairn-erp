/**
 * Company-scope authorization for the production order cost report (adversarial). Two companies (A 1000, B 2000) in
 * one tenant, a second tenant, and actors who hold the display capability but not the company, no scope, no
 * capability, or a plant limit. A capability alone must never reach another company's order or postings.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { postJournalEntry } from '../src/platform/posting';
import { getProductionOrderCostReport } from '../src/modules/production/order-cost-report';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const A = '1000';
const B = '2000';
const SEED = 'SCOPE_PROD_SEED';
const ORDER_A = 'PRD0000001';
const ORDER_B = 'PRD0000002';
const ORDER_MIXED = 'PRD0000003';
const ORDER_NO_COMPANY = 'PRD0000004';
const GONE = 'PRD9999999';
const CAPS = ['PROD.ORDER.COST.DISPLAY'];

let tenant: TestTenant;
let other: TestTenant;
let client = '';
let onlyA: FinanceActor;
let onlyB: FinanceActor;
let both: FinanceActor;
let noCapability: FinanceActor;
let noScope: FinanceActor;
let plantLimited: FinanceActor;
let plantOk: FinanceActor;
let otherTenantActor: FinanceActor;

const report = (orderNumber: string, a: FinanceActor['authorization'] | undefined) =>
  getProductionOrderCostReport({ client, orderNumber, authorization: a });
const ask = (p: Promise<unknown>) => p.then(() => 'done', (e: Error) => e.message);

async function post(company: string, order: string, amount: string) {
  await withTenant(client, (tx) => postJournalEntry(tx, {
    client, companyCode: company, documentType: 'SA', documentDate: '2026-01-15', postingDate: '2026-01-15',
    fiscalYear: 2026, postingPeriod: 1, currency: 'USD', localCurrency: 'USD', headerText: 'Order cost', postedBy: SEED,
    lines: [
      { glAccount: '410000', debitCredit: 'S', amount, productionOrder: order },
      { glAccount: '100000', debitCredit: 'H', amount },
    ],
  }));
}

beforeAll(async () => {
  tenant = await createTenant('scope-prod');
  client = tenant.client;
  other = await createTenant('scope-prod-2');
  await defineTestRanges(tenant);
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by)
      select client, ${B}, 'B company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${SEED}
        from company_code where client = ${client} and company_code = ${A} on conflict do nothing`);
    await defineRange(tx, { client, objectCode: 'RF_BELEG', companyCode: B, subObject: 'GENERAL', fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999_999, createdBy: SEED });
    for (const [plant, company] of [['PLA1', A], ['PLB1', B], ['PLN1', null]] as const) {
      await tx.execute(sql`insert into plant (client, plant, name, company_code, country, created_by) values (${client}, ${plant}, ${plant}, ${company}, 'US', ${SEED}) on conflict do nothing`);
    }
    for (const [number, plant] of [[ORDER_A, 'PLA1'], [ORDER_B, 'PLB1'], [ORDER_MIXED, 'PLA1'], [ORDER_NO_COMPANY, 'PLN1']] as const) {
      await tx.execute(sql`
        insert into production_order (client, order_number, material_number, plant, order_quantity, unit_of_measure,
          scheduled_start, scheduled_finish, status, created_by)
        values (${client}, ${number}, 'FG01', ${plant}, 10, 'PC', '2026-11-02', '2026-11-06', 'RELEASED', ${SEED})`);
    }
  });
  await post(A, ORDER_A, '100.00');
  await post(B, ORDER_B, '200.00');
  await post(A, ORDER_MIXED, '10.00');
  await post(B, ORDER_MIXED, '20.00');
  onlyA = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A] });
  onlyB = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [B] });
  both = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B] });
  noCapability = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
  noScope = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [] });
  plantLimited = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B], plantScopes: ['PLB1'] });
  plantOk = await createFinanceActor(client, { capabilities: CAPS, companyScopes: [A, B], plantScopes: ['PLA1'] });
  otherTenantActor = await createFinanceActor(other.client, { capabilities: CAPS });
}, 240_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 240_000);

describe('production order cost report', () => {
  it('shows an order only to a session whose Company Code scope covers its plant', async () => {
    expect((await report(ORDER_A, onlyA.authorization)).lines.length).toBeGreaterThan(0);
    expect((await report(ORDER_B, onlyB.authorization)).lines.length).toBeGreaterThan(0);
    expect((await report(ORDER_A, both.authorization)).lines.length).toBeGreaterThan(0);
  });

  it("answers another company's order exactly as one that does not exist", async () => {
    const mask = (m: string, n: string) => m.replace(n, '#');
    const foreign = mask(await ask(report(ORDER_B, onlyA.authorization)), ORDER_B);
    expect(foreign).toMatch(/does not stand in this tenant/);
    expect(foreign).toBe(mask(await ask(report(GONE, onlyA.authorization)), GONE));
  });

  it('refuses the whole report when the order carries postings of a company outside the scope', async () => {
    const message = await ask(report(ORDER_MIXED, onlyA.authorization));
    expect(message).not.toBe('done');
    expect(message).toMatch(/scope|Company Code/i);
    expect((await report(ORDER_MIXED, both.authorization)).lines).toHaveLength(2);
  });

  it('refuses a caller with no session, no capability, no scope or another tenant', async () => {
    for (const a of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      const message = await ask(report(ORDER_A, a));
      expect(message).not.toBe('done');
      expect(message).not.toMatch(/does not stand/);
    }
  });

  it('hides an order whose plant lies outside a Plant scope, and shows one inside it', async () => {
    expect(await ask(report(ORDER_A, plantLimited.authorization))).toMatch(/does not stand in this tenant/);
    expect((await report(ORDER_A, plantOk.authorization)).lines.length).toBeGreaterThan(0);
  });

  it('does not show an order whose plant names no company', async () => {
    expect(await ask(report(ORDER_NO_COMPANY, both.authorization))).toMatch(/does not stand in this tenant/);
  });
});
