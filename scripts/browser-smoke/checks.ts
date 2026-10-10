/** Independently runnable browser cases. Business records are created only through UI. */
import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { hashPassword } from '../../src/platform/auth/password';
import { withTenant } from '../../src/platform/db/client';
import { getMaterialDetail } from '../../src/modules/inventory/materials';
import { getPaymentTerms } from '../../src/modules/foundation/payment-terms';
import { getBusinessPartner } from '../../src/modules/foundation/business-partners';
import { getSupplierCompany } from '../../src/modules/foundation/supplier-companies';
import { getSupplierPurchasing } from '../../src/modules/foundation/supplier-purchasing';
import { getCustomerCompany } from '../../src/modules/foundation/customer-companies';
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
  const { page, BASE, CLIENT } = scope(ctx);
  await basic(ctx);
  await page.getByRole('link', { name: /^MRP/ }).click();
  await page.locator('[name="mrpController"]').waitFor();
  await page.locator('[name="mrpController"]').selectOption('');
  await page.locator('[name="reason"]').fill('Browser incomplete planning setup');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Incomplete.', { exact: true }).waitFor();
  const staged = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(staged?.plants[0].mrpController, null);
  assert.equal(staged?.plants[0].mrpStatus, 'INCOMPLETE');
  assert.equal(staged?.plants[0].version, 1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('No data changed. Status: Incomplete.', { exact: true }).waitFor();
  assert.equal((await getMaterialDetail(CLIENT, 'RAW-BROWSER'))?.plants[0].version, 1);
  console.log('  ✓ missing controller stages correctly; untouched resave cannot auto-complete it');

  await page.locator('[name="mrpController"]').selectOption('001');
  await page.locator('[name="lotSizing"]').selectOption('FIXED');
  await page.locator('[name="fixedLotSize"]').fill('100');
  await page.locator('[name="minimumLotSize"]').fill('10');
  await page.locator('[name="maximumLotSize"]').fill('200');
  await page.locator('[name="safetyStock"]').fill('12.375');
  await page.locator('[name="plannedDeliveryDays"]').fill('7');
  await page.locator('[name="reason"]').fill('Browser planning completion');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Created.', { exact: true }).waitFor();
  const completed = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(completed?.plants[0].version, 2);
  assert.equal(completed?.plants[0].safetyStock, '12.375');
  assert.equal(completed?.plants[0].fixedLotSize, '100.000');
  assert.equal(completed?.plants[0].plannedDeliveryDays, 7);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('No data changed. Status: Created.', { exact: true }).waitFor();
  assert.equal((await getMaterialDetail(CLIENT, 'RAW-BROWSER'))?.plants[0].version, 2);
  console.log('  ✓ fixed-lot sizing/exact safety stock complete and preserve the committed view');

  // Isolated fixture only: simulate a previously consumed planning-file flag.
  await withTenant(CLIENT, (tx) => tx.execute(sql`update planning_file set net_change = false where material_number = 'RAW-BROWSER' and plant = '1000'`));
  await page.locator('[name="mrpType"]').selectOption('REORDER');
  await page.locator('[name="reorderPoint"]').fill('25.500');
  await page.locator('[name="safetyStock"]').fill('13.125');
  await page.locator('[name="reason"]').fill('Browser planning maintenance');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Maintained.', { exact: true }).waitFor();
  const flags = await withTenant(CLIENT, (tx) => tx.execute(sql`select net_change, last_changed_by from planning_file where material_number = 'RAW-BROWSER' and plant = '1000'`));
  assert.equal((flags as unknown as Array<{ net_change: boolean }>)[0].net_change, true);
  assert.equal((flags as unknown as Array<{ last_changed_by: string }>)[0].last_changed_by, 'browser.admin');
  await page.locator('[name="maximumLotSize"]').fill('5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Maximum lot size must not be below minimum lot size.', { exact: true }).waitFor();
  const maintained = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(maintained?.plants[0].version, 3);
  assert.equal(maintained?.plants[0].maximumLotSize, '200.000');
  assert.equal(maintained?.plants[0].reorderPoint, '25.500');
  assert.equal(maintained?.plants[0].safetyStock, '13.125');
  assert.equal(maintained?.plants[0].mrpStatus, 'MAINTAINED');
  assert.equal(maintained?.plants[0].purchasingStatus, 'NOT_CREATED');
  assert.equal(maintained?.base.version, 1);
  assert.equal(maintained?.valuations.length, 0);
  console.log('  ✓ reorder changes reflag net-change; invalid lot bounds cannot mutate the record');

  await page.getByRole('link', { name: 'Change history', exact: true }).click();
  await page.getByText('Browser planning completion', { exact: true }).waitFor();
  await page.getByText('Browser planning maintenance', { exact: true }).waitFor();
  assert.match(await page.locator('footer').innerText(), new RegExp(`${CLIENT}.*browser.admin`));
  await page.screenshot({ path: '.arena/material-mrp-history-review.png', fullPage: true });
  console.log('  ✓ plant-level planning history and signed-in footer are visible');

  // Authorisation identity fixture only; no live tenant/user data is modified.
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
  await page.goto(`${BASE}/inventory/materials?material=RAW-BROWSER&plant=1000&view=MRP`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/PROD.MATERIAL.MRP.MAINTAIN/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  console.log('  ✓ warehouse authority cannot edit production-planning fields');
}

async function valuation(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  await basic(ctx);
  await page.getByRole('link', { name: /^Accounting/ }).click();
  await page.locator('[name="valuationClass"]').waitFor();
  assert.equal(await page.locator('[name="priceControl"]').inputValue(), 'MOVING_AVERAGE');
  for (const key of ['currency', 'totalStockQuantity', 'stockValue']) assert.equal(await page.locator(`input[name="${key}"]`).count(), 0);
  const form = page.locator('form').filter({ has: page.locator('[name="expectedVersion"]') });
  await form.evaluate((element) => {
    for (const [name, value] of [['currency','USD'], ['totalStockQuantity','999'], ['stockValue','999999']]) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; element.appendChild(input);
    }
  });
  await page.locator('[name="reason"]').fill('Browser incomplete valuation setup');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Incomplete.', { exact: true }).waitFor();
  const staged = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(staged?.valuations[0].currency, 'KWD');
  assert.equal(staged?.valuations[0].totalStockQuantity, '0.000');
  assert.equal(staged?.valuations[0].stockValue, '0.0000');
  assert.equal(staged?.valuations[0].valuationClass, null);
  assert.equal(staged?.valuations[0].version, 1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('No data changed. Status: Incomplete.', { exact: true }).waitFor();
  assert.equal((await getMaterialDetail(CLIENT, 'RAW-BROWSER'))?.valuations[0].version, 1);
  console.log('  ✓ incomplete valuation preserves unset class; forged currency/stock values are ignored');

  await page.locator('[name="valuationClass"]').selectOption('RAW_INVENTORY');
  await page.locator('[name="movingAveragePrice"]').fill('12.3456');
  await page.locator('[name="priceUnit"]').fill('10');
  await page.locator('[name="reason"]').fill('Browser valuation completion');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Created.', { exact: true }).waitFor();
  const completed = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(completed?.valuations[0].version, 2);
  assert.equal(completed?.valuations[0].movingAveragePrice, '12.3456');
  assert.equal(completed?.valuations[0].priceUnit, '10.000');
  assert.equal(completed?.valuations[0].currency, 'KWD');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('No data changed. Status: Created.', { exact: true }).waitFor();
  assert.equal((await getMaterialDetail(CLIENT, 'RAW-BROWSER'))?.valuations[0].version, 2);
  console.log('  ✓ exact moving-average price/unit complete and survive an unchanged resave');

  await page.locator('[name="priceControl"]').selectOption('STANDARD');
  await page.locator('[name="standardPrice"]').fill('25.6789');
  await page.locator('[name="reason"]').fill('Browser valuation maintenance');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('View saved. Status: Maintained.', { exact: true }).waitFor();
  await page.locator('[name="priceUnit"]').fill('0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('priceUnit: Price unit must be positive.', { exact: true }).waitFor();
  assert.equal((await getMaterialDetail(CLIENT, 'RAW-BROWSER'))?.valuations[0].version, 3);

  // Isolated guard fixture only: represent existing book stock; this is not a goods posting.
  await withTenant(CLIENT, (tx) => tx.execute(sql`update material_valuation set total_stock_quantity = '10.000', stock_value = '25.6789' where material_number = 'RAW-BROWSER' and valuation_area = '1000'`));
  await page.locator('[name="standardPrice"]').fill('30.0000');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Valuation settings cannot be changed here while stock exists.', { exact: true }).waitFor();
  const preserved = await getMaterialDetail(CLIENT, 'RAW-BROWSER');
  assert.equal(preserved?.valuations[0].version, 3);
  assert.equal(preserved?.valuations[0].standardPrice, '25.6789');
  assert.equal(preserved?.valuations[0].totalStockQuantity, '10.000');
  assert.equal(preserved?.valuations[0].stockValue, '25.6789');
  assert.equal(preserved?.base.version, 1);
  assert.equal(preserved?.plants.length, 0);
  console.log('  ✓ positive price unit enforced; stock-bearing price change refused without altering book value');

  await page.getByRole('link', { name: 'Change history', exact: true }).click();
  await page.getByText('Browser valuation completion', { exact: true }).waitFor();
  await page.getByText('Browser valuation maintenance', { exact: true }).waitFor();
  assert.match(await page.locator('footer').innerText(), new RegExp(`${CLIENT}.*browser.admin`));
  await page.screenshot({ path: '.arena/material-valuation-history-review.png', fullPage: true });
  console.log('  ✓ valuation/control-change evidence and session-derived footer are visible');

  // Authorization identities only: the user-admin UI is not built yet.
  const warehouseId = randomUUID(); const reviewerId = randomUUID();
  const password = await hashPassword(PASSWORD);
  await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by) values (${CLIENT}, 'PRICE_REVIEWER', 'Price reviewer', true, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code) values (${CLIENT}, 'PRICE_REVIEWER', 'FIN.MATERIAL.VALUATION.DISPLAY')`);
    for (const [id, username, roleCode] of [[warehouseId,'warehouse.viewer','WAREHOUSE_CLERK'],[reviewerId,'finance.viewer','PRICE_REVIEWER']]) {
      await tx.execute(sql`insert into app_user (id, client, username, full_name, password_hash, must_change_password, created_by) values (${id}, ${CLIENT}, ${username}, ${username}, ${password}, false, 'BROWSER_FIXTURE')`);
      await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by) values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')`);
    }
  });
  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/$/);
    await page.goto(`${BASE}/inventory/materials?material=RAW-BROWSER&plant=1000&view=ACCOUNTING&history=1`, { waitUntil: 'domcontentloaded' });
  }
  await signInAs('finance.viewer');
  await page.getByText(/FIN.MATERIAL.VALUATION.MAINTAIN/).waitFor();
  await page.getByText('Browser valuation maintenance', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  assert.match(await page.locator('body').innerText(), /25\.6789/);
  console.log('  ✓ finance display authority can review valuation/history but cannot maintain');

  await signInAs('warehouse.viewer');
  await page.getByText(/This screen requires authority FIN.MATERIAL.VALUATION.DISPLAY/).waitFor();
  const html = await page.content();
  for (const price of ['12.3456','25.6789']) assert.equal(html.includes(price), false, 'Financial values must not leak in rendered or serialized content');
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  console.log('  ✓ warehouse authority cannot read valuation prices or their history');
}

async function paymentTerms(ctx: BrowserContext) {
  const {page,BASE,CLIENT}=scope(ctx);
  await page.goto(`${BASE}/config/payment-terms?new=1`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="termsCode"]').fill('TESTPAY');
  await page.locator('input[name="description"]').fill('Test 2 percent 10, 1 percent 20, net 30');
  await page.locator('[name="discount1Days"]').fill('10');
  await page.locator('[name="discount1Percent"]').fill('2.00');
  await page.locator('[name="discount2Days"]').fill('20');
  await page.locator('[name="discount2Percent"]').fill('1.00');
  await page.locator('[name="reason"]').fill('Browser payment term creation');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Payment terms saved and change evidence recorded.',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Open saved payment terms',exact:true}).click();
  await page.locator('input[name="termsCode"][readonly]').waitFor();
  const term=await getPaymentTerms(CLIENT,'TESTPAY');
  assert.equal(term?.createdBy,'browser.admin');assert.equal(term?.discount1Percent,'2.00');
  await page.locator('[name="baseline"]').fill('2026-10-10');
  await page.getByRole('button',{name:'Preview dates',exact:true}).click();
  await page.getByText('2026-11-09',{exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/2026-10-20.*2.00%/);
  assert.match(await page.locator('body').innerText(),/2026-10-30.*1.00%/);
  console.log('  ✓ payment terms create with exact discounts and expected due-date preview');
  await page.locator('[name="reason"]').fill('Browser unchanged resave');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No payment-term data changed.',{exact:true}).waitFor();
  assert.equal((await getPaymentTerms(CLIENT,'TESTPAY'))?.version,1);
  await page.locator('[name="netDays"]').fill('5');
  await page.locator('[name="reason"]').fill('Invalid payment window');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('First discount deadline must not exceed net days.',{exact:true}).waitFor();
  assert.equal((await getPaymentTerms(CLIENT,'TESTPAY'))?.netDays,30);
  await page.locator('[name="netDays"]').fill('45');
  await page.locator('[name="reason"]').fill('Browser payment term maintenance');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Payment terms saved and change evidence recorded.',{exact:true}).waitFor();
  assert.equal((await getPaymentTerms(CLIENT,'TESTPAY'))?.version,2);
  await page.getByRole('link',{name:'Change history',exact:true}).click();
  await page.getByText('Browser payment term maintenance',{exact:true}).waitFor();
  await page.getByText('Browser payment term creation',{exact:true}).waitFor();
  await page.screenshot({path:'.arena/payment-terms-history-review.png',fullPage:true});
  console.log('  ✓ no-op/version preservation, invalid windows and audit history verified');
  await page.goto(`${BASE}/config`,{waitUntil:'domcontentloaded'});
  assert.match(await page.locator('tr').filter({hasText:'CFG.FIN.PAYTERMS.DEFINE'}).innerText(),/Completed/i);
  await page.goto(`${BASE}/config/payment-terms`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="q"]').fill('TESTPAY');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByRole('link',{name:'TESTPAY',exact:true}).waitFor();
  console.log('  ✓ term search and define/assign checklist are consistent');
}

async function businessPartners(ctx: BrowserContext) {
  const {page,BASE,CLIENT}=scope(ctx);
  await page.goto(`${BASE}/foundation/partners?new=1`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="partnerNumber"]').fill('TESTSUPP01');
  await page.locator('input[name="name"]').fill('Demo Industrial Supply');
  await page.locator('[name="searchTerm"]').fill('DEMOSUPP');
  await page.locator('[name="street"]').fill('Test Street 10');
  await page.locator('[name="email"]').fill('orders@example.com');
  await page.locator('[name="reason"]').fill('Browser incomplete partner');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Partner saved. Status: Incomplete.',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Open saved business partner',exact:true}).click();
  await page.locator('input[name="partnerNumber"][readonly]').waitFor();
  await page.locator('[name="city"]').fill('Kuwait City');
  await page.locator('[name="reason"]').fill('Browser partner completion');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Partner saved. Status: Created.',{exact:true}).waitFor();
  await page.locator('[name="reason"]').fill('Browser unchanged partner');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No partner data changed.',{exact:true}).waitFor();
  assert.equal((await getBusinessPartner(CLIENT,'TESTSUPP01'))?.general.version,2);
  console.log('  ✓ general partner stages/completes; unchanged save preserves version');

  await page.locator('[name="roles"][value="CUSTOMER"]').check();
  await page.locator('[name="reason"]').fill('Browser dual partner role');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Partner saved. Status: Maintained.',{exact:true}).waitFor();
  assert.equal((await getBusinessPartner(CLIENT,'TESTSUPP01'))?.roles.filter(r=>r.isActive).length,2);
  await page.locator('[name="roles"][value="SUPPLIER"]').uncheck();
  await page.locator('[name="reason"]').fill('Browser supplier role hold');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='4');
  const roleHold=await getBusinessPartner(CLIENT,'TESTSUPP01');
  assert.equal(roleHold?.roles.length,2);assert.equal(roleHold?.roles.find(r=>r.roleCode==='SUPPLIER')?.isActive,false);
  await page.locator('[name="roles"][value="SUPPLIER"]').check();
  await page.locator('[name="reason"]').fill('Browser supplier role restore');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='5');
  await page.locator('[name="isBlocked"]').check();
  await page.locator('[name="reason"]').fill('Browser compliance hold');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Blocked',{exact:true}).waitFor();
  assert.equal((await getBusinessPartner(CLIENT,'TESTSUPP01'))?.general.isBlocked,true);
  await page.locator('[name="isBlocked"]').uncheck();
  await page.locator('[name="reason"]').fill('Browser compliance cleared');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='7');
  assert.equal((await getBusinessPartner(CLIENT,'TESTSUPP01'))?.general.isBlocked,false);
  const version=(await getBusinessPartner(CLIENT,'TESTSUPP01'))!.general.version;
  await page.locator('[name="country"]').evaluate((select)=>{const option=document.createElement('option');option.value='ZZ';option.text='Invalid test country';select.appendChild(option);});
  await page.locator('[name="country"]').selectOption('ZZ');
  await page.locator('[name="reason"]').fill('Invalid country test');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Country code is not configured.',{exact:true}).waitFor();
  assert.equal((await getBusinessPartner(CLIENT,'TESTSUPP01'))?.general.version,version);
  console.log('  ✓ dual roles stay stable, block/unblock works and invalid country cannot overwrite');

  await page.getByRole('link',{name:'Change history',exact:true}).click();
  await page.getByText('Browser partner completion',{exact:true}).waitFor();
  await page.getByText('Browser dual partner role',{exact:true}).waitFor();
  await page.getByText('Browser compliance hold',{exact:true}).waitFor();
  await page.screenshot({path:'.arena/business-partners-history-review.png',fullPage:true});
  await page.goto(`${BASE}/foundation/partners`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="q"]').fill('DEMOSUPP');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await page.getByRole('link',{name:'TESTSUPP01',exact:true}).waitFor();
  console.log('  ✓ general partner search/history and explicit pending segments are visible');

  const id=randomUUID();const password=await hashPassword(PASSWORD);
  await withTenant(CLIENT,async tx=>{
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${id},${CLIENT},'partner.viewer','Partner Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${id},'WAREHOUSE_CLERK','BROWSER_FIXTURE')`);
  });
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.goto(`${BASE}/signin`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="client"]').fill(CLIENT);await page.locator('[name="username"]').fill('partner.viewer');await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/$/);
  await page.goto(`${BASE}/foundation/partners?partner=TESTSUPP01`,{waitUntil:'domcontentloaded'});
  await page.getByText(/FND.PARTNER.MAINTAIN/).last().waitFor();
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  console.log('  ✓ warehouse authority can review but cannot maintain general partner data');
}

async function supplierCompany(ctx: BrowserContext) {
  const {page,BASE,CLIENT}=scope(ctx);
  await page.goto(`${BASE}/foundation/partners?new=1`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="partnerNumber"]').fill('TESTSUPP01');
  await page.locator('input[name="name"]').fill('Demo Industrial Supply');
  await page.locator('[name="city"]').fill('Kuwait City');
  await page.locator('[name="reason"]').fill('Browser supplier prerequisite');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Partner saved. Status: Created.',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Open saved business partner',exact:true}).click();
  await page.getByRole('link',{name:'Supplier company code',exact:true}).click();
  await page.locator('[name="reconciliationAccount"]').waitFor();
  await page.locator('[name="reason"]').fill('Browser staged supplier accounting');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier company view saved. Status: Incomplete.',{exact:true}).waitFor();
  await page.locator('[name="reason"]').fill('Browser unchanged supplier accounting');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No supplier company data changed.',{exact:true}).waitFor();
  assert.equal((await getSupplierCompany(CLIENT,'TESTSUPP01','1000'))?.version,1);
  await page.locator('[name="reconciliationAccount"]').selectOption('200000');
  await page.locator('[name="paymentTermsCode"]').selectOption('NET30');
  await page.locator('[name="reason"]').fill('Browser supplier accounting completion');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier company view saved. Status: Created.',{exact:true}).waitFor();
  assert.equal((await getSupplierCompany(CLIENT,'TESTSUPP01','1000'))?.chartOfAccounts,'CAIRN');
  await page.locator('[name="paymentTermsCode"]').selectOption('NET15');
  await page.locator('[name="reason"]').fill('Browser supplier accounting maintenance');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier company view saved. Status: Maintained.',{exact:true}).waitFor();
  assert.equal((await getSupplierCompany(CLIENT,'TESTSUPP01','1000'))?.version,3);
  await page.locator('[name="isBlocked"]').check();
  await page.locator('[name="reason"]').fill('Browser company hold');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Blocked',{exact:true}).waitFor();
  await page.locator('[name="isBlocked"]').uncheck();
  await page.locator('[name="reason"]').fill('Browser company hold cleared');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='5');
  await page.locator('[name="reconciliationAccount"]').evaluate(select=>{const option=document.createElement('option');option.value='100000';option.text='Invalid cash account';select.appendChild(option);});
  await page.locator('[name="reconciliationAccount"]').selectOption('100000');
  await page.locator('[name="reason"]').fill('Invalid reconciliation test');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Use an unblocked supplier reconciliation account in the company chart.',{exact:true}).waitFor();
  assert.equal((await getSupplierCompany(CLIENT,'TESTSUPP01','1000'))?.reconciliationAccount,'200000');
  assert.equal((await getSupplierCompany(CLIENT,'TESTSUPP01','1000'))?.version,5);
  await page.getByRole('link',{name:'Change history',exact:true}).click();
  await page.getByText('Browser supplier accounting completion',{exact:true}).waitFor();
  await page.getByText('Browser company hold',{exact:true}).waitFor();
  await page.screenshot({path:'.arena/supplier-company-history-review.png',fullPage:true});
  console.log('  ✓ supplier company stages/completes, preserves no-op, maintains/blocks and rejects cash account');

  const id=randomUUID();const password=await hashPassword(PASSWORD);
  await withTenant(CLIENT,async tx=>{
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${id},${CLIENT},'company.viewer','Company Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${id},'WAREHOUSE_CLERK','BROWSER_FIXTURE')`);
  });
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.goto(`${BASE}/signin`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="client"]').fill(CLIENT);await page.locator('[name="username"]').fill('company.viewer');await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/$/);
  await page.goto(`${BASE}/foundation/partners?partner=TESTSUPP01&view=SUPPLIER_COMPANY&history=1`,{waitUntil:'domcontentloaded'});
  await page.getByText(/This screen requires authority FIN.SUPPLIER.COMPANY.DISPLAY/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  assert.equal((await page.content()).includes('Browser supplier accounting completion'),false);
  console.log('  ✓ non-finance authority cannot read/maintain supplier accounting or its history');
}

async function supplierPurchasing(ctx: BrowserContext) {
  const {page,BASE,CLIENT}=scope(ctx);
  await page.goto(`${BASE}/foundation/partners?new=1`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="partnerNumber"]').fill('TESTSUPP01');
  await page.locator('input[name="name"]').fill('Demo Industrial Supply');
  await page.locator('[name="city"]').fill('Kuwait City');
  await page.locator('[name="reason"]').fill('Browser purchasing supplier prerequisite');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Partner saved. Status: Created.',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Open saved business partner',exact:true}).click();
  await page.getByRole('link',{name:'Purchasing organisation',exact:true}).click();
  await page.locator('[name="orderCurrency"]').waitFor();
  assert.equal(await page.locator('[name="orderCurrency"]').inputValue(),'KWD');
  await page.locator('[name="reason"]').fill('Browser staged supplier purchasing');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier purchasing view saved. Status: Incomplete.',{exact:true}).waitFor();
  await page.locator('[name="reason"]').fill('Browser unchanged buying defaults');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No supplier purchasing data changed.',{exact:true}).waitFor();
  assert.equal((await getSupplierPurchasing(CLIENT,'TESTSUPP01','1000'))?.version,1);
  await page.locator('[name="orderCurrency"]').selectOption('USD');
  await page.locator('[name="purchasingGroup"]').selectOption('001');
  await page.locator('[name="incotermsCode"]').selectOption('FCA');
  await page.locator('[name="incotermsLocation"]').fill('Kuwait City');
  await page.locator('[name="paymentTermsCode"]').selectOption('NET30');
  await page.locator('[name="reason"]').fill('Browser buying defaults completion');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier purchasing view saved. Status: Created.',{exact:true}).waitFor();
  assert.equal((await getSupplierPurchasing(CLIENT,'TESTSUPP01','1000'))?.orderCurrency,'USD');
  await page.locator('[name="incotermsLocation"]').fill('Test receiving site');
  await page.locator('[name="paymentTermsCode"]').selectOption('NET15');
  await page.locator('[name="reason"]').fill('Browser buying defaults maintenance');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier purchasing view saved. Status: Maintained.',{exact:true}).waitFor();
  await page.locator('[name="isBlocked"]').check();
  await page.locator('[name="reason"]').fill('Browser buying organisation hold');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Blocked',{exact:true}).waitFor();
  await page.locator('[name="isBlocked"]').uncheck();
  await page.locator('[name="reason"]').fill('Browser buying organisation cleared');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='5');
  await page.locator('[name="orderCurrency"]').evaluate(select=>{const option=document.createElement('option');option.value='ZZZ';option.text='Invalid test currency';select.appendChild(option);});
  await page.locator('[name="orderCurrency"]').selectOption('ZZZ');
  await page.locator('[name="reason"]').fill('Invalid order currency test');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Order currency is missing or inactive.',{exact:true}).waitFor();
  assert.equal((await getSupplierPurchasing(CLIENT,'TESTSUPP01','1000'))?.version,5);
  assert.equal((await getSupplierPurchasing(CLIENT,'TESTSUPP01','1000'))?.orderCurrency,'USD');
  assert.equal(await getSupplierCompany(CLIENT,'TESTSUPP01','1000'),null);
  await page.getByRole('link',{name:'Change history',exact:true}).click();
  await page.getByText('Browser buying defaults completion',{exact:true}).waitFor();
  await page.getByText('Browser buying organisation hold',{exact:true}).waitFor();
  await page.screenshot({path:'.arena/supplier-purchasing-history-review.png',fullPage:true});
  console.log('  ✓ supplier buying defaults stage/complete/maintain/block and reject invalid currency');

  const id=randomUUID();const password=await hashPassword(PASSWORD);
  await withTenant(CLIENT,async tx=>{
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${id},${CLIENT},'purchasing.viewer','Purchasing Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${id},'WAREHOUSE_CLERK','BROWSER_FIXTURE')`);
  });
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.goto(`${BASE}/signin`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="client"]').fill(CLIENT);await page.locator('[name="username"]').fill('purchasing.viewer');await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/$/);
  await page.goto(`${BASE}/foundation/partners?partner=TESTSUPP01&view=SUPPLIER_PURCHASING&history=1`,{waitUntil:'domcontentloaded'});
  await page.getByText(/This screen requires authority PROC.SUPPLIER.PURCHASING.DISPLAY/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  assert.equal((await page.content()).includes('Browser buying defaults completion'),false);
  console.log('  ✓ unrelated warehouse authority cannot read buying defaults or their history');
}

async function customerCompany(ctx: BrowserContext) {
  const {page,BASE,CLIENT}=scope(ctx);
  await page.goto(`${BASE}/foundation/partners?new=1`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="partnerNumber"]').fill('TESTCUST01');
  await page.locator('input[name="name"]').fill('Demo Retail Customer');
  await page.locator('[name="city"]').fill('Kuwait City');
  await page.locator('[name="roles"][value="SUPPLIER"]').uncheck();
  await page.locator('[name="roles"][value="CUSTOMER"]').check();
  await page.locator('[name="reason"]').fill('Browser customer prerequisite');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Partner saved. Status: Created.',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Open saved business partner',exact:true}).click();
  await page.getByRole('link',{name:'Customer company code',exact:true}).click();
  await page.locator('[name="reconciliationAccount"]').waitFor();
  await page.locator('[name="reason"]').fill('Browser staged customer accounting');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Customer company view saved. Status: Incomplete.',{exact:true}).waitFor();
  await page.locator('[name="reason"]').fill('Browser unchanged customer accounting');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No customer company data changed.',{exact:true}).waitFor();
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.version,1);
  await page.locator('[name="reconciliationAccount"]').selectOption('110000');
  await page.locator('[name="paymentTermsCode"]').selectOption('NET30');
  await page.locator('[name="reason"]').fill('Browser customer accounting completion');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Customer company view saved. Status: Created.',{exact:true}).waitFor();
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.chartOfAccounts,'CAIRN');
  await page.locator('[name="paymentTermsCode"]').selectOption('NET15');
  await page.locator('[name="reason"]').fill('Browser customer accounting maintenance');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Customer company view saved. Status: Maintained.',{exact:true}).waitFor();
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.version,3);
  await page.locator('[name="isBlocked"]').check();
  await page.locator('[name="reason"]').fill('Browser company hold');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Blocked',{exact:true}).waitFor();
  await page.locator('[name="isBlocked"]').uncheck();
  await page.locator('[name="reason"]').fill('Browser company hold cleared');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='5');
  await page.locator('[name="reconciliationAccount"]').evaluate(select=>{const option=document.createElement('option');option.value='100000';option.text='Invalid cash account';select.appendChild(option);});
  await page.locator('[name="reconciliationAccount"]').selectOption('100000');
  await page.locator('[name="reason"]').fill('Invalid reconciliation test');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Use an unblocked customer reconciliation account in the company chart.',{exact:true}).waitFor();
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.reconciliationAccount,'110000');
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.version,5);
  await page.getByRole('link',{name:'Change history',exact:true}).click();
  await page.getByText('Browser customer accounting completion',{exact:true}).waitFor();
  await page.getByText('Browser company hold',{exact:true}).waitFor();
  await page.screenshot({path:'.arena/customer-company-history-review.png',fullPage:true});
  console.log('  ✓ customer company stages/completes, preserves no-op, maintains/blocks and rejects cash account');

  const id=randomUUID();const password=await hashPassword(PASSWORD);
  await withTenant(CLIENT,async tx=>{
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${id},${CLIENT},'company.viewer','Company Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${id},'WAREHOUSE_CLERK','BROWSER_FIXTURE')`);
  });
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.goto(`${BASE}/signin`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="client"]').fill(CLIENT);await page.locator('[name="username"]').fill('company.viewer');await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/$/);
  await page.goto(`${BASE}/foundation/partners?partner=TESTCUST01&view=CUSTOMER_COMPANY&history=1`,{waitUntil:'domcontentloaded'});
  await page.getByText(/This screen requires authority FIN.CUSTOMER.COMPANY.DISPLAY/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  assert.equal((await page.content()).includes('Browser customer accounting completion'),false);
  console.log('  ✓ non-finance authority cannot read/maintain customer accounting or its history');
}

export const CHECKS: Record<BrowserTargetId, (ctx: BrowserContext) => Promise<void>> = {
  foundation,
  'payment-terms': paymentTerms,
  'business-partners': businessPartners,
  'supplier-company': supplierCompany,
  'supplier-purchasing': supplierPurchasing,
  'customer-company': customerCompany,
  'material-basic': basicLifecycle,
  'material-purchasing': purchasing,
  'material-mrp': mrp,
  'material-valuation': valuation,
};
