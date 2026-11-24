import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  CREDIT_MAX_RATE_AGE_DAYS, evaluateCreditCheck, listCreditMonitor,
} from '../src/modules/finance/credit';
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

let multi: Fixture;
let stale: Fixture;

beforeAll(async () => {
  multi = await buildFixture('credit-basis-multi', 'KWD');
  stale = await buildFixture('credit-basis-stale', 'KWD');
}, 300_000);

afterAll(async () => {
  if (multi) await destroyTenant(multi.tenant.client);
  if (stale) await destroyTenant(stale.tenant.client);
}, 300_000);

describe('option A — foreign commitments are in the basis, converted at their own date', () => {
  it('sums KWD + USD + EUR commitments as their converted amounts', async () => {
    // KWD local. KWD 100 stays 100; USD 1000 at 0.300 is KWD 300; EUR 500 at 0.330 is KWD 165.
    // All three dates carry a rate within the staleness window of their own date.
    await setRate(multi, 'USD', 'KWD', '2026-10-01', 0.300);
    await setRate(multi, 'EUR', 'KWD', '2026-10-01', 0.330);
    await openOrder(multi, 'KWD', 100, '2026-10-05', 'SO-KWD');
    await openOrder(multi, 'USD', 1000, '2026-10-05', 'SO-USD');
    await openOrder(multi, 'EUR', 500, '2026-10-05', 'SO-EUR');
    await setLimit(multi, 1_000_000);

    const check = await evaluateCreditCheck({
      client: multi.tenant.client, customer: 'C100', creditControlArea: AREA,
    });
    // Exposure is the receivable half (zero here) plus every converted commitment: 100 + 300 + 165 = 565.
    expect(check.exposure).toBeCloseTo(565, 4);
    expect(check.decision).toBe('OK');

    const monitor = await listCreditMonitor(multi.tenant.client, {});
    const row = monitor.rows.find((r) => r.customer === 'C100')!;
    expect(row.orderExposure).toBeCloseTo(565, 4);
    expect(row.totalExposure).toBeCloseTo(565, 4);
    // The breakdown is per currency, each with its own rate and rate date — never only a total.
    const byCurrency = new Map(row.commitmentBreakdown.map((b) => [b.currency, b]));
    expect([...byCurrency.keys()].sort()).toEqual(['EUR', 'KWD', 'USD']);
    expect(byCurrency.get('USD')!.originalAmount).toBe(1000);
    expect(byCurrency.get('USD')!.rate).toBeCloseTo(0.3, 8);
    expect(byCurrency.get('USD')!.rateDate).toBe('2026-10-01');
    expect(byCurrency.get('USD')!.convertedAmount).toBeCloseTo(300, 4);
    expect(byCurrency.get('EUR')!.convertedAmount).toBeCloseTo(165, 4);
    expect(byCurrency.get('KWD')!.convertedAmount).toBeCloseTo(100, 4);
    // The local-currency bucket is the identity: no rate, no rate date.
    expect(byCurrency.get('KWD')!.rate).toBeNull();
    expect(byCurrency.get('KWD')!.rateDate).toBeNull();
  }, 120_000);

  it('refuses by name when a currency in the basis has no rate', async () => {
    // A JPY order with no JPY→KWD rate: the basis cannot be valued, so the check refuses.
    await openOrder(multi, 'JPY', 50_000, '2026-10-06', 'SO-JPY');
    await expect(evaluateCreditCheck({
      client: multi.tenant.client, customer: 'C100', creditControlArea: AREA,
    })).rejects.toThrow(/No AVERAGE exchange rate stands from JPY to KWD/);
    // The basis is never silently short: the same refusal reaches the monitor.
    await expect(listCreditMonitor(multi.tenant.client, {})).rejects.toThrow(/JPY/);
    await withTenant(multi.tenant.client, async (tx) => {
      await tx.execute(sql`delete from sales_order_line where client = ${multi.tenant.client} and order_number = 'SO-JPY'`);
      await tx.execute(sql`delete from sales_order where client = ${multi.tenant.client} and order_number = 'SO-JPY'`);
    });
  }, 120_000);

  it('makes a standing commitment block the next document, and releasing re-reads the same basis', async () => {
    // DI-019's own criterion, applied to the converted basis. This customer already stands at KWD 565:
    // KWD 100 + USD 1,000 (KWD 300) + EUR 500 (KWD 165).
    await setLimit(multi, 600);
    const next = await evaluateCreditCheck({
      client: multi.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '800', amountCurrency: 'USD', documentDate: '2026-10-08',
      excludeSalesDocument: 'SO-NEXT',
    });
    // 565 standing + KWD 240 for the new document = 805, over the KWD 600 limit.
    expect(next.decision).toBe('BLOCK');
    expect(next.reason).toBe('LIMIT_EXCEEDED');

    // Raising the limit re-reads the same basis and the same document now passes: releasing a block
    // re-judges against the live basis, not against a remembered figure.
    await setLimit(multi, 50_000);
    const released = await evaluateCreditCheck({
      client: multi.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '800', amountCurrency: 'USD', documentDate: '2026-10-08',
      excludeSalesDocument: 'SO-NEXT',
    });
    expect(released.decision).toBe('OK');
    expect(released.exposure).toBeCloseTo(565, 4);
    await setLimit(multi, 1_000_000);
  }, 120_000);
});

describe('item 3 — a stale rate is refused, and the age is configurable', () => {
  it('refuses a rate older than the 45-day default, naming the rate date and the age', async () => {
    // A USD order dated 2026-12-01 whose only USD rate dates from 2026-10-01: 61 days old.
    await setRate(stale, 'USD', 'KWD', '2026-10-01', 0.300);
    await openOrder(stale, 'USD', 1000, '2026-12-01', 'SO-STALE');
    await setLimit(stale, 1_000_000);
    await expect(evaluateCreditCheck({
      client: stale.tenant.client, customer: 'C100', creditControlArea: AREA,
    })).rejects.toThrow(/dates from 2026-10-01, 61 days old, which exceeds the 45-day maximum/);
  }, 120_000);

  it('accepts the same row when the tenant widens the maximum age', async () => {
    await maxRateAge(stale, 90);
    const check = await evaluateCreditCheck({
      client: stale.tenant.client, customer: 'C100', creditControlArea: AREA,
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
