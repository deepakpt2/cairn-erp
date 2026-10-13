/** Independently runnable browser cases. Business data uses the UI; the D-074 check adds one synthetic encrypted bank row through a guarded disposable-test fixture connection because no bank write path exists. */
import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { encryptBankData } from '../../src/platform/security/bank-data-encryption';
import { generateBankRecordId } from '../../src/platform/security/bank-record-id';
import { loadBankDataKeyring } from '../../src/platform/security/bank-data-keyring';
import { hashPassword } from '../../src/platform/auth/password';
import { withTenant } from '../../src/platform/db/client';
import { changeHistory } from '../../src/platform/change';
import { listCompanyCodes } from '../../src/modules/foundation/services';
import { getMaterialDetail } from '../../src/modules/inventory/materials';
import { getPaymentTerms } from '../../src/modules/foundation/payment-terms';
import { getPaymentMethod, savePaymentMethod } from '../../src/modules/foundation/payment-methods';
import { getBusinessPartner } from '../../src/modules/foundation/business-partners';
import { getSupplierCompany } from '../../src/modules/foundation/supplier-companies';
import { getSupplierPurchasing } from '../../src/modules/foundation/supplier-purchasing';
import { listSupplierPurchasingPartners } from '../../src/modules/foundation/supplier-purchasing-partners';
import { getCustomerCompany } from '../../src/modules/foundation/customer-companies';
import { getCustomerSalesArea } from '../../src/modules/foundation/customer-sales-areas';
import { FIXTURE_NAME, type BrowserTargetId, type BrowserTarget } from './targets';

const PASSWORD = 'browser-check-2026';
const SYNTHETIC_BANK_IDENTIFIER = 'SYNTHETIC-IBAN-4321';
const year = new Date().getUTCFullYear();
export type BrowserContext = { page: Page; base: string; target: BrowserTarget };
function scope(ctx: BrowserContext) { return { page: ctx.page, BASE: ctx.base, CLIENT: ctx.target.client }; }

/** Elevated fixture writes are allowed only to a fresh, loopback cairn_test database. */
async function insertSyntheticPartnerBankRecord(client: string, partnerNumber: string): Promise<string> {
  const fixtureUrl = process.env.CAIRN_SMOKE_FIXTURE_DATABASE_URL;
  assert.ok(fixtureUrl, 'Masked bank-detail smoke requires CAIRN_SMOKE_FIXTURE_DATABASE_URL.');
  const fixtureDb = postgres(fixtureUrl, { max: 1, prepare: false, onnotice: () => {} });

  try {
    const [identity] = await fixtureDb`
      select current_database() as database_name,
             host(inet_server_addr()) as server_address,
             current_user as role_name`;
    assert.equal(identity?.database_name, 'cairn_test', 'Fixture writes are restricted to the disposable cairn_test database.');
    assert.equal(identity?.server_address, '127.0.0.1', 'Fixture writes are restricted to loopback PostgreSQL.');
    assert.notEqual(identity?.role_name, 'cairn_app', 'Fixture writer must be separate from the read-only application role.');
    const [role] = await fixtureDb`
      select (rolsuper or rolbypassrls) as elevated
      from pg_roles where rolname = current_user`;
    assert.equal(role?.elevated, true, 'Fixture connection must be privileged only inside the disposable test cluster.');

    const [tenant] = await fixtureDb`
      select name, is_development from client where client = ${client}`;
    assert.equal(tenant?.name, FIXTURE_NAME, 'Refusing fixture writes outside the owned browser tenant.');
    assert.equal(tenant?.is_development, true, 'Refusing fixture writes outside a development tenant.');
    const [partner] = await fixtureDb`
      select 1 as present from business_partner
      where client = ${client} and partner_number = ${partnerNumber}`;
    assert.equal(partner?.present, 1, 'Synthetic bank row requires the UI-created test partner.');
    const [existing] = await fixtureDb`
      select count(*)::int as count from partner_bank
      where client = ${client} and partner_number = ${partnerNumber}`;
    assert.equal(existing?.count, 0, 'Refusing to add a fixture beside any pre-existing bank row.');

    const bankRecordId = generateBankRecordId();
    const envelope = encryptBankData(SYNTHETIC_BANK_IDENTIFIER, {
      client,
      partnerNumber,
      bankRecordId,
      field: 'iban',
    }, loadBankDataKeyring());
    await fixtureDb`
      insert into partner_bank (
        client, partner_number, bank_record_id, account_holder, country, bank_name,
        iban_ciphertext, valid_from, is_active, version, created_by
      ) values (
        ${client}, ${partnerNumber}, ${bankRecordId}, 'Synthetic Test Holder', 'KW',
        'Synthetic Test Bank', ${envelope}, '2026-01-01', true, 1, 'BROWSER_FIXTURE'
      )`;
    return bankRecordId;
  } finally {
    await fixtureDb.end({ timeout: 5 });
  }
}

async function createSupplierRoleThroughUi(page: Page, BASE: string, number: string, name: string) {
  await page.goto(`${BASE}/foundation/partners?new=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="partnerNumber"]').fill(number);
  await page.locator('input[name="name"]').fill(name);
  await page.locator('[name="country"]').selectOption('KW');
  await page.locator('[name="city"]').fill('Kuwait City');
  await page.locator('[name="roles"][value="SUPPLIER"]').check();
  await page.locator('[name="roles"][value="CUSTOMER"]').uncheck();
  await page.locator('[name="reason"]').fill('Browser partner-function Supplier prerequisite');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Partner saved. Status: Created.', { exact: true }).waitFor();
}

export async function onboard(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const NAME = FIXTURE_NAME;
  console.log('Browser: create tenant through onboarding');
  await page.goto(`${BASE}/clients/new`, { waitUntil: 'domcontentloaded' });
  // The runner enforces CAIRN_ENV=development. If the protected field is
  // rendered, satisfy it with an ephemeral value rather than a deployment secret.
  const provisioningToken = page.locator('[name="provisioningToken"]');
  if (await provisioningToken.count()) await provisioningToken.fill(randomUUID());
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
  await page.waitForURL(/\/config$/, { waitUntil: 'domcontentloaded' });
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

async function companyCodeDefinition(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const code = '2000';
  const name = 'Browser Acceptance Secondary Company';
  console.log('Company Code: verify the capability-gated definition form');

  await page.goto(`${BASE}/config/company-codes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Company codes', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Create company code', exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count() >= 1, true, 'The standard package should leave a readable existing Company Code.');

  const countryOptions = await page.locator('[name="country"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  const currencyOptions = await page.locator('[name="currency"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  assert.ok(countryOptions.includes('KW'), 'Authorized maintainer receives country choices.');
  assert.ok(currencyOptions.includes('KWD'), 'Authorized maintainer receives active-currency choices.');

  for (const field of ['client', 'changedBy', 'chartOfAccounts', 'fiscalYearVariant', 'postingPeriodVariant']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `${field} is not a definition-form field.`);
  }
  await page.locator('[name="companyCode"]').fill(code);
  await page.locator('[name="name"]').fill(name);
  await page.locator('[name="country"]').selectOption('KW');
  await page.locator('[name="currency"]').selectOption('KWD');
  await page.locator('[name="city"]').fill('Al Jahra');
  await page.locator('[name="taxRegistrationNumber"]').fill('B110-TAX-2000');
  const definitionForm = page.locator('form').filter({ has: page.locator('[name="companyCode"]') });
  await definitionForm.evaluate((form) => {
    for (const [field, value] of Object.entries({
      client: '0100',
      changedBy: 'spoofed.actor',
      chartOfAccounts: 'FORGED',
      fiscalYearVariant: 'FORGED',
      postingPeriodVariant: 'FORGED',
    })) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = field;
      input.value = value;
      form.appendChild(input);
    }
  });
  await page.getByRole('button', { name: 'Create company code', exact: true }).click();
  await page.getByRole('status').getByText(
    'Company code 2000 defined; its assignments remain pending.',
    { exact: true },
  ).waitFor();

  // A successful create resets the form but keeps the server-confirmed feedback visible.
  for (const field of ['companyCode', 'name', 'city', 'taxRegistrationNumber']) {
    assert.equal(await page.locator(`[name="${field}"]`).inputValue(), '', `${field} resets after success.`);
  }
  assert.equal(await page.locator('[name="country"]').inputValue(), '');
  assert.equal(await page.locator('[name="currency"]').inputValue(), '');

  let rows = await listCompanyCodes(CLIENT);
  let created = rows.filter((row) => row.companyCode === code);
  assert.equal(created.length, 1, 'The create action inserts exactly one Company Code.');
  assert.deepEqual(
    {
      name: created[0].name,
      country: created[0].country,
      currency: created[0].currency,
      city: created[0].city,
      taxRegistrationNumber: created[0].taxRegistrationNumber,
      chartOfAccounts: created[0].chartOfAccounts,
      fiscalYearVariant: created[0].fiscalYearVariant,
      postingPeriodVariant: created[0].postingPeriodVariant,
      createdBy: created[0].createdBy,
    },
    {
      name,
      country: 'KW',
      currency: 'KWD',
      city: 'Al Jahra',
      taxRegistrationNumber: 'B110-TAX-2000',
      chartOfAccounts: null,
      fiscalYearVariant: null,
      postingPeriodVariant: null,
      createdBy: 'browser.admin',
    },
  );
  const createdHistory = await withTenant(CLIENT, (tx) =>
    changeHistory(tx, CLIENT, 'company_code', code),
  );
  assert.equal(createdHistory.length, 1);
  assert.equal(createdHistory[0].changeType, 'CREATE');
  assert.equal(createdHistory[0].changedBy, 'browser.admin');
  assert.equal(createdHistory[0].transactionCode, 'CFG.ORG.COMPANYCODE.DEFINE');

  const createdRow = page.locator('tbody tr').filter({ hasText: code }).filter({ hasText: name });
  await createdRow.waitFor();
  const visibleValues = await createdRow.locator('td').allInnerTexts();
  assert.deepEqual(visibleValues.slice(0, 7), [
    code,
    name,
    'KWD',
    'KW',
    'Not assigned',
    'Not assigned',
    'Not assigned',
  ]);
  assert.equal(await createdRow.getByRole('link').count(), 0, 'Unassigned periods are not opened.');
  await createdRow.getByText('Complete the Company Code assignments before opening posting periods.', { exact: true }).waitFor();
  console.log('  ✓ form creates one audited definition, resets after success and leaves assignments unset');

  // Duplicate submits are rejected by the create-only action and do not overwrite the row.
  await page.locator('[name="companyCode"]').fill(code);
  await page.locator('[name="name"]').fill('Attempted browser overwrite');
  await page.locator('[name="country"]').selectOption('US');
  await page.locator('[name="currency"]').selectOption('USD');
  await page.getByRole('button', { name: 'Create company code', exact: true }).click();
  await page.getByRole('status').getByText('Company code 2000 already exists.', { exact: true }).waitFor();
  rows = await listCompanyCodes(CLIENT);
  created = rows.filter((row) => row.companyCode === code);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, name);
  assert.equal(created[0].country, 'KW');
  assert.equal(created[0].currency, 'KWD');
  assert.equal((await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'company_code', code))).length, 1);
  console.log('  ✓ duplicate definition is refused without overwrite or extra history');

  // The Auditor role has display-only authority: keep list access, omit the form.
  const viewerId = randomUUID();
  const password = await hashPassword(PASSWORD);
  await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into app_user
      (id, client, username, full_name, password_hash, must_change_password, created_by)
      values (${viewerId}, ${CLIENT}, 'company.viewer', 'Company Code Viewer', ${password}, false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
      values (${CLIENT}, ${viewerId}, 'AUDITOR', 'BROWSER_FIXTURE')`);
  });

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="client"]').fill(CLIENT);
  await page.locator('[name="username"]').fill('company.viewer');
  await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.goto(`${BASE}/config/company-codes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Company codes', exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.ORG.COMPANYCODE.DEFINE.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Create company code', exact: true }).count(), 0);
  for (const field of ['companyCode', 'name', 'country', 'currency', 'city', 'taxRegistrationNumber']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `Display-only session has no ${field} form control.`);
  }
  assert.equal(await page.locator('select').count(), 0, 'Reference choices are not rendered for display-only sessions.');
  const viewerRow = page.locator('tbody tr').filter({ hasText: code }).filter({ hasText: name });
  await viewerRow.waitFor();
  assert.deepEqual((await viewerRow.locator('td').allInnerTexts()).slice(0, 7), visibleValues.slice(0, 7));
  console.log('  ✓ cookie-backed Auditor retains the readable list but receives no form or reference choices');
}

async function plantDefinition(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const code = 'PLT125';
  const name = 'Browser Acceptance Plant';
  const passwordHash = await hashPassword(PASSWORD);
  console.log('Plant definition: verify exact capability, audited create/change and display-only access');

  const roleCapabilities = await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'B125_PLANT_DEFINE', 'B-125 Plant Definition Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'B125_PLANT_DEFINE', 'CFG.ORG.PLANT.DEFINE', 'BROWSER_FIXTURE')`);
    const [definerId, viewerId] = [randomUUID(), randomUUID()];
    for (const [id, username, fullName, roleCode] of [
      [definerId, 'plant.definer', 'Plant Definition-Only User', 'B125_PLANT_DEFINE'],
      [viewerId, 'plant.viewer', 'Plant Read-Only User', 'AUDITOR'],
    ]) {
      await tx.execute(sql`insert into app_user
        (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')`);
      await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
        values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')`);
    }
    return tx.execute(sql`select capability_code from role_capability
      where client = ${CLIENT} and role_code = 'B125_PLANT_DEFINE' order by capability_code`);
  }) as unknown as Array<{ capability_code: string }>;
  assert.deepEqual(roleCapabilities.map((row) => row.capability_code), ['CFG.ORG.PLANT.DEFINE']);

  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');
  }

  // A role containing only the registered definition capability gets the create/change UI.
  await signInAs('plant.definer');
  await page.goto(`${BASE}/config/plants?new=1`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Plants', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Create Plant', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Create Plant', exact: true }).waitFor();
  assert.ok((await page.locator('[name="country"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  )).includes('KW'));
  assert.equal(await page.locator('[name="language"]').inputValue(), 'EN');
  assert.equal(await page.locator('input[type="checkbox"][name="isProductionSite"]').isChecked(), true);
  assert.equal(await page.locator('input[type="checkbox"][name="isStorageSite"]').isChecked(), true);
  for (const field of ['companyCode', 'defaultStorageLocation', 'isActive', 'client', 'changedBy']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `${field} is not a Plant definition-form field.`);
  }
  await page.getByText('Stored as a key only: it is not checked against a master or used operationally.', { exact: true }).waitFor();
  await page.locator('[name="plant"]').fill(code);
  await page.locator('[name="name"]').fill(name);
  await page.locator('[name="country"]').selectOption('KW');
  await page.locator('[name="street"]').fill('Industrial Road');
  await page.locator('[name="houseNumber"]').fill('12A');
  await page.locator('[name="postalCode"]').fill('12345');
  await page.locator('[name="city"]').fill('Al Jahra');
  await page.locator('[name="region"]').fill('Al Jahra');
  await page.locator('[name="factoryCalendar"]').fill('UNUSED');
  await page.locator('input[type="checkbox"][name="isProductionSite"]').uncheck();
  await page.locator('input[type="checkbox"][name="isStorageSite"]').uncheck();
  const createForm = page.locator('form').filter({ has: page.locator('[name="plant"]') });
  await createForm.evaluate((form) => {
    for (const [field, value] of Object.entries({
      client: '0100',
      changedBy: 'spoofed.actor',
      companyCode: '1000',
      defaultStorageLocation: '0001',
      isActive: 'false',
    })) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = field;
      input.value = value;
      form.appendChild(input);
    }
  });
  await page.getByRole('button', { name: 'Create Plant', exact: true }).click();
  await page.getByRole('status').getByText(
    'Plant PLT125 defined; Company Code assignment remains separate.',
    { exact: true },
  ).waitFor();

  const readPlant = async () => {
    const rows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select client, plant, name, company_code, country, street, house_number,
             postal_code, city, region, factory_calendar, language,
             is_production_site, is_storage_site, default_storage_location,
             is_active, created_by, changed_by
        from plant where client = ${CLIENT} and plant = ${code}
    `))) as unknown as Array<{
      client: string; plant: string; name: string; company_code: string | null;
      country: string; street: string | null; house_number: string | null;
      postal_code: string | null; city: string | null; region: string | null;
      factory_calendar: string | null; language: string;
      is_production_site: boolean; is_storage_site: boolean;
      default_storage_location: string | null; is_active: boolean;
      created_by: string; changed_by: string | null;
    }>;
    assert.equal(rows.length, 1);
    return rows[0];
  };
  const created = await readPlant();
  assert.deepEqual(
    {
      client: created.client, plant: created.plant, name: created.name,
      companyCode: created.company_code, country: created.country.trim(),
      street: created.street, houseNumber: created.house_number,
      postalCode: created.postal_code, city: created.city, region: created.region,
      factoryCalendar: created.factory_calendar, language: created.language.trim(),
      isProductionSite: created.is_production_site, isStorageSite: created.is_storage_site,
      defaultStorageLocation: created.default_storage_location, isActive: created.is_active,
      createdBy: created.created_by,
    },
    {
      client: CLIENT, plant: code, name, companyCode: null, country: 'KW',
      street: 'Industrial Road', houseNumber: '12A', postalCode: '12345',
      city: 'Al Jahra', region: 'Al Jahra', factoryCalendar: 'UNUSED', language: 'EN',
      isProductionSite: false, isStorageSite: false, defaultStorageLocation: null,
      isActive: true, createdBy: 'plant.definer',
    },
  );
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'plant', code));
  assert.equal(history.length, 1);
  assert.equal(history[0].changeType, 'CREATE');
  assert.equal(history[0].changedBy, 'plant.definer');
  assert.equal(history[0].transactionCode, 'CFG.ORG.PLANT.DEFINE');
  console.log('  ✓ definition-only user creates an unassigned Plant; forged tenant/actor/assignment fields are ignored and both role flags may be false');

  const plantCard = () => page.locator('section.panel').filter({ hasText: code }).filter({ hasText: name });
  await plantCard().waitFor();
  assert.deepEqual(await plantCard().locator('.chip').allInnerTexts(), ['NOT ASSIGNED']);
  await plantCard().getByRole('link', { name: 'Change', exact: true }).click();
  await page.getByRole('heading', { name: 'Change', exact: true }).waitFor();
  assert.equal(await page.locator('[name="plant"]').inputValue(), code);
  assert.equal(await page.locator('[name="plant"]').getAttribute('readonly'), '');
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '1');
  assert.equal(await page.locator('[name="city"]').inputValue(), 'Al Jahra');
  assert.equal(await page.locator('input[type="checkbox"][name="isProductionSite"]').isChecked(), false);
  assert.equal(await page.locator('input[type="checkbox"][name="isStorageSite"]').isChecked(), false);
  for (const field of ['companyCode', 'defaultStorageLocation', 'isActive']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `${field} stays outside the change form.`);
  }
  await page.locator('[name="city"]').fill('Al Jahra Industrial Area');
  await page.locator('[name="factoryCalendar"]').fill('STILLFAKE');
  await page.locator('input[type="checkbox"][name="isProductionSite"]').check();
  await page.locator('[name="reason"]').fill('Browser UI maintenance change');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').getByText(
    'Plant PLT125 saved and its change history recorded.',
    { exact: true },
  ).waitFor();
  const changed = await readPlant();
  assert.equal(changed.city, 'Al Jahra Industrial Area');
  assert.equal(changed.factory_calendar, 'STILLFAKE');
  assert.equal(changed.is_production_site, true);
  assert.equal(changed.is_storage_site, false);
  assert.equal(changed.company_code, null);
  assert.equal(changed.default_storage_location, null);
  assert.equal(changed.is_active, true);
  assert.equal(changed.changed_by, 'plant.definer');
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'plant', code));
  assert.equal(history.length, 2);
  assert.deepEqual(new Set(history.map((entry) => entry.changeType)), new Set(['CREATE', 'CHANGE']));
  assert.ok(history.every((entry) => entry.changedBy === 'plant.definer'));
  assert.ok(history.every((entry) => entry.transactionCode === 'CFG.ORG.PLANT.DEFINE'));
  const [activity] = await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status, completed_by from config_activity_status
     where client = ${CLIENT} and activity_code = 'CFG.ORG.PLANT.DEFINE'
  `)) as unknown as Array<{ status: string; completed_by: string | null }>;
  assert.equal(activity?.status, 'COMPLETED');
  assert.equal(activity?.completed_by, 'plant.definer');
  console.log('  ✓ change form preserves assignment/defaults, records a second version and completes the definition activity');

  // An Auditor retains the list but receives neither create/change controls nor form/reference data.
  await signInAs('plant.viewer');
  await page.goto(`${BASE}/config/plants`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Plants', exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.ORG.PLANT.DEFINE.', { exact: true }).waitFor();
  await plantCard().waitFor();
  assert.equal(await page.getByRole('link', { name: 'Create Plant', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
  assert.equal(await page.locator('[name="plant"]').count(), 0);
  await page.goto(`${BASE}/config/plants?new=1`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Read-only view. Changes require authority CFG.ORG.PLANT.DEFINE.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Create Plant', exact: true }).count(), 0);
  assert.equal(await page.locator('[name="country"]').count(), 0, 'Country choices are not rendered for a viewer.');
  assert.equal(await page.locator('[name="plant"]').count(), 0, 'A direct create URL does not bypass the capability gate.');
  console.log('  ✓ cookie-backed Auditor can read Plant data but cannot see the form or country choices');
}

async function plantCompanyCodeAssignment(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const plantCode = 'B129PLT';
  const plantName = 'B-129 Assignment Plant';
  const otherClient = 'T982';
  const otherTenantName = 'B-129 Company Choice Isolation Fixture';
  const otherCompanyCode = 'B129REM';
  const inactiveCompanyCode = 'B129OFF';
  let otherTenantCreated = false;
  const passwordHash = await hashPassword(PASSWORD);
  console.log('Plant Company Code assignment: verify separate capabilities, active tenant-local choices, audited initial save and no replacement control');

  async function removeOtherTenant() {
    if (!otherTenantCreated) return;
    const removed = (await withTenant(otherClient, (tx) => tx.execute(sql`
      delete from client
       where client = ${otherClient}
         and name = ${otherTenantName}
         and is_development = true
       returning client
    `))) as unknown as Array<{ client: string }>;
    assert.equal(removed.length, 1, 'The guarded cross-tenant choice fixture must be removed.');
    otherTenantCreated = false;
  }

  try {
    // These two fixture-only rows prove the UI picker excludes inactive and other-tenant choices.
    const localFixture = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select company_code from company_code
       where client = ${CLIENT} and company_code = ${inactiveCompanyCode}
    `))) as unknown as Array<{ company_code: string }>;
    assert.equal(localFixture.length, 0, 'Refusing to overwrite an existing inactive-code fixture.');
    await withTenant(CLIENT, (tx) => tx.execute(sql`
      insert into company_code
        (client, company_code, name, country, currency, is_active, created_by)
      values
        (${CLIENT}, ${inactiveCompanyCode}, 'B-129 Inactive Company Code', 'KW', 'KWD', false, 'BROWSER_FIXTURE')
    `));

    await withTenant(otherClient, async (tx) => {
      const existing = (await tx.execute(sql`
        select name from client where client = ${otherClient}
      `)) as unknown as Array<{ name: string }>;
      assert.equal(existing.length, 0, 'Refusing to alter a pre-existing tenant using the reserved fixture key.');
      await tx.execute(sql`
        insert into client (client, name, country, currency, status, is_development, created_by)
        values (${otherClient}, ${otherTenantName}, 'KW', 'KWD', 'ACTIVE', true, 'BROWSER_FIXTURE')
      `);
      await tx.execute(sql`
        insert into company_code
          (client, company_code, name, country, currency, is_active, created_by)
        values
          (${otherClient}, ${otherCompanyCode}, 'B-129 Other-Tenant Company Code', 'KW', 'KWD', true, 'BROWSER_FIXTURE')
      `);
    });
    otherTenantCreated = true;

    const roles = await withTenant(CLIENT, async (tx) => {
      await tx.execute(sql`
        insert into role (client, code, name, is_read_only, created_by)
        values
          (${CLIENT}, 'B129_PLANT_DEFINE', 'B-129 Plant Definition Only', false, 'BROWSER_FIXTURE'),
          (${CLIENT}, 'B129_PLANT_ASSIGN', 'B-129 Plant Assignment Only', false, 'BROWSER_FIXTURE')
      `);
      await tx.execute(sql`
        insert into role_capability (client, role_code, capability_code, created_by)
        values
          (${CLIENT}, 'B129_PLANT_DEFINE', 'CFG.ORG.PLANT.DEFINE', 'BROWSER_FIXTURE'),
          (${CLIENT}, 'B129_PLANT_ASSIGN', 'CFG.ORG.PLANT.ASSIGN_COMPANY', 'BROWSER_FIXTURE')
      `);
      for (const [id, username, fullName, roleCode] of [
        [randomUUID(), 'plant.definer', 'B-129 Plant Definition-Only User', 'B129_PLANT_DEFINE'],
        [randomUUID(), 'plant.assigner', 'B-129 Plant Assignment-Only User', 'B129_PLANT_ASSIGN'],
        [randomUUID(), 'plant.viewer', 'B-129 Plant Read-Only User', 'AUDITOR'],
      ]) {
        await tx.execute(sql`
          insert into app_user
            (id, client, username, full_name, password_hash, must_change_password, created_by)
          values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')
        `);
        await tx.execute(sql`
          insert into user_role (client, user_id, role_code, created_by)
          values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')
        `);
      }
      return tx.execute(sql`
        select role_code, capability_code from role_capability
         where client = ${CLIENT} and role_code in ('B129_PLANT_DEFINE', 'B129_PLANT_ASSIGN')
         order by role_code, capability_code
      `);
    }) as unknown as Array<{ role_code: string; capability_code: string }>;
    assert.deepEqual(roles.map((row) => [row.role_code, row.capability_code]), [
      ['B129_PLANT_ASSIGN', 'CFG.ORG.PLANT.ASSIGN_COMPANY'],
      ['B129_PLANT_DEFINE', 'CFG.ORG.PLANT.DEFINE'],
    ]);

    async function signInAs(username: string) {
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
      await page.locator('[name="client"]').fill(CLIENT);
      await page.locator('[name="username"]').fill(username);
      await page.locator('[name="password"]').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/');
    }

    const plantCard = () => page.locator('section.panel').filter({ hasText: plantCode }).filter({ hasText: plantName });

    // Definition remains a distinct operation; a forged Company Code field is ignored.
    await signInAs('plant.definer');
    await page.goto(`${BASE}/config/plants?new=1`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Create Plant', exact: true }).waitFor();
    assert.equal(await page.locator('[name="companyCode"]').count(), 0);
    await page.locator('[name="plant"]').fill(plantCode);
    await page.locator('[name="name"]').fill(plantName);
    await page.locator('[name="country"]').selectOption('KW');
    const definitionForm = page.locator('form').filter({ has: page.locator('[name="plant"]') });
    await definitionForm.evaluate((form) => {
      for (const [field, value] of Object.entries({
        client: '0100',
        changedBy: 'spoofed.actor',
        companyCode: '1000',
      })) {
        const input = document.createElement('input');
        input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
      }
    });
    await page.getByRole('button', { name: 'Create Plant', exact: true }).click();
    await page.getByRole('status').getByText(
      `Plant ${plantCode} defined; Company Code assignment remains separate.`,
      { exact: true },
    ).waitFor();
    const [definedPlant] = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select client, plant, company_code, created_by
        from plant where client = ${CLIENT} and plant = ${plantCode}
    `))) as unknown as Array<{ client: string; plant: string; company_code: string | null; created_by: string }>;
    assert.deepEqual(definedPlant, {
      client: CLIENT, plant: plantCode, company_code: null, created_by: 'plant.definer',
    });
    await plantCard().waitFor();
    await page.getByText('Read-only view. Changes require authority CFG.ORG.PLANT.ASSIGN_COMPANY.', { exact: true }).waitFor();
    assert.equal(await page.locator('[name="companyCode"]').count(), 0, 'Definition-only authority must not expose assignment choices.');
    console.log('  ✓ definition-only user creates an unassigned Plant; forged Company Code, tenant and actor fields are ignored');

    // Neither capability means read-only even while the Plant remains unassigned.
    await signInAs('plant.viewer');
    await page.goto(`${BASE}/config/plants`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Read-only view. Changes require authority CFG.ORG.PLANT.DEFINE.', { exact: true }).waitFor();
    await page.getByText('Read-only view. Changes require authority CFG.ORG.PLANT.ASSIGN_COMPANY.', { exact: true }).waitFor();
    await plantCard().waitFor();
    assert.equal(await page.getByRole('link', { name: 'Create Plant', exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
    assert.equal(await page.locator('[name="companyCode"]').count(), 0);
    await page.goto(`${BASE}/config/plants?new=1`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.getByRole('heading', { name: 'Create Plant', exact: true }).count(), 0);
    assert.equal(await page.locator('[name="companyCode"]').count(), 0);
    console.log('  ✓ cookie-backed Auditor has read-only Plant access and no assignment or definition form');

    // Assignment-only authority sees active choices from this tenant, but no definition controls.
    await signInAs('plant.assigner');
    await page.goto(`${BASE}/config/plants`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Read-only view. Changes require authority CFG.ORG.PLANT.DEFINE.', { exact: true }).waitFor();
    await plantCard().waitFor();
    await page.getByText('Initial assignment only; an assigned Plant cannot be changed or cleared in this milestone.', { exact: true }).waitFor();
    const assignmentForm = page.locator('form').filter({ has: page.locator('[name="companyCode"]') });
    await assignmentForm.waitFor();
    assert.equal(await page.getByRole('link', { name: 'Create Plant', exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
    assert.equal(await page.locator('[name="country"]').count(), 0);

    const expectedChoices = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select company_code from company_code
       where client = ${CLIENT} and is_active = true
       order by company_code
    `))) as unknown as Array<{ company_code: string }>;
    const expectedChoiceCodes = expectedChoices.map((row) => row.company_code.trim());
    assert.ok(expectedChoiceCodes.includes('1000'));
    assert.ok(!expectedChoiceCodes.includes(inactiveCompanyCode));
    assert.ok(!expectedChoiceCodes.includes(otherCompanyCode));
    const renderedChoices = await assignmentForm.locator('select[name="companyCode"] option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
    );
    assert.deepEqual(renderedChoices, expectedChoiceCodes);
    assert.equal(renderedChoices.includes(inactiveCompanyCode), false);
    assert.equal(renderedChoices.includes(otherCompanyCode), false);
    console.log('  ✓ assignment-only user receives only active, same-tenant Company Code choices');

    // The action must use the signed-in tenant and actor, not forged form fields.
    await assignmentForm.evaluate((form) => {
      for (const [field, value] of Object.entries({
        client: '0100',
        changedBy: 'spoofed.actor',
        company_code: 'B129REM',
      })) {
        const input = document.createElement('input');
        input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
      }
    });
    await assignmentForm.locator('[name="companyCode"]').selectOption('1000');
    await assignmentForm.getByRole('button', { name: 'Assign Company Code', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('select[name="companyCode"]') === null);
    const [assignedPlant] = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select client, plant, company_code, changed_by
        from plant where client = ${CLIENT} and plant = ${plantCode}
    `))) as unknown as Array<{ client: string; plant: string; company_code: string | null; changed_by: string | null }>;
    assert.deepEqual(assignedPlant, {
      client: CLIENT, plant: plantCode, company_code: '1000', changed_by: 'plant.assigner',
    });
    const history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'plant', plantCode));
    assert.equal(history.length, 2, 'Definition plus one assignment event; no replacement event exists.');
    const assignmentEvent = history.find((event) => event.transactionCode === 'CFG.ORG.PLANT.ASSIGN_COMPANY');
    assert.equal(assignmentEvent?.changeType, 'CHANGE');
    assert.equal(assignmentEvent?.changedBy, 'plant.assigner');
    assert.ok(assignmentEvent?.items.some((item) =>
      item.fieldName === 'companyCode' && item.oldValue === null && item.newValue === '1000' && item.isSecurityRelevant === 'true',
    ));
    const [assignmentActivity] = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select status, completed_by from config_activity_status
       where client = ${CLIENT} and activity_code = 'CFG.ORG.PLANT.ASSIGN_COMPANY'
    `))) as unknown as Array<{ status: string; completed_by: string | null }>;
    assert.equal(assignmentActivity?.status, 'COMPLETED');
    assert.equal(assignmentActivity?.completed_by, 'plant.assigner');
    await plantCard().waitFor();
    assert.equal(await assignmentForm.count(), 0, 'Assigned Plant has no replacement or clear form.');
    assert.equal(await page.getByRole('button', { name: 'Assign Company Code', exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
    assert.equal(await plantCard().getByText('1000', { exact: true }).count(), 1);
    console.log('  ✓ initial assignment persists once, records security-relevant history and completion under the session actor; no replacement control remains');
  } finally {
    await removeOtherTenant();
  }
}

async function companyCodeCoaAssignment(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const code = '2000';
  const name = 'Browser Acceptance CoA Assignment';
  const activeChart = 'B115ACT';
  const inactiveChart = 'B115OFF';
  console.log('Company Code CoA assignment: verify independent capabilities, local active choices, one-time save and read-only access');

  await page.goto(`${BASE}/config/company-codes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Company codes', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Create company code', exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count() >= 1, true, 'The standard package should leave a readable assigned Company Code.');

  // Create a fresh unassigned row through the real session-bound definition action.
  await page.locator('[name="companyCode"]').fill(code);
  await page.locator('[name="name"]').fill(name);
  await page.locator('[name="country"]').selectOption('KW');
  await page.locator('[name="currency"]').selectOption('KWD');
  await page.locator('[name="city"]').fill('Al Jahra');
  await page.locator('[name="taxRegistrationNumber"]').fill('B115-TAX-2000');
  await page.getByRole('button', { name: 'Create company code', exact: true }).click();
  await page.getByRole('status').getByText(
    'Company code 2000 defined; its assignments remain pending.',
    { exact: true },
  ).waitFor();

  let companyRows = await listCompanyCodes(CLIENT);
  let created = companyRows.filter((row) => row.companyCode === code);
  assert.equal(created.length, 1);
  assert.deepEqual(
    {
      client: created[0].client,
      name: created[0].name,
      country: created[0].country,
      currency: created[0].currency,
      chartOfAccounts: created[0].chartOfAccounts,
      fiscalYearVariant: created[0].fiscalYearVariant,
      postingPeriodVariant: created[0].postingPeriodVariant,
      createdBy: created[0].createdBy,
      changedBy: created[0].changedBy,
    },
    {
      client: CLIENT,
      name,
      country: 'KW',
      currency: 'KWD',
      chartOfAccounts: null,
      fiscalYearVariant: null,
      postingPeriodVariant: null,
      createdBy: 'browser.admin',
      changedBy: null,
    },
  );

  // Test-only local choices: one active chart and one inactive chart in this tenant.
  // This provisions the browser fixture; it is not CoA definition or seed acceptance.
  const beforeCharts = (await withTenant(CLIENT, (tx) =>
    tx.execute(sql`select chart_of_accounts, is_active from chart_of_accounts where client = ${CLIENT}`),
  )) as unknown as Array<{ chart_of_accounts: string; is_active: boolean }>;
  assert.ok(beforeCharts.some((chart) => chart.chart_of_accounts === 'CAIRN' && chart.is_active));
  assert.equal(beforeCharts.some((chart) => [activeChart, inactiveChart].includes(chart.chart_of_accounts)), false);
  await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`
      insert into chart_of_accounts (client, chart_of_accounts, name, is_active, created_by)
      values
        (${CLIENT}, ${activeChart}, 'B-115 Active Local Chart', true, 'BROWSER_FIXTURE'),
        (${CLIENT}, ${inactiveChart}, 'B-115 Inactive Local Chart', false, 'BROWSER_FIXTURE')
    `);
  });
  const chartRows = (await withTenant(CLIENT, (tx) =>
    tx.execute(sql`select chart_of_accounts, is_active from chart_of_accounts where client = ${CLIENT} order by chart_of_accounts`),
  )) as unknown as Array<{ chart_of_accounts: string; is_active: boolean }>;
  const activeChartChoices = chartRows
    .filter((chart) => chart.is_active)
    .map((chart) => chart.chart_of_accounts)
    .sort();
  assert.ok(activeChartChoices.includes(activeChart));
  assert.equal(chartRows.find((chart) => chart.chart_of_accounts === inactiveChart)?.is_active, false);
  assert.deepEqual(companyRows.filter((row) => !row.chartOfAccounts).map((row) => row.companyCode), [code]);

  const defineOnlyId = randomUUID();
  const assignOnlyId = randomUUID();
  const viewerId = randomUUID();
  const passwordHash = await hashPassword(PASSWORD);
  await withTenant(CLIENT, async (tx) => {
    for (const [roleCode, roleName, capability] of [
      ['B115_DEFINE_ONLY', 'B-115 Company Code Definer', 'CFG.ORG.COMPANYCODE.DEFINE'],
      ['B115_ASSIGN_ONLY', 'B-115 CoA Assigner', 'CFG.ORG.COMPANYCODE.ASSIGN_COA'],
    ] as const) {
      await tx.execute(sql`
        insert into role (client, code, name, is_read_only, created_by)
        values (${CLIENT}, ${roleCode}, ${roleName}, false, 'BROWSER_FIXTURE')
      `);
      await tx.execute(sql`
        insert into role_capability (client, role_code, capability_code, created_by)
        values (${CLIENT}, ${roleCode}, ${capability}, 'BROWSER_FIXTURE')
      `);
    }
    for (const [id, username, fullName, roleCode] of [
      [defineOnlyId, 'company.definer', 'Company Code Definition-Only User', 'B115_DEFINE_ONLY'],
      [assignOnlyId, 'company.assigner', 'CoA Assignment-Only User', 'B115_ASSIGN_ONLY'],
      [viewerId, 'company.viewer', 'Company Code Read-Only User', 'AUDITOR'],
    ]) {
      await tx.execute(sql`
        insert into app_user
          (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')
      `);
      await tx.execute(sql`
        insert into user_role (client, user_id, role_code, created_by)
        values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')
      `);
    }
  });

  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await page.goto(`${BASE}/config/company-codes`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Company codes', exact: true }).waitFor();
  }
  const companyRow = () => page.locator('tbody tr').filter({ hasText: code }).filter({ hasText: name });
  const unassignedCells = [code, name, 'KWD', 'KW', 'Not assigned', 'Not assigned', 'Not assigned'];

  // Definition-only authority must not receive assignment controls or CoA choices.
  await signInAs('company.definer');
  await page.getByRole('heading', { name: 'Create company code', exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.ORG.COMPANYCODE.ASSIGN_COA.', { exact: true }).waitFor();
  assert.equal(await page.locator('select[name="chartOfAccounts"]').count(), 0);
  assert.equal((await page.locator('body').innerText()).includes(activeChart), false);
  const definerRow = companyRow();
  await definerRow.waitFor();
  assert.deepEqual((await definerRow.locator('td').allInnerTexts()).slice(0, 7), unassignedCells);
  console.log('  ✓ definition authority does not imply CoA assignment or expose its choices');

  // A display-only Auditor can read the unassigned row but receives neither form nor choices.
  await signInAs('company.viewer');
  await page.getByText('Read-only view. Changes require authority CFG.ORG.COMPANYCODE.DEFINE.', { exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.ORG.COMPANYCODE.ASSIGN_COA.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Create company code', exact: true }).count(), 0);
  assert.equal(await page.locator('select').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Assign', exact: true }).count(), 0);
  assert.equal((await page.locator('body').innerText()).includes(activeChart), false);
  const viewerUnassignedRow = companyRow();
  await viewerUnassignedRow.waitFor();
  assert.deepEqual((await viewerUnassignedRow.locator('td').allInnerTexts()).slice(0, 7), unassignedCells);
  console.log('  ✓ cookie-backed Auditor can read the unassigned Company Code without either maintenance form or chart choices');

  // Assignment-only authority may assign, but cannot open the independent definition form.
  await signInAs('company.assigner');
  await page.getByText('Read-only view. Changes require authority CFG.ORG.COMPANYCODE.DEFINE.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Create company code', exact: true }).count(), 0);
  assert.equal(await page.locator('[name="name"]').count(), 0);
  await page.getByText('This is an initial assignment only. A different chart cannot replace an existing assignment through this step.', { exact: true }).waitFor();
  const assignRow = companyRow();
  const chartSelect = assignRow.locator('select[name="chartOfAccounts"]');
  await chartSelect.waitFor();
  const renderedChoices = await chartSelect.locator('option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value).filter(Boolean).sort(),
  );
  assert.deepEqual(renderedChoices, activeChartChoices, 'Choices must equal the active charts belonging to this tenant.');
  assert.equal(renderedChoices.includes(inactiveChart), false, 'Inactive tenant-local charts are not assignable.');
  const renderedLabels = await chartSelect.locator('option').allTextContents();
  assert.ok(renderedLabels.some((label) => label.includes(`${activeChart} · B-115 Active Local Chart`)));
  for (const field of ['client', 'changedBy', 'fiscalYearVariant', 'postingPeriodVariant']) {
    assert.equal(await assignRow.locator(`[name="${field}"]`).count(), 0, `${field} is not an assignment-form field.`);
  }
  await chartSelect.selectOption(activeChart);
  const assignmentForm = assignRow.locator('form');
  await assignmentForm.evaluate((form) => {
    for (const [field, value] of Object.entries({
      client: '0100',
      changedBy: 'spoofed.actor',
      fiscalYearVariant: 'FORGED',
      postingPeriodVariant: 'FORGED',
    })) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = field;
      input.value = value;
      form.appendChild(input);
    }
  });
  await assignmentForm.getByRole('button', { name: 'Assign', exact: true }).click();
  await page.waitForFunction(
    ({ targetCode, targetName, chart }) => {
      const row = Array.from(document.querySelectorAll('tbody tr')).find((candidate) => {
        const cells = candidate.querySelectorAll('td');
        return cells[0]?.textContent?.trim() === targetCode && cells[1]?.textContent?.trim() === targetName;
      });
      return row?.querySelectorAll('td')[4]?.textContent?.trim() === chart
        && !row.querySelector('select[name="chartOfAccounts"]');
    },
    { targetCode: code, targetName: name, chart: activeChart },
  );

  companyRows = await listCompanyCodes(CLIENT);
  created = companyRows.filter((row) => row.companyCode === code);
  assert.equal(created.length, 1);
  assert.deepEqual(
    {
      client: created[0].client,
      name: created[0].name,
      chartOfAccounts: created[0].chartOfAccounts,
      fiscalYearVariant: created[0].fiscalYearVariant,
      postingPeriodVariant: created[0].postingPeriodVariant,
      createdBy: created[0].createdBy,
      changedBy: created[0].changedBy,
    },
    {
      client: CLIENT,
      name,
      chartOfAccounts: activeChart,
      fiscalYearVariant: null,
      postingPeriodVariant: null,
      createdBy: 'browser.admin',
      changedBy: 'company.assigner',
    },
  );
  assert.deepEqual(companyRows.filter((row) => !row.chartOfAccounts).map((row) => row.companyCode), []);

  const assignmentHistory = await withTenant(CLIENT, (tx) =>
    changeHistory(tx, CLIENT, 'company_code', code),
  );
  assert.equal(assignmentHistory.length, 2, 'Definition and initial assignment each write one change document.');
  const assignmentEvent = assignmentHistory.find((event) => event.transactionCode === 'CFG.ORG.COMPANYCODE.ASSIGN_COA');
  assert.ok(assignmentEvent, 'The initial assignment writes SCR-013 change evidence.');
  assert.equal(assignmentEvent.changeType, 'CHANGE');
  assert.equal(assignmentEvent.changedBy, 'company.assigner');
  assert.equal(assignmentEvent.items.length, 1);
  assert.equal(assignmentEvent.items[0].fieldName, 'chartOfAccounts');
  assert.equal(assignmentEvent.items[0].oldValue, null);
  assert.equal(assignmentEvent.items[0].newValue, activeChart);
  assert.equal(assignmentEvent.items[0].isSecurityRelevant, 'true');
  const activityRows = (await withTenant(CLIENT, (tx) =>
    tx.execute(sql`
      select status, completed_by from config_activity_status
       where client = ${CLIENT} and activity_code = 'CFG.ORG.COMPANYCODE.ASSIGN_COA'
    `),
  )) as unknown as Array<{ status: string; completed_by: string }>;
  assert.equal(activityRows.length, 1);
  assert.equal(activityRows[0].status, 'COMPLETED');
  assert.equal(activityRows[0].completed_by, 'company.assigner');
  console.log('  ✓ assignment-only session saves one CoA, preserves FYV/PPV, ignores forged tenant/actor values and records audit evidence');

  // The server-action revalidation and a fresh request both remove the initial-only control.
  const assignedRow = companyRow();
  assert.deepEqual((await assignedRow.locator('td').allInnerTexts()).slice(0, 7), [
    code,
    name,
    'KWD',
    'KW',
    activeChart,
    'Not assigned',
    'Not assigned',
  ]);
  assert.equal(await assignedRow.locator('select[name="chartOfAccounts"]').count(), 0);
  assert.equal(await assignedRow.getByRole('link').count(), 0, 'Posting periods remain unavailable until their separate assignments.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Company codes', exact: true }).waitFor();
  const refreshedRow = companyRow();
  await refreshedRow.waitFor();
  assert.deepEqual((await refreshedRow.locator('td').allInnerTexts()).slice(0, 7), [
    code,
    name,
    'KWD',
    'KW',
    activeChart,
    'Not assigned',
    'Not assigned',
  ]);
  assert.equal(await refreshedRow.locator('select[name="chartOfAccounts"]').count(), 0);
  assert.equal(await page.locator('select[name="chartOfAccounts"]').count(), 0, 'Assigned Company Codes have no replacement control.');

  await signInAs('company.viewer');
  await page.getByText('Read-only view. Changes require authority CFG.ORG.COMPANYCODE.DEFINE.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Create company code', exact: true }).count(), 0);
  assert.equal(await page.locator('select').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Assign', exact: true }).count(), 0);
  const finalViewerRow = companyRow();
  await finalViewerRow.waitFor();
  assert.deepEqual((await finalViewerRow.locator('td').allInnerTexts()).slice(0, 7), [
    code,
    name,
    'KWD',
    'KW',
    activeChart,
    'Not assigned',
    'Not assigned',
  ]);
  console.log('  ✓ refreshed UI and cookie-backed Auditor show the saved assignment read-only, with no replacement control');
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

async function paymentMethods(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  await page.goto(`${BASE}/config`, { waitUntil: 'domcontentloaded' });
  const activity = page.locator('tr').filter({ hasText: 'CFG.FIN.PAYMENTMETHOD.DEFINE' });
  await activity.waitFor();
  assert.match(await activity.innerText(), /Not started/i);
  await activity.getByRole('link', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/config\/payment-methods/);
  await page.locator('select[name="country"]').selectOption('KW');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByText('No methods are defined for this country.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Create payment method', exact: true }).click();

  await page.locator('[name="methodCode"]').fill('B1');
  await page.locator('input[name="description"]').fill('Browser Payment Method');
  await page.locator('[name="allowedDirection"]').selectOption('BOTH');
  await page.locator('input[name="reason"]').fill('Browser payment method create');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Payment Method saved and change evidence recorded.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open saved Payment Method', exact: true }).click();
  let method = await getPaymentMethod(CLIENT, 'KW', 'B1');
  assert.equal(method?.description, 'Browser Payment Method');
  assert.equal(method?.allowedDirection, 'BOTH');
  assert.equal(method?.version, 1);
  const statusRows = await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status from config_activity_status
    where client = ${CLIENT} and activity_code = 'CFG.FIN.PAYMENTMETHOD.DEFINE'
  `)) as unknown as Array<{ status: string }>;
  assert.equal(statusRows[0]?.status, 'COMPLETED');
  console.log('  ✓ workbench route, empty tenant state, create, audit actor and activity completion');

  await page.getByRole('link', { name: 'Change', exact: true }).click();
  assert.equal(await page.locator('[name="methodCode"]').getAttribute('readonly'), '');
  await page.locator('input[name="description"]').fill('Browser Payment Method revised');
  await page.locator('[name="allowedDirection"]').selectOption('INCOMING');
  await page.locator('input[name="reason"]').fill('Browser payment method change');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Payment Method saved and change evidence recorded.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open saved Payment Method', exact: true }).click();
  method = await getPaymentMethod(CLIENT, 'KW', 'B1');
  assert.equal(method?.description, 'Browser Payment Method revised');
  assert.equal(method?.allowedDirection, 'INCOMING');
  assert.equal(method?.version, 2);
  await page.getByRole('link', { name: 'Change history', exact: true }).click();
  await page.getByText('Browser payment method create', { exact: true }).waitFor();
  await page.getByText('Browser payment method change', { exact: true }).waitFor();
  console.log('  ✓ code immutability, versioned change and history');

  const viewerId = randomUUID();
  const password = await hashPassword(PASSWORD);
  await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into app_user (id, client, username, full_name, password_hash, must_change_password, created_by)
      values (${viewerId}, ${CLIENT}, 'payment.viewer', 'Payment Method Viewer', ${password}, false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
      values (${CLIENT}, ${viewerId}, 'WAREHOUSE_CLERK', 'BROWSER_FIXTURE')`);
  });
  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/', { waitUntil: 'domcontentloaded' });
  }
  await signInAs('payment.viewer');
  await page.goto(`${BASE}/config/payment-methods?country=KW`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Browser Payment Method revised', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Create payment method', exact: true }).count(), 0);
  await page.goto(`${BASE}/config/payment-methods?country=KW&code=B1&client=0100`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Browser Payment Method revised', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
  assert.equal(await page.getByText('Retire this method', { exact: true }).count(), 0, 'Display-only user cannot see retire controls for an active method');
  await page.goto(`${BASE}/config/payment-methods?country=KW&code=B1&edit=1&client=0100`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Browser Payment Method revised', { exact: true }).waitFor();
  assert.equal(await page.locator('input[name="reason"]').count(), 0, 'Forged edit query must not expose a form');
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Change history', exact: true }).click();
  await page.getByText('Browser payment method change', { exact: true }).waitFor();
  console.log('  ✓ non-configurator is display-only; forged tenant/edit query does not grant maintenance');

  await signInAs('browser.admin');
  await page.goto(`${BASE}/config/payment-methods?country=KW&code=B1`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Retire this method', { exact: true }).click();
  await page.locator('input[name="reason"]').fill('Browser payment method retirement');
  await page.getByRole('checkbox', { name: 'I understand this method will be inactive and retained for review.' }).check();
  await page.getByRole('button', { name: 'Confirm retirement', exact: true }).click();
  await page.getByText('Payment Method retired and retained for review.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open saved Payment Method', exact: true }).click();
  method = await getPaymentMethod(CLIENT, 'KW', 'B1');
  assert.equal(method?.isActive, false);
  assert.equal(method?.version, 3);
  await page.getByRole('link', { name: 'Change history', exact: true }).click();
  await page.getByText('Browser payment method retirement', { exact: true }).waitFor();
  await page.goto(`${BASE}/config`, { waitUntil: 'domcontentloaded' });
  const completed = page.locator('tr').filter({ hasText: 'CFG.FIN.PAYMENTMETHOD.DEFINE' });
  assert.match(await completed.innerText(), /Completed/i);
  console.log('  ✓ explicit versioned soft retirement retains the definition and evidence');
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

  await page.getByRole('link',{name:'Bank details',exact:true}).click();
  await page.getByRole('heading',{name:'Partner-wide bank records',exact:true}).waitFor();
  await page.getByText('No bank records are available for this partner.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:/reveal/i}).count(),0);

  const bankRecordId = await insertSyntheticPartnerBankRecord(CLIENT, 'TESTSUPP01');
  await page.goto(`${BASE}/foundation/partners?partner=TESTSUPP01&view=BANKS`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Synthetic Test Holder', { exact: true }).waitFor();
  await page.getByText('••••', { exact: true }).waitFor();
  const detailsLink = page.getByRole('link', { name: 'View details', exact: true });
  assert.equal(await detailsLink.count(), 1);
  assert.ok((await detailsLink.getAttribute('href'))?.includes(`bank=${bankRecordId}`));
  await detailsLink.click();
  await page.getByRole('heading', { name: 'Bank record details', exact: true }).waitFor();
  await page.getByText('••••4321', { exact: true }).waitFor();
  const maskedDetailText = await page.locator('body').innerText();
  assert.equal(maskedDetailText.includes(SYNTHETIC_BANK_IDENTIFIER), false);
  assert.equal((await page.content()).includes('cbd1.'), false);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /reveal/i }).count(), 0);
  await page.getByRole('link', { name: 'Back to bank records', exact: true }).click();
  await page.getByRole('heading', { name: 'Partner-wide bank records', exact: true }).waitFor();
  await page.getByRole('link',{name:'General data',exact:true}).click();
  await page.locator('[name="partnerNumber"][readonly]').waitFor();
  console.log('  ✓ masked detail shows only the synthetic D-074 suffix and no save/reveal controls');

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
  console.log('  ✓ general partner search/history and bank metadata empty state are visible');

  const id=randomUUID();const password=await hashPassword(PASSWORD);
  await withTenant(CLIENT,async tx=>{
    // Give this synthetic warehouse viewer partner display, but not maintain.
    await tx.execute(sql`insert into role_capability(client,role_code,capability_code,created_by) values(${CLIENT},'WAREHOUSE_CLERK','FND.PARTNER.DISPLAY','BROWSER_FIXTURE') on conflict (client,role_code,capability_code) do nothing`);
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
  await page.goto(`${BASE}/foundation/partners?partner=TESTSUPP01&view=BANKS`,{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'Partner-wide bank records',exact:true}).waitFor();
  await page.getByText('Synthetic Test Holder',{exact:true}).waitFor();
  await page.getByText('••••',{exact:true}).waitFor();
  await page.getByRole('link',{name:'View details',exact:true}).click();
  await page.getByRole('heading',{name:'Bank record details',exact:true}).waitFor();
  await page.getByText('••••4321',{exact:true}).waitFor();
  assert.equal((await page.locator('body').innerText()).includes(SYNTHETIC_BANK_IDENTIFIER),false);
  assert.equal((await page.content()).includes('cbd1.'),false);
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:/reveal/i}).count(),0);
  console.log('  ✓ display-only user sees the suffix mask but cannot maintain or reveal');
}

async function supplierCompany(ctx: BrowserContext) {
  const {page,BASE,CLIENT}=scope(ctx);
  page.setDefaultNavigationTimeout(30_000);
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
  const pendingDefaults=page.locator('fieldset').filter({hasText:'Additional company-code defaults'});
  assert.equal(await pendingDefaults.count(),1);
  assert.equal(await pendingDefaults.locator('input').count(),3);
  assert.equal(await pendingDefaults.locator('input:disabled').count(),3);
  assert.equal(await pendingDefaults.locator('input[name]').count(),0,'Pending defaults are display-only and never submitted.');
  const paymentMethods=page.getByRole('group',{name:'Payment methods'});
  assert.equal(await page.locator('input[name="paymentMethods"]').count(),1);
  assert.equal(await page.locator('input[name="paymentMethods"]').inputValue(),'');
  assert.equal(await paymentMethods.locator('input[type="checkbox"]').count(),0);
  await page.getByText('No active outgoing or BOTH methods are configured for the country assigned to this company code.',{exact:true}).waitFor();
  console.log('  ✓ three pending defaults stay disabled; empty eligible-method editor submits a clear field');
  await page.locator('[name="reason"]').fill('Browser staged supplier accounting');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier company view saved. Status: Incomplete.',{exact:true}).waitFor();
  await page.locator('[name="reason"]').fill('Browser unchanged supplier accounting');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No supplier company data changed.',{exact:true}).waitFor();
  assert.equal((await getSupplierCompany(CLIENT,'TESTSUPP01','1000'))?.version,1);
  async function createMethodFixture(country:string,code:string,direction:'OUTGOING'|'INCOMING'|'BOTH'){
    await savePaymentMethod({
      client:CLIENT,country,methodCode:code,expectedVersion:0,changedBy:'BROWSER_FIXTURE',
      reason:`Supplier Payment Methods browser fixture ${country}/${code}`,
      values:{description:`Browser supplier ${code} ${direction}`,allowedDirection:direction,isActive:true},
    });
  }
  const eligiblePaymentMethods=[
    {code:'B1',direction:'BOTH'},{code:'C1',direction:'OUTGOING'},{code:'D1',direction:'OUTGOING'},
    {code:'E1',direction:'OUTGOING'},{code:'F1',direction:'OUTGOING'},{code:'G1',direction:'OUTGOING'},
    {code:'H1',direction:'OUTGOING'},{code:'J1',direction:'OUTGOING'},{code:'K1',direction:'OUTGOING'},
    {code:'O1',direction:'OUTGOING'},{code:'P1',direction:'OUTGOING'},
  ] as const;
  const methodLabel=(method:typeof eligiblePaymentMethods[number])=>`${method.code} · Browser supplier ${method.code} ${method.direction}`;
  const selectedPaymentMethods=eligiblePaymentMethods.slice(0,10);
  for(const method of eligiblePaymentMethods) await createMethodFixture('KW',method.code,method.direction);
  await createMethodFixture('KW','I1','INCOMING');
  await createMethodFixture('US','U1','OUTGOING');
  await page.goto(`${BASE}/foundation/partners?partner=TESTSUPP01&view=SUPPLIER_COMPANY&company=1000`,{waitUntil:'networkidle'});
  const methodsGroup=page.getByRole('group',{name:'Payment methods'});
  await methodsGroup.getByText(methodLabel(eligiblePaymentMethods[0]),{exact:true}).waitFor();
  assert.equal(await methodsGroup.getByRole('checkbox').count(),eligiblePaymentMethods.length,'Only same-country outgoing/BOTH methods are selectable.');
  assert.equal(await methodsGroup.getByText('I1 · Browser supplier I1 INCOMING',{exact:true}).count(),0);
  assert.equal(await methodsGroup.getByText('U1 · Browser supplier U1 OUTGOING',{exact:true}).count(),0);
  for(const method of selectedPaymentMethods) await methodsGroup.getByRole('checkbox',{name:methodLabel(method)}).check();
  const savedPaymentMethods=selectedPaymentMethods.map(method=>method.code).join(',');
  await page.waitForFunction(expected=>document.querySelector<HTMLInputElement>('input[name="paymentMethods"]')?.value===expected,savedPaymentMethods);
  const eleventhPaymentMethod=eligiblePaymentMethods[10];
  assert.equal(await methodsGroup.getByRole('checkbox',{name:methodLabel(eleventhPaymentMethod)}).isDisabled(),true,'An eleventh selection must be disabled.');
  await page.locator('[name="reconciliationAccount"]').selectOption('200000');
  await page.locator('[name="paymentTermsCode"]').selectOption('NET30');
  await page.locator('[name="reason"]').fill('Browser supplier accounting completion');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier company view saved. Status: Created.',{exact:true}).waitFor();
  const completedSupplierCompany=await getSupplierCompany(CLIENT,'TESTSUPP01','1000');
  assert.equal(completedSupplierCompany?.chartOfAccounts,'CAIRN');
  assert.equal(completedSupplierCompany?.paymentMethods,savedPaymentMethods);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('input[name="paymentMethods"]').waitFor({state:'attached'});
  assert.equal(await page.locator('input[name="paymentMethods"]').inputValue(),savedPaymentMethods);
  for(const method of selectedPaymentMethods) assert.equal(await page.getByRole('checkbox',{name:methodLabel(method)}).isChecked(),true);
  assert.equal(await page.getByRole('checkbox',{name:methodLabel(eleventhPaymentMethod)}).isDisabled(),true);
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
    await tx.execute(sql`insert into role(client,code,name,is_read_only,created_by) values(${CLIENT},'PARTNER_VIEWER','Partner viewer',true,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability(client,role_code,capability_code) values(${CLIENT},'PARTNER_VIEWER','FND.PARTNER.DISPLAY')`);
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${id},${CLIENT},'company.viewer','Company Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${id},'WAREHOUSE_CLERK','BROWSER_FIXTURE'),(${CLIENT},${id},'PARTNER_VIEWER','BROWSER_FIXTURE')`);
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

  const financeViewerId=randomUUID();
  await withTenant(CLIENT,async tx=>{
    await tx.execute(sql`insert into role(client,code,name,is_read_only,created_by) values(${CLIENT},'SUPPLIER_FINANCE_VIEWER','Supplier finance viewer',true,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability(client,role_code,capability_code) values(${CLIENT},'SUPPLIER_FINANCE_VIEWER','FIN.SUPPLIER.COMPANY.DISPLAY')`);
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${financeViewerId},${CLIENT},'finance.viewer','Finance Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${financeViewerId},'WAREHOUSE_CLERK','BROWSER_FIXTURE'),(${CLIENT},${financeViewerId},'PARTNER_VIEWER','BROWSER_FIXTURE'),(${CLIENT},${financeViewerId},'SUPPLIER_FINANCE_VIEWER','BROWSER_FIXTURE')`);
  });
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.goto(`${BASE}/signin`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="client"]').fill(CLIENT);await page.locator('[name="username"]').fill('finance.viewer');await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/$/);
  await page.goto(`${BASE}/foundation/partners?partner=TESTSUPP01&view=SUPPLIER_COMPANY&company=1000`,{waitUntil:'domcontentloaded'});
  await page.getByText('Payment methods',{exact:true}).waitFor();
  await page.getByText(savedPaymentMethods,{exact:true}).waitFor();
  assert.equal(await page.locator('input[name="paymentMethods"]').count(),0,'Display-only users must not receive an editable Payment Methods field.');
  assert.equal(await page.getByRole('checkbox').count(),0);
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  console.log('  ✓ authorized display-only user sees saved Payment Methods without controls');

  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.goto(`${BASE}/signin`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="client"]').fill(CLIENT);await page.locator('[name="username"]').fill('browser.admin');await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/$/);
  await page.goto(`${BASE}/config/payment-methods?country=KW&code=B1`,{waitUntil:'domcontentloaded'});
  await page.getByText('Retire this method',{exact:true}).click();
  await page.locator('input[name="reason"]').fill('Browser supplier stale method retirement');
  await page.getByRole('checkbox',{name:'I understand this method will be inactive and retained for review.'}).check();
  await page.getByRole('button',{name:'Confirm retirement',exact:true}).click();
  await page.getByText('Payment Method retired and retained for review.',{exact:true}).waitFor();
  await page.goto(`${BASE}/foundation/partners?partner=TESTSUPP01&view=SUPPLIER_COMPANY&company=1000`,{waitUntil:'domcontentloaded'});
  const staleMethodsGroup=page.getByRole('group',{name:'Payment methods'});
  await page.getByText('Some saved methods are no longer eligible for this company code. Uncheck them before saving.',{exact:true}).waitFor();
  const staleMethod=staleMethodsGroup.getByRole('checkbox',{name:/^B1 · No longer eligible/});
  assert.equal(await staleMethod.isChecked(),true);
  assert.equal(await staleMethodsGroup.getByRole('checkbox',{name:'O1 · Browser supplier O1 OUTGOING'}).isChecked(),true);
  await staleMethod.click();
  const paymentMethodsAfterStaleRemoval=selectedPaymentMethods.slice(1).map(method=>method.code).join(',');
  await page.waitForFunction(expected=>document.querySelector<HTMLInputElement>('input[name="paymentMethods"]')?.value===expected,paymentMethodsAfterStaleRemoval);
  await page.locator('[name="reason"]').fill('Browser clear stale supplier Payment Method');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier company view saved. Status: Maintained.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='6');
  let clearedStale=await getSupplierCompany(CLIENT,'TESTSUPP01','1000');
  assert.equal(clearedStale?.paymentMethods,paymentMethodsAfterStaleRemoval);
  assert.equal(clearedStale?.version,6);
  for(const method of selectedPaymentMethods.slice(1)){
    await page.getByRole('group',{name:'Payment methods'}).getByRole('checkbox',{name:methodLabel(method)}).uncheck();
  }
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="paymentMethods"]')?.value==='');
  await page.locator('[name="reason"]').fill('Browser explicitly clear all supplier Payment Methods');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier company view saved. Status: Maintained.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='7');
  clearedStale=await getSupplierCompany(CLIENT,'TESTSUPP01','1000');
  assert.equal(clearedStale?.paymentMethods,null);
  assert.equal(clearedStale?.version,7);
  console.log('  ✓ stale saved method can be removed; an empty selection explicitly clears the stored set');
}

async function supplierPartnerFunctionEditor(ctx: BrowserContext) {
  const {page,BASE,CLIENT}=scope(ctx);
  const focal='TESTSUPP01', view=`${BASE}/foundation/partners?partner=${focal}&view=SUPPLIER_PURCHASING&org=1000`;
  await createSupplierRoleThroughUi(page,BASE,'TESTSUPP02','Browser Related Supplier A');
  await createSupplierRoleThroughUi(page,BASE,'TESTSUPP03','Browser Related Supplier B');

  // The product has no cardinality editor. This fixture-only rule change exposes the approved multiple-role path.
  const ruleRows=await withTenant(CLIENT,tx=>tx.execute(sql`update supplier_partner_function set allows_multiple=true where client=${CLIENT} and function_code='DELIVERY_PARTNER' returning function_code`)) as unknown as Array<{function_code:string}>;
  assert.deepEqual(ruleRows.map(row=>row.function_code),['DELIVERY_PARTNER']);
  await page.goto(view,{waitUntil:'domcontentloaded'});
  const panel=page.locator('section[aria-labelledby="supplier-partner-functions-title"]');
  const card=(code:string)=>panel.locator('article').filter({hasText:code});
  const ordering=card('ORDERING_PARTNER');
  await ordering.getByText('Unique',{exact:true}).waitFor();
  for(const number of ['TESTSUPP02','TESTSUPP03']){
    assert.equal(await ordering.locator('select[name="assignedPartnerNumber"] option').filter({hasText:number}).count(),1);
  }
  await ordering.locator('select[name="assignedPartnerNumber"]').selectOption('TESTSUPP02');
  await ordering.locator('input[name="reason"]').fill('Browser unique partner-function add');
  const uniqueAddButton=ordering.getByRole('button',{name:'Add assignment',exact:true});
  await uniqueAddButton.click();
  await ordering.getByRole('button',{name:'Replace assignment',exact:true}).waitFor();
  let assignments=await listSupplierPurchasingPartners(CLIENT,focal,'1000');
  let orderingRows=assignments.filter(row=>row.functionCode==='ORDERING_PARTNER');
  assert.equal(orderingRows.length,1);assert.equal(orderingRows[0].assignedPartnerNumber,'TESTSUPP02');

  await page.goto(view,{waitUntil:'domcontentloaded'});
  const orderingAfterAdd=card('ORDERING_PARTNER');
  await orderingAfterAdd.getByText('Replace with Supplier',{exact:true}).waitFor();
  const replaceForm=orderingAfterAdd.locator('form:has(select[name="assignedPartnerNumber"])');
  await replaceForm.locator('select[name="assignedPartnerNumber"]').selectOption('TESTSUPP03');
  await replaceForm.locator('input[name="reason"]').fill('Browser unique partner-function replacement');
  const replaceButton=replaceForm.getByRole('button',{name:'Replace assignment',exact:true});
  await replaceButton.click();
  await replaceForm.getByRole('button',{name:'Replace assignment',exact:true}).waitFor();
  assignments=await listSupplierPurchasingPartners(CLIENT,focal,'1000');
  orderingRows=assignments.filter(row=>row.functionCode==='ORDERING_PARTNER');
  assert.equal(orderingRows.length,1);assert.equal(orderingRows[0].assignedPartnerNumber,'TESTSUPP03');
  await page.goto(view,{waitUntil:'domcontentloaded'});
  const replacedRow=card('ORDERING_PARTNER').locator('li').filter({hasText:'TESTSUPP03'});
  assert.equal(await replacedRow.count(),1);
  await replacedRow.locator('form').last().locator('[name="reason"]').fill('Browser unique partner-function removal');
  const uniqueRemoveButton=replacedRow.getByRole('button',{name:'Remove assignment',exact:true});
  await uniqueRemoveButton.click();
  await uniqueRemoveButton.waitFor({state:'detached'});
  assignments=await listSupplierPurchasingPartners(CLIENT,focal,'1000');
  assert.equal(assignments.filter(row=>row.functionCode==='ORDERING_PARTNER').length,0);
  console.log('  ✓ unique assignment add, replacement and reasoned removal persist through the UI');

  await page.goto(view,{waitUntil:'domcontentloaded'});
  let delivery=card('DELIVERY_PARTNER');
  await delivery.getByText('Multiple',{exact:true}).waitFor();
  let addForm=delivery.locator('form:has(select[name="assignedPartnerNumber"])');
  await addForm.locator('select[name="assignedPartnerNumber"]').selectOption('TESTSUPP02');
  await addForm.locator('input[name="reason"]').fill('Browser multiple partner-function add');
  const firstMultipleAddButton=addForm.getByRole('button',{name:'Add assignment',exact:true});
  await firstMultipleAddButton.click();
  await firstMultipleAddButton.waitFor();
  await delivery.getByText('No default is set. A purchasing transaction must ask the user to choose.',{exact:true}).waitFor();
  assignments=await listSupplierPurchasingPartners(CLIENT,focal,'1000');
  let deliveryRows=assignments.filter(row=>row.functionCode==='DELIVERY_PARTNER');
  assert.equal(deliveryRows.length,1);assert.equal(deliveryRows[0].assignedPartnerNumber,'TESTSUPP02');assert.equal(deliveryRows[0].isDefault,false);

  await page.goto(view,{waitUntil:'domcontentloaded'});
  delivery=card('DELIVERY_PARTNER');
  addForm=delivery.locator('form:has(select[name="assignedPartnerNumber"])');
  await addForm.locator('select[name="assignedPartnerNumber"]').selectOption('TESTSUPP03');
  await addForm.locator('input[name="isDefault"]').check();
  await addForm.locator('input[name="reason"]').fill('Browser multiple partner-function default add');
  const secondMultipleAddButton=addForm.getByRole('button',{name:'Add assignment',exact:true});
  await secondMultipleAddButton.click();
  await secondMultipleAddButton.waitFor();
  assignments=await listSupplierPurchasingPartners(CLIENT,focal,'1000');
  deliveryRows=assignments.filter(row=>row.functionCode==='DELIVERY_PARTNER');
  assert.equal(deliveryRows.length,2);assert.equal(deliveryRows.filter(row=>row.isDefault).length,1);
  assert.equal(deliveryRows.find(row=>row.isDefault)?.assignedPartnerNumber,'TESTSUPP03');

  await page.goto(view,{waitUntil:'domcontentloaded'});
  delivery=card('DELIVERY_PARTNER');
  const defaultRow=delivery.locator('li').filter({hasText:'TESTSUPP03'});
  const defaultForm=defaultRow.locator('form').first();
  await defaultForm.locator('input[name="isDefault"]').uncheck();
  await defaultForm.locator('input[name="reason"]').fill('Browser multiple partner-function default unset');
  const unsetButton=defaultForm.getByRole('button',{name:'Save',exact:true});
  await unsetButton.click();
  await unsetButton.waitFor();
  await delivery.getByText('No default is set. A purchasing transaction must ask the user to choose.',{exact:true}).waitFor();
  assignments=await listSupplierPurchasingPartners(CLIENT,focal,'1000');
  deliveryRows=assignments.filter(row=>row.functionCode==='DELIVERY_PARTNER');
  assert.equal(deliveryRows.filter(row=>row.isDefault).length,0);

  await page.goto(view,{waitUntil:'domcontentloaded'});
  delivery=card('DELIVERY_PARTNER');
  const newDefaultRow=delivery.locator('li').filter({hasText:'TESTSUPP02'});
  const newDefaultForm=newDefaultRow.locator('form').first();
  await newDefaultForm.locator('input[name="isDefault"]').check();
  await newDefaultForm.locator('input[name="reason"]').fill('Browser multiple partner-function default transfer');
  const transferButton=newDefaultForm.getByRole('button',{name:'Save',exact:true});
  await transferButton.click();
  await transferButton.waitFor();
  assignments=await listSupplierPurchasingPartners(CLIENT,focal,'1000');
  deliveryRows=assignments.filter(row=>row.functionCode==='DELIVERY_PARTNER');
  assert.equal(deliveryRows.filter(row=>row.isDefault).length,1);
  assert.equal(deliveryRows.find(row=>row.isDefault)?.assignedPartnerNumber,'TESTSUPP02');

  await page.goto(view,{waitUntil:'domcontentloaded'});
  delivery=card('DELIVERY_PARTNER');
  const promotedRow=delivery.locator('li').filter({hasText:'TESTSUPP02'});
  await promotedRow.locator('form').last().locator('[name="reason"]').fill('Browser remove current default partner');
  const currentDefaultRemoveButton=promotedRow.getByRole('button',{name:'Remove assignment',exact:true});
  await currentDefaultRemoveButton.click();
  await currentDefaultRemoveButton.waitFor({state:'detached'});
  assignments=await listSupplierPurchasingPartners(CLIENT,focal,'1000');
  deliveryRows=assignments.filter(row=>row.functionCode==='DELIVERY_PARTNER');
  assert.equal(deliveryRows.length,1);assert.equal(deliveryRows[0].assignedPartnerNumber,'TESTSUPP03');assert.equal(deliveryRows[0].isDefault,false);
  await page.goto(view,{waitUntil:'domcontentloaded'});
  delivery=card('DELIVERY_PARTNER');
  await delivery.getByText('No default is set. A purchasing transaction must ask the user to choose.',{exact:true}).waitFor();

  const auditorId=randomUUID();const password=await hashPassword(PASSWORD);
  await withTenant(CLIENT,async tx=>{
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${auditorId},${CLIENT},'partner.auditor','Partner Function Auditor',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${auditorId},'AUDITOR','BROWSER_FIXTURE')`);
  });
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.goto(`${BASE}/signin`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="client"]').fill(CLIENT);await page.locator('[name="username"]').fill('partner.auditor');await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/$/);
  await page.goto(view,{waitUntil:'domcontentloaded'});
  const auditPanel=page.locator('section[aria-labelledby="supplier-partner-functions-title"]');
  await auditPanel.getByRole('heading',{name:'Supplier partner functions',exact:true}).waitFor();
  await auditPanel.getByText('TESTSUPP03',{exact:true}).waitFor();
  await auditPanel.getByText('No default is set. A purchasing transaction must ask the user to choose.',{exact:true}).waitFor();
  assert.equal(await auditPanel.locator('form').count(),0,'Display-only readers cannot see assignment forms.');
  assert.equal(await auditPanel.getByRole('button',{name:/Add assignment|Replace assignment|Remove assignment/}).count(),0);
  console.log('  ✓ multiple add, default set/unset/transfer and no-promotion-on-remove pass; AUDITOR can read without edit controls');
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
  const partnerFunctionsPanel=page.locator('section[aria-labelledby="supplier-partner-functions-title"]');
  const purchasingForm=page.locator('form:has([name="orderCurrency"])');
  await partnerFunctionsPanel.getByRole('heading',{name:'Supplier partner functions',exact:true}).waitFor();
  await partnerFunctionsPanel.getByText('Save the supplier purchasing-organisation segment before adding partner assignments.',{exact:true}).waitFor();
  assert.equal(await partnerFunctionsPanel.locator('article').count(),3);
  assert.equal(await partnerFunctionsPanel.getByText('Unique',{exact:true}).count(),3,'Standard catalogue functions start as unique.');
  assert.equal(await partnerFunctionsPanel.locator('form').count(),0,'Partner assignments stay disabled before the purchasing segment exists.');
  for(const functionCode of ['ORDERING_PARTNER','DELIVERY_PARTNER','INVOICE_SENDER']){
    await partnerFunctionsPanel.getByText(functionCode,{exact:true}).waitFor();
  }
  console.log('  ✓ all three unique functions display, with assignment controls gated until the purchasing segment exists');
  await purchasingForm.locator('[name="reason"]').fill('Browser staged supplier purchasing');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier purchasing view saved. Status: Incomplete.',{exact:true}).waitFor();
  await partnerFunctionsPanel.getByText('Save the supplier purchasing-organisation segment before adding partner assignments.',{exact:true}).waitFor({state:'hidden'});
  assert.equal(await partnerFunctionsPanel.locator('form').count(),3,'Maintainers can edit after the purchasing segment exists.');
  await purchasingForm.locator('[name="reason"]').fill('Browser unchanged buying defaults');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No supplier purchasing data changed.',{exact:true}).waitFor();
  assert.equal((await getSupplierPurchasing(CLIENT,'TESTSUPP01','1000'))?.version,1);
  await page.locator('[name="orderCurrency"]').selectOption('USD');
  await page.locator('[name="purchasingGroup"]').selectOption('001');
  await page.locator('[name="incotermsCode"]').selectOption('FCA');
  await page.locator('[name="incotermsLocation"]').fill('Kuwait City');
  await page.locator('[name="paymentTermsCode"]').selectOption('NET30');
  await purchasingForm.locator('[name="reason"]').fill('Browser buying defaults completion');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier purchasing view saved. Status: Created.',{exact:true}).waitFor();
  assert.equal((await getSupplierPurchasing(CLIENT,'TESTSUPP01','1000'))?.orderCurrency,'USD');
  await page.locator('[name="incotermsLocation"]').fill('Test receiving site');
  await page.locator('[name="paymentTermsCode"]').selectOption('NET15');
  await purchasingForm.locator('[name="reason"]').fill('Browser buying defaults maintenance');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Supplier purchasing view saved. Status: Maintained.',{exact:true}).waitFor();
  await page.locator('[name="isBlocked"]').check();
  await purchasingForm.locator('[name="reason"]').fill('Browser buying organisation hold');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Blocked',{exact:true}).waitFor();
  await page.locator('[name="isBlocked"]').uncheck();
  await purchasingForm.locator('[name="reason"]').fill('Browser buying organisation cleared');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='5');
  await page.locator('[name="orderCurrency"]').evaluate(select=>{const option=document.createElement('option');option.value='ZZZ';option.text='Invalid test currency';select.appendChild(option);});
  await page.locator('[name="orderCurrency"]').selectOption('ZZZ');
  await purchasingForm.locator('[name="reason"]').fill('Invalid order currency test');
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
  await supplierPartnerFunctionEditor(ctx);

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
  for(const field of ['interestIndicator','toleranceGroup']){
    assert.equal(await page.locator(`[name="${field}"]`).getAttribute('maxlength'),'4');
    assert.equal(await page.locator(`[name="${field}"]`).getAttribute('pattern'),'[A-Za-z0-9]{1,4}');
  }
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
  await page.locator('[name="paymentMethods"]').fill(' t , c,C ');
  await page.locator('[name="dunningProcedure"]').fill('ma04');
  await page.locator('[name="reason"]').fill('Browser customer payment and dunning codes');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='4');
  const paymentDunning=await getCustomerCompany(CLIENT,'TESTCUST01','1000');
  assert.equal(paymentDunning?.paymentMethods,'C,T');
  assert.equal(paymentDunning?.dunningProcedure,'MA04');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('[name="paymentMethods"]').waitFor();
  assert.equal(await page.locator('[name="paymentMethods"]').inputValue(),'C,T');
  assert.equal(await page.locator('[name="dunningProcedure"]').inputValue(),'MA04');
  await page.locator('[name="paymentMethods"]').fill('T C');
  await page.locator('[name="dunningProcedure"]').fill('MA04');
  await page.locator('[name="reason"]').fill('Browser reordered payment methods');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No customer company data changed.',{exact:true}).waitFor();
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.version,4);
  await page.locator('[name="interestIndicator"]').fill('i1');
  await page.locator('[name="toleranceGroup"]').fill('t1');
  await page.locator('[name="reason"]').fill('Browser customer interest and tolerance codes');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='5');
  const interestTolerance=await getCustomerCompany(CLIENT,'TESTCUST01','1000');
  assert.equal(interestTolerance?.interestIndicator,'I1');
  assert.equal(interestTolerance?.toleranceGroup,'T1');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('[name="interestIndicator"]').waitFor();
  assert.equal(await page.locator('[name="interestIndicator"]').inputValue(),'I1');
  assert.equal(await page.locator('[name="toleranceGroup"]').inputValue(),'T1');
  await page.locator('[name="interestIndicator"]').fill('i1');
  await page.locator('[name="toleranceGroup"]').fill('t1');
  await page.locator('[name="reason"]').fill('Browser canonical interest and tolerance no-op');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No customer company data changed.',{exact:true}).waitFor();
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.version,5);
  await page.locator('[name="interestIndicator"]').fill('');
  await page.locator('[name="toleranceGroup"]').fill('');
  await page.locator('[name="reason"]').fill('Browser clear interest and tolerance codes');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='6');
  const clearedInterestTolerance=await getCustomerCompany(CLIENT,'TESTCUST01','1000');
  assert.equal(clearedInterestTolerance?.interestIndicator,null);
  assert.equal(clearedInterestTolerance?.toleranceGroup,null);
  await page.locator('[name="interestIndicator"]').fill('i1');
  await page.locator('[name="toleranceGroup"]').fill('t1');
  await page.locator('[name="reason"]').fill('Browser restore interest and tolerance codes');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='7');
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.interestIndicator,'I1');
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.toleranceGroup,'T1');
  await page.locator('[name="isBlocked"]').check();
  await page.locator('[name="reason"]').fill('Browser company hold');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Blocked',{exact:true}).waitFor();
  await page.locator('[name="isBlocked"]').uncheck();
  await page.locator('[name="reason"]').fill('Browser company hold cleared');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='9');
  await page.locator('[name="reconciliationAccount"]').evaluate(select=>{const option=document.createElement('option');option.value='100000';option.text='Invalid cash account';select.appendChild(option);});
  await page.locator('[name="reconciliationAccount"]').selectOption('100000');
  await page.locator('[name="reason"]').fill('Invalid reconciliation test');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Use an unblocked customer reconciliation account in the company chart.',{exact:true}).waitFor();
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.reconciliationAccount,'110000');
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.version,9);
  await page.getByRole('link',{name:'Change history',exact:true}).click();
  await page.getByText('Browser customer accounting completion',{exact:true}).waitFor();
  await page.getByText('Browser customer payment and dunning codes',{exact:true}).waitFor();
  await page.getByText('Browser customer interest and tolerance codes',{exact:true}).waitFor();
  await page.getByText('Browser clear interest and tolerance codes',{exact:true}).waitFor();
  await page.getByText('Browser restore interest and tolerance codes',{exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/Payment Methods: — → C,T/);
  assert.match(await page.locator('body').innerText(),/Dunning Procedure: — → MA04/);
  assert.match(await page.locator('body').innerText(),/Interest Indicator: — → I1 · Control change/);
  assert.match(await page.locator('body').innerText(),/Tolerance Group: — → T1 · Control change/);
  await page.getByText('Browser company hold',{exact:true}).waitFor();
  await page.screenshot({path:'.arena/customer-company-history-review.png',fullPage:true});
  console.log('  ✓ customer company stages/completes, preserves no-op, maintains/blocks and rejects cash account');

  const warehouseId=randomUUID();const reviewerId=randomUUID();const password=await hashPassword(PASSWORD);
  await withTenant(CLIENT,async tx=>{
    await tx.execute(sql`insert into role(client,code,name,is_read_only,created_by) values(${CLIENT},'CUSTOMER_AR_REVIEWER','Customer AR reviewer',true,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability(client,role_code,capability_code) values(${CLIENT},'CUSTOMER_AR_REVIEWER','FIN.CUSTOMER.COMPANY.DISPLAY')`);
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${warehouseId},${CLIENT},'company.viewer','Company Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${warehouseId},'WAREHOUSE_CLERK','BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${reviewerId},${CLIENT},'finance.viewer','Finance Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${reviewerId},'CUSTOMER_AR_REVIEWER','BROWSER_FIXTURE')`);
  });
  async function signInAs(username:string){
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.goto(`${BASE}/signin`,{waitUntil:'domcontentloaded'});
    await page.locator('[name="client"]').fill(CLIENT);await page.locator('[name="username"]').fill(username);await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(/\/$/);
  }
  await signInAs('finance.viewer');
  await page.goto(`${BASE}/foundation/partners?partner=TESTCUST01&view=CUSTOMER_COMPANY`,{waitUntil:'domcontentloaded'});
  await page.getByText(/Read-only view\. Changes require authority FIN\.CUSTOMER\.COMPANY\.MAINTAIN/).waitFor();
  await page.getByText('Interest indicator code',{exact:true}).waitFor();
  await page.getByText('I1',{exact:true}).waitFor();await page.getByText('T1',{exact:true}).waitFor();
  assert.equal(await page.locator('[name="interestIndicator"]').count(),0);
  assert.equal(await page.locator('[name="toleranceGroup"]').count(),0);
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  console.log('  ✓ finance display authority can read the new codes without edit controls');

  await signInAs('company.viewer');
  await page.goto(`${BASE}/foundation/partners?partner=TESTCUST01&view=CUSTOMER_COMPANY&history=1`,{waitUntil:'domcontentloaded'});
  await page.getByText(/This screen requires authority FIN.CUSTOMER.COMPANY.DISPLAY/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);
  assert.equal((await page.content()).includes('Browser customer accounting completion'),false);
  assert.equal((await page.content()).includes('C,T'),false);
  assert.equal((await page.content()).includes('MA04'),false);
  assert.equal((await page.content()).includes('I1'),false);
  assert.equal((await page.content()).includes('T1'),false);
  console.log('  ✓ non-finance authority cannot read/maintain customer accounting or its history');
}

async function customerSalesArea(ctx: BrowserContext) {
  const {page,BASE,CLIENT}=scope(ctx);
  await page.goto(`${BASE}/foundation/partners?new=1`,{waitUntil:'domcontentloaded'});
  await page.locator('[name="partnerNumber"]').fill('TESTCUST01');
  await page.locator('input[name="name"]').fill('Demo Retail Customer');
  await page.locator('[name="city"]').fill('Kuwait City');
  await page.locator('[name="roles"][value="SUPPLIER"]').uncheck();
  await page.locator('[name="roles"][value="CUSTOMER"]').check();
  await page.locator('[name="reason"]').fill('Browser sales-area customer prerequisite');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Partner saved. Status: Created.',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Open saved business partner',exact:true}).click();
  await page.getByRole('link',{name:'Sales area',exact:true}).click();
  await page.locator('[name="area"]').waitFor();
  const areaKey=await page.locator('[name="area"]').inputValue();
  assert.equal(areaKey,'1000/01/01','Standard development fixture exposes the expected active sales area');
  const reselectArea=async()=>{
    const navigation=page.waitForURL(url=>url.searchParams.get('area')===areaKey,{timeout:15_000});
    await page.getByRole('button',{name:'Select sales area',exact:true}).click();
    await navigation;
    await page.locator('[name="pricingProcedure"]').waitFor();
  };
  await page.locator('[name="deliveringPlant"]').waitFor();
  assert.equal(await page.locator('[name="deliveringPlant"] option[value="1000"]').count(),1);
  await page.locator('[name="reason"]').fill('Browser sales-area staged');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Customer sales area saved. Status: Incomplete.',{exact:true}).waitFor();
  const staged=await getCustomerSalesArea(CLIENT,'TESTCUST01','1000','01','01');
  assert.equal(staged?.salesStatus,'INCOMPLETE');assert.equal(staged?.version,1);

  await page.locator('[name="deliveringPlant"]').selectOption('1000');
  await page.locator('[name="pricingProcedure"]').fill('rvaa01');
  await page.locator('[name="salesDistrict"]').fill('kw01');
  await page.locator('[name="completeDelivery"]').check();
  await page.locator('[name="orderCombination"]').check();
  await page.locator('[name="reason"]').fill('Browser sales-area complete');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='2');
  const saved=await getCustomerSalesArea(CLIENT,'TESTCUST01','1000','01','01');
  assert.equal(saved?.salesStatus,'CREATED');assert.equal(saved?.version,2);
  assert.equal(saved?.deliveringPlant,'1000');assert.equal(saved?.pricingProcedure,'RVAA01');
  assert.equal(saved?.salesDistrict,'KW01');assert.equal(saved?.completeDelivery,true);assert.equal(saved?.orderCombination,true);
  await reselectArea();
  assert.equal(await page.locator('[name="pricingProcedure"]').inputValue(),'RVAA01');
  assert.equal(await page.locator('[name="salesDistrict"]').inputValue(),'KW01');
  assert.equal(await page.locator('[name="completeDelivery"]').isChecked(),true);
  assert.equal(await page.locator('[name="orderCombination"]').isChecked(),true);
  await page.screenshot({path:'.arena/customer-sales-area-maintain-review.png',fullPage:true});
  console.log('  ✓ sales-area stage/complete, same-company plant, canonical codes and persisted flags');

  await page.locator('[name="pricingProcedure"]').fill('rvaa01');
  await page.locator('[name="salesDistrict"]').fill('kw01');
  await page.locator('[name="reason"]').fill('Browser sales-area canonical no-op');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('No customer sales-area data changed.',{exact:true}).waitFor();
  assert.equal((await getCustomerSalesArea(CLIENT,'TESTCUST01','1000','01','01'))?.version,2);
  await page.locator('[name="isBlocked"]').check();
  await page.locator('[name="reason"]').fill('Browser sales-area block');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='3');
  assert.equal((await getCustomerSalesArea(CLIENT,'TESTCUST01','1000','01','01'))?.isBlocked,true);
  assert.equal(await page.locator('[name="isBlocked"]').isChecked(),true);
  await page.locator('[name="isBlocked"]').uncheck();
  await page.locator('[name="reason"]').fill('Browser sales-area unblock');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')?.value==='4');
  assert.equal((await getCustomerSalesArea(CLIENT,'TESTCUST01','1000','01','01'))?.isBlocked,false);
  await page.getByRole('link',{name:'Change history',exact:true}).click();
  await page.getByText('Browser sales-area complete',{exact:true}).waitFor();
  await page.getByText('Browser sales-area block',{exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/Pricing Procedure: — → RVAA01 · Control change/);
  console.log('  ✓ no-op, scoped block/unblock and security-relevant history');

  await page.screenshot({path:'.arena/customer-sales-area-history-review.png',fullPage:true});
}

async function storageLocations(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const plantCode = 'STL139';
  const inactivePlantCode = 'STL139OFF';
  const locationCode = 'SL139A';
  const plantName = 'Storage Location Acceptance Plant';
  const locationName = 'Acceptance Storage Area';
  const passwordHash = await hashPassword(PASSWORD);
  console.log('Storage Locations: verify exact capability, active tenant-local Plants, lifecycle, history and read-only access');

  // The admin creates the active, deliberately unassigned Plant through its own UI.
  await page.goto(`${BASE}/config/plants?new=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="plant"]').fill(plantCode);
  await page.locator('[name="name"]').fill(plantName);
  await page.locator('[name="country"]').selectOption('KW');
  await page.locator('[name="reason"]').fill('B-139 unassigned Plant prerequisite');
  await page.getByRole('button', { name: 'Create Plant', exact: true }).click();
  await page.getByRole('status').getByText(
    `Plant ${plantCode} defined; Company Code assignment remains separate.`,
    { exact: true },
  ).waitFor();

  // A disposable inactive Plant proves it is omitted from the create selector.
  // The test fixture is tenant-scoped; business definitions continue to be created via the UI.
  await withTenant(CLIENT, (tx) => tx.execute(sql`
    insert into plant (client, plant, name, country, is_active, created_by)
    values (${CLIENT}, ${inactivePlantCode}, 'Inactive selector fixture', 'KW', false, 'BROWSER_FIXTURE')
  `));

  const roleCapabilities = await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'B139_STORAGELOC_DEFINE', 'B-139 Storage Location Definition Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'B139_STORAGELOC_DEFINE', 'CFG.ORG.STORAGELOC.DEFINE', 'BROWSER_FIXTURE')`);
    const [definerId, viewerId] = [randomUUID(), randomUUID()];
    for (const [id, username, fullName, roleCode] of [
      [definerId, 'storage.definer', 'Storage Location Definition-Only User', 'B139_STORAGELOC_DEFINE'],
      [viewerId, 'storage.viewer', 'Storage Location Read-Only User', 'AUDITOR'],
    ]) {
      await tx.execute(sql`insert into app_user
        (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')`);
      await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
        values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')`);
    }
    await tx.execute(sql`update config_activity_status
      set status = 'NOT_STARTED', completed_at = null, completed_by = null
      where client = ${CLIENT} and activity_code = 'CFG.ORG.STORAGELOC.DEFINE'`);
    return tx.execute(sql`select capability_code from role_capability
      where client = ${CLIENT} and role_code = 'B139_STORAGELOC_DEFINE' order by capability_code`);
  }) as unknown as Array<{ capability_code: string }>;
  assert.deepEqual(roleCapabilities.map((row) => row.capability_code), ['CFG.ORG.STORAGELOC.DEFINE']);

  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');
  }

  await signInAs('storage.definer');
  await page.goto(`${BASE}/config/storage-locations?new=1`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Storage Locations', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Create Storage Location', exact: true }).waitFor();
  await page.locator('header').getByText('Stored configuration only; this setting does not enforce stock movements.', { exact: true }).waitFor();
  await page.getByText('Company Code assignment is not a prerequisite.', { exact: false }).waitFor();
  const plantOptions = await page.locator('select[name="plant"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  assert.ok(plantOptions.includes(plantCode), 'The active same-tenant, unassigned Plant is offered.');
  assert.ok(!plantOptions.includes(inactivePlantCode), 'Inactive Plants are excluded from create choices.');
  for (const field of ['companyCode', 'client', 'changedBy', 'isActive']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `${field} is outside the Storage Location definition form.`);
  }
  assert.equal(await page.locator('[name="allowNegativeStock"][type="checkbox"]').isChecked(), false);
  assert.equal(await page.locator('[name="storageLocation"]').getAttribute('maxlength'), '10');
  await page.locator('[name="plant"]').selectOption(plantCode);
  await page.locator('[name="storageLocation"]').fill(locationCode);
  await page.locator('[name="name"]').fill(locationName);
  await page.locator('[name="reason"]').fill('B-139 Storage Location create');
  const createForm = page.locator('form').filter({ has: page.locator('[name="expectedVersion"]') });
  await createForm.evaluate((form) => {
    for (const [field, value] of Object.entries({
      client: '0100', changedBy: 'spoofed.actor', companyCode: '1000', isActive: 'false',
    })) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
    }
  });
  await page.getByRole('button', { name: 'Create Storage Location', exact: true }).click();
  await page.getByRole('status').getByText(
    `Storage Location ${locationCode} created for Plant ${plantCode}. Negative-stock allowance is stored configuration only.`,
    { exact: true },
  ).waitFor();

  const readLocation = async () => {
    const rows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select client, plant, storage_location, name, allow_negative_stock, is_active, created_by, changed_by
        from storage_location
       where client = ${CLIENT} and plant = ${plantCode} and storage_location = ${locationCode}
    `))) as unknown as Array<{
      client: string; plant: string; storage_location: string; name: string;
      allow_negative_stock: boolean; is_active: boolean; created_by: string; changed_by: string | null;
    }>;
    assert.equal(rows.length, 1);
    return rows[0];
  };
  const created = await readLocation();
  assert.deepEqual(created, {
    client: CLIENT, plant: plantCode, storage_location: locationCode, name: locationName,
    allow_negative_stock: false, is_active: true, created_by: 'storage.definer', changed_by: null,
  });
  const parentRows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select company_code, is_active from plant where client = ${CLIENT} and plant = ${plantCode}
  `))) as unknown as Array<{ company_code: string | null; is_active: boolean }>;
  assert.equal(parentRows.length, 1);
  assert.equal(parentRows[0].company_code, null);
  assert.equal(parentRows[0].is_active, true);
  const objectKey = `${plantCode.length}:${plantCode}${locationCode.length}:${locationCode}`;
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'storage_location', objectKey));
  assert.equal(history.length, 1);
  assert.equal(history[0].changeType, 'CREATE');
  assert.equal(history[0].changedBy, 'storage.definer');
  assert.equal(history[0].transactionCode, 'CFG.ORG.STORAGELOC.DEFINE');
  let [activity] = await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status, completed_by from config_activity_status
     where client = ${CLIENT} and activity_code = 'CFG.ORG.STORAGELOC.DEFINE'
  `)) as unknown as Array<{ status: string; completed_by: string | null }>;
  assert.equal(activity?.status, 'COMPLETED');
  assert.equal(activity?.completed_by, 'storage.definer');
  console.log('  ✓ exact-capability user creates under the session tenant; only active tenant Plants are selectable, Company Code is not required, and forged fields are ignored');

  await page.goto(`${BASE}/config/storage-locations?plant=${plantCode}&edit=${locationCode}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Change Storage Location', exact: true }).waitFor();
  assert.equal(await page.locator('[name="storageLocation"]').getAttribute('readonly'), '');
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '1');
  assert.equal(await page.locator('[name="allowNegativeStock"][type="checkbox"]').isChecked(), false);
  await page.locator('[name="name"]').fill('Acceptance Storage Area Updated');
  await page.locator('[name="allowNegativeStock"][type="checkbox"]').check();
  await page.locator('[name="reason"]').fill('B-139 Storage Location change');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').getByText(
    `Storage Location ${locationCode} in Plant ${plantCode} saved and its change history recorded.`,
    { exact: true },
  ).waitFor();
  let changed = await readLocation();
  assert.equal(changed.name, 'Acceptance Storage Area Updated');
  assert.equal(changed.allow_negative_stock, true);
  assert.equal(changed.is_active, true);
  assert.equal(changed.changed_by, 'storage.definer');
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'storage_location', objectKey));
  assert.equal(history.length, 2);
  assert.deepEqual(new Set(history.map((entry) => entry.changeType)), new Set(['CREATE', 'CHANGE']));
  assert.ok(history.every((entry) => entry.changedBy === 'storage.definer'));
  console.log('  ✓ definition key stays fixed while name and stored-only negative-stock allowance are changed with audit');

  // A no-op form submit must not manufacture a new version or change document.
  await page.goto(`${BASE}/config/storage-locations?plant=${plantCode}&edit=${locationCode}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').getByText(
    `No Storage Location definition data changed for ${plantCode}/${locationCode}.`,
    { exact: true },
  ).waitFor();
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'storage_location', objectKey));
  assert.equal(history.length, 2);
  console.log('  ✓ unchanged save preserves version and audit count');

  await page.goto(`${BASE}/config/storage-locations?plant=${plantCode}&location=${locationCode}&history=1`, { waitUntil: 'domcontentloaded' });
  await page.getByText('B-139 Storage Location create', { exact: true }).waitFor();
  await page.getByText('B-139 Storage Location change', { exact: true }).waitFor();
  assert.match(await page.locator('body').innerText(), /Name: Acceptance Storage Area → Acceptance Storage Area Updated/);
  assert.match(await page.locator('body').innerText(), /Allow negative stock \(stored configuration only\): false → true/);

  const deactivateDetails = page.locator('details').filter({ hasText: 'Deactivate Storage Location' });
  await deactivateDetails.locator('summary').click();
  await deactivateDetails.locator('[name="reason"]').fill('B-139 Storage Location deactivation');
  const deactivateForm = deactivateDetails.locator('form');
  for (const field of ['client', 'changedBy', 'isActive']) {
    assert.equal(await deactivateForm.locator(`[name="${field}"]`).count(), 0, `${field} is not supplied by the browser.`);
  }
  await deactivateForm.evaluate((form) => {
    for (const [field, value] of Object.entries({ client: '0100', changedBy: 'spoofed.actor' })) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
    }
  });
  await deactivateForm.getByRole('button', { name: 'Confirm deactivation', exact: true }).click();
  await page.getByRole('status').getByText(
    `Storage Location ${locationCode} in Plant ${plantCode} deactivated and retained with its history.`,
    { exact: true },
  ).waitFor();
  const deactivated = await readLocation();
  assert.equal(deactivated.is_active, false);
  assert.equal(deactivated.name, 'Acceptance Storage Area Updated');
  assert.equal(deactivated.changed_by, 'storage.definer');
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'storage_location', objectKey));
  assert.equal(history.length, 3);
  assert.ok(history.every((entry) => entry.changedBy === 'storage.definer'));
  [activity] = await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status, completed_by from config_activity_status
     where client = ${CLIENT} and activity_code = 'CFG.ORG.STORAGELOC.DEFINE'
  `)) as unknown as Array<{ status: string; completed_by: string | null }>;
  assert.equal(activity?.status, 'COMPLETED');
  assert.equal(activity?.completed_by, 'storage.definer');
  console.log('  ✓ deactivation updates status only, retains the row and history, and has no hard-delete route');

  await page.goto(`${BASE}/config`, { waitUntil: 'domcontentloaded' });
  assert.match(await page.locator('tr').filter({ hasText: 'CFG.ORG.STORAGELOC.DEFINE' }).innerText(), /Completed/i);
  console.log('  ✓ the built Storage Location activity appears in the workbench and completes after maintenance');

  await signInAs('storage.viewer');
  await page.goto(`${BASE}/config/storage-locations`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Storage Locations', exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.ORG.STORAGELOC.DEFINE.', { exact: true }).waitFor();
  const locationRow = page.locator('tbody tr').filter({ hasText: locationCode });
  await locationRow.waitFor();
  assert.ok((await locationRow.innerText()).includes('Inactive'));
  assert.equal(await page.getByRole('link', { name: 'Create Storage Location', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Confirm deactivation', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /delete/i }).count(), 0);
  await page.goto(`${BASE}/config/storage-locations?new=1&client=0100`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Read-only view. Changes require authority CFG.ORG.STORAGELOC.DEFINE.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Create Storage Location', exact: true }).count(), 0);
  assert.equal(await page.locator('select[name="plant"]').count(), 0, 'Direct create URLs do not expose Plant choices to a viewer.');
  console.log('  ✓ Auditor retains the inactive read view but has no create/change/deactivate controls or form choices');
}

export const CHECKS: Record<BrowserTargetId, (ctx: BrowserContext) => Promise<void>> = {
  foundation,
  'company-code-definition': companyCodeDefinition,
  'company-code-coa-assignment': companyCodeCoaAssignment,
  'plant-definition': plantDefinition,
  'plant-company-code-assignment': plantCompanyCodeAssignment,
  'storage-locations': storageLocations,
  'payment-terms': paymentTerms,
  'payment-methods': paymentMethods,
  'business-partners': businessPartners,
  'supplier-company': supplierCompany,
  'supplier-purchasing': supplierPurchasing,
  'customer-company': customerCompany,
  'customer-sales-area': customerSalesArea,
  'material-basic': basicLifecycle,
  'material-purchasing': purchasing,
  'material-mrp': mrp,
  'material-valuation': valuation,
};
