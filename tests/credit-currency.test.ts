import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  checkSalesDocumentCredit, evaluateCreditCheck, getCreditExposure, listCreditMonitor,
} from '../src/modules/finance/credit';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * The credit check compares a judged document against a limit, and the two must be the same unit.
 *
 * The order states its value in its own document currency; the limit, the exposure and the warning
 * threshold stand in the credit control area's currency (which every supported path keeps equal to the
 * company's local currency). Before this repair the document figure was compared as though its number
 * were already local: a USD 3,200 order (KWD 960 at 0.300) blocked against a KWD 1,000 limit, and a KWD
 * 400 order (USD 1,200 at 3.0) passed a USD 1,000 limit. Both directions are pinned here.
 */

const ACTOR = 'CREDIT-CCY-TEST';
/** The area the standard structure builds (`STANDARD_STRUCTURE.creditControlArea`). */
const AREA = '0001';

interface Fixture { tenant: TestTenant; company: string; currency: string }

async function buildFixture(seed: string, localCurrency: string): Promise<Fixture> {
  const tenant = await createTenant(seed, { currency: localCurrency });
  const company = tenant.companyCode;
  await withTenant(tenant.client, async (tx) => {
    // The standard structure already made the area in the company currency; the customer, its
    // record and the partner master are what these cases add.
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${tenant.client}, 'C100', 'ORGANIZATION', 'Credit currency customer', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into credit_risk_category (client, risk_category, name, created_by)
      values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into customer_credit
        (client, customer, credit_control_area, credit_limit, credit_currency, risk_category, created_by)
      values (${tenant.client}, 'C100', ${AREA}, 1000, ${localCurrency}, 'A', ${ACTOR})
      on conflict do nothing`);
  });
  return { tenant, company, currency: localCurrency };
}

let kwdLocal: Fixture;
let usdLocal: Fixture;

beforeAll(async () => {
  kwdLocal = await buildFixture('credit-ccy-kwd', 'KWD');
  usdLocal = await buildFixture('credit-ccy-usd', 'USD');
}, 300_000);

afterAll(async () => {
  if (kwdLocal) await destroyTenant(kwdLocal.tenant.client);
  if (usdLocal) await destroyTenant(usdLocal.tenant.client);
}, 300_000);

async function withRate(fixture: Fixture, from: string, to: string, rate: number, fromDate = '2026-01-01'): Promise<void> {
  await withTenant(fixture.tenant.client, async (tx) => {
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by)
      values (${fixture.tenant.client}, 'AVERAGE', ${from}, ${to}, ${fromDate}, ${rate}, ${ACTOR})
      on conflict do nothing`);
  });
}

describe('the judged amount is translated into the credit control area currency', () => {
  it('blocks a USD order whose translated value exceeds a KWD limit', async () => {
    // USD 3,200 at 0.300 is KWD 960 — inside a KWD 1,000 limit. Unconverted, 3200 > 1000 blocked it.
    await withRate(kwdLocal, 'USD', 'KWD', 0.300);
    const check = await evaluateCreditCheck({
      client: kwdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '3600', amountCurrency: 'USD', documentDate: '2026-10-10',
    });
    // USD 3,600 at 0.300 is KWD 1,080: over the limit, and it blocks for the right reason.
    expect(check.decision).toBe('BLOCK');
    expect(check.reason).toBe('LIMIT_EXCEEDED');
  }, 90_000);

  it('passes a USD order just under a KWD limit that the raw number would have blocked', async () => {
    // The regression: USD 2,900 at 0.300 is KWD 870 — inside KWD 1,000 and below the 90% warning.
    // Judged unconverted, 2,900 > 1,000 blocked it outright.
    const check = await evaluateCreditCheck({
      client: kwdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '2900', amountCurrency: 'USD', documentDate: '2026-10-10',
    });
    expect(check.decision).toBe('OK');
    expect(check.reason).toBe('WITHIN_LIMIT');
  }, 90_000);

  it('blocks a KWD order whose translated value exceeds a USD limit', async () => {
    // The dangerous direction: KWD 400 at 3.0 is USD 1,200 — over a USD 1,000 limit. Unconverted,
    // 400 < 1000 read as comfortably inside it, so goods would have shipped past the limit.
    await withRate(usdLocal, 'KWD', 'USD', 3.0);
    const check = await evaluateCreditCheck({
      client: usdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '400', amountCurrency: 'KWD', documentDate: '2026-10-10',
    });
    expect(check.decision).toBe('BLOCK');
    expect(check.reason).toBe('LIMIT_EXCEEDED');
  }, 90_000);

  it('passes a KWD order just under a USD limit', async () => {
    // KWD 250 at 3.0 is USD 750, inside USD 1,000 and below the 90% warning.
    const check = await evaluateCreditCheck({
      client: usdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '250', amountCurrency: 'KWD', documentDate: '2026-10-10',
    });
    expect(check.decision).toBe('OK');
  }, 90_000);

  it('warns at the threshold on the translated figure, not the document one', async () => {
    // KWD 320 at 3.0 is USD 960: 96% of a USD 1,000 limit, past the 90% warning threshold.
    // Unconverted, 320 was 32% and warned for nothing.
    const check = await evaluateCreditCheck({
      client: usdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '320', amountCurrency: 'KWD', documentDate: '2026-10-10',
    });
    expect(check.decision).toBe('WARN');
    expect(check.reason).toBe('WARNING_THRESHOLD');
    expect(check.utilizationPercent).toBeCloseTo(96, 4);
  }, 90_000);

  it('leaves a same-currency judgement untouched', async () => {
    const check = await evaluateCreditCheck({
      client: kwdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '500', amountCurrency: 'KWD', documentDate: '2026-10-10',
    });
    expect(check.decision).toBe('OK');
  }, 90_000);
});

describe('no rate standing is a refusal, never an unconverted comparison', () => {
  it('names the currency pair, the date and the remedy', async () => {
    // EUR was never maintained against KWD in this tenant.
    await expect(evaluateCreditCheck({
      client: kwdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '500', amountCurrency: 'EUR', documentDate: '2026-10-10',
    })).rejects.toThrow(/No AVERAGE exchange rate stands from EUR to KWD on or before 2026-10-10/);
  }, 90_000);

  it('offers the maintenance path in the remedy', async () => {
    // The message names the pair and the date; the remedy is what tells an operator how to fix it.
    const error = await evaluateCreditCheck({
      client: kwdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '500', amountCurrency: 'EUR', documentDate: '2026-10-10',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as { remedy?: string }).remedy).toMatch(/Maintain the AVERAGE rate/);
    expect((error as { remedy?: string }).remedy).toMatch(/never translated at 1/);
  }, 90_000);

  it('does not fall back to a rate of 1', async () => {
    // A rate of 1 would make EUR 500 read as KWD 500 and pass. It must refuse instead.
    const attempt = evaluateCreditCheck({
      client: kwdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '500', amountCurrency: 'EUR', documentDate: '2026-10-10',
    });
    await expect(attempt).rejects.toThrow();
    await expect(attempt).rejects.not.toThrow(/WITHIN_LIMIT/);
  }, 90_000);

  it('refuses an amount that states no currency', async () => {
    await expect(evaluateCreditCheck({
      client: kwdLocal.tenant.client, customer: 'C100', creditControlArea: AREA,
      amount: '500', documentDate: '2026-10-10',
    })).rejects.toThrow(/does not state its currency/);
  }, 90_000);

  it('refuses a determination whose document date is missing, because no rate can be selected', async () => {
    await expect(checkSalesDocumentCredit({
      client: kwdLocal.tenant.client, changedBy: ACTOR, salesDocument: 'NO-DATE',
      documentDate: '', customer: 'C100', creditControlArea: AREA,
      orderValue: '500', orderCurrency: 'USD',
    })).rejects.toThrow(/not a calendar date|document date/);
  }, 90_000);

  /**
   * The sales documents ask this exact function, so refusing here is what stops each of them: an order
   * cannot be created, a delivery cannot be built, and therefore no goods issue can stand behind a
   * commitment the engine could not judge. Better a refusal at the first document than a clearance
   * granted on a number in the wrong currency.
   */
  it('refuses the sales determination itself when the rate is missing', async () => {
    await expect(checkSalesDocumentCredit({
      client: kwdLocal.tenant.client, changedBy: ACTOR, salesDocument: 'NO-RATE-1',
      documentDate: '2026-10-10', customer: 'C100', creditControlArea: AREA,
      orderValue: '500', orderCurrency: 'EUR',
    })).rejects.toThrow(/No AVERAGE exchange rate stands from EUR to KWD on or before 2026-10-10/);
    // Nothing was recorded for the refused document: it never entered the blocked worklist.
    const leftovers = await withTenant(kwdLocal.tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as n from credit_determination
       where client = ${kwdLocal.tenant.client} and sales_document = 'NO-RATE-1'`));
    expect((leftovers as unknown as Array<{ n: number }>)[0].n).toBe(0);
  }, 90_000);
});

describe('the exposure unit is verified, not assumed', () => {
  it('reports exposure in the area currency when every company agrees', async () => {
    const exposure = await getCreditExposure(kwdLocal.tenant.client, 'C100', AREA);
    expect(exposure.currency).toBe('KWD');
  }, 90_000);

  it('refuses by name when a company in the area keeps another currency', async () => {
    // An out-of-band assignment: this company keeps its books in EUR inside a KWD area. Exposure
    // would sum EUR local amounts against a KWD limit, so the check must refuse and name it.
    await withTenant(kwdLocal.tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into company_code (client, company_code, name, chart_of_accounts, currency, country, credit_control_area, created_by)
        values (${kwdLocal.tenant.client}, '2000', 'Euro books', 'CA01', 'EUR', 'KW', ${AREA}, ${ACTOR})
        on conflict do nothing`);
    });
    await expect(getCreditExposure(kwdLocal.tenant.client, 'C100', AREA))
      .rejects.toThrow(/keep their books in another currency/);
    await expect(getCreditExposure(kwdLocal.tenant.client, 'C100', AREA))
      .rejects.toThrow(/2000 \(EUR\)/);
    await withTenant(kwdLocal.tenant.client, async (tx) => {
      await tx.execute(sql`delete from company_code where client = ${kwdLocal.tenant.client} and company_code = '2000'`);
    });
  }, 90_000);
});

describe('the monitor renders the order component and names what it excludes', () => {
  it('reports an order exposure figure instead of null', async () => {
    const monitor = await listCreditMonitor(kwdLocal.tenant.client, {});
    const row = monitor.rows.find((r) => r.customer === 'C100');
    expect(row).toBeDefined();
    expect(row!.orderExposure).not.toBeNull();
  }, 90_000);

  it('states how many foreign-currency documents stand outside the basis', async () => {
    const monitor = await listCreditMonitor(kwdLocal.tenant.client, {});
    // A tenant with no foreign open orders says so explicitly rather than leaving it implicit.
    expect(monitor.foreignCommitmentExclusion).toBeDefined();
    expect(monitor.foreignCommitmentExclusion.excluded).toBe(0);
    expect(monitor.foreignCommitmentExclusion.byCurrency).toEqual([]);
  }, 90_000);
});
