import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import type { Page } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { postJournalEntry } from '../../src/platform/posting';
import { createProductionOrder } from '../../src/modules/inventory/production-orders';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };
const ACTOR = 'browser.admin';

export async function productionOrderCostReport(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('DI-012: read posted order-assigned actuals, filter periods, prove the report writes nothing');

  const fixture = await withTenant(client, async (tx) => {
    const [place] = await tx.execute(sql`
      select c.company_code, c.currency
        from company_code c
       where c.client = ${client}
       order by c.company_code
       limit 1
    `) as unknown as Array<{ company_code: string; currency: string }>;
    assert.ok(place, 'the browser tenant must have a standard company code');

    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: place.company_code,
      subObject: 'GENERAL', fiscalYear: 2026, prefix: 'JE', fromNumber: 1,
      toNumber: 999_999, createdBy: ACTOR,
    });
    await defineRange(tx, {
      client, objectCode: 'PRODORDER', subObject: '*', prefix: 'PRD',
      numberLength: 7, createdBy: ACTOR,
    });
    await tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${client}, 'PP01', 'Browser cost report', '10', ${ACTOR})
      on conflict (client, order_type) do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QR01', 'Cost report plant', ${place.company_code}, 'KW', ${ACTOR})
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'CR-FG', 'Cost report finished good', material_type, 'PC', ${ACTOR}
        from material_type where client = ${client} order by material_type limit 1
      on conflict (client, material_number) do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'CR-FG', 'QR01', ${ACTOR})
      on conflict (client, material_number, plant) do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'CR-RM', 'Cost report component', material_type, 'PC', ${ACTOR}
        from material_type where client = ${client} order by material_type limit 1
      on conflict (client, material_number) do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'CR-RM', 'QR01', ${ACTOR})
      on conflict (client, material_number, plant) do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, 'QR01', 'SR01', 'Cost report store', true, false, ${ACTOR})
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    return { companyCode: place.company_code, currency: place.currency.trim() };
  });

  const order = await createProductionOrder({
    client, createdBy: ACTOR, materialNumber: 'CR-FG', plant: 'QR01',
    orderQuantity: 10, scheduledStart: '2026-01-01', scheduledFinish: '2026-01-05',
    components: [{ materialNumber: 'CR-RM', plant: 'QR01', storageLocation: 'SR01', requiredQuantity: 5 }],
    orderType: 'PP01',
  });

  async function post(reference: string, postingDate: string, postingPeriod: number, value: string, secondValue?: string) {
    await withTenant(client, (tx) => postJournalEntry(tx, {
      client, companyCode: fixture.companyCode, documentType: 'SA',
      documentDate: postingDate, postingDate, fiscalYear: 2026, postingPeriod,
      currency: fixture.currency, localCurrency: fixture.currency, reference,
      headerText: 'Browser production-order cost report fixture', postedBy: ACTOR,
      lines: secondValue
        ? [
            { glAccount: '410000', debitCredit: 'S', amount: value, productionOrder: order.orderNumber, lineText: 'Assigned debit' },
            { glAccount: '100000', debitCredit: 'H', amount: value, lineText: 'Offset debit' },
            { glAccount: '410000', debitCredit: 'H', amount: secondValue, productionOrder: order.orderNumber, lineText: 'Assigned credit' },
            { glAccount: '100000', debitCredit: 'S', amount: secondValue, lineText: 'Offset credit' },
          ]
        : [
            { glAccount: '410000', debitCredit: 'S', amount: value, productionOrder: order.orderNumber, lineText: 'Period-two assigned debit' },
            { glAccount: '100000', debitCredit: 'H', amount: value, lineText: 'Period-two offset' },
          ],
    }));
  }

  await post('BROWSER-COST-REPORT-P1', '2026-01-15', 1, '250', '40');
  await post('BROWSER-COST-REPORT-P2', '2026-02-15', 2, '20', '5');

  const before = await withTenant(client, async (tx) => {
    const [counts] = await tx.execute(sql`
      select (select count(*)::int from journal_entry where client = ${client}) as journals,
             (select count(*)::int from journal_entry_line where client = ${client}) as lines,
             (select count(*)::int from production_order where client = ${client}) as orders
    `) as unknown as Array<{ journals: number; lines: number; orders: number }>;
    return counts;
  });

  const reportUrl = new URL(`${base}/production/order-cost-report`);
  reportUrl.searchParams.set('order', order.orderNumber);
  reportUrl.searchParams.set('fiscalYear', '2026');
  reportUrl.searchParams.set('periodFrom', '1');
  reportUrl.searchParams.set('periodTo', '1');
  await page.goto(reportUrl.toString(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Production order cost report', exact: true }).waitFor();
  const report = page.locator(`[data-cost-report-order="${order.orderNumber}"]`);
  await report.waitFor();
  assert.equal(await report.locator('[data-cost-report-line]').count(), 2, 'period one displays its two order-assigned journal lines');
  const totals = await report.locator('[data-cost-report-totals]').innerText();
  assert.match(totals, /250(?:\.0{2,4})?\s+KWD/, 'period one debit total');
  assert.match(totals, /40(?:\.0{2,4})?\s+KWD/, 'period one credit total');
  assert.match(totals, /210(?:\.0{2,4})?\s+KWD/, 'period one net total');
  assert.match(await report.innerText(), /2026-01-15/);
  assert.match(await report.innerText(), /Assigned debit/);
  assert.match(await report.innerText(), /Assigned credit/);

  reportUrl.searchParams.delete('periodFrom');
  reportUrl.searchParams.delete('periodTo');
  await page.goto(reportUrl.toString(), { waitUntil: 'domcontentloaded' });
  const allPeriods = page.locator(`[data-cost-report-order="${order.orderNumber}"]`);
  await allPeriods.waitFor();
  assert.equal(await allPeriods.locator('[data-cost-report-line]').count(), 4, 'both periods display all four assigned journal lines');
  const allTotals = await allPeriods.locator('[data-cost-report-totals]').innerText();
  assert.match(allTotals, /270(?:\.0{2,4})?\s+KWD/, 'all-period debit total includes period two');
  assert.match(allTotals, /45(?:\.0{2,4})?\s+KWD/, 'all-period credit total includes period two');
  assert.match(allTotals, /225(?:\.0{2,4})?\s+KWD/, 'all-period net total includes period two');

  const after = await withTenant(client, async (tx) => {
    const [counts] = await tx.execute(sql`
      select (select count(*)::int from journal_entry where client = ${client}) as journals,
             (select count(*)::int from journal_entry_line where client = ${client}) as lines,
             (select count(*)::int from production_order where client = ${client}) as orders
    `) as unknown as Array<{ journals: number; lines: number; orders: number }>;
    return counts;
  });
  assert.deepEqual(after, before, 'reading the report creates, changes, or reverses no journal or production-order rows');
  console.log(`  ✓ order ${order.orderNumber}: period filter and totals by assigned journal lines; no writes`);
}
