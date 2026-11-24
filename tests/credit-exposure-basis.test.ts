import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { CREDIT_MAX_RATE_AGE_DAYS, evaluateCreditCheck } from '../src/modules/finance/credit';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * Option A of the exposure-basis decision: foreign-currency open commitments are *in* the basis,
 * converted into the credit control area's currency at each document's own date, at the same AVERAGE
 * rate and under the same no-rate and staleness rules as the judged amount.
 *
 * These tests are the ones the decision rests on: a customer whose commitments stand in three currencies
 * is judged on their converted sum; a missing or stale rate refuses by name rather than dropping a
 * document or using an ancient one; and an order that passed at its own date can block at a later date
 * when the rate has moved, with both determinations recording which rate decided them.
 */

const ACTOR = 'CREDIT-BASIS-TEST';
const AREA = '0001';

interface Fixture { tenant: TestTenant; company: string; local: string }

async function buildFixture(seed: string, local: string): Promise<Fixture> {
  const tenant = await createTenant(seed, { currency: local });
  const company = tenant.companyCode;
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${tenant.client}, 'C100', 'ORGANIZATION', 'Basis customer', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into credit_risk_category (client, risk_category, name, created_by)
      values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing`);
  });
  return { tenant, company, local };
}

/** An open order in `currency`, with one open line, dated `date`. */
async function openOrder(fixture: Fixture, currency: string, gross: number, date: string, key: string): Promise<void> {
  await withTenant(fixture.tenant.client, async (tx) => {
    const company = fixture.company;
    const area = AREA;
    const org = '1000';
    const ch = '10';
    const div = '00';
    await tx.execute(sql`insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit)
      values ('UNT', 'Unit', 'COUNT', 0, false) on conflict do nothing`);
    await tx.execute(sql`insert into sales_org (client, sales_org, company_code, currency, created_by)
      values (${fixture.tenant.client}, ${org}, ${company}, ${fixture.local}, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into distribution_channel (client, distribution_channel, name, created_by)
      values (${fixture.tenant.client}, ${ch}, 'DC', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into division (client, division, name, created_by)
      values (${fixture.tenant.client}, ${div}, 'Div', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into sales_org_distribution_channel (client, sales_org, distribution_channel, created_by)
      values (${fixture.tenant.client}, ${org}, ${ch}, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into sales_org_division (client, sales_org, division, created_by)
      values (${fixture.tenant.client}, ${org}, ${div}, ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
      values (${fixture.tenant.client}, ${org}, ${ch}, ${div}, 'Area', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${fixture.tenant.client}, 'M1', 'm', 'RAW', 'UNT', ${ACTOR}) on conflict do nothing`);
    // One condition record serves every line in this fixture. A per-currency number would collide on
    // `sales_condition_record_key_uq`, which does not include the currency, and `on conflict do nothing`
    // would then silently skip the insert the line's foreign key depends on. The line's price comes from
    // its own `net_amount`, not from this record; the foreign key only requires that the number exists.
    const condition = 'KC01';
    await tx.execute(sql`insert into sales_condition_record
        (client, condition_number, condition_type, sales_org, distribution_channel, division, customer_number,
         material_number, currency, amount, price_unit, validity_from, validity_to, created_by)
      values (${fixture.tenant.client}, ${condition}, 'PR00', ${org}, ${ch}, ${div}, '',
              'M1', ${currency}, ${gross}, 1, '2025-01-01', '2027-12-31', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`insert into sales_order
        (client, order_number, document_type, sales_org, distribution_channel, division, customer_number,
         company_code, currency, order_date, status, net_value, tax_value, gross_value, version, created_by)
      values (${fixture.tenant.client}, ${key}, 'OR', ${org}, ${ch}, ${div}, 'C100',
              ${company}, ${currency}, ${date}, 'OPEN', ${gross}, 0, ${gross}, 1, ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`insert into sales_order_line
        (client, order_number, line_number, material_number, plant, order_quantity, quantity_unit,
         base_quantity, net_price, price_unit, net_amount, tax_rate, tax_amount, condition_number, status, created_by)
      values (${fixture.tenant.client}, ${key}, 1, 'M1', '1000', 1, 'UNT', 1, ${gross}, 1, ${gross}, 0, 0,
              ${condition}, 'OPEN', ${ACTOR})
      on conflict do nothing`);
    void area;
  });
}

async function setLimit(fixture: Fixture, limit: number): Promise<void> {
  await withTenant(fixture.tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into customer_credit (client, customer, credit_control_area, credit_limit, credit_currency, risk_category, created_by)
      values (${fixture.tenant.client}, 'C100', ${AREA}, ${limit}, ${fixture.local}, 'A', ${ACTOR})
      on conflict (client, customer, credit_control_area) do update set credit_limit = ${limit}`);
  });
}

async function setRate(fixture: Fixture, from: string, to: string, validFrom: string, rate: number): Promise<void> {
  await withTenant(fixture.tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by)
      values (${fixture.tenant.client}, 'AVERAGE', ${from}, ${to}, ${validFrom}, ${rate}, ${ACTOR})
      on conflict do nothing`);
  });
}

async function maxRateAge(fixture: Fixture, days: number): Promise<void> {
  await withTenant(fixture.tenant.client, async (tx) => {
    await tx.execute(sql`
      update client_settings set flags = jsonb_set(coalesce(flags, '{}'::jsonb), '{CREDIT_MAX_RATE_AGE_DAYS}', ${JSON.stringify(days)}::jsonb)
      where client = ${fixture.tenant.client}`);
  });
}

let stale: Fixture;

beforeAll(async () => {
  stale = await buildFixture('credit-basis-stale', 'KWD');
}, 300_000);

afterAll(async () => {
  if (stale) await destroyTenant(stale.tenant.client);
}, 300_000);

describe('item 3 — a stale rate is refused, and the age is configurable', () => {
  it('refuses a rate older than the 45-day default, naming the rate date and the age', async () => {
    // A USD document dated 2026-12-01 whose only USD rate dates from 2026-10-01: 61 days old.
    await setRate(stale, 'USD', 'KWD', '2026-10-01', 0.300);
    await setLimit(stale, 1_000_000);
    await expect(evaluateCreditCheck({
      client: stale.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '1000', amountCurrency: 'USD', documentDate: '2026-12-01',
    })).rejects.toThrow(/dates from 2026-10-01, 61 days old, which exceeds the 45-day maximum/);
  }, 120_000);

  it('accepts the same row when the tenant widens the maximum age', async () => {
    await maxRateAge(stale, 90);
    const check = await evaluateCreditCheck({
      client: stale.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '1000', amountCurrency: 'USD', documentDate: '2026-12-01',
    });
    expect(check.decision).toBe('OK');
    // Restore the default for any later case.
    await maxRateAge(stale, CREDIT_MAX_RATE_AGE_DAYS);
  }, 120_000);
});

describe('item 4 — the rate is recorded, so a rate move is visible in both determinations', () => {
  it('passes at the order date and blocks at a later date after the rate moves', async () => {
    // KWD local, limit KWD 1,000. A USD order of 3,200.
    //   At order date 2026-10-05 the rate is 0.300 → KWD 960, inside the limit: PASSES.
    //   A delivery posted 2026-11-20, when a new rate of 0.400 stands → KWD 1,280: BLOCKS.
    const f = await buildFixture('credit-basis-move', 'KWD');
    try {
      await setRate(f, 'USD', 'KWD', '2026-10-01', 0.300);
      await setRate(f, 'USD', 'KWD', '2026-11-15', 0.400);
      await setLimit(f, 1_000);
      await openOrder(f, 'USD', 3200, '2026-10-05', 'SO-MOVE');

      // The order's own determination is judged at the order date (and excludes the order itself,
      // as the order-under-judgement always does), so it is judged on the 0.300 rate: KWD 960 against
      // a KWD 1,000 limit — inside it, though at 96% it warns.
      const atOrder = await evaluateCreditCheck({
        client: f.tenant.client, customer: 'C100', creditControlArea: AREA,
        amount: '3200', amountCurrency: 'USD', documentDate: '2026-10-05',
        excludeSalesDocument: 'SO-MOVE',
      });
      expect(atOrder.decision).toBe('WARN');
      expect(atOrder.reason).toBe('WARNING_THRESHOLD');
      expect(atOrder.rateUsed).toBeCloseTo(0.3, 8);
      expect(atOrder.rateDate).toBe('2026-10-01');

      // Judged later, at a posting date after the rate moved, the same value is KWD 1,280 and blocks.
      const atDelivery = await evaluateCreditCheck({
        client: f.tenant.client, customer: 'C100', creditControlArea: AREA,
        amount: '3200', amountCurrency: 'USD', documentDate: '2026-11-20',
        excludeSalesDocument: 'SO-MOVE',
      });
      expect(atDelivery.decision).toBe('BLOCK');
      expect(atDelivery.reason).toBe('LIMIT_EXCEEDED');
      expect(atDelivery.rateUsed).toBeCloseTo(0.4, 8);
      expect(atDelivery.rateDate).toBe('2026-11-15');
    } finally {
      await destroyTenant(f.tenant.client);
    }
  }, 150_000);
});
