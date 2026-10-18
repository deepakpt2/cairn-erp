import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/industries';
const ACTIVITY = 'CFG.ORG.INDUSTRY.DEFINE';
const REASON = 'Browser acceptance run';

/**
 * SCR-077 / OB44 browser acceptance: industries.
 *
 * The journey: the delivered industries stand on the new master screen,
 * an industry is created and its description changed through it, and
 * the industry a partner carries refuses deletion — asserted in the
 * browser and in the database.
 */
export async function industriesOb44(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-077 OB44: verify the delivered industries, industry maintenance, and the deletion refusal');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
  });

  // ── 1. The delivered industries stand ────────────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Maintain Industries', exact: true }).waitFor();
  const section = page.locator('section[aria-labelledby="industries-grid"]');
  for (const [code, name] of [
    ['MEC1', 'Mechanical Eng.'],
    ['CHEM', 'Chemical'],
    ['CONS', 'Construction'],
  ] as const) {
    const row = section.locator('tr').filter({
      has: page.getByRole('cell', { name: code, exact: true }),
    });
    await row.getByRole('cell', { name, exact: true }).waitFor();
  }
  console.log('  ✓ the delivered industries stand on the master');

  // ── 2. An industry is created and its description changed ────────────────
  await page.locator('#ind-key').fill('AGRI');
  await page.locator('#ind-desc').fill('Agriculture');
  await page.locator('#ind-reason').fill(REASON);
  await page.getByRole('button', { name: 'Create industry', exact: true }).click();
  await page.getByText('Industry AGRI saved.').waitFor();
  const agriRow = section.locator('tr').filter({
    has: page.getByRole('cell', { name: 'AGRI', exact: true }),
  });
  await agriRow.getByRole('button', { name: 'Change', exact: true }).click();
  await page.locator('#ind-desc').fill('Agriculture & food');
  await page.locator('#ind-reason').fill(REASON);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Industry AGRI saved.').waitFor();
  await agriRow.getByRole('cell', { name: 'Agriculture & food', exact: true }).waitFor();
  console.log('  ✓ the industry is created and its description changed through the screen');

  // ── 3. The industry a partner carries refuses deletion ───────────────────
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, industry, created_by)
      values (${client}, 'P90000', 'ORGANIZATION', 'Browser Farm Partner', 'AGRI', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await agriRow.getByRole('cell', { name: '1', exact: true }).waitFor();
  await agriRow.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('#dlg-industry-delete-reason').fill(REASON);
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.getByText(/cannot be deleted: 1 business partner carries it/).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  console.log('  ✓ the carried industry refuses deletion');

  // ── 4. The database remembers it all ─────────────────────────────────────
  const evidence = await withTenant(client, async (tx) => {
    const text = await tx.execute(sql`
      select description from industry_text
      where client = ${client} and industry_code = 'AGRI' and language_code = 'en'
    `);
    const partner = await tx.execute(sql`
      select industry from business_partner where client = ${client} and partner_number = 'P90000'
    `);
    return {
      text: (text as unknown as Array<{ description: string }>)[0],
      partner: (partner as unknown as Array<{ industry: string }>)[0],
    };
  });
  assert.equal(evidence.text.description, 'Agriculture & food');
  assert.equal(evidence.partner.industry, 'AGRI');
  console.log('  ✓ the database remembers the industry, its description and the partner carrying it');
}
