/** Independently runnable browser cases. Business records are created only through UI. */
import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { hashPassword } from '../../src/platform/auth/password';
import { withTenant } from '../../src/platform/db/client';
import { getMaterialDetail } from '../../src/modules/inventory/materials';
import { FIXTURE_NAME, type BrowserTargetId, type BrowserTarget } from './targets';

const PASSWORD = 'browser-check-2026';
const year = new Date().getUTCFullYear();
export type BrowserContext = { page: Page; base: string; target: BrowserTarget };
function scope(ctx: BrowserContext) { return { page: ctx.page, BASE: ctx.base, CLIENT: ctx.target.client }; }

export async function onboard(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const NAME = FIXTURE_NAME;
  console.log('Browser: create tenant through onboarding');
  await page.goto(`${BASE}/clients/new`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="clientKey"]').fill(CLIENT);
  await page.locator('[name="name"]').fill(NAME);
  await page.locator('[name="companyName"]').fill('Browser verification company');
  await page.locator('[name="currency"]').fill('KWD');
  await page.locator('[name="username"]').fill('browser.admin');
  await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create tenant', exact: true }).click();
  await page.waitForURL(/\/signin\?/);
  await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/config$/);
  assert.equal((await withTenant(CLIENT, (tx) => tx.execute(sql`select count(*)::int as n from number_range where object_code = 'JOURNAL_ENTRY'`)) as unknown as Array<{ n: number }>)[0].n, 0);
  console.log('  ✓ UI-created tenant has no hidden accounting intervals');
}

async function foundation(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  await page.goto(`${BASE}/config/number-ranges?new=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="reason"]').fill('Browser implementation verification');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Interval saved and change evidence recorded.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Return to monitor', exact: true }).click();
  await page.getByText('Accounting numbering is ready', { exact: true }).waitFor();
  console.log('  ✓ range saved through its actual server action');
  await page.goto(`${BASE}/config`, { waitUntil: 'domcontentloaded' });
  assert.match(await page.locator('tr').filter({ hasText: 'CFG.PLT.NUMBERRANGE.DEFINE' }).innerText(), /Completed/i);
  console.log('  ✓ define/assign checklist reflects completed configuration');

  await page.goto(`${BASE}/finance/journal/new`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('[name="currency"]').inputValue(), 'KWD');
  await page.locator('[name="postingDate"]').fill(`${year}-04-15`);
  await page.locator('[name="reference"]').fill('BROWSER-001');
  await page.locator('[name="headerText"]').fill('Browser acceptance entry');
  for (const [name, value] of Object.entries({ line_0_account: '100000', line_0_amount: '100', line_1_account: '200000', line_1_amount: '100' })) {
    await page.locator(`[name="${name}"]`).fill(value);
  }
  // Deliberately forge the old tenant input. The session must remain authoritative.
  await page.locator('form').filter({ has: page.locator('[name="postingDate"]') }).evaluate((form) => {
    const input = document.createElement('input'); input.type = 'hidden'; input.name = 'client'; input.value = '0100'; form.appendChild(input);
  });
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText(/Document JE-\d{4}-000001 posted/).waitFor();
  const rows = (await withTenant(CLIENT, (tx) => tx.execute(sql`select document_number, created_by, local_currency from journal_entry where reference = 'BROWSER-001'`))) as unknown as Array<{ document_number: string; created_by: string; local_currency: string }>;
  assert.equal(rows.length, 1); assert.equal(rows[0].created_by, 'browser.admin'); assert.equal(rows[0].local_currency, 'KWD');
  console.log('  ✓ journal posts under the real user and currency, ignoring the forged tenant');

  await page.locator('[name="line_1_amount"]').fill('90');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText(/difference 10\.0000/).waitFor();
  const counter = (await withTenant(CLIENT, (tx) => tx.execute(sql`select current_number from number_range where object_code = 'JOURNAL_ENTRY'`))) as unknown as Array<{ current_number: string }>;
  assert.equal(counter[0].current_number, '1');
  console.log('  ✓ an unbalanced UI posting consumes no number');

  await page.goto(`${BASE}/finance/journal?document=${encodeURIComponent(rows[0].document_number)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: new RegExp(`Document detail.*JE-${year}-000001`) }).waitFor();
  await page.getByText('Browser acceptance entry', { exact: true }).waitFor();
  console.log('  ✓ document list and scoped detail render the posted entry');

  await page.goto(`${BASE}/config/number-ranges?history=${encodeURIComponent('JOURNAL_ENTRY/1000/GENERAL/0')}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Browser implementation verification', { exact: true }).waitFor();
  await page.getByRole('link', { name: rows[0].document_number, exact: true }).waitFor();
  console.log('  ✓ change history and number-allocation evidence drill into the document');
  await mkdir('.arena', { recursive: true });
  await page.screenshot({ path: '.arena/number-ranges-review.png', fullPage: true });
}

async function basic(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  await page.goto(`${BASE}/inventory/materials?new=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="materialNumber"]').fill('RAW-BROWSER');
  await page.locator('input[name="description"]').fill('Browser raw material');
  await page.locator('[name="materialGroup"]').selectOption('RAW');
  await page.locator('[name="baseUnit"]').selectOption('KG');
  await page.locator('[name="reason"]').fill('Browser basic creation');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Created.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open material and its views', exact: true }).click();
  await page.locator('input[name="materialNumber"][readonly]').waitFor();
  console.log('  ✓ basic material created without direct database setup');
  const master = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(master?.base.createdBy, 'browser.admin');
  assert.equal(master?.base.basicStatus, 'CREATED');
  assert.equal(master?.base.baseUnit, 'KG');
  assert.equal(master?.plants.length, 0, 'Basic case must not create plant views');
  assert.equal(master?.valuations.length, 0, 'Basic case must not create valuation');
}


/** Basic-only lifecycle. Other material targets keep the short create prerequisite. */
async function basicLifecycle(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  await basic(ctx);
  await page.goto(`${BASE}/inventory/materials?new=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="materialNumber"]').fill('RAW-STAGED');
  await page.locator('[name="materialGroup"]').selectOption('RAW');
  await page.locator('input[name="description"]').fill('');
  await page.locator('[name="baseUnit"]').selectOption('');
  await page.locator('[name="reason"]').fill('Browser incomplete basic creation');
  await page.locator('form').filter({ has: page.locator('[name="expectedVersion"]') }).evaluate((form) => {
    for (const [name, value] of [['client', '0100'], ['changedBy', 'FORGED']]) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.appendChild(input);
    }
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Incomplete.', { exact: true }).waitFor();
  const incomplete = await getMaterialDetail(CLIENT, 'RAW-STAGED');
  assert.equal(incomplete?.base.basicStatus, 'INCOMPLETE');
  assert.equal(incomplete?.base.baseUnit, null);
  assert.equal(incomplete?.base.createdBy, 'browser.admin');
  await page.getByRole('link', { name: 'Open material and its views', exact: true }).click();
  await page.locator('input[name="materialNumber"][readonly]').waitFor();
  console.log('  ✓ incomplete basic data saves under the session tenant/actor');

  await page.locator('input[name="description"]').fill('Completed staged material');
  await page.locator('[name="baseUnit"]').selectOption('KG');
  await page.locator('[name="reason"]').fill('Browser staged completion');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Created.', { exact: true }).waitFor();
  assert.equal((await getMaterialDetail(CLIENT, 'RAW-STAGED'))?.base.version, 2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('No data changed. Status: Created.', { exact: true }).waitFor();
  assert.equal((await getMaterialDetail(CLIENT, 'RAW-STAGED'))?.base.version, 2);
  console.log('  ✓ completion promotes the status; unchanged resave preserves its version');

  await page.locator('[name="grossWeight"]').fill('3.500');
  await page.locator('[name="netWeight"]').fill('3.250');
  await page.locator('[name="weightUnit"]').selectOption('KG');
  await page.locator('[name="reason"]').fill('Browser basic weight maintenance');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Maintained.', { exact: true }).waitFor();
  const maintained = await getMaterialDetail(CLIENT, 'RAW-STAGED');
  assert.equal(maintained?.base.version, 3);
  assert.equal(maintained?.base.grossWeight, '3.500');
  assert.equal(maintained?.base.netWeight, '3.250');
  assert.equal(maintained?.plants.length, 0);
  assert.equal(maintained?.valuations.length, 0);
  await page.getByRole('link', { name: 'Change history', exact: true }).click();
  await page.getByText('Browser staged completion', { exact: true }).waitFor();
  await page.getByText('Browser basic weight maintenance', { exact: true }).waitFor();
  assert.match(await page.locator('footer').innerText(), new RegExp(`${CLIENT}.*browser.admin`));
  await page.screenshot({ path: '.arena/material-basic-history-review.png', fullPage: true });
  console.log('  ✓ exact weights, change history and session-derived footer are visible');

  await page.goto(`${BASE}/inventory/materials`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="q"]').fill('RAW-STAGED');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('link', { name: 'RAW-STAGED', exact: true }).waitFor();
  await page.locator('tbody tr').filter({ hasText: 'RAW-STAGED' }).getByRole('link', { name: 'Copy basic data', exact: true }).click();
  await page.locator('input[name="materialNumber"]:not([readonly])').waitFor();
  assert.equal(await page.locator('[name="materialNumber"]').inputValue(), '');
  assert.equal(await page.locator('[name="grossWeight"]').inputValue(), '3.500');
  await page.locator('[name="materialNumber"]').fill('RAW-STAGED-COPY');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Created.', { exact: true }).waitFor();
  const copy = await getMaterialDetail(CLIENT, 'RAW-STAGED-COPY');
  assert.equal(copy?.base.description, 'Completed staged material');
  assert.equal(copy?.base.grossWeight, '3.500');
  assert.equal(copy?.plants.length, 0);
  assert.equal(copy?.valuations.length, 0);
  await page.getByRole('link', { name: 'Open material and its views', exact: true }).click();
  console.log('  ✓ search and basic-only copy do not fabricate organisational views');
}

async function purchasing(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  await basic(ctx);
  await page.getByRole('link', { name: /^Purchasing/ }).click();
  await page.locator('[name="orderUnit"]').waitFor();
  assert.equal(await page.locator('[name="orderUnit"]').inputValue(), 'KG');
  await page.locator('[name="purchasingGroup"]').selectOption('');
  await page.locator('[name="reason"]').fill('Browser staged purchasing creation');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Incomplete.', { exact: true }).waitFor();
  const staged = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(staged?.plants[0].purchasingStatus, 'INCOMPLETE');
  assert.equal(staged?.plants[0].version, 1);
  console.log('  ✓ purchasing stages an incomplete view under plant 1000');

  await page.locator('[name="purchasingGroup"]').selectOption('001');
  await page.locator('[name="orderUnit"]').selectOption('KG');
  await page.locator('[name="overdeliveryTolerance"]').fill('5.25');
  await page.locator('[name="underdeliveryTolerance"]').fill('1.75');
  await page.locator('[name="manufacturerPartNumber"]').fill('MFG-PURCH-001');
  await page.locator('[name="reason"]').fill('Browser purchasing completion');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Created.', { exact: true }).waitFor();
  const completed = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(completed?.plants[0].version, 2);
  assert.equal(completed?.plants[0].purchasingGroup, '001');
  assert.equal(completed?.plants[0].overdeliveryTolerance, '5.25');
  assert.equal(completed?.plants[0].underdeliveryTolerance, '1.75');
  assert.equal(completed?.plants[0].manufacturerPartNumber, 'MFG-PURCH-001');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('No data changed. Status: Created.', { exact: true }).waitFor();
  assert.equal((await getMaterialDetail(CLIENT, 'RAW-BROWSER'))?.plants[0].version, 2);
  console.log('  ✓ completion stores exact tolerances; unchanged resave preserves values/version');

  await page.locator('[name="purchasingGroup"]').selectOption('002');
  await page.locator('[name="manufacturerPartNumber"]').fill('MFG-PURCH-002');
  await page.locator('[name="reason"]').fill('Browser purchasing maintenance');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Maintained.', { exact: true }).waitFor();
  await page.locator('[name="orderUnit"]').selectOption('LB');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('A different order unit requires a material-specific conversion.', { exact: true }).waitFor();
  const maintained = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(maintained?.base.version, 1, 'Plant editing must not alter global basic data');
  assert.equal(maintained?.plants[0].version, 3);
  assert.equal(maintained?.plants[0].orderUnit, 'KG');
  assert.equal(maintained?.plants[0].purchasingStatus, 'MAINTAINED');
  assert.equal(maintained?.plants[0].mrpStatus, 'NOT_CREATED');
  assert.equal(maintained?.valuations.length, 0);
  console.log('  ✓ unsupported alternative unit is refused without changing data/version');

  await page.getByRole('link', { name: 'Change history', exact: true }).click();
  await page.getByText('Browser purchasing completion', { exact: true }).waitFor();
  await page.getByText('Browser purchasing maintenance', { exact: true }).waitFor();
  assert.match(await page.locator('footer').innerText(), new RegExp(`${CLIENT}.*browser.admin`));
  await page.screenshot({ path: '.arena/material-purchasing-history-review.png', fullPage: true });
  console.log('  ✓ purchasing change history and correct session footer are visible');

  // Authorisation identity fixture only; every material record above was UI-created.
  const userId = randomUUID();
  const password = await hashPassword(PASSWORD);
  await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into app_user (id, client, username, full_name, password_hash, must_change_password, created_by) values (${userId}, ${CLIENT}, 'warehouse.viewer', 'Warehouse Viewer', ${password}, false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by) values (${CLIENT}, ${userId}, 'WAREHOUSE_CLERK', 'BROWSER_FIXTURE')`);
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="client"]').fill(CLIENT);
  await page.locator('[name="username"]').fill('warehouse.viewer');
  await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/$/);
  await page.goto(`${BASE}/inventory/materials?material=RAW-BROWSER&plant=1000&view=PURCHASING`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/PROC.MATERIAL.PURCHASING.MAINTAIN/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  console.log('  ✓ warehouse-only authority can read, but has no purchasing save form');
}

async function mrp(ctx: BrowserContext) {
  const { page, CLIENT } = scope(ctx);
  await basic(ctx);
  await page.getByRole('link', { name: /^MRP/ }).click();
  await page.locator('[name="lotSizing"]').selectOption('FIXED');
  await page.locator('[name="fixedLotSize"]').fill('100');
  await page.locator('[name="safetyStock"]').fill('12.375');
  await page.locator('[name="plannedDeliveryDays"]').fill('7');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Created.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open material and its views', exact: true }).click();
  console.log('  ✓ planning view saved with exact quantities and a net-change flag');
  const master = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(master?.plants[0].mrpStatus, 'CREATED');
  assert.equal(master?.plants[0].safetyStock, '12.375');
  assert.equal(master?.plants[0].fixedLotSize, '100.000');
  assert.equal(master?.plants[0].purchasingStatus, 'NOT_CREATED');
  const flags = await withTenant(CLIENT, (tx) => tx.execute(sql`select net_change from planning_file where material_number = 'RAW-BROWSER' and plant = '1000'`));
  assert.equal((flags as unknown as Array<{ net_change: boolean }>)[0].net_change, true);
  assert.equal(master?.valuations.length, 0);
}

async function valuation(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  await basic(ctx);
  await page.getByRole('link', { name: /^Accounting/ }).click();
  await page.locator('[name="valuationClass"]').selectOption('RAW_INVENTORY');
  await page.locator('[name="movingAveragePrice"]').fill('12.3456');
  await page.locator('[name="priceUnit"]').fill('10');
  await page.locator('[name="reason"]').fill('Browser valuation parameters');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Created.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open material and its views', exact: true }).click();
  const master = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(master?.base.createdBy, 'browser.admin');
  assert.equal(master?.valuations[0].currency, 'KWD');
  assert.equal(master?.valuations[0].movingAveragePrice, '12.3456');
  assert.equal(master?.valuations[0].priceUnit, '10.000');
  assert.equal(master?.valuations[0].stockValue, '0.0000');
  console.log('  ✓ valuation derives KWD and never fabricates stock or inventory value');
  await page.getByRole('link', { name: 'Change history', exact: true }).click();
  await page.getByText('Browser valuation parameters', { exact: true }).waitFor();
  await page.screenshot({ path: '.arena/material-valuation-history-review.png', fullPage: true });
  console.log('  ✓ material change evidence is visible in the application');
  // Only this authorisation fixture is seeded: the user-admin screen is pending.
  // Every tenant/master/business document above was still created through UI.
  const warehouseId = randomUUID();
  await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into app_user (id, client, username, full_name, password_hash, must_change_password, created_by) values (${warehouseId}, ${CLIENT}, 'warehouse.viewer', 'Warehouse Viewer', ${await hashPassword(PASSWORD)}, false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by) values (${CLIENT}, ${warehouseId}, 'WAREHOUSE_CLERK', 'BROWSER_FIXTURE')`);
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="client"]').fill(CLIENT);
  await page.locator('[name="username"]').fill('warehouse.viewer');
  await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/$/);
  await page.goto(`${BASE}/inventory/materials?material=RAW-BROWSER&view=ACCOUNTING&history=1`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/This screen requires authority FIN.MATERIAL.VALUATION.DISPLAY/).waitFor();
  assert.equal((await page.content()).includes('12.3456'), false, 'Valuation and price history must not leak in rendered or serialised content');
  console.log('  ✓ warehouse authority cannot read valuation prices or their change history');
}

export const CHECKS: Record<BrowserTargetId, (ctx: BrowserContext) => Promise<void>> = {
  foundation,
  'material-basic': basicLifecycle,
  'material-purchasing': purchasing,
  'material-mrp': mrp,
  'material-valuation': valuation,
};
