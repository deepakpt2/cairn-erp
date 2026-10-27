import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';
import { chooseClosed } from './closed-fields';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/inventory/reservations';
const MD04 = '/production/stock-requirements';

/**
 * SCR-133 browser acceptance: MB21 create reservation.
 *
 * The fixture gives the browser tenant a plant, a store, a material extended to
 * the plant, a controlling area assignment and a cost centre valid on the
 * required date. The run then does what an owner would: create a reservation on
 * 201 for 25 at a required date, find it as a **requirement** in the
 * stock/requirements list at that date, withdraw 10 and read the 15 that remain
 * as demand, withdraw the rest and read the demand gone.
 */
export async function reservations(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-133: create a reservation, see it demand stock in MD04, withdraw it in part and in full');

  const company = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code from company_code where client = ${client} order by company_code limit 1
    `) as unknown as Array<{ company_code: string }>;
    if (!rows[0]) throw new Error('the browser tenant carries no company code');
    const companyCode = rows[0].company_code;
    const areas = await tx.execute(sql`
      select controlling_area from controlling_area where client = ${client} order by controlling_area limit 1
    `) as unknown as Array<{ controlling_area: string }>;
    if (!areas[0]) throw new Error('the browser tenant carries no controlling area');
    const area = areas[0].controlling_area;

    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, 'QK01', 'Reservation plant', ${companyCode}, 'KW', 'browser.admin')
      on conflict (client, plant) do update set company_code = excluded.company_code
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by)
      values (${client}, 'QK01', 'SK01', 'Reservation store', true, 'browser.admin')
      on conflict (client, plant, storage_location) do update set is_active = true
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MB21-MAT', 'Reserved material', t.material_type, 'PC', 'browser.admin'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MB21-MAT', 'QK01', 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into controlling_area_company (client, controlling_area, company_code, created_by)
      values (${client}, ${area}, ${companyCode}, 'browser.admin') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
      values (${client}, ${area}, 'CC9001', '2026-01-01', '2026-12-31', 'Reservation centre', 'PRODUCTION', ${companyCode}, false, 'browser.admin')
      on conflict do nothing
    `);
    return companyCode;
  });

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Create Reservation', exact: true }).waitFor();

  await page.selectOption('select[name="movementTypeCode"]', '201');
  await page.fill('input[name="baseDate"]', '2026-11-20');
  await page.fill('input[name="costCenter"]', 'CC9001');
  await page.fill('input[name="material-1"]', 'MB21-MAT');
  await chooseClosed(page, 'plant-1', 'QK01');
  await page.fill('input[name="quantity-1"]', '25');
  await chooseClosed(page, 'sloc-1', 'SK01');
  await page.getByRole('button', { name: 'Create reservation', exact: true }).click();

  const status = page.locator('p[role="status"]').first();
  await status.waitFor();
  const created = await status.innerText();
  assert.match(created, /Reservation RSV-\d+ created with 1 item\./, `creation confirmed: ${created}`);
  const number = /RSV-\d+/.exec(created)![0];

  await page.goto(`${base}${ROUTE}?reservation=${encodeURIComponent(number)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('h2#reservation-document').waitFor();
  assert.equal(await page.locator('[data-item="10"]').getAttribute('data-open'), '25.000', 'the item stands open at 25');

  // The open reservation is a requirement at its required date.
  await page.goto(`${base}${MD04}?material=MB21-MAT&plant=QK01`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('tr[data-element="RESERVATION"]').first();
  await row.waitFor();
  assert.equal(await row.getAttribute('data-date'), '2026-11-20', 'the requirement is dated at the required date');
  assert.equal((await row.innerText()).includes('25.000'), true, 'MD04 demands the full 25');

  // Withdraw 10; the remainder stays a demand.
  await page.goto(`${base}${ROUTE}?reservation=${encodeURIComponent(number)}`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[aria-label="Withdraw 10"]', '10');
  await page.getByRole('button', { name: 'Withdraw', exact: true }).first().click();
  await page.locator('p[role="status"]').filter({ hasText: 'Withdrawal recorded on item 10' }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('[data-item="10"]').getAttribute('data-open'), '15.000', '15 remains open');

  await page.goto(`${base}${MD04}?material=MB21-MAT&plant=QK01`, { waitUntil: 'domcontentloaded' });
  const partial = page.locator('tr[data-element="RESERVATION"]').first();
  await partial.waitFor();
  assert.equal((await partial.innerText()).includes('15.000'), true, 'MD04 demands the 15 that remain');

  // Withdraw the rest; the demand is gone.
  await page.goto(`${base}${ROUTE}?reservation=${encodeURIComponent(number)}`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[aria-label="Withdraw 10"]', '15');
  await page.getByRole('button', { name: 'Withdraw', exact: true }).first().click();
  await page.locator('p[role="status"]').filter({ hasText: 'Withdrawal recorded on item 10' }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('[data-item="10"]').getAttribute('data-completed'), 'true', 'the item completes at full withdrawal');
  assert.equal(await page.locator('input[aria-label="Withdraw 10"]').count(), 0, 'a completed item offers no further withdrawal');

  await page.goto(`${base}${MD04}?material=MB21-MAT&plant=QK01`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('tr[data-element="RESERVATION"]').count(), 0, 'the completed reservation demands nothing');

  // A 261 has no order master and must refuse by name.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.selectOption('select[name="movementTypeCode"]', '261');
  await page.fill('input[name="baseDate"]', '2026-11-20');
  await page.fill('input[name="material-1"]', 'MB21-MAT');
  await chooseClosed(page, 'plant-1', 'QK01');
  await page.fill('input[name="quantity-1"]', '5');
  await page.getByRole('button', { name: 'Create reservation', exact: true }).click();
  await page.locator('p[role="status"]').filter({ hasText: 'carries no order master' }).waitFor();

  console.log(`SCR-133: ${number} demanded 25, then 15, then nothing; the 261 refused by name (company code ${company})`);
}
