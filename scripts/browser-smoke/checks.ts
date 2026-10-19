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
import { listTenants } from '../../src/platform/tenancy';
import { applyStandardStructure } from '../../src/platform/tenancy/standard-structure';
import { changeHistory } from '../../src/platform/change';
import { indexDocument } from '../../src/platform/document';
import { listCompanyCodes } from '../../src/modules/foundation/services';
import { getMaterialDetail } from '../../src/modules/inventory/materials';
import { getPaymentTerms } from '../../src/modules/foundation/payment-terms';
import { getPaymentMethod, savePaymentMethod } from '../../src/modules/foundation/payment-methods';
import { getBusinessPartner } from '../../src/modules/foundation/business-partners';
import { getSupplierCompany } from '../../src/modules/foundation/supplier-companies';
import { getSupplierPurchasing, supplierPurchasingChoices } from '../../src/modules/foundation/supplier-purchasing';
import { listSupplierPurchasingPartners } from '../../src/modules/foundation/supplier-purchasing-partners';
import { getCustomerCompany } from '../../src/modules/foundation/customer-companies';
import { getCustomerSalesArea } from '../../src/modules/foundation/customer-sales-areas';
import { defineCompanyCode } from '../../src/modules/foundation/company-code-definition';
import { listControllingAreas } from '../../src/modules/foundation/controlling-area-maintenance';
import { deactivateSalesOrg, saveSalesOrgDefinition } from '../../src/modules/foundation/sales-organization-maintenance';
import { assignSalesOrgDistributionChannel, unassignSalesOrgDistributionChannel } from '../../src/modules/foundation/sales-org-distribution-channel-assignment';
import { deactivateDivision, saveDivisionDefinition } from '../../src/modules/foundation/distribution-channel-division-maintenance';
import { FIXTURE_NAME, type BrowserTargetId, type BrowserTarget } from './targets';
import { ACCEPTANCE_DATABASE_GUARDS } from './database-guards';
import { controllingAreaCompanyAssignment as ox19Assignment } from './ox19-assignment';
import { chartOfAccountsDefinition as ob13ChartOfAccounts } from './chart-of-accounts';
import { chartOfAccountsCopyOby7 } from './chart-of-accounts-copy';
import { fiscalYearVariantAssignmentOb37 } from './fiscal-year-variant-assignment';
import { fiscalYearVariantsOb29 } from './fiscal-year-variants';
import { glAccountMasterFs00 } from './gl-accounts';
import { postingPeriodVariantsObbo } from './posting-period-variants';
import { postingPeriodVariantAssignmentObbp } from './posting-period-variant-assignment';
import { exchangeRatesOb08 } from './exchange-rates';
import { taxCodesFtxp } from './tax-codes';
import { banksBankMaster } from './banks';
import { houseBanksFi12 } from './house-banks';
import { documentTypesOba7 } from './document-types';
import { toleranceGroupsOba4 } from './tolerance-groups';
import { accountDeterminationObyc } from './account-determination';
import { costCentersKs01 } from './cost-centers';
import { costCenterHierarchyKs01 } from './cost-center-hierarchy';
import { activityTypesKl01 } from './activity-types';
import { activityRatesKp26 } from './activity-rates';
import { profitCentersKe51 } from './profit-centers';
import { profitCenterHierarchyKch1 } from './profit-center-hierarchy';
import { materialTypesOms2 } from './material-types';
import { materialGroupsOmsf } from './material-groups';
import { numberRangeObjectsSnro } from './number-range-objects';
import { materialNumberRangesMmnr } from './material-number-ranges';
import { industrySectorsOms3 } from './industry-sectors';
import { industriesOb44 } from './industries';
import { materialDeletionFlagMm06 } from './material-deletion-flag';
import { materialPeriodControlOmsy } from './material-period-control';
import { purchaseRequisitionsMe51n } from './purchase-requisitions';
import { purchaseOrdersMe21n } from './purchase-orders';
import { characteristicsCt04 } from './characteristics';
import { classesCl02 } from './classes';
import { releaseStrategiesConfig } from './release-strategies';
import { releaseActs } from './release-acts';
import { goodsReceiptMigo } from './goods-receipt';
import { invoiceVerificationMiro } from './invoice-verification';
import { paymentRunF110 } from './payment-run';
import { vendorClearingF44 } from './vendor-clearing';
import { vendorBalancesFk10n } from './vendor-balances';
import { vendorAgeingAnalysis } from './vendor-ageing';
import { customerInvoiceFb70 } from './customer-invoice';
import { incomingPaymentF28 } from './incoming-payment';
import { incomingPaymentCompletionF28 } from './incoming-payment-completion';
import { outgoingPaymentF53 } from './outgoing-payment';
import { outgoingPaymentCompletionF53 } from './outgoing-payment-completion';
import { vendorDownPaymentF48 } from './vendor-down-payment';
import { vendorDownPaymentClearingF54 } from './vendor-down-payment-clearing';
import { customerDownPaymentClearingF39 } from './customer-down-payment-clearing';
import { customerDownPaymentRequestF37 } from './customer-down-payment-request';
import { vendorDownPaymentRequestF47 } from './vendor-down-payment-request';
import { parkedJournalFv50 } from './parked-journal';
import { journalItemsFagll03 } from './journal-items';
import { glBalancesFs10n } from './gl-balances';
import { documentDisplayFb03 } from './document-display';
import { assetMasterAs01As02 } from './asset-master';
import { assetAcquisitionAbzon } from './asset-acquisition';
import { assetRetirementAbavn } from './asset-retirement';
import { assetDepreciationAfab } from './asset-depreciation';
import { assetHistorySheet } from './asset-history';
import { glDocumentEntry } from './gl-document';
import { taxReportReturn } from './tax-report';
import { fxValuationRun } from './fx-valuation';
import { grIrAnalysis } from './grir-reclass';
import { accrualDocument } from './accrual';
import { closeCockpit } from './close-cockpit';
import { carryforward } from './carryforward';
import { customerCredit } from './credit';
import { creditMonitor } from './credit-monitor';
import { creditRelease } from './credit-release';
import { trialBalance } from './trial-balance';
import { balanceSheet } from './balance-sheet';
import { glReporting } from './gl-reporting';
import { glReportingSuite } from './gl-reporting-suite';
import { customerDownPaymentF29 } from './customer-down-payment';
import { customerBalancesFd10n } from './customer-balances';
import { customerAgeingAnalysis } from './customer-ageing';
import { clearingResetFbra } from './clearing-reset';
import { documentReversalFb08 } from './document-reversal';
import { customerClearingF32 } from './customer-clearing';
import { dunningF150 } from './dunning';
import { vendorInvoiceFb60 } from './vendor-invoice';
import { vendorCreditMemoFb65 } from './vendor-credit-memo';

const PASSWORD = 'browser-check-2026';
const SYNTHETIC_BANK_IDENTIFIER = 'SYNTHETIC-IBAN-4321';
const year = new Date().getUTCFullYear();
export type BrowserContext = { page: Page; base: string; target: BrowserTarget };
function scope(ctx: BrowserContext) { return { page: ctx.page, BASE: ctx.base, CLIENT: ctx.target.client }; }

/**
 * Elevated fixture writes use the migration connection only after both connection strings are
 * proven to name the reviewed business-partners loopback database (R-79). The application role
 * can read partner_bank but cannot insert into it, which is why this one synthetic row needs the
 * separated elevated role; the tenant, partner and no-existing-row checks below remain the limit
 * on what that role may touch here.
 */
async function insertSyntheticPartnerBankRecord(client: string, partnerNumber: string): Promise<string> {
  const guard = ACCEPTANCE_DATABASE_GUARDS['business-partners'];
  assert.ok(guard, 'Business-partners acceptance has no reviewed database guard.');
  const fixtureUrl = process.env.MIGRATION_DATABASE_URL;
  assert.ok(fixtureUrl, 'Masked bank-detail smoke requires MIGRATION_DATABASE_URL.');
  const runtimeUrl = process.env.DATABASE_URL;
  assert.ok(runtimeUrl, 'Masked bank-detail smoke requires DATABASE_URL so the fixture binding can be verified.');
  let fixture: URL;
  let runtime: URL;
  try {
    fixture = new URL(fixtureUrl);
    runtime = new URL(runtimeUrl);
  } catch {
    throw new Error('Masked bank-detail smoke connection URLs must be valid PostgreSQL URLs.');
  }
  for (const [url, variable] of [[fixture, 'MIGRATION_DATABASE_URL'], [runtime, 'DATABASE_URL']] as const) {
    assert.equal(url.protocol, 'postgresql:', `${variable} must use PostgreSQL.`);
    assert.equal(url.hostname, '127.0.0.1', `${variable} must use loopback; remote databases are forbidden.`);
    assert.equal(url.port, guard.port, `${variable} must target the reviewed business-partners port.`);
    assert.equal(url.pathname, `/${guard.database}`, `${variable} must target only the reviewed business-partners database.`);
    assert.equal(url.search, '', `${variable} must not include unreviewed connection parameters.`);
    assert.ok(url.password.length > 0, `${variable} must include the reviewed local password.`);
  }
  assert.equal(decodeURIComponent(runtime.username), 'cairn_app', 'DATABASE_URL must use the restricted application role.');
  const fixtureRole = decodeURIComponent(fixture.username);
  assert.notEqual(fixtureRole, 'cairn_app', 'Fixture writer must be separate from the read-only application role.');
  const fixtureDb = postgres(fixtureUrl, { max: 1, prepare: false, onnotice: () => {} });

  try {
    const [identity] = await fixtureDb`
      select current_database() as database_name,
             host(inet_server_addr()) as server_address,
             inet_server_port() as server_port,
             current_user as role_name`;
    assert.equal(identity?.database_name, guard.database, 'Fixture writes are restricted to the reviewed business-partners database.');
    assert.equal(identity?.server_address, '127.0.0.1', 'Fixture writes are restricted to loopback PostgreSQL.');
    assert.equal(String(identity?.server_port), guard.port, 'Fixture writes are restricted to the reviewed business-partners port.');
    assert.equal(identity?.role_name, fixtureRole, 'Fixture writer must be the role named by MIGRATION_DATABASE_URL.');
    const [role] = await fixtureDb`
      select (rolsuper or rolbypassrls) as elevated
      from pg_roles where rolname = current_user`;
    assert.equal(role?.elevated, true, 'Fixture connection must be the separated elevated role for the reviewed database.');

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

async function createCustomerRoleThroughUi(page: Page, BASE: string, number: string, name: string) {
  await page.goto(`${BASE}/foundation/partners?new=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="partnerNumber"]').fill(number);
  await page.locator('input[name="name"]').fill(name);
  await page.locator('[name="country"]').selectOption('KW');
  await page.locator('[name="city"]').fill('Kuwait City');
  await page.locator('[name="roles"][value="CUSTOMER"]').check();
  await page.locator('[name="roles"][value="SUPPLIER"]').uncheck();
  await page.locator('[name="reason"]').fill('Browser intercompany-billing Customer prerequisite');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Partner saved. Status: Created.', { exact: true }).waitFor();
}

export async function onboard(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const NAME = FIXTURE_NAME;
  console.log('Browser: create tenant through onboarding');
  await page.goto(`${BASE}/clients/new`, { waitUntil: 'commit' });
  // The runner enforces CAIRN_ENV=development. If the protected field is
  // rendered, satisfy it with an ephemeral value rather than a deployment secret.
  const provisioningToken = page.locator('[name="provisioningToken"]');
  if (await provisioningToken.count()) await provisioningToken.fill(randomUUID());
  await page.locator('[name="clientKey"]').fill(CLIENT);
  await page.locator('[name="name"]').fill(NAME);
  await page.locator('[name="currency"]').fill('KWD');
  // The general data every target's fixtures assume: the chart and its accounts, the
  // fiscal year variant and its periods, the posting period variant, the catalogues.
  // The enterprise structure comes from the builder below, because creating a tenant
  // configures no company any more.
  await page.locator('input[name="creationType"][value="standard"]').check();
  await page.locator('[name="username"]').fill('browser.admin');
  await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create tenant', exact: true }).click();
  await page.waitForURL(/\/signin\?/, { waitUntil: 'commit' });
  await page.locator('[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/config$/, { waitUntil: 'commit' });
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  // The enterprise structure every browser target was written against. Creation no
  // longer supplies it, so the builder must: asserting that is what keeps this honest
  // if a future change silently drops the structure from a fixture tenant.
  const structure = await applyStandardStructure({
    client: CLIENT,
    companyName: 'Browser verification company',
    country: 'KW',
    currency: 'KWD',
    changedBy: 'browser.admin',
  });
  assert.equal(
    structure.created,
    true,
    'The builder must supply the standard structure; tenant creation no longer does.',
  );
  console.log('  ✓ builder supplied the standard structure');
  assert.equal((await withTenant(CLIENT, (tx) => tx.execute(sql`select count(*)::int as n from number_range where object_code = 'RF_BELEG'`)) as unknown as Array<{ n: number }>)[0].n, 0);
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
  const counter = (await withTenant(CLIENT, (tx) => tx.execute(sql`select current_number from number_range where object_code = 'RF_BELEG'`))) as unknown as Array<{ current_number: string }>;
  assert.equal(counter[0].current_number, '1');
  console.log('  ✓ an unbalanced UI posting consumes no number');

  await page.goto(`${BASE}/finance/journal?document=${encodeURIComponent(rows[0].document_number)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: new RegExp(`Document detail.*JE-${year}-000001`) }).waitFor();
  await page.getByText('Browser acceptance entry', { exact: true }).waitFor();
  console.log('  ✓ document list and scoped detail render the posted entry');

  await page.goto(`${BASE}/config/number-ranges?history=${encodeURIComponent('RF_BELEG/1000/GENERAL/0')}`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Browser implementation verification', { exact: true }).waitFor();
  await page.getByRole('link', { name: rows[0].document_number, exact: true }).waitFor();
  console.log('  ✓ change history and number-allocation evidence drill into the document');
  await mkdir('.arena', { recursive: true });
  await page.screenshot({ path: '.arena/number-ranges-review.png', fullPage: true });
}

async function controllingAreaDefinition(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const route = `${BASE}/config/controlling-area`;
  const areaCode = 'B201';

  // The fresh standard-package tenant has K4 only. Mark it inactive inside this
  // owned fixture so the UI proves Fiscal Year Variant F4 still includes it.
  const deactivatedVariant = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    update fiscal_year_variant set is_active = false
     where client = ${CLIENT} and variant = 'K4'
     returning variant, is_active
  `))) as unknown as Array<{ variant: string; is_active: boolean }>;
  assert.equal(deactivatedVariant.length, 1);
  assert.equal(deactivatedVariant[0]?.variant, 'K4');
  assert.equal(deactivatedVariant[0]?.is_active, false);

  await page.goto(route, { waitUntil: 'load' });
  // Server-rendered markup can be visible before React wires the F4 dialogs and forms.
  await page.waitForLoadState('load');
  await page.getByRole('heading', { level: 1, name: 'Controlling Areas', exact: true }).waitFor();
  await page.getByText('Company Code assignments are maintained separately in OX19.', { exact: true }).first().waitFor();

  // Keep the owner-provided Assignment Control heading, choices and help copy verbatim.
  const assignmentCopy = await page.locator('#scr024-create-assignment-control-control-copy').innerText();
  for (const copy of [
    'Description of Controlling Area’s Purpose',
    'Controls the relationship between Controlling Area and Company Code',
    'Controlling area same as company code (1:1 Relationship)',
    'This maps Controlling Area to a single Company Code in a strict 1:1 relationship, where only one Company Code may be assigned to the Controlling Area.',
    'Cross-company-code cost accounting (1:N Relationship)',
    'This enables one Controlling Area to be assigned to multiple Company Codes, allowing cost accounting to be performed across all assigned Company Codes.',
    'The scope controls whether a Controlling Area can be assigned to one or multiple Company Codes in the system.',
    '1:1 Relationship: Exactly one Company Code must be assigned to the Controlling Area.',
    '1:N Relationship: One Controlling Area can be assigned to multiple Company Codes.',
    'This will determine whether cost accounting for a Controlling Area is restricted to a single Company Code or includes all cross-company costs.',
  ]) {
    assert.ok(assignmentCopy.includes(copy), `Missing exact Assignment Control copy: ${copy}`);
  }

  const initialList = page.getByRole('list', { name: 'Current Controlling Areas', exact: true });
  const standardRow = initialList.locator('li').filter({ hasText: 'A000' });
  assert.equal(await standardRow.count(), 1);
  assert.equal(await standardRow.locator('[name="companyCodeScope"]').inputValue(), 'SINGLE');
  assert.equal(await standardRow.locator('[name="currency"]').inputValue(), 'KWD');
  assert.equal(await standardRow.locator('[name="fiscalYearVariant"]').inputValue(), 'K4');
  const initialAreas = await listControllingAreas(CLIENT);
  const standardArea = initialAreas.find((area) => area.controllingArea === 'A000');
  assert.ok(standardArea, 'The standard A000 Controlling Area must be present.');
  assert.equal(standardArea.companyCodeCount, 1);
  assert.equal(standardArea.currencyLocked, false);
  assert.equal(standardArea.fiscalYearVariantLocked, false);
  console.log('  ✓ standard A000 starts 1:1 and financial settings are editable before activity');

  const createPanel = page.locator('section[aria-labelledby="controlling-area-create-title"]');
  const createForm = createPanel.locator('form');
  await createForm.getByRole('button', { name: 'Open Currency Key lookup (F4)', exact: true }).click();
  const currencyDialog = page.getByRole('dialog', { name: 'Currency Key lookup', exact: true });
  await currencyDialog.waitFor();
  const kwdChoice = currencyDialog.getByRole('button', { name: /KWD.*Kuwaiti Dinar.*Active/i });
  await kwdChoice.waitFor();
  await kwdChoice.click();
  assert.equal(await createForm.locator('[name="currency"]').inputValue(), 'KWD');

  await createForm.getByRole('button', { name: 'Open Fiscal Year Variant lookup (F4)', exact: true }).click();
  const fiscalYearDialog = page.getByRole('dialog', { name: 'Fiscal Year Variant lookup', exact: true });
  await fiscalYearDialog.waitFor();
  const k4Choice = fiscalYearDialog.getByRole('button', { name: /K4.*Calendar year \+ 4 special.*Inactive/i });
  await k4Choice.waitFor();
  assert.match(await k4Choice.innerText(), /Inactive/i);
  await k4Choice.click();
  assert.equal(await createForm.locator('[name="fiscalYearVariant"]').inputValue(), 'K4');

  // Restore the standard variant before the posting part of this acceptance run.
  const activatedVariant = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    update fiscal_year_variant set is_active = true
     where client = ${CLIENT} and variant = 'K4'
     returning variant, is_active
  `))) as unknown as Array<{ variant: string; is_active: boolean }>;
  assert.equal(activatedVariant.length, 1);
  assert.equal(activatedVariant[0]?.is_active, true);

  // Use the hydrated client form to verify key normalization and Assignment Control.
  await createForm.locator('[name="controllingArea"]').fill('b201');
  assert.equal(await createForm.locator('[name="controllingArea"]').inputValue(), areaCode);
  await createForm.locator('[name="name"]').fill('OKKP Browser Area');
  await createForm.locator('[name="organizationName"]').fill('Browser Controlling');
  assert.equal(await createForm.locator('[name="companyCodeScope"]').inputValue(), 'SINGLE');
  await createForm.locator('[name="companyCodeScope"]').selectOption('MULTIPLE');

  await createPanel.getByRole('button', { name: 'Create Controlling Area', exact: true }).click();
  await createPanel.getByRole('status').getByText(
    'Controlling Area B201 created; change history recorded.', { exact: true },
  ).waitFor();
  let areas = await listControllingAreas(CLIENT);
  let createdArea = areas.find((area) => area.controllingArea === areaCode);
  assert.ok(createdArea);
  assert.equal(createdArea.name, 'OKKP Browser Area');
  assert.equal(createdArea.organizationName, 'Browser Controlling');
  assert.equal(createdArea.companyCodeScope, 'MULTIPLE');
  assert.equal(createdArea.currency, 'KWD');
  assert.equal(createdArea.fiscalYearVariant, 'K4');
  assert.equal(createdArea.companyCodeCount, 0);
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'controlling_area', areaCode));
  assert.equal(history.length, 1);
  assert.equal(history[0]?.changeType, 'CREATE');
  assert.equal(history[0]?.changedBy, 'browser.admin');
  assert.equal(history[0]?.transactionCode, 'CFG.COST.CONTROLLINGAREA.DEFINE');
  console.log('  ✓ create uses active Currency F4 and includes an inactive Fiscal Year Variant in F4');

  // Repeating a key with conflicting field values must be an idempotent no-op.
  await createForm.locator('[name="name"]').fill('Ignored Duplicate Name');
  await createForm.locator('[name="organizationName"]').fill('Ignored Duplicate');
  await createForm.locator('[name="companyCodeScope"]').selectOption('SINGLE');
  await createForm.locator('[name="currency"]').fill('USD');
  await createPanel.getByRole('button', { name: 'Create Controlling Area', exact: true }).click();
  await createPanel.getByRole('status').getByText(
    'Controlling Area B201 already exists; no change made.', { exact: true },
  ).waitFor();
  areas = await listControllingAreas(CLIENT);
  createdArea = areas.find((area) => area.controllingArea === areaCode);
  assert.ok(createdArea);
  assert.equal(createdArea.name, 'OKKP Browser Area');
  assert.equal(createdArea.organizationName, 'Browser Controlling');
  assert.equal(createdArea.companyCodeScope, 'MULTIPLE');
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'controlling_area', areaCode));
  assert.equal(history.length, 1, 'Duplicate create must not add a history event.');
  console.log('  ✓ duplicate key leaves persisted values and change history untouched');

  const areaList = page.getByRole('list', { name: 'Current Controlling Areas', exact: true });
  const areaRow = areaList.locator('li').filter({ hasText: areaCode });
  assert.equal(await areaRow.count(), 1);
  await areaRow.locator('summary').click();
  const changeForm = areaRow.locator('form');
  await changeForm.locator('[name="expectedVersion"]').waitFor({ state: 'attached' });
  assert.equal(await changeForm.locator('[name="controllingArea"]').getAttribute('type'), 'hidden');
  assert.equal(await changeForm.locator('[name="controllingArea"]').inputValue(), areaCode);
  await changeForm.locator('[name="name"]').fill('OKKP Browser Revised');
  await changeForm.locator('[name="organizationName"]').fill('Browser Organization Updated');
  await changeForm.locator('[name="companyCodeScope"]').selectOption('SINGLE');
  await changeForm.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await changeForm.getByRole('status').getByText(
    'Controlling Area B201 saved; change history recorded.', { exact: true },
  ).waitFor();
  areas = await listControllingAreas(CLIENT);
  createdArea = areas.find((area) => area.controllingArea === areaCode);
  assert.ok(createdArea);
  assert.equal(createdArea.name, 'OKKP Browser Revised');
  assert.equal(createdArea.organizationName, 'Browser Organization Updated');
  assert.equal(createdArea.companyCodeScope, 'SINGLE');
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'controlling_area', areaCode));
  assert.equal(history.length, 2);
  assert.equal(history[0]?.changeType, 'CHANGE');
  assert.equal(history[0]?.changedBy, 'browser.admin');
  const changedFields = new Map(history[0]?.items.map((item) => [item.fieldName, [item.oldValue, item.newValue]]));
  assert.deepEqual(changedFields.get('name'), ['OKKP Browser Area', 'OKKP Browser Revised']);
  assert.deepEqual(changedFields.get('organizationName'), ['Browser Controlling', 'Browser Organization Updated']);
  assert.deepEqual(changedFields.get('companyCodeScope'), ['MULTIPLE', 'SINGLE']);
  console.log('  ✓ key stays immutable while both names and Assignment Control change with audit history');

  // Verify the default area remains unlocked before the first actual transaction.
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  const preTransactionList = page.getByRole('list', { name: 'Current Controlling Areas', exact: true });
  const preTransactionRow = preTransactionList.locator('li').filter({ hasText: 'A000' });
  await preTransactionRow.locator('summary').click();
  const preTransactionForm = preTransactionRow.locator('form');
  assert.equal(await preTransactionForm.locator('[name="currency"]').getAttribute('readonly'), null);
  assert.equal(await preTransactionForm.locator('[name="fiscalYearVariant"]').getAttribute('readonly'), null);
  assert.equal(await preTransactionForm.getByRole('button', { name: 'Open Currency Key lookup (F4)', exact: true }).isEnabled(), true);
  assert.equal(await preTransactionForm.getByRole('button', { name: 'Open Fiscal Year Variant lookup (F4)', exact: true }).isEnabled(), true);

  // No non-journal operational writer exists in the repository yet. Use a
  // synthetic OPEN document-index row to exercise that lock source, then remove it.
  const nonJournalFixtureKey = 'OKKP-NON-JE-FIXTURE';
  await withTenant(CLIENT, (tx) => indexDocument(tx, {
    client: CLIENT,
    document: { documentClass: 'browser_fixture', documentKey: nonJournalFixtureKey },
    displayNumber: nonJournalFixtureKey,
    companyCode: '1000',
    status: 'OPEN',
    summary: 'Synthetic pre-ledger fixture only; not an actual business transaction.',
  }));
  let indexedAreas = await listControllingAreas(CLIENT);
  let indexedStandard = indexedAreas.find((area) => area.controllingArea === 'A000');
  assert.ok(indexedStandard);
  assert.equal(indexedStandard.currencyLocked, true);
  assert.equal(indexedStandard.fiscalYearVariantLocked, true);
  await page.goto(route, { waitUntil: 'load' });
  const indexedList = page.getByRole('list', { name: 'Current Controlling Areas', exact: true });
  const indexedRow = indexedList.locator('li').filter({ hasText: 'A000' });
  await indexedRow.getByRole('status').getByText(
    'Currency Key and Fiscal Year Variant are read-only because an actual operational transaction exists under an assigned Company Code.',
    { exact: true },
  ).waitFor();
  await indexedRow.locator('summary').click();
  const indexedForm = indexedRow.locator('form');
  assert.equal(await indexedForm.locator('[name="currency"]').getAttribute('readonly'), '');
  assert.equal(await indexedForm.locator('[name="fiscalYearVariant"]').getAttribute('readonly'), '');

  const removedIndexFixture = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    delete from document_index
     where client = ${CLIENT} and document_class = 'browser_fixture'
       and document_key = ${nonJournalFixtureKey}
     returning id
  `))) as unknown as Array<{ id: string }>;
  assert.equal(removedIndexFixture.length, 1);
  indexedAreas = await listControllingAreas(CLIENT);
  indexedStandard = indexedAreas.find((area) => area.controllingArea === 'A000');
  assert.ok(indexedStandard);
  assert.equal(indexedStandard.currencyLocked, false);
  console.log('  ✓ synthetic non-journal document-index fixture exercises and then releases the activity lock');

  await page.goto(`${BASE}/config/number-ranges?new=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="reason"]').fill('SCR-024 browser transaction-lock verification');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Interval saved and change evidence recorded.', { exact: true }).waitFor();

  await page.goto(`${BASE}/finance/journal/new`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('[name="currency"]').inputValue(), 'KWD');
  await page.locator('[name="postingDate"]').fill(`${year}-04-15`);
  await page.locator('[name="reference"]').fill('OKKP-LOCK-001');
  await page.locator('[name="headerText"]').fill('Actual transaction for OKKP activity lock');
  for (const [name, value] of Object.entries({
    line_0_account: '100000', line_0_amount: '100',
    line_1_account: '200000', line_1_amount: '100',
  })) {
    await page.locator(`[name="${name}"]`).fill(value);
  }
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByText(/Document JE-\d{4}-000001 posted/).waitFor();
  const posted = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select document_number, status, created_by, local_currency
      from journal_entry
     where client = ${CLIENT} and reference = 'OKKP-LOCK-001'
  `))) as unknown as Array<{ document_number: string; status: string; created_by: string; local_currency: string }>;
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.status, 'POSTED');
  assert.equal(posted[0]?.created_by, 'browser.admin');
  assert.equal(posted[0]?.local_currency, 'KWD');
  console.log('  ✓ actual journal transaction posts under the assigned Company Code');

  await page.goto(route, { waitUntil: 'domcontentloaded' });
  const postTransactionAreas = await listControllingAreas(CLIENT);
  const lockedStandard = postTransactionAreas.find((area) => area.controllingArea === 'A000');
  const stillEditableArea = postTransactionAreas.find((area) => area.controllingArea === areaCode);
  assert.ok(lockedStandard);
  assert.ok(stillEditableArea);
  assert.equal(lockedStandard.companyCodeCount, 1);
  assert.equal(lockedStandard.currencyLocked, true);
  assert.equal(lockedStandard.fiscalYearVariantLocked, true);
  assert.equal(stillEditableArea.companyCodeCount, 0);
  assert.equal(stillEditableArea.currencyLocked, false);
  assert.equal(stillEditableArea.fiscalYearVariantLocked, false);

  const postTransactionList = page.getByRole('list', { name: 'Current Controlling Areas', exact: true });
  const lockedRow = postTransactionList.locator('li').filter({ hasText: 'A000' });
  await lockedRow.getByRole('status').getByText(
    'Currency Key and Fiscal Year Variant are read-only because an actual operational transaction exists under an assigned Company Code.',
    { exact: true },
  ).waitFor();
  await lockedRow.locator('summary').click();
  const lockedForm = lockedRow.locator('form');
  assert.equal(await lockedForm.locator('[name="currency"]').getAttribute('readonly'), '');
  assert.equal(await lockedForm.locator('[name="fiscalYearVariant"]').getAttribute('readonly'), '');
  assert.equal(await lockedForm.getByRole('button', { name: 'Open Currency Key lookup (F4)', exact: true }).isDisabled(), true);
  assert.equal(await lockedForm.getByRole('button', { name: 'Open Fiscal Year Variant lookup (F4)', exact: true }).isDisabled(), true);

  const unlockedRow = postTransactionList.locator('li').filter({ hasText: areaCode });
  await unlockedRow.locator('summary').click();
  const unlockedForm = unlockedRow.locator('form');
  assert.equal(await unlockedForm.locator('[name="currency"]').getAttribute('readonly'), null);
  assert.equal(await unlockedForm.locator('[name="fiscalYearVariant"]').getAttribute('readonly'), null);
  console.log('  ✓ Currency Key and Fiscal Year Variant become read-only only for areas assigned to posted activity');
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

  // The page renders a second form — the assignment form — as soon as any company code has
  // pending assignments, and that form carries a companyCode control of its own. Every field
  // access in the create flow is scoped to the form that owns the create button, because an
  // unscoped [name="companyCode"] resolves to two elements the moment 2000 exists unassigned.
  const definitionForm = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Create company code', exact: true }) });

  const countryOptions = await definitionForm.locator('[name="country"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  const currencyOptions = await definitionForm.locator('[name="currency"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  assert.ok(countryOptions.includes('KW'), 'Authorized maintainer receives country choices.');
  assert.ok(currencyOptions.includes('KWD'), 'Authorized maintainer receives active-currency choices.');

  for (const field of ['client', 'changedBy', 'chartOfAccounts', 'fiscalYearVariant', 'postingPeriodVariant']) {
    assert.equal(await definitionForm.locator(`[name="${field}"]`).count(), 0, `${field} is not a definition-form field.`);
  }
  await definitionForm.locator('[name="companyCode"]').fill(code);
  await definitionForm.locator('[name="name"]').fill(name);
  await definitionForm.locator('[name="country"]').selectOption('KW');
  await definitionForm.locator('[name="currency"]').selectOption('KWD');
  await definitionForm.locator('[name="city"]').fill('Al Jahra');
  await definitionForm.locator('[name="taxRegistrationNumber"]').fill('B110-TAX-2000');
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
    assert.equal(await definitionForm.locator(`[name="${field}"]`).inputValue(), '', `${field} resets after success.`);
  }
  assert.equal(await definitionForm.locator('[name="country"]').inputValue(), '');
  assert.equal(await definitionForm.locator('[name="currency"]').inputValue(), '');

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
  await definitionForm.locator('[name="companyCode"]').fill(code);
  await definitionForm.locator('[name="name"]').fill('Attempted browser overwrite');
  await definitionForm.locator('[name="country"]').selectOption('US');
  await definitionForm.locator('[name="currency"]').selectOption('USD');
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
  // Chart keys are varchar(4) — this target was written when they were wider, and its
  // seven-character fixture keys were rejected by the column long after it last ran.
  const activeChart = 'B11A';
  const inactiveChart = 'B11O';
  console.log('Company Code CoA assignment: verify independent capabilities, local active choices, one-time save and read-only access');

  await page.goto(`${BASE}/config/company-codes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Company codes', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Create company code', exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count() >= 1, true, 'The standard structure builder leaves a readable assigned Company Code.');

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
  assert.ok(beforeCharts.some((chart) => chart.chart_of_accounts === 'CA01' && chart.is_active));
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

  // The dedicated assignment screen: findable, shows every standing assignment,
  // and judges a replacement attempt by name while a repeat changes nothing.
  await page.goto(`${BASE}/config/company-codes/assign-chart-of-accounts`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Assign chart of accounts to company code', exact: true }).waitFor();
  const standing = page.locator('section[aria-labelledby="coa-standing"]');
  await standing.locator('tbody tr').filter({ hasText: code }).getByText(activeChart).waitFor();
  assert.equal(await page.locator('select[name="companyCode"]').count(), 0, 'A read-only viewer gets no assignment form on the dedicated screen.');

  await signInAs('company.assigner');
  await page.goto(`${BASE}/config/company-codes/assign-chart-of-accounts`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 1, name: 'Assign chart of accounts to company code', exact: true }).waitFor();
  const assignSection = page.locator('section[aria-labelledby="coa-assign"]');
  await assignSection.locator('select[name="companyCode"]').selectOption(code);
  await assignSection.locator('select[name="chartOfAccounts"]').selectOption('CA01');
  await assignSection.locator('input[name="reason"]').fill('Browser dedicated-screen replacement attempt');
  await assignSection.getByRole('button', { name: 'Assign', exact: true }).click();
  await assignSection.getByText(new RegExp(`Company code ${code} already has chart of accounts ${activeChart} assigned`)).waitFor();

  await assignSection.locator('select[name="companyCode"]').selectOption(code);
  await assignSection.locator('select[name="chartOfAccounts"]').selectOption(activeChart);
  await assignSection.locator('input[name="reason"]').fill('Browser dedicated-screen repeat');
  await assignSection.getByRole('button', { name: 'Assign', exact: true }).click();
  await assignSection.getByText(`Chart of accounts ${activeChart} is already assigned to Company Code ${code}.`, { exact: true }).waitFor();
  console.log('  ✓ the dedicated screen shows the standing assignment, refuses replacement by name, and a repeat changes nothing');
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
  // The link navigates client-side, and the detail view it passes through carries the
  // code in a hidden input of the same name for its retire form. Reading the first
  // match therefore tested a hidden field mid-navigation and got null for readonly;
  // waiting for the edit URL and scoping to the visible field puts the assertion on the
  // form it means to check.
  await page.waitForURL(/edit=1/);
  const immutableCode = page.locator('input[name="methodCode"]:not([type="hidden"])');
  await immutableCode.waitFor();
  assert.equal(await immutableCode.getAttribute('readonly'), '');
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
  assert.equal(completedSupplierCompany?.chartOfAccounts,'CA01');
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
  // The action re-renders this panel from the server, and the client-side status line is lost in
  // that refresh, so there is no message to wait for. What the panel renders afterwards is read
  // from committed data, while a query issued from this process can run before the write is
  // visible to its own connection — which is why waiting on the button, or on nothing at all,
  // made this step pass or fail on timing alone. Waiting on the server's own sentence makes the
  // read that follows deterministic.
  await card('ORDERING_PARTNER').getByText('No related Supplier is assigned.',{exact:true}).waitFor();
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
  // The action re-renders this panel from the server, and the client-side status line is lost in
  // that refresh, so there is no message to wait for. What the panel renders afterwards is read
  // from committed data, while a query issued from this process can run before the write is
  // visible to its own connection — which is why waiting on the button, or on nothing at all,
  // made this step pass or fail on timing alone. Waiting on the server's own sentence makes the
  // read that follows deterministic.
  await delivery.getByText('No default is set. A purchasing transaction must ask the user to choose.',{exact:true}).waitFor();
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
    // The partners page gained a page-level gate on FND.PARTNER.DISPLAY after this target was
    // written, so a user without it is refused the page and never reaches the panel-level gate
    // that is the subject of this assertion. The fixture grants page access and nothing else:
    // the refusal still has to come from the panel, and still has to name the panel's authority.
    await tx.execute(sql`insert into role(client,code,name,is_read_only,created_by) values(${CLIENT},'PARTNER_PAGE_ONLY','Partner page access only',true,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability(client,role_code,capability_code) values(${CLIENT},'PARTNER_PAGE_ONLY','FND.PARTNER.DISPLAY')`);
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${id},${CLIENT},'purchasing.viewer','Purchasing Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${id},'PARTNER_PAGE_ONLY','BROWSER_FIXTURE')`);
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
  assert.equal((await getCustomerCompany(CLIENT,'TESTCUST01','1000'))?.chartOfAccounts,'CA01');
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
    // Page-level access, without which the partners page refuses both users below and neither
    // panel-level notice this target asserts can ever render. Read authority for the customer
    // panel stays the only thing that separates the reviewer from the unrelated viewer.
    await tx.execute(sql`insert into role_capability(client,role_code,capability_code) values(${CLIENT},'CUSTOMER_AR_REVIEWER','FND.PARTNER.DISPLAY')`);
    await tx.execute(sql`insert into role(client,code,name,is_read_only,created_by) values(${CLIENT},'PARTNER_PAGE_ONLY','Partner page access only',true,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability(client,role_code,capability_code) values(${CLIENT},'PARTNER_PAGE_ONLY','FND.PARTNER.DISPLAY')`);
    await tx.execute(sql`insert into app_user(id,client,username,full_name,password_hash,must_change_password,created_by) values(${warehouseId},${CLIENT},'company.viewer','Company Viewer',${password},false,'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role(client,user_id,role_code,created_by) values(${CLIENT},${warehouseId},'PARTNER_PAGE_ONLY','BROWSER_FIXTURE')`);
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
  // The status chip is uppercased by CSS (.chip applies `uppercase`) and innerText reports the
  // transformed text, so the catalogue's "Inactive" arrives as "INACTIVE". The comparison has to
  // be case-insensitive; matching the exact casing would test the stylesheet, not the status.
  assert.match(await locationRow.innerText(), /inactive/i);
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

async function purchasingGroups(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const code = 'B52';
  const initialName = 'B-152 Buyers';
  const updatedName = 'B-152 Updated';
  const passwordHash = await hashPassword(PASSWORD);
  console.log('Purchasing Groups: verify standalone contact maintenance, audit, consumer visibility and exact-capability access');

  const capabilities = await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'B152_PGROUP_DEF', 'B-152 Purchasing Group Definition Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'B152_PGROUP_DEF', 'CFG.PROC.PURGROUP.DEFINE', 'BROWSER_FIXTURE')`);
    const [definerId, viewerId] = [randomUUID(), randomUUID()];
    for (const [id, username, fullName, roleCode] of [
      [definerId, 'pg.definer', 'Purchasing Group Definition-Only User', 'B152_PGROUP_DEF'],
      [viewerId, 'pg.viewer', 'Purchasing Group Read-Only User', 'AUDITOR'],
    ]) {
      await tx.execute(sql`insert into app_user
        (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')`);
      await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
        values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')`);
    }
    return tx.execute(sql`select capability_code from role_capability
      where client = ${CLIENT} and role_code = 'B152_PGROUP_DEF' order by capability_code`);
  }) as unknown as Array<{ capability_code: string }>;
  assert.deepEqual(capabilities.map((row) => row.capability_code), ['CFG.PROC.PURGROUP.DEFINE']);

  const existing = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select purchasing_group from purchasing_group
     where client = ${CLIENT} and purchasing_group = ${code}
  `))) as unknown as Array<{ purchasing_group: string }>;
  assert.equal(existing.length, 0, 'The reserved B-152 group key must be unused in its fresh tenant.');

  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'commit' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');
  }

  async function groupRow(groupCode: string) {
    const rows = page.locator('tbody tr');
    for (let index = 0; index < await rows.count(); index++) {
      const row = rows.nth(index);
      const codeInput = row.locator('input[aria-label="Purchasing Group"]');
      if (await codeInput.count() && await codeInput.inputValue() === groupCode) return row;
    }
    return null;
  }

  await signInAs('pg.definer');
  await page.waitForLoadState('networkidle');
  await page.goto(`${BASE}/config/purchasing-groups`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Change View "Purchasing Groups": Overview', exact: true }).waitFor();
  await page.getByText('Purchasing Groups', { exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('button', { name: 'New Entries', exact: true }).count(), 1);
  for (const field of ['purchasingOrg', 'responsibleBuyer', 'companyCode', 'plant']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `${field} is outside the standalone definition form.`);
  }
  for (const field of ['Desc. Pur. Grp', 'Tel.No. Pur.Grp', 'Fax Number', 'Telephone', 'Extension', 'E-Mail Address']) {
    await page.getByRole('columnheader', { name: field, exact: true }).waitFor();
  }

  const baselineRowCount = await page.locator('tbody tr').count();
  await page.getByRole('button', { name: 'New Entries', exact: true }).click();
  await page.waitForFunction((expectedCount) => document.querySelectorAll('tbody tr').length === expectedCount, baselineRowCount + 1);
  const newRow = page.locator('tbody tr').last();
  await newRow.locator('input[aria-label="Purchasing Group"]').fill('b52');
  await newRow.locator('input[aria-label="Purchasing Group Description"]').fill(initialName);
  await newRow.locator('input[aria-label="Tel.No. Pur.Grp"]').fill('55501001122');
  await newRow.locator('input[aria-label="Fax Number"]').fill('555010011223344');
  await newRow.locator('input[aria-label="Telephone"]').fill('00965550100');
  await newRow.locator('input[aria-label="Extension"]').fill('314');
  await newRow.locator('input[aria-label="E-Mail Address"]').fill('buyers@example.test');
  assert.equal(await newRow.locator('input[aria-label="Purchasing Group"]').inputValue(), code, 'The overview normalizes the key to uppercase.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Purchasing Group overview saved. 1 entry changed; change history recorded.', { exact: true }).waitFor();

  const created = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select purchasing_group, name, tel_no_purch_group, fax_number, telephone, extension,
           email_address, purchasing_org, responsible_buyer, created_by
      from purchasing_group
     where client = ${CLIENT} and purchasing_group = ${code}
  `))) as unknown as Array<{
    purchasing_group: string; name: string; tel_no_purch_group: string; fax_number: string;
    telephone: string; extension: string; email_address: string;
    purchasing_org: string | null; responsible_buyer: string | null; created_by: string;
  }>;
  assert.deepEqual(Array.from(created), [{
    purchasing_group: code,
    name: initialName,
    tel_no_purch_group: '55501001122',
    fax_number: '555010011223344',
    telephone: '00965550100',
    extension: '314',
    email_address: 'buyers@example.test',
    purchasing_org: null,
    responsible_buyer: null,
    created_by: 'pg.definer',
  }]);
  const createHistory = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'purchasing_group', code));
  assert.equal(createHistory.length, 1);
  assert.equal(createHistory[0].changeType, 'CREATE');
  assert.equal(createHistory[0].changedBy, 'pg.definer');
  assert.ok(createHistory[0].items.some((item) => item.fieldName === 'telNoPurchGroup'));
  const choices = await supplierPurchasingChoices(CLIENT, '1000');
  assert.ok(choices.groups.some((group) => group.code === code && group.org === null), 'Unassigned group is available for supplier purchasing choices.');
  console.log('  ✓ new group saves contact fields without organisation assignments and is visible to existing purchasing consumers');

  // Search, copy and undo are client-side table actions; they must not write a second definition.
  await page.getByRole('button', { name: 'Find in Purchasing Groups', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Search group or description' });
  await search.fill(code);
  assert.equal(await page.locator('tbody tr').count(), 1);
  await search.fill('');
  await page.getByRole('button', { name: 'Find in Purchasing Groups', exact: true }).click();
  const createdRow = await groupRow(code);
  assert.ok(createdRow);
  await createdRow.getByRole('checkbox', { name: `Select Purchasing Group ${code}`, exact: true }).check();
  await page.getByRole('button', { name: 'Copy selected row', exact: true }).click();
  await page.waitForFunction((expectedCount) => document.querySelectorAll('tbody tr').length === expectedCount, baselineRowCount + 2);
  const copiedRow = page.locator('tbody tr').last();
  assert.equal(await copiedRow.locator('input[aria-label="Purchasing Group"]').inputValue(), '');
  assert.equal(await copiedRow.locator('input[aria-label="Purchasing Group Description"]').inputValue(), initialName);
  await page.getByRole('button', { name: 'Undo unsaved changes', exact: true }).click();
  await page.waitForFunction((expectedCount) => document.querySelectorAll('tbody tr').length === expectedCount, baselineRowCount + 1);
  assert.equal(await page.locator('tbody tr').count(), baselineRowCount + 1, 'Undo removes the unsaved copied row.');

  const rowToChange = await groupRow(code);
  assert.ok(rowToChange);
  await rowToChange.locator('input[aria-label="Purchasing Group Description"]').fill(updatedName);
  await rowToChange.locator('input[aria-label="Telephone"]').fill('00965550200');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Purchasing Group overview saved. 1 entry changed; change history recorded.', { exact: true }).waitFor();
  const updated = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select name, telephone, purchasing_org from purchasing_group
     where client = ${CLIENT} and purchasing_group = ${code}
  `))) as unknown as Array<{ name: string; telephone: string; purchasing_org: string | null }>;
  assert.deepEqual(Array.from(updated), [{ name: updatedName, telephone: '00965550200', purchasing_org: null }]);
  const updateHistory = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'purchasing_group', code));
  assert.equal(updateHistory.length, 2);
  assert.equal(updateHistory[0].changeType, 'CHANGE');
  assert.ok(updateHistory[0].items.some((item) => item.fieldName === 'name' && item.oldValue === initialName && item.newValue === updatedName));
  console.log('  ✓ inline changes update the definition and append field-level history');

  const rowToDelete = await groupRow(code);
  assert.ok(rowToDelete);
  await rowToDelete.getByRole('checkbox', { name: `Select Purchasing Group ${code}`, exact: true }).check();
  await page.getByRole('button', { name: 'Delete selected row', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Purchasing Group overview saved. 1 entry changed; change history recorded.', { exact: true }).waitFor();
  const deleted = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select count(*)::int as count from purchasing_group
     where client = ${CLIENT} and purchasing_group = ${code}
  `))) as unknown as Array<{ count: number }>;
  assert.equal(deleted[0].count, 0);
  const deleteHistory = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'purchasing_group', code));
  assert.equal(deleteHistory.length, 3);
  assert.equal(deleteHistory[0].changeType, 'DELETE');
  console.log('  ✓ unreferenced deletion preserves its audited history');

  await signInAs('pg.viewer');
  await page.goto(`${BASE}/config/purchasing-groups`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Change View "Purchasing Groups": Overview', exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.PROC.PURGROUP.DEFINE.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New Entries', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Delete selected row', exact: true }).count(), 0);

  // Forge a valid create request in the DOM to prove the server-side capability check is authoritative.
  const forgedCode = 'V01';
  await page.locator('form:has(input[name="changes"])').evaluate((form, payload) => {
    const input = form.querySelector<HTMLInputElement>('input[name="changes"]');
    if (!input) throw new Error('Expected the pending change-set field.');
    input.value = JSON.stringify(payload);
    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Submit forged change';
    form.appendChild(button);
  }, [{ mode: 'CREATE', purchasingGroup: forgedCode, expectedVersion: 0, values: { name: 'Forged group' } }]);
  await page.getByRole('button', { name: 'Submit forged change', exact: true }).click();
  await page.getByText('User pg.viewer does not hold the authority CFG.PROC.PURGROUP.DEFINE.', { exact: true }).waitFor();
  const forged = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select count(*)::int as count from purchasing_group
     where client = ${CLIENT} and purchasing_group = ${forgedCode}
  `))) as unknown as Array<{ count: number }>;
  assert.equal(forged[0].count, 0, 'A forged form submission cannot create a group without its activity capability.');
  console.log('  ✓ Auditor can inspect the overview but the forged mutation is rejected server-side');
}

async function purchasingOrgDefinition(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const code = 'B149PO';
  const changedName = 'B-149 Purchasing Organisation Updated';
  const createReason = 'B-149 Purchasing Organisation create';
  const changeReason = 'B-149 Purchasing Organisation change';
  const deactivateReason = 'B-149 Purchasing Organisation deactivation';
  const passwordHash = await hashPassword(PASSWORD);
  console.log('Purchasing Organisations: verify exact capability, separate assignments, create/change/deactivate, history and read-only access');

  const roleCapabilities = await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'B149_PURORG_DEFINE', 'B-149 Purchasing Organisation Definition Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'B149_PURORG_DEFINE', 'CFG.PROC.PURORG.DEFINE', 'BROWSER_FIXTURE')`);
    const [definerId, viewerId] = [randomUUID(), randomUUID()];
    for (const [id, username, fullName, roleCode] of [
      [definerId, 'purchasing.definer', 'Purchasing Organisation Definition-Only User', 'B149_PURORG_DEFINE'],
      [viewerId, 'purchasing.viewer', 'Purchasing Organisation Read-Only User', 'AUDITOR'],
    ]) {
      await tx.execute(sql`insert into app_user
        (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')`);
      await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
        values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')`);
    }
    return tx.execute(sql`select capability_code from role_capability
      where client = ${CLIENT} and role_code = 'B149_PURORG_DEFINE' order by capability_code`);
  }) as unknown as Array<{ capability_code: string }>;
  assert.deepEqual(roleCapabilities.map((row) => row.capability_code), ['CFG.PROC.PURORG.DEFINE']);

  const existingTarget = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select purchasing_org from purchasing_org
     where client = ${CLIENT} and purchasing_org = ${code}
  `))) as unknown as Array<{ purchasing_org: string }>;
  assert.equal(existingTarget.length, 0, 'The reserved B-149 organisation key must be unused in its fresh tenant.');

  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'commit' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');
  }

  async function readDefinition() {
    const rows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select client, purchasing_org, name, company_code, is_active, created_by, changed_by
        from purchasing_org
       where client = ${CLIENT} and purchasing_org = ${code}
    `))) as unknown as Array<{
      client: string; purchasing_org: string; name: string; company_code: string | null;
      is_active: boolean; created_by: string; changed_by: string | null;
    }>;
    assert.equal(rows.length, 1, 'The definition must be retained exactly once.');
    return rows[0];
  }

  // A user holding only the registered definition capability can maintain the definition.
  await signInAs('purchasing.definer');
  await page.goto(`${BASE}/config/purchasing-orgs`, { waitUntil: 'commit' });
  await page.locator('h1').filter({ hasText: 'Purchasing Organisations' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Create Purchasing Organisation', exact: true }).count(), 1);

  // The standard onboarding organisation shows both assignments as read-only, not as OX08 fields.
  const baselineRows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select company_code from purchasing_org
     where client = ${CLIENT} and purchasing_org = '1000'
  `))) as unknown as Array<{ company_code: string | null }>;
  assert.equal(baselineRows.length, 1);
  assert.equal(baselineRows[0].company_code?.trim(), '1000');
  const baselinePlantRows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select plant from purchasing_org_plant
     where client = ${CLIENT} and purchasing_org = '1000'
     order by plant
  `))) as unknown as Array<{ plant: string }>;
  assert.deepEqual(baselinePlantRows.map((row) => row.plant.trim()), ['1000']);
  await page.goto(`${BASE}/config/purchasing-orgs?purchasingOrg=1000`, { waitUntil: 'commit' });
  const baselineDetail = page.locator('section.panel').filter({
    has: page.getByRole('heading', { name: 'Purchasing Organisation · 1000', exact: true }),
  });
  await baselineDetail.waitFor();
  const baselineCompanyCode = baselineDetail.locator('dl > div')
    .filter({ hasText: 'Company Code assignment (read-only)' }).locator('dd');
  assert.equal((await baselineCompanyCode.innerText()).trim(), '1000');
  assert.deepEqual(await baselineDetail.locator('ul > li').allTextContents(), ['1000']);
  assert.equal(await page.locator('[name="companyCode"], [name="plant"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /assign/i }).count(), 0);
  console.log('  ✓ Company Code and Plant assignments are visible but have no OX08 controls');

  // The create URL carries an irrelevant, forged tenant query. Session scope remains authoritative.
  await page.goto(`${BASE}/config/purchasing-orgs?new=1&client=0100`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Create Purchasing Organisation', exact: true }).waitFor();
  await page.getByText(/Supplier-purchasing use requires exactly one Company Code assignment, maintained separately\./).waitFor();
  for (const field of ['client', 'changedBy', 'companyCode', 'plant', 'isActive']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `${field} is outside OX08.`);
  }
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '0');
  await page.locator('[name="purchasingOrg"]').fill(code);
  await page.locator('[name="name"]').fill('B-149 Purchasing Organisation');
  await page.locator('[name="reason"]').fill(createReason);
  const createForm = page.locator('form').filter({ has: page.locator('[name="mode"]') });
  await createForm.evaluate((form) => {
    for (const [field, value] of Object.entries({
      client: '0100', changedBy: 'spoofed.actor', companyCode: '1000', plant: '1000', isActive: 'false',
    })) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
    }
  });
  await page.getByRole('button', { name: 'Create Purchasing Organisation', exact: true }).click();
  await page.getByRole('status').getByText(
    `Purchasing Organisation ${code} defined; Company Code and Plant assignments remain separate.`,
    { exact: true },
  ).waitFor();

  const created = await readDefinition();
  assert.deepEqual(created, {
    client: CLIENT, purchasing_org: code, name: 'B-149 Purchasing Organisation', company_code: null,
    is_active: true, created_by: 'purchasing.definer', changed_by: null,
  });
  const assignmentsAfterCreate = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select plant from purchasing_org_plant
     where client = ${CLIENT} and purchasing_org = ${code}
  `))) as unknown as Array<{ plant: string }>;
  assert.equal(assignmentsAfterCreate.length, 0, 'OX08 must not create Plant assignment rows.');
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'purchasing_org', code));
  assert.equal(history.length, 1);
  assert.equal(history[0].changeType, 'CREATE');
  assert.equal(history[0].changedBy, 'purchasing.definer');
  assert.equal(history[0].transactionCode, 'CFG.PROC.PURORG.DEFINE');
  assert.equal(history[0].reason, createReason);
  assert.ok(history[0].items.some((item) => item.fieldName === 'name' && item.newValue === 'B-149 Purchasing Organisation'));
  let [activity] = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status, completed_by from config_activity_status
     where client = ${CLIENT} and activity_code = 'CFG.PROC.PURORG.DEFINE'
  `))) as unknown as Array<{ status: string; completed_by: string | null }>;
  assert.equal(activity?.status, 'COMPLETED');
  assert.equal(activity?.completed_by, 'purchasing.definer');
  await page.getByRole('link', { name: 'Open saved Purchasing Organisation', exact: true }).click();
  const pendingDetail = page.locator('section.panel').filter({
    has: page.getByRole('heading', { name: `Purchasing Organisation · ${code}`, exact: true }),
  });
  await pendingDetail.waitFor();
  const pendingCompanyCode = pendingDetail.locator('dl > div')
    .filter({ hasText: 'Company Code assignment (read-only)' }).locator('dd');
  assert.equal((await pendingCompanyCode.innerText()).trim(), 'Unassigned');
  await pendingDetail.getByText('No Plant assignments.', { exact: true }).waitFor();
  await pendingDetail.getByText(
    'Supplier-purchasing use is unavailable until exactly one Company Code is assigned in its separate activity. Cross-company and multi-company behaviour are not supported.',
    { exact: true },
  ).waitFor();
  console.log('  ✓ exact-capability create ignores forged tenant/actor/assignment/status fields and leaves the Company Code pending');

  // Change retains the key and uses the audit-count optimistic version.
  await page.goto(`${BASE}/config/purchasing-orgs?edit=${code}`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Change Purchasing Organisation', exact: true }).waitFor();
  assert.equal(await page.locator('input[readonly]').first().inputValue(), code);
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '1');
  await page.locator('[name="name"]').fill(changedName);
  await page.locator('[name="reason"]').fill(changeReason);
  const changeForm = page.locator('form').filter({ has: page.locator('[name="mode"]') });
  await changeForm.evaluate((form) => {
    for (const [field, value] of Object.entries({
      client: '0100', changedBy: 'spoofed.actor', companyCode: '2000', plant: '2000', isActive: 'false',
    })) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
    }
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').getByText(
    `Purchasing Organisation ${code} saved and its change history recorded.`,
    { exact: true },
  ).waitFor();
  const changed = await readDefinition();
  assert.deepEqual(changed, {
    client: CLIENT, purchasing_org: code, name: changedName, company_code: null,
    is_active: true, created_by: 'purchasing.definer', changed_by: 'purchasing.definer',
  });
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'purchasing_org', code));
  assert.equal(history.length, 2);
  assert.equal(history[0].changeType, 'CHANGE');
  assert.equal(history[0].changedBy, 'purchasing.definer');
  assert.equal(history[0].reason, changeReason);
  assert.ok(history[0].items.some((item) => item.fieldName === 'name' && item.oldValue === 'B-149 Purchasing Organisation' && item.newValue === changedName));
  await page.getByRole('link', { name: 'Open saved Purchasing Organisation', exact: true }).click();
  const changedDetail = page.locator('section.panel').filter({
    has: page.getByRole('heading', { name: `Purchasing Organisation · ${code}`, exact: true }),
  });
  const changedNameField = changedDetail.locator('dl > div').filter({ hasText: 'NAME' }).locator('dd');
  assert.equal((await changedNameField.innerText()).trim(), changedName);

  await page.goto(`${BASE}/config/purchasing-orgs?edit=${code}`, { waitUntil: 'commit' });
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '2');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').getByText(
    `No Purchasing Organisation definition data changed for ${code}.`,
    { exact: true },
  ).waitFor();
  assert.equal((await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'purchasing_org', code))).length, 2);
  console.log('  ✓ change preserves the key, records the session actor, and no-op does not add history');

  // Deactivation is a retained state change. Forged request fields cannot alter assignment or identity.
  await page.goto(`${BASE}/config/purchasing-orgs?purchasingOrg=${code}`, { waitUntil: 'commit' });
  const deactivateDetails = page.locator('details').filter({ hasText: 'Deactivate Purchasing Organisation' });
  await deactivateDetails.locator('summary').click();
  await deactivateDetails.locator('[name="reason"]').fill(deactivateReason);
  const deactivateForm = deactivateDetails.locator('form');
  for (const field of ['client', 'changedBy', 'companyCode', 'plant', 'isActive']) {
    assert.equal(await deactivateForm.locator(`[name="${field}"]`).count(), 0, `${field} is not a deactivation input.`);
  }
  await deactivateForm.evaluate((form) => {
    for (const [field, value] of Object.entries({
      client: '0100', changedBy: 'spoofed.actor', companyCode: '3000', plant: '3000', isActive: 'true',
    })) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
    }
  });
  await deactivateForm.getByRole('button', { name: 'Confirm deactivation', exact: true }).click();
  await page.getByRole('status').getByText(
    `Purchasing Organisation ${code} deactivated and retained with its Company Code, Plant assignments and history.`,
    { exact: true },
  ).waitFor();
  const deactivated = await readDefinition();
  assert.deepEqual(deactivated, {
    client: CLIENT, purchasing_org: code, name: changedName, company_code: null,
    is_active: false, created_by: 'purchasing.definer', changed_by: 'purchasing.definer',
  });
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'purchasing_org', code));
  assert.equal(history.length, 3);
  assert.deepEqual(new Set(history.map((entry) => entry.changeType)), new Set(['CREATE', 'CHANGE']));
  assert.ok(history.every((entry) => entry.changedBy === 'purchasing.definer'));
  assert.equal(history[0].reason, deactivateReason);
  [activity] = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status, completed_by from config_activity_status
     where client = ${CLIENT} and activity_code = 'CFG.PROC.PURORG.DEFINE'
  `))) as unknown as Array<{ status: string; completed_by: string | null }>;
  assert.equal(activity?.status, 'COMPLETED');
  assert.equal(activity?.completed_by, 'purchasing.definer');
  await page.goto(`${BASE}/config/purchasing-orgs?purchasingOrg=${code}&history=1`, { waitUntil: 'commit' });
  const inactiveDetail = page.locator('section.panel').filter({
    has: page.getByRole('heading', { name: `Purchasing Organisation · ${code}`, exact: true }),
  });
  await inactiveDetail.getByText('Inactive', { exact: true }).waitFor();
  await inactiveDetail.getByText('This definition is inactive and retained with its assignments and history.', { exact: true }).waitFor();
  await page.getByText(createReason, { exact: true }).waitFor();
  await page.getByText(changeReason, { exact: true }).waitFor();
  await page.getByText(deactivateReason, { exact: true }).waitFor();
  assert.equal(await page.locator('details').filter({ hasText: 'Deactivate Purchasing Organisation' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /delete|reactivate/i }).count(), 0);
  console.log('  ✓ deactivation retains one inactive row and three audit events; no delete/reactivation control appears');

  // An Auditor keeps list/detail/history access but receives no definition controls, including direct URLs.
  await signInAs('purchasing.viewer');
  await page.goto(`${BASE}/config/purchasing-orgs`, { waitUntil: 'commit' });
  await page.locator('h1').filter({ hasText: 'Purchasing Organisations' }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.PROC.PURORG.DEFINE.', { exact: true }).waitFor();
  const inactiveRow = page.locator('tbody tr').filter({ hasText: code });
  await inactiveRow.waitFor();
  assert.match(await inactiveRow.innerText(), /Inactive/i);
  assert.equal(await page.getByRole('link', { name: 'Create Purchasing Organisation', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
  await page.goto(`${BASE}/config/purchasing-orgs?new=1&client=0100`, { waitUntil: 'commit' });
  await page.getByText('Read-only view. Changes require authority CFG.PROC.PURORG.DEFINE.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Create Purchasing Organisation', exact: true }).count(), 0);
  for (const field of ['purchasingOrg', 'name', 'companyCode', 'plant', 'isActive']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `Auditor direct-create URL has no ${field} field.`);
  }
  await page.goto(`${BASE}/config/purchasing-orgs?purchasingOrg=${code}&history=1&client=0100`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: `Purchasing Organisation · ${code}`, exact: true }).waitFor();
  await page.getByRole('link', { name: 'Change history', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
  assert.equal(await page.locator('details').count(), 0);
  assert.equal(await page.getByRole('button', { name: /delete|reactivate|deactivate/i }).count(), 0);
  assert.equal(await page.locator('[name="purchasingOrg"], [name="name"], [name="companyCode"], [name="plant"]').count(), 0);
  await page.getByText(deactivateReason, { exact: true }).waitFor();
  console.log('  ✓ Auditor can review retained inactive history but direct list/detail/create URLs expose no maintenance controls');
}


async function salesOrgDefinition(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const code = 'B153';
  const changedName = 'Global Sales Org Updated';
  const createReason = 'B-153 Sales Organization create';
  const changeReason = 'B-153 Sales Organization change';
  const deactivateReason = 'B-153 Sales Organization deactivation';
  const vendorNumber = '12345';
  const customerNumber = 'CUST153';
  const roleCode = 'B153_SALESORG_DEFINE';
  const passwordHash = await hashPassword(PASSWORD);
  console.log('Sales Organizations: verify OVX5 fields, CAM address, logon-language text, exact capability, history and separate Company Code assignment');

  // Business Partner choices are created through the real UI; only test authorization and calendar customizing are fixture rows.
  await createSupplierRoleThroughUi(page, BASE, vendorNumber, 'B-153 Intercompany Vendor');
  await createCustomerRoleThroughUi(page, BASE, customerNumber, 'B-153 Intercompany Customer');
  const roleCapabilities = await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, ${roleCode}, 'B-153 Sales Organization Definition Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, ${roleCode}, 'CFG.ORG.SALESORG.DEFINE', 'BROWSER_FIXTURE')`);
    const definerId = randomUUID();
    const viewerId = randomUUID();
    await tx.execute(sql`insert into app_user
      (id, client, username, full_name, password_hash, must_change_password, preferences, created_by)
      values (${definerId}, ${CLIENT}, 'salesorg.definer', 'B-153 Sales Organization Definer', ${passwordHash}, false,
              ${JSON.stringify({ logonLanguage: 'D' })}::jsonb, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
      values (${CLIENT}, ${definerId}, ${roleCode}, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into app_user
      (id, client, username, full_name, password_hash, must_change_password, created_by)
      values (${viewerId}, ${CLIENT}, 'salesorg.viewer', 'B-153 Sales Organization Auditor', ${passwordHash}, false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
      values (${CLIENT}, ${viewerId}, 'AUDITOR', 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into factory_calendar (client, calendar_id, name, created_by)
      values (${CLIENT}, '01', 'B-153 sample factory calendar', 'BROWSER_FIXTURE')
      on conflict (client, calendar_id) do nothing`);
    return tx.execute(sql`select capability_code from role_capability
      where client = ${CLIENT} and role_code = ${roleCode} order by capability_code`);
  }) as unknown as Array<{ capability_code: string }>;
  assert.deepEqual(roleCapabilities.map((row) => row.capability_code), ['CFG.ORG.SALESORG.DEFINE']);

  const existingTarget = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select sales_org from sales_org where client = ${CLIENT} and sales_org = ${code}
  `))) as unknown as Array<{ sales_org: string }>;
  assert.equal(existingTarget.length, 0, 'The reserved B-153 Sales Organization key must be unused in its fresh tenant.');

  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'commit' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');
  }

  async function readDefinition(targetCode: string) {
    const rows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select org.client, org.sales_org, btrim(org.company_code) as company_code,
             btrim(org.currency) as currency, btrim(org.factory_calendar) as factory_calendar,
             org.ale_purchase_orders, btrim(org.purchasing_organization) as purchasing_organization,
             btrim(org.reference_sales_org) as reference_sales_org, org.rebate_processing_active,
             btrim(org.address_number) as address_number, btrim(org_text.language_key) as language_key,
             btrim(org_text.name) as name, btrim(org_text.form_text) as form_text,
             btrim(address.country) as country, address.search_term_1, address.search_term_2,
             address.street, address.house_number, address.postal_code, address.city, address.region,
             address.po_box, address.po_box_postal_code, address.company_postal_code,
             address.telephone, address.telephone_extension, address.mobile_phone,
             address.fax_number, address.fax_extension, address.email_address,
             org.intercompany_billing_customer, org.intercompany_billing_vendor,
             org.is_active, org.created_by, org.changed_by
        from sales_org org
        left join sales_org_text org_text
          on org_text.client = org.client and org_text.sales_org = org.sales_org and org_text.language_key = 'D'
        left join central_address address
          on address.client = org.client and address.address_number = org.address_number
       where org.client = ${CLIENT} and org.sales_org = ${targetCode}
    `))) as unknown as Array<{
      client: string; sales_org: string; company_code: string | null; currency: string | null;
      factory_calendar: string | null; ale_purchase_orders: boolean; purchasing_organization: string | null;
      reference_sales_org: string | null; rebate_processing_active: boolean; address_number: string | null;
      language_key: string | null; name: string | null; form_text: string | null; country: string | null;
      search_term_1: string | null; search_term_2: string | null; street: string | null; house_number: string | null;
      postal_code: string | null; city: string | null; region: string | null; po_box: string | null;
      po_box_postal_code: string | null; company_postal_code: string | null; telephone: string | null;
      telephone_extension: string | null; mobile_phone: string | null; fax_number: string | null;
      fax_extension: string | null; email_address: string | null; intercompany_billing_customer: string | null;
      intercompany_billing_vendor: string | null; is_active: boolean; created_by: string; changed_by: string | null;
    }>;
    assert.equal(rows.length, 1, `Sales Organization ${targetCode} must be retained exactly once.`);
    return rows[0];
  }

  await signInAs('salesorg.definer');
  await page.goto(`${BASE}/config/sales-orgs`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Change View "Sales Organizations": Overview', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'New Entries', exact: true }).count(), 1);

  // The standard package maintains Sales Organization 1000 and its Company Code separately.
  const baseline = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select btrim(company_code) as company_code, is_active from sales_org
     where client = ${CLIENT} and sales_org = '1000'
  `))) as unknown as Array<{ company_code: string | null; is_active: boolean }>;
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].company_code, '1000');
  assert.equal(baseline[0].is_active, true);
  await page.goto(`${BASE}/config/sales-orgs?salesOrg=1000`, { waitUntil: 'commit' });
  const baselineDetail = page.locator('section.panel').filter({
    has: page.getByRole('heading', { name: 'Sales Organization · 1000', exact: true }),
  });
  await baselineDetail.waitFor();
  assert.equal((await baselineDetail.locator('dl > div').filter({ hasText: 'Company Code (assigned separately)' }).locator('dd').innerText()).trim(), '1000');
  assert.equal(await baselineDetail.locator('input[name="companyCode"]').count(), 0);
  console.log('  ✓ standard Sales Organization is visible and its Company Code is read-only');

  await page.goto(`${BASE}/config/sales-orgs?new=1&client=0100`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'New Sales Organization', exact: true }).waitFor();
  for (const field of ['client', 'changedBy', 'companyCode', 'isActive']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `${field} is outside SCR-020 definition input.`);
  }
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '0');
  await page.locator('[name="salesOrg"]').fill(code);
  await page.locator('[name="name"]').fill('Global Sales Org');
  await page.getByText('Description is saved in your logon language (D).', { exact: true }).waitFor();
  await page.locator('[name="currency"]').selectOption('USD');
  assert.equal(await page.locator('[name="formText"]').inputValue(), 'STANDARD');
  const calendarOptions = await page.locator('[name="factoryCalendar"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  assert.ok(calendarOptions.includes('01'), 'The active tenant Factory Calendar is offered by the value help.');
  assert.equal(await page.locator('[name="factoryCalendar"]').inputValue(), '01', 'Factory Calendar 01 is the default when that customizing exists.');
  await page.locator('[name="factoryCalendar"]').selectOption('01');
  await page.locator('[name="purchasingOrganization"]').selectOption('1000');
  await page.locator('[name="referenceSalesOrg"]').selectOption('1000');
  await page.locator('[name="intercompanyBillingVendor"]').selectOption(vendorNumber);
  await page.locator('[name="intercompanyBillingCustomer"]').selectOption(customerNumber);
  assert.equal(await page.locator('[name="alePurchaseOrders"]').isChecked(), false);
  assert.equal(await page.locator('[name="rebateProcessingActive"]').isChecked(), false);
  await page.locator('[name="alePurchaseOrders"]').check();
  await page.locator('[name="rebateProcessingActive"]').check();

  await page.getByRole('button', { name: 'Maintain Address', exact: true }).click();
  const addressDialog = page.getByRole('dialog', { name: 'Central Address Management', exact: true });
  await addressDialog.waitFor();
  await addressDialog.locator('[name="addressCountry"]').selectOption('KW');
  for (const [field, value] of Object.entries({
    searchTerm1: 'NORTH', searchTerm2: 'EAST', street: 'Gulf Road', houseNumber: '12A',
    postalCode: '70010', city: 'Al Jahra', region: 'JAH', poBox: '123', poBoxPostalCode: '70012',
    companyPostalCode: '70014', telephone: '+965 2222 0100', telephoneExtension: '101',
    mobilePhone: '+965 5550 0100', faxNumber: '+965 2222 0199', faxExtension: '199',
    emailAddress: 'sales@example.test',
  })) await addressDialog.locator(`[name="${field}"]`).fill(value);
  // The dialog offers a header close and a footer close with the same accessible name; pick one deterministically.
  await addressDialog.getByRole('button', { name: 'Close dialog', exact: true }).first().click();
  await page.locator('[name="reason"]').fill(createReason);
  const createForm = page.locator('form').filter({ has: page.locator('[name="mode"]') });
  await createForm.evaluate((form) => {
    for (const [field, value] of Object.entries({
      client: '0100', changedBy: 'spoofed.actor', companyCode: '9999', isActive: 'false',
    })) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
    }
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').getByText(
    `Sales Organization ${code} created; Company Code assignment remains separate.`, { exact: true },
  ).waitFor();
  const created = await readDefinition(code);
  assert.match(created.address_number ?? '', /^\d{10}$/);
  assert.deepEqual(created, {
    client: CLIENT, sales_org: code, company_code: null, currency: 'USD', factory_calendar: '01',
    ale_purchase_orders: true, purchasing_organization: '1000', reference_sales_org: '1000',
    rebate_processing_active: true, address_number: created.address_number, language_key: 'D',
    name: 'Global Sales Org', form_text: 'STANDARD', country: 'KW', search_term_1: 'NORTH',
    search_term_2: 'EAST', street: 'Gulf Road', house_number: '12A', postal_code: '70010',
    city: 'Al Jahra', region: 'JAH', po_box: '123', po_box_postal_code: '70012',
    company_postal_code: '70014', telephone: '+965 2222 0100', telephone_extension: '101',
    mobile_phone: '+965 5550 0100', fax_number: '+965 2222 0199', fax_extension: '199',
    email_address: 'sales@example.test', intercompany_billing_customer: customerNumber,
    intercompany_billing_vendor: vendorNumber, is_active: true, created_by: 'salesorg.definer', changed_by: null,
  });
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org', code));
  assert.equal(history.length, 1);
  assert.equal(history[0].changeType, 'CREATE');
  assert.equal(history[0].changedBy, 'salesorg.definer');
  assert.equal(history[0].transactionCode, 'CFG.ORG.SALESORG.DEFINE');
  assert.equal(history[0].reason, createReason);
  assert.ok(history[0].items.some((item) => item.fieldName === 'street' && item.newValue === 'Gulf Road'));
  assert.ok(history[0].items.some((item) => item.fieldName === 'formText' && item.newValue === 'STANDARD'));
  assert.ok(history[0].items.some((item) => item.fieldName === 'factoryCalendar' && item.newValue === '01'));
  assert.ok(history[0].items.some((item) => item.fieldName === 'intercompanyBillingVendor' && item.newValue === '0000012345'));
  assert.ok(history[0].items.some((item) => item.fieldName === 'intercompanyBillingCustomer' && item.newValue === customerNumber));
  assert.ok(!history[0].items.some((item) => item.fieldName === 'companyCode'));
  let [activity] = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status, completed_by from config_activity_status
     where client = ${CLIENT} and activity_code = 'CFG.ORG.SALESORG.DEFINE'
  `))) as unknown as Array<{ status: string; completed_by: string | null }>;
  assert.equal(activity?.status, 'COMPLETED');
  assert.equal(activity?.completed_by, 'salesorg.definer');
  console.log('  ✓ exact-capability create uses logon language, persists OVX5 values/CAM address and ignores forged assignment data');

  await page.goto(`${BASE}/config/sales-orgs?salesOrg=${code}`, { waitUntil: 'commit' });
  const createdDetail = page.locator('section.panel').filter({
    has: page.getByRole('heading', { name: `Sales Organization · ${code}`, exact: true }),
  });
  await createdDetail.waitFor();
  assert.equal((await createdDetail.locator('dl > div').filter({ hasText: /^Vendor/ }).locator('dd').innerText()).trim(), '0000012345');
  assert.equal((await createdDetail.locator('dl > div').filter({ hasText: 'Customer for Intercompany Billing' }).locator('dd').innerText()).trim(), customerNumber);
  console.log('  ✓ vendor selection preserves canonical BP key while detail and audit show the fixed ten-digit ID');

  await page.goto(`${BASE}/config/sales-orgs?edit=${code}`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Change Sales Organization', exact: true }).waitFor();
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '1');
  assert.equal(await page.locator('[name="salesOrg"]').getAttribute('readonly'), '');
  await page.locator('[name="name"]').fill(changedName);
  await page.locator('[name="formText"]').fill('B153FORM');
  await page.getByRole('button', { name: 'Change Address', exact: true }).click();
  const changeAddressDialog = page.getByRole('dialog', { name: 'Central Address Management', exact: true });
  await changeAddressDialog.waitFor();
  await changeAddressDialog.locator('[name="street"]').fill('Boulevard 10');
  await changeAddressDialog.locator('[name="telephone"]').fill('+965 2222 0200');
  await changeAddressDialog.getByRole('button', { name: 'Close dialog', exact: true }).first().click();
  await page.locator('[name="reason"]').fill(changeReason);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').getByText(`Sales Organization ${code} saved and its change history recorded.`, { exact: true }).waitFor();
  const changed = await readDefinition(code);
  assert.deepEqual(changed, {
    client: CLIENT, sales_org: code, company_code: null, currency: 'USD', factory_calendar: '01',
    ale_purchase_orders: true, purchasing_organization: '1000', reference_sales_org: '1000',
    rebate_processing_active: true, address_number: created.address_number, language_key: 'D',
    name: changedName, form_text: 'B153FORM', country: 'KW', search_term_1: 'NORTH',
    search_term_2: 'EAST', street: 'Boulevard 10', house_number: '12A', postal_code: '70010',
    city: 'Al Jahra', region: 'JAH', po_box: '123', po_box_postal_code: '70012',
    company_postal_code: '70014', telephone: '+965 2222 0200', telephone_extension: '101',
    mobile_phone: '+965 5550 0100', fax_number: '+965 2222 0199', fax_extension: '199',
    email_address: 'sales@example.test', intercompany_billing_customer: customerNumber,
    intercompany_billing_vendor: vendorNumber, is_active: true, created_by: 'salesorg.definer', changed_by: 'salesorg.definer',
  });
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org', code));
  assert.equal(history.length, 2);
  assert.equal(history[0].changeType, 'CHANGE');
  assert.equal(history[0].reason, changeReason);
  assert.ok(history[0].items.some((item) => item.fieldName === 'name' && item.oldValue === 'Global Sales Org' && item.newValue === changedName));
  assert.ok(history[0].items.some((item) => item.fieldName === 'street' && item.oldValue === 'Gulf Road' && item.newValue === 'Boulevard 10'));
  assert.ok(!history.flatMap((entry) => entry.items).some((item) => item.fieldName === 'companyCode'));
  console.log('  ✓ change retains ADRNR and dependent CAM fields while the language-dependent description/Form Text are versioned');

  await page.goto(`${BASE}/config/sales-orgs?edit=${code}`, { waitUntil: 'commit' });
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '2');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').getByText(`No Sales Organization definition data changed for ${code}.`, { exact: true }).waitFor();
  assert.equal((await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org', code))).length, 2);
  console.log('  ✓ no-op change does not add a change document');

  await page.goto(`${BASE}/config/sales-orgs?salesOrg=${code}`, { waitUntil: 'commit' });
  const deactivateDetails = page.locator('details').filter({ hasText: 'Deactivate Sales Organization' });
  await deactivateDetails.locator('summary').click();
  await deactivateDetails.locator('[name="confirmDeactivation"]').check();
  await deactivateDetails.locator('[name="reason"]').fill(deactivateReason);
  await deactivateDetails.locator('form').getByRole('button', { name: 'Confirm deactivation', exact: true }).click();
  await page.getByRole('status').getByText(`Sales Organization ${code} deactivated and retained with its history.`, { exact: true }).waitFor();
  assert.deepEqual(await readDefinition(code), {
    client: CLIENT, sales_org: code, company_code: null, currency: 'USD', factory_calendar: '01',
    ale_purchase_orders: true, purchasing_organization: '1000', reference_sales_org: '1000',
    rebate_processing_active: true, address_number: created.address_number, language_key: 'D',
    name: changedName, form_text: 'B153FORM', country: 'KW', search_term_1: 'NORTH',
    search_term_2: 'EAST', street: 'Boulevard 10', house_number: '12A', postal_code: '70010',
    city: 'Al Jahra', region: 'JAH', po_box: '123', po_box_postal_code: '70012',
    company_postal_code: '70014', telephone: '+965 2222 0200', telephone_extension: '101',
    mobile_phone: '+965 5550 0100', fax_number: '+965 2222 0199', fax_extension: '199',
    email_address: 'sales@example.test', intercompany_billing_customer: customerNumber,
    intercompany_billing_vendor: vendorNumber, is_active: false, created_by: 'salesorg.definer', changed_by: 'salesorg.definer',
  });
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org', code));
  assert.equal(history.length, 3);
  assert.equal(history[0].changeType, 'CHANGE');
  assert.equal(history[0].reason, deactivateReason);
  assert.ok(history[0].items.some((item) => item.fieldName === 'isActive' && item.oldValue === 'true' && item.newValue === 'false'));
  console.log('  ✓ confirmed soft deactivation keeps one inactive row and full retained history');

  // The standard organisation is referenced by a Sales Area; a blocked deactivation must not change it.
  await page.goto(`${BASE}/config/sales-orgs?salesOrg=1000`, { waitUntil: 'commit' });
  const protectedDetails = page.locator('details').filter({ hasText: 'Deactivate Sales Organization' });
  await protectedDetails.locator('summary').click();
  await protectedDetails.locator('[name="confirmDeactivation"]').check();
  await protectedDetails.locator('form').getByRole('button', { name: 'Confirm deactivation', exact: true }).click();
  await page.getByRole('alert').getByText(/still referenced by sales-area configuration/, { exact: false }).waitFor();
  const protectedBaseline = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select is_active from sales_org where client = ${CLIENT} and sales_org = '1000'
  `))) as unknown as Array<{ is_active: boolean }>;
  assert.equal(protectedBaseline[0].is_active, true);
  await page.goto(`${BASE}/config/sales-orgs?edit=${code}`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: `Sales Organization · ${code}`, exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
  assert.equal(await page.locator('details').count(), 0);
  assert.equal(await page.getByRole('button', { name: /delete|reactivate/i }).count(), 0);
  console.log('  ✓ dependent Sales Areas block deactivation and inactive definitions cannot be changed or reactivated');

  await signInAs('salesorg.viewer');
  await page.goto(`${BASE}/config/sales-orgs`, { waitUntil: 'commit' });
  await page.getByText('Read-only view. Changes require authority CFG.ORG.SALESORG.DEFINE.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'New Entries', exact: true }).count(), 0);
  await page.goto(`${BASE}/config/sales-orgs?new=1&client=0100`, { waitUntil: 'commit' });
  await page.getByText('Read-only view. Changes require authority CFG.ORG.SALESORG.DEFINE.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'New Sales Organization', exact: true }).count(), 0);
  for (const field of ['salesOrg', 'name', 'currency', 'factoryCalendar', 'companyCode', 'isActive']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `Auditor direct-create URL has no ${field} field.`);
  }
  await page.goto(`${BASE}/config/sales-orgs?salesOrg=${code}&history=1`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: `Sales Organization · ${code}`, exact: true }).waitFor();
  await page.getByRole('link', { name: 'Change history', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
  assert.equal(await page.locator('details').count(), 0);
  assert.equal(await page.getByRole('button', { name: /delete|reactivate|deactivate/i }).count(), 0);
  assert.equal(await page.locator('[name="salesOrg"], [name="name"], [name="companyCode"]').count(), 0);
  await page.getByText(deactivateReason, { exact: true }).waitFor();
  console.log('  ✓ Auditor retains tenant-local review but receives no definition or deactivation controls');
}

async function purchasingOrgCompanyCodeAssignment(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const code = 'B151PO';
  const passwordHash = await hashPassword(PASSWORD);
  console.log('Purchasing Organisation -> Company Code: verify separate initial-assignment activity, exact capability, tenant scope and audit');

  // Create a pending Purchasing Organisation through OX08, using the real browser form.
  await page.goto(`${BASE}/config/purchasing-orgs?new=1`, { waitUntil: 'commit' });
  await page.locator('[name="purchasingOrg"]').fill(code);
  await page.locator('[name="name"]').fill('B-151 Purchasing Organisation');
  await page.locator('[name="reason"]').fill('B-151 SCR-018 pending organisation');
  await page.getByRole('button', { name: 'Create Purchasing Organisation', exact: true }).click();
  await page.getByRole('status').getByText(
    `Purchasing Organisation ${code} defined; Company Code and Plant assignments remain separate.`,
    { exact: true },
  ).waitFor();

  // Assign-only, definition-only and Auditor users prove the authorities do not bleed together.
  await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'B151_ASSIGN', 'B-151 Purchasing Organisation Assignment Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'B151_ASSIGN', 'CFG.PROC.PURORG.ASSIGN_COMPANY', 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'B151_DEFINE', 'B-151 Purchasing Organisation Definition Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'B151_DEFINE', 'CFG.PROC.PURORG.DEFINE', 'BROWSER_FIXTURE')`);
    const [assignerId, definerId, viewerId] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, username, fullName, roleCode] of [
      [assignerId, 'purchasing.assigner', 'Purchasing Organisation Assigner', 'B151_ASSIGN'],
      [definerId, 'purchasing.definer', 'Purchasing Organisation Definer', 'B151_DEFINE'],
      [viewerId, 'purchasing.viewer', 'Purchasing Organisation Auditor', 'AUDITOR'],
    ]) {
      await tx.execute(sql`insert into app_user
        (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')`);
      await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
        values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')`);
    }
    await tx.execute(sql`update config_activity_status
      set status = 'NOT_STARTED', completed_at = null, completed_by = null
      where client = ${CLIENT} and activity_code = 'CFG.PROC.PURORG.ASSIGN_COMPANY'`);
  });

  const signInAs = async (username: string) => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'commit' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/', { waitUntil: 'commit' });
  };

  const pendingRows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select company_code from purchasing_org
     where client = ${CLIENT} and purchasing_org = ${code}
  `))) as unknown as Array<{ company_code: string | null }>;
  assert.deepEqual(Array.from(pendingRows), [{ company_code: null }], 'OX08 must leave the new organisation pending.');

  await signInAs('purchasing.definer');
  await page.goto(`${BASE}/config/purchasing-orgs/assign-company`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Assign Purchasing Organisation to Company Code', exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.PROC.PURORG.ASSIGN_COMPANY.', { exact: true }).waitFor();
  assert.equal(await page.locator('select[name="companyCode"]').count(), 0, 'Definition-only authority cannot assign.');
  console.log('  ✓ OX08 definition authority does not grant Company Code assignment');

  await signInAs('purchasing.assigner');
  await page.goto(`${BASE}/config/purchasing-orgs/assign-company`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Assign Purchasing Organisation to Company Code', exact: true }).waitFor();
  const orgRow = page.locator('tbody tr').filter({ hasText: code });
  await orgRow.waitFor();
  const companyChoices = await orgRow.locator('select[name="companyCode"] option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  assert.ok(companyChoices.includes('1000'), 'The active same-tenant standard Company Code is offered.');
  assert.equal(companyChoices.includes(''), true, 'The select begins with its placeholder.');
  for (const field of ['client', 'changedBy', 'isActive']) {
    assert.equal(await orgRow.locator(`[name="${field}"]`).count(), 0, `${field} is outside the assignment form.`);
  }
  const assignmentForm = orgRow.locator('form');
  await assignmentForm.evaluate((form) => {
    for (const [field, value] of Object.entries({ client: '0100', changedBy: 'spoofed.actor', isActive: 'false' })) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
    }
  });
  await orgRow.locator('select[name="companyCode"]').selectOption('1000');
  await orgRow.getByRole('button', { name: 'Assign Company Code', exact: true }).click();
  await orgRow.getByRole('link', { name: 'View', exact: true }).waitFor();

  const assigned = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select client, purchasing_org, name, company_code, is_active, created_by, changed_by
      from purchasing_org where client = ${CLIENT} and purchasing_org = ${code}
  `))) as unknown as Array<{
    client: string; purchasing_org: string; name: string; company_code: string | null;
    is_active: boolean; created_by: string; changed_by: string | null;
  }>;
  assert.deepEqual(Array.from(assigned), [{
    client: CLIENT, purchasing_org: code, name: 'B-151 Purchasing Organisation', company_code: '1000',
    is_active: true, created_by: 'browser.admin', changed_by: 'purchasing.assigner',
  }]);
  const history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'purchasing_org', code));
  assert.equal(history.length, 2);
  const assignmentEvent = history.find((entry) => entry.transactionCode === 'CFG.PROC.PURORG.ASSIGN_COMPANY');
  assert.ok(assignmentEvent);
  assert.equal(assignmentEvent.changedBy, 'purchasing.assigner');
  assert.deepEqual(assignmentEvent.items.map((item) => [item.fieldName, item.oldValue, item.newValue]), [
    ['companyCode', null, '1000'],
  ]);
  const [activity] = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status, completed_by from config_activity_status
     where client = ${CLIENT} and activity_code = 'CFG.PROC.PURORG.ASSIGN_COMPANY'
  `))) as unknown as Array<{ status: string; completed_by: string | null }>;
  assert.equal(activity?.status, 'COMPLETED');
  assert.equal(activity?.completed_by, 'purchasing.assigner');
  console.log('  ✓ exact-capability initial assignment writes one tenant-local link and a Company Code audit event');

  await page.goto(`${BASE}/config/purchasing-orgs/assign-company`, { waitUntil: 'commit' });
  const assignedRow = page.locator('tbody tr').filter({ hasText: code });
  assert.equal(await assignedRow.locator('select[name="companyCode"]').count(), 0, 'Assigned organisations have no replacement or clear control.');
  const baselineRow = page.locator('tbody tr').filter({ hasText: '1000' }).first();
  assert.equal(await baselineRow.locator('select[name="companyCode"]').count(), 0, 'The preassigned standard organisation is read-only here.');
  await page.goto(`${BASE}/config/purchasing-orgs?purchasingOrg=${code}&history=1`, { waitUntil: 'commit' });
  await page.getByText('Company Code: — → 1000', { exact: false }).waitFor();
  console.log('  ✓ assignment remains read-only after save and is visible in OX08 detail history');

  await signInAs('purchasing.viewer');
  await page.goto(`${BASE}/config/purchasing-orgs/assign-company`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Assign Purchasing Organisation to Company Code', exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.PROC.PURORG.ASSIGN_COMPANY.', { exact: true }).waitFor();
  assert.equal(await page.locator('select[name="companyCode"]').count(), 0, 'Auditor has no assignment choices.');
  assert.equal(await page.getByRole('button', { name: 'Assign Company Code', exact: true }).count(), 0);
  console.log('  ✓ Auditor can review assignments but has no assignment controls');
}


async function salesOrgCompanyCodeAssignment(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const salesOrgCode = 'B216';
  const reassignmentCode = '2000';
  const tooLongCompanyCode = '99999';
  const passwordHash = await hashPassword(PASSWORD);
  const assignmentActivity = 'CFG.ORG.SALESORG.ASSIGN_COMPANY';
  console.log('Sales Organization -> Company Code (OVX3): verify four-character F4 fields, audited reassignment, exact capability and mobile layout');

  // Prepare a pending Sales Organization and two valid Company Codes through the product services.
  const definedSalesOrg = await saveSalesOrgDefinition({
    client: CLIENT,
    changedBy: 'browser.admin',
    mode: 'CREATE',
    salesOrg: salesOrgCode,
    expectedVersion: 0,
    values: { name: 'B-216 Sales Organization', address: { country: 'KW' } },
  });
  assert.equal(definedSalesOrg.created, true);
  await defineCompanyCode({
    client: CLIENT, changedBy: 'browser.admin', companyCode: reassignmentCode,
    name: 'B-216 Secondary Company', country: 'KW', currency: 'KWD',
  });
  // A five-character definition may exist in the wider data model but is outside OVX3's Char 4 help.
  await defineCompanyCode({
    client: CLIENT, changedBy: 'browser.admin', companyCode: tooLongCompanyCode,
    name: 'B-216 Non-OVX3 Company', country: 'KW', currency: 'KWD',
  });

  // Create three distinct personas: assignment-only, definition-only, and Auditor.
  const roleCapabilities = await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'B216_ASSIGN', 'B-216 Sales Company Assignment Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'B216_ASSIGN', ${assignmentActivity}, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'B216_DEFINE', 'B-216 Sales Organization Definition Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'B216_DEFINE', 'CFG.ORG.SALESORG.DEFINE', 'BROWSER_FIXTURE')`);
    const assignerId = randomUUID();
    const definerId = randomUUID();
    const viewerId = randomUUID();
    for (const [id, username, fullName, roleCode] of [
      [assignerId, 'sales.assigner', 'B-216 Sales Company Assigner', 'B216_ASSIGN'],
      [definerId, 'sales.definer', 'B-216 Sales Organization Definer', 'B216_DEFINE'],
      [viewerId, 'sales.viewer', 'B-216 Sales Organization Auditor', 'AUDITOR'],
    ]) {
      await tx.execute(sql`insert into app_user
        (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')`);
      await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
        values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')`);
    }
    await tx.execute(sql`update config_activity_status
      set status = 'NOT_STARTED', completed_at = null, completed_by = null, changed_by = 'BROWSER_FIXTURE', changed_at = now()
      where client = ${CLIENT} and activity_code = ${assignmentActivity}`);
    const capabilities = await tx.execute(sql`select capability_code from role_capability
      where client = ${CLIENT} and role_code = 'B216_ASSIGN' order by capability_code`);
    return capabilities;
  }) as unknown as Array<{ capability_code: string }>;
  assert.deepEqual(roleCapabilities.map((row) => row.capability_code), [assignmentActivity]);

  const signInAs = async (username: string) => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'commit' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/', { waitUntil: 'commit' });
  };

  async function assignmentRow() {
    const rows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select client, sales_org, btrim(company_code) as company_code, is_active, created_by, changed_by
        from sales_org where client = ${CLIENT} and sales_org = ${salesOrgCode}
    `))) as unknown as Array<{
      client: string; sales_org: string; company_code: string | null; is_active: boolean;
      created_by: string; changed_by: string | null;
    }>;
    assert.equal(rows.length, 1, 'A Sales Organization occupies one row and therefore one current Company Code only.');
    return rows[0];
  }

  async function signInAsAssigner() {
    await signInAs('sales.assigner');
    await page.goto(`${BASE}/config/sales-orgs/assign-company`, { waitUntil: 'commit' });
    await page.getByRole('heading', { name: 'Assign Sales Organization to Company Code', exact: true }).waitFor();
  }

  async function selectSalesOrgWithF4(code: string, expectedCurrentCompanyCode?: string) {
    const field = page.locator('[name="salesOrg"]');
    await field.press('F4');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Sales Organization lookup', exact: true }).waitFor();
    await dialog.locator('[type="search"]').fill(code);
    const choice = dialog.getByRole('button', { name: new RegExp(code) });
    await choice.waitFor();
    assert.equal(await choice.isEnabled(), true, `Active Sales Organization ${code} is selectable even when it already has a Company Code.`);
    if (expectedCurrentCompanyCode) {
      await choice.getByText(`Current: ${expectedCurrentCompanyCode}`, { exact: true }).waitFor();
    }
    await choice.click();
    assert.equal(await field.inputValue(), code);
  }

  async function selectCompanyCodeWithF4(code: string) {
    const field = page.locator('[name="companyCode"]');
    await page.getByRole('button', { name: 'Open Company Code lookup (F4)', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Company Code lookup', exact: true }).waitFor();
    await dialog.locator('[type="search"]').fill(code);
    const choice = dialog.getByRole('button', { name: new RegExp(code) });
    await choice.waitFor();
    await choice.click();
    assert.equal(await field.inputValue(), code);
  }

  // The user with only the SCR-020 definition authority cannot see or invoke OVX3 controls.
  await signInAs('sales.definer');
  await page.goto(`${BASE}/config/sales-orgs/assign-company`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Assign Sales Organization to Company Code', exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.ORG.SALESORG.ASSIGN_COMPANY.', { exact: true }).waitFor();
  assert.equal(await page.locator('[name="salesOrg"], [name="companyCode"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Open Sales Organization lookup (F4)', exact: true }).count(), 0);
  console.log('  ✓ Sales Organization definition authority does not grant assignment authority');

  await signInAsAssigner();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open Sales Organization lookup (F4)', exact: true }).waitFor();
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(pageWidth <= 391, `OVX3 assignment screen must fit a 390px viewport (document width ${pageWidth}px).`);
  await selectSalesOrgWithF4(salesOrgCode);

  // Verify the F4 list enforces the OVX3 four-character destination format, even if longer codes exist in data.
  await page.getByRole('button', { name: 'Open Company Code lookup (F4)', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Company Code lookup', exact: true }).waitFor();
  await dialog.locator('[type="search"]').fill(tooLongCompanyCode);
  await dialog.getByText('No matching active Company Codes are available.', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await selectCompanyCodeWithF4('1000');

  const firstForm = page.locator('form').filter({ has: page.locator('[name="salesOrg"]') });
  await firstForm.evaluate((form) => {
    for (const [field, value] of Object.entries({ client: '0100', changedBy: 'spoofed.actor', companyCode: '3000' })) {
      if (field === 'companyCode') continue;
      const input = document.createElement('input'); input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
    }
  });
  await firstForm.getByRole('button', { name: 'Assign Company Code', exact: true }).click();
  await page.getByRole('status').getByText(
    `Sales Organization ${salesOrgCode} assigned to Company Code 1000; change history recorded.`,
    { exact: true },
  ).waitFor();
  assert.deepEqual(await assignmentRow(), {
    client: CLIENT, sales_org: salesOrgCode, company_code: '1000', is_active: true,
    created_by: 'browser.admin', changed_by: 'sales.assigner',
  });
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org', salesOrgCode));
  assert.equal(history.length, 2);
  const initialAssignment = history.find((entry) => entry.transactionCode === assignmentActivity);
  assert.ok(initialAssignment);
  assert.equal(initialAssignment.changedBy, 'sales.assigner');
  assert.deepEqual(initialAssignment.items.map((item) => [item.fieldName, item.oldValue, item.newValue]), [
    ['companyCode', null, '1000'],
  ]);
  console.log('  ✓ F4 selection creates one tenant-local assignment under the session actor and records the first audit event');

  // An already-assigned Sales Organization remains selectable; repeating the same pair adds no history.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE}/config/sales-orgs/assign-company`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Assign Sales Organization to Company Code', exact: true }).waitFor();
  await selectSalesOrgWithF4(salesOrgCode, '1000');
  await selectCompanyCodeWithF4('1000');
  await page.getByRole('button', { name: 'Assign Company Code', exact: true }).click();
  await page.getByRole('status').getByText(
    `Sales Organization ${salesOrgCode} is already assigned to Company Code 1000.`,
    { exact: true },
  ).waitFor();
  assert.equal((await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org', salesOrgCode))).length, 2);
  console.log('  ✓ repeating the same assignment is idempotent and the current value remains visible in F4');

  // A different active Company Code may replace the current assignment; old/new values remain audited.
  await page.goto(`${BASE}/config/sales-orgs/assign-company`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Assign Sales Organization to Company Code', exact: true }).waitFor();
  await selectSalesOrgWithF4(salesOrgCode, '1000');
  await selectCompanyCodeWithF4(reassignmentCode);
  const reassignmentForm = page.locator('form').filter({ has: page.locator('[name="salesOrg"]') });
  assert.equal(await reassignmentForm.locator('button').filter({ hasText: /clear|unassign/i }).count(), 0);
  await reassignmentForm.getByRole('button', { name: 'Assign Company Code', exact: true }).click();
  await page.getByRole('status').getByText(
    `Sales Organization ${salesOrgCode} reassigned to Company Code ${reassignmentCode}; the previous value and this change are recorded in history.`,
    { exact: true },
  ).waitFor();
  assert.deepEqual(await assignmentRow(), {
    client: CLIENT, sales_org: salesOrgCode, company_code: reassignmentCode, is_active: true,
    created_by: 'browser.admin', changed_by: 'sales.assigner',
  });
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org', salesOrgCode));
  assert.equal(history.length, 3);
  const reassignmentEvent = history.find((entry) => entry.transactionCode === assignmentActivity
    && entry.items.some((item) => item.oldValue === '1000' && item.newValue === reassignmentCode));
  assert.ok(reassignmentEvent);
  assert.equal(reassignmentEvent.changedBy, 'sales.assigner');
  assert.ok(reassignmentEvent.items.some((item) => item.fieldName === 'companyCode'
    && item.oldValue === '1000' && item.newValue === reassignmentCode && item.isSecurityRelevant === 'true'));
  const [activity] = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status, completed_by from config_activity_status
     where client = ${CLIENT} and activity_code = ${assignmentActivity}
  `))) as unknown as Array<{ status: string; completed_by: string | null }>;
  assert.equal(activity?.status, 'COMPLETED');
  assert.equal(activity?.completed_by, 'sales.assigner');
  const afterRows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select count(*)::int as n, count(distinct company_code)::int as company_count
      from sales_org where client = ${CLIENT} and sales_org = ${salesOrgCode}
  `))) as unknown as Array<{ n: number; company_count: number }>;
  assert.deepEqual(Array.from(afterRows), [{ n: 1, company_count: 1 }]);
  console.log('  ✓ reassignment replaces the single current Company Code and records the old/new values as security-relevant history');

  // The exact-capability user sees current state, while the Auditor remains display-only.
  await page.goto(`${BASE}/config/sales-orgs/assign-company`, { waitUntil: 'commit' });
  const orgRow = page.locator('tbody tr').filter({ hasText: salesOrgCode });
  await orgRow.waitFor();
  assert.match(await orgRow.innerText(), new RegExp(`${salesOrgCode}.*${reassignmentCode}`));
  await signInAs('sales.viewer');
  await page.goto(`${BASE}/config/sales-orgs/assign-company`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: 'Assign Sales Organization to Company Code', exact: true }).waitFor();
  await page.getByText('Read-only view. Changes require authority CFG.ORG.SALESORG.ASSIGN_COMPANY.', { exact: true }).waitFor();
  assert.equal(await page.locator('[name="salesOrg"], [name="companyCode"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /lookup \(F4\)/i }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Assign Company Code', exact: true }).count(), 0);
  console.log('  ✓ exact-capability assignment persists and Auditor can review the list without maintenance controls');
}

type DistributionDimensionKind = 'distributionChannel' | 'division';
type DistributionDimensionRecord = {
  client: string; code: string; name: string; is_active: boolean; created_by: string; changed_by: string | null;
};

async function distributionDimensionDefinition(ctx: BrowserContext, kind: DistributionDimensionKind) {
  const { page, BASE, CLIENT } = scope(ctx);
  const channel = kind === 'distributionChannel';
  const singular = channel ? 'Distribution Channel' : 'Division';
  const plural = channel ? 'Distribution Channels' : 'Divisions';
  const codeField = channel ? 'distributionChannel' : 'division';
  const route = channel ? '/config/distribution-channels' : '/config/divisions';
  const otherRoute = channel ? '/config/divisions' : '/config/distribution-channels';
  const activity = channel ? 'CFG.ORG.DISTCHANNEL.DEFINE' : 'CFG.ORG.DIVISION.DEFINE';
  const otherActivity = channel ? 'CFG.ORG.DIVISION.DEFINE' : 'CFG.ORG.DISTCHANNEL.DEFINE';
  const capabilityRole = channel ? 'B164_CHANNEL' : 'B164_DIVISION';
  const actor = channel ? 'channel.definer' : 'division.definer';
  const viewer = channel ? 'channel.viewer' : 'division.viewer';
  const capability = activity;
  const codeOne = channel ? 'C1' : 'D1';
  const codeTwo = channel ? 'C2' : 'D2';
  const initialName = channel ? 'Wholesale' : 'Bicycles';
  const changedName = channel ? 'Retail' : 'Components';
  const createReason = `SCR-022 ${singular} create`;
  const copyReason = `SCR-022 ${singular} copy`;
  const changeReason = `SCR-022 ${singular} name change`;
  const deactivateReason = `SCR-022 ${singular} deactivation`;
  const passwordHash = await hashPassword(PASSWORD);
  console.log(`${plural}: verify exact capability, create/copy/name-only change, guarded deactivation, history and responsive access`);

  const roleCapabilities = await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, ${capabilityRole}, ${`SCR-022 ${singular} Definition Only`}, false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, ${capabilityRole}, ${capability}, 'BROWSER_FIXTURE')`);
    const [definerId, viewerId] = [randomUUID(), randomUUID()];
    for (const [id, username, fullName, roleCode] of [
      [definerId, actor, `SCR-022 ${singular} Definition-Only User`, capabilityRole],
      [viewerId, viewer, `SCR-022 ${singular} Read-Only User`, 'AUDITOR'],
    ]) {
      await tx.execute(sql`insert into app_user
        (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')`);
      await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
        values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')`);
    }
    await tx.execute(sql`insert into config_activity_status (client, activity_code, status, created_by)
      values (${CLIENT}, ${activity}, 'NOT_STARTED', 'BROWSER_FIXTURE') on conflict do nothing`);
    await tx.execute(sql`update config_activity_status
      set status = 'NOT_STARTED', completed_at = null, completed_by = null
      where client = ${CLIENT} and activity_code = ${activity}`);
    return tx.execute(sql`select capability_code from role_capability
      where client = ${CLIENT} and role_code = ${capabilityRole} order by capability_code`);
  }) as unknown as Array<{ capability_code: string }>;
  assert.deepEqual(roleCapabilities.map((row) => row.capability_code), [capability]);

  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'commit' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/', { waitUntil: 'commit' });
  }

  async function readDefinition(code: string): Promise<DistributionDimensionRecord | undefined> {
    const rows = await withTenant(CLIENT, async (tx) => channel
      ? tx.execute(sql`select client, distribution_channel as code, name, is_active, created_by, changed_by
          from distribution_channel where client = ${CLIENT} and distribution_channel = ${code}`)
      : tx.execute(sql`select client, division as code, name, is_active, created_by, changed_by
          from division where client = ${CLIENT} and division = ${code}`)) as unknown as DistributionDimensionRecord[];
    assert.ok(rows.length <= 1, `${singular} ${code} must be tenant-local and unique.`);
    return rows[0];
  }

  async function referenceCount(code: string): Promise<number> {
    const rows = await withTenant(CLIENT, async (tx) => channel
      ? tx.execute(sql`select count(*)::int as count from sales_area
          where client = ${CLIENT} and distribution_channel = ${code}`)
      : tx.execute(sql`select count(*)::int as count from sales_area
          where client = ${CLIENT} and division = ${code}`)) as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  async function readActivityStatus() {
    const rows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select status, completed_by from config_activity_status
       where client = ${CLIENT} and activity_code = ${activity}
    `))) as unknown as Array<{ status: string; completed_by: string | null }>;
    return rows[0];
  }

  await signInAs(actor);
  await page.goto(`${BASE}${route}`, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: plural, exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: `Create definition · ${singular}`, exact: true }).count(), 1);

  // A definition-only role must not inherit the other dimension's capability.
  await page.goto(`${BASE}${otherRoute}?new=1`, { waitUntil: 'commit' });
  await page.getByText(`Read-only view. Changes require authority ${otherActivity}.`, { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: /Create definition ·/ }).count(), 0);
  await page.goto(`${BASE}${route}`, { waitUntil: 'commit' });

  // Exercise the responsive create form at a phone-sized viewport before the desktop lifecycle checks.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${route}?new=1&client=0100`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: `Create definition · ${singular}`, exact: true }).waitFor();
  const horizontalOverflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ) - document.documentElement.clientWidth);
  assert.ok(horizontalOverflow <= 1, `${plural} mobile page must not overflow horizontally (overflow ${horizontalOverflow}px).`);
  assert.equal(await page.locator(`[name="${codeField}"]`).getAttribute('maxlength'), '2');
  assert.equal(await page.locator(`[name="${codeField}"]`).getAttribute('pattern'), '[A-Za-z0-9]{2}');
  assert.equal(await page.locator('[name="name"]').getAttribute('maxlength'), '20');
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '0');
  for (const field of ['client', 'changedBy', 'isActive', 'companyCode', 'salesOrg']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `${field} is outside the ${singular} definition contract.`);
  }
  const standard = await readDefinition('01');
  assert.ok(standard?.is_active, `Standard ${singular} 01 must remain active.`);
  assert.ok(await referenceCount('01') > 0, `Standard ${singular} 01 must be referenced by a Sales Area.`);

  await page.locator(`[name="${codeField}"]`).fill(codeOne.toLowerCase());
  await page.locator('[name="name"]').fill(initialName);
  await page.locator('[name="reason"]').fill(createReason);
  const createForm = page.locator('form').filter({ has: page.locator(`[name="${codeField}"]`) });
  await createForm.evaluate((form) => {
    for (const [field, value] of Object.entries({ client: '0100', changedBy: 'spoofed.actor', isActive: 'false' })) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = field; input.value = value; form.appendChild(input);
    }
  });
  await page.getByRole('button', { name: 'Create definition', exact: true }).click();
  await page.getByRole('status').getByText(`${singular} ${codeOne} defined; change history recorded.`, { exact: true }).waitFor();
  assert.deepEqual(await readDefinition(codeOne), {
    client: CLIENT, code: codeOne, name: initialName, is_active: true, created_by: actor, changed_by: null,
  });
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, channel ? 'distribution_channel' : 'division', codeOne));
  assert.equal(history.length, 1);
  assert.equal(history[0].changeType, 'CREATE');
  assert.equal(history[0].changedBy, actor);
  assert.equal(history[0].transactionCode, activity);
  assert.equal(history[0].reason, createReason);
  assert.ok(history[0].items.some((item) => item.fieldName === 'name' && item.newValue === initialName));
  assert.deepEqual(await readActivityStatus(), { status: 'COMPLETED', completed_by: actor });
  console.log(`  ✓ lowercase key normalized; session tenant/actor and active state override forged create fields`);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Open saved definition', exact: true }).click();
  const detail = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: `Definition · ${codeOne}`, exact: true }) });
  await detail.waitFor();
  await detail.getByRole('link', { name: 'Copy as new', exact: true }).click();
  await page.getByRole('heading', { name: `Create definition · ${singular}`, exact: true }).waitFor();
  assert.equal(await page.locator(`[name="${codeField}"]`).inputValue(), '', 'Copy must require a new, immutable key.');
  assert.equal(await page.locator('[name="name"]').inputValue(), initialName, 'Copy carries only the source name.');
  await page.locator(`[name="${codeField}"]`).fill(codeTwo.toLowerCase());
  await page.locator('[name="reason"]').fill(copyReason);
  await page.getByRole('button', { name: 'Create definition', exact: true }).click();
  await page.getByRole('status').getByText(`${singular} ${codeTwo} defined; change history recorded.`, { exact: true }).waitFor();
  assert.deepEqual(await readDefinition(codeTwo), {
    client: CLIENT, code: codeTwo, name: initialName, is_active: true, created_by: actor, changed_by: null,
  });
  const copyHistory = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, channel ? 'distribution_channel' : 'division', codeTwo));
  assert.equal(copyHistory.length, 1);
  assert.equal(copyHistory[0].changeType, 'CREATE', 'A copy is a distinct new definition, not an update to its source.');
  assert.equal(copyHistory[0].reason, copyReason);
  console.log('  ✓ copy-as-new leaves the source intact and records an independent create');

  await page.goto(`${BASE}${route}?edit=${codeOne}`, { waitUntil: 'commit' });
  await page.getByRole('heading', { name: `Change definition · ${singular}`, exact: true }).waitFor();
  assert.equal(await page.locator('[name="expectedVersion"]').inputValue(), '1');
  assert.equal(await page.locator('input[readonly]').inputValue(), codeOne, 'The created key is read-only on change.');
  await page.getByText('The key is immutable after creation.', { exact: true }).waitFor();
  await page.locator('[name="name"]').fill(changedName);
  await page.locator('[name="reason"]').fill(changeReason);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').getByText(`${singular} ${codeOne} saved and change history recorded.`, { exact: true }).waitFor();
  assert.deepEqual(await readDefinition(codeOne), {
    client: CLIENT, code: codeOne, name: changedName, is_active: true, created_by: actor, changed_by: actor,
  });
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, channel ? 'distribution_channel' : 'division', codeOne));
  assert.equal(history.length, 2);
  assert.equal(history[0].changeType, 'CHANGE');
  assert.equal(history[0].reason, changeReason);
  assert.deepEqual(history[0].items.map((item) => item.fieldName), ['name'], 'Name is the only changeable definition field.');
  assert.deepEqual(await readActivityStatus(), { status: 'COMPLETED', completed_by: actor });
  console.log('  ✓ name-only change increments the audit version without changing the key');

  await page.goto(`${BASE}${route}?${codeField}=${codeTwo}`, { waitUntil: 'commit' });
  const deactivatePanel = page.locator('details').filter({ hasText: `Deactivate definition · ${singular}` });
  await deactivatePanel.locator('summary').click();
  await deactivatePanel.locator('[name="reason"]').fill(deactivateReason);
  await deactivatePanel.getByRole('button', { name: 'Confirm deactivation', exact: true }).click();
  await page.getByRole('status').getByText(`${singular} ${codeTwo} deactivated and retained with its history.`, { exact: true }).waitFor();
  assert.deepEqual(await readDefinition(codeTwo), {
    client: CLIENT, code: codeTwo, name: initialName, is_active: false, created_by: actor, changed_by: actor,
  });
  const deactivationHistory = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, channel ? 'distribution_channel' : 'division', codeTwo));
  assert.equal(deactivationHistory.length, 2);
  assert.equal(deactivationHistory[0].changeType, 'CHANGE');
  assert.equal(deactivationHistory[0].reason, deactivateReason);
  assert.ok(deactivationHistory[0].items.some((item) => item.fieldName === 'isActive' && item.oldValue === 'true' && item.newValue === 'false' && item.isSecurityRelevant === 'true'));
  assert.equal(await readActivityStatus().then((status) => status?.completed_by), actor);
  console.log('  ✓ unused definition is soft-deactivated and retained with security-relevant history');

  // The standard structure leaves key 01 with two references: it is assigned to Sales
  // Organization 1000, and Sales Area 1000/01/01 uses it. The service refuses deactivation on the
  // sales-organisation reference first (distribution-channel-division-maintenance.ts:320 and :326)
  // and on the Sales Area reference second (:333), and the first cannot be cleared to reach the
  // second: removing the pair is itself refused while a Sales Area uses it, and the Sales Area F4
  // only offers pairs that are assigned. So in any state the screens can produce, a referenced
  // standard key is protected by the sales-organisation guard, and that is what this step asserts.
  // The Sales Area guard remains reachable only through a direct service write, which is recorded
  // as an open item rather than covered here by fabricating a state no operator can reach.
  await page.goto(`${BASE}${route}?${codeField}=01`, { waitUntil: 'commit' });
  const protectedPanel = page.locator('details').filter({ hasText: `Deactivate definition · ${singular}` });
  await protectedPanel.locator('summary').click();
  await protectedPanel.locator('form').getByRole('button', { name: 'Confirm deactivation', exact: true }).click();
  await page.getByRole('alert').getByText(new RegExp(`${singular} 01 is still assigned to one or more Sales Organizations`)).waitFor();
  assert.equal((await readDefinition('01'))?.is_active, true, 'A referenced standard definition remains active after rejection.');
  assert.equal(await referenceCount('01') > 0, true, 'The Sales Area that also references the key is untouched by the refusal.');
  console.log('  ✓ a key assigned to a Sales Organization cannot be deactivated, and neither the definition nor its Sales Area changes');

  await page.goto(`${BASE}${route}?${codeField}=${codeTwo}&history=1`, { waitUntil: 'commit' });
  await page.getByText('This definition is inactive and retained with its history.', { exact: true }).waitFor();
  const inactiveDetail = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: `Definition · ${codeTwo}`, exact: true }) });
  assert.equal(await inactiveDetail.getByRole('link', { name: 'Copy as new', exact: true }).count(), 0, 'Inactive entries cannot be copied.');
  assert.equal(await page.locator('details').count(), 0, 'Inactive entries have no deactivation/reactivation form.');
  assert.equal(await page.getByRole('button', { name: /delete|reactivate/i }).count(), 0);
  await page.getByText(deactivateReason, { exact: true }).waitFor();

  await signInAs(viewer);
  await page.goto(`${BASE}${route}`, { waitUntil: 'commit' });
  await page.getByText(`Read-only view. Changes require authority ${activity}.`, { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: `Create definition · ${singular}`, exact: true }).count(), 0);
  await page.goto(`${BASE}${route}?new=1&client=0100`, { waitUntil: 'commit' });
  await page.getByText(`Read-only view. Changes require authority ${activity}.`, { exact: true }).waitFor();
  await page.goto(`${BASE}${route}?${codeField}=${codeOne}&history=1`, { waitUntil: 'commit' });
  await page.getByText(createReason, { exact: true }).waitFor();
  await page.getByText(changeReason, { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Change', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Copy as new', exact: true }).count(), 0);
  assert.equal(await page.locator('details').count(), 0);
  for (const field of [codeField, 'name', 'expectedVersion', 'reason']) {
    assert.equal(await page.locator(`[name="${field}"]`).count(), 0, `Read-only user receives no ${field} maintenance control.`);
  }
  console.log('  ✓ Auditor can inspect history but cannot create, change, copy or deactivate');

  await signInAs(actor);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${route}`, { waitUntil: 'commit' });
  // 'commit' only means navigation has started; evaluating before the heading renders can find
  // no body yet and throw on scrollWidth. Wait for the server-rendered heading, as the earlier
  // mobile step does, so the width is read from a complete document.
  await page.getByRole('heading', { level: 1, name: plural, exact: true }).waitFor();
  const finalMobileOverflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ) - document.documentElement.clientWidth);
  assert.ok(finalMobileOverflow <= 1, `${plural} mobile list must not overflow horizontally (overflow ${finalMobileOverflow}px).`);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function distributionChannels(ctx: BrowserContext) {
  await distributionDimensionDefinition(ctx, 'distributionChannel');
}

async function divisions(ctx: BrowserContext) {
  await distributionDimensionDefinition(ctx, 'division');
}

async function salesOrgDivisionAssignment(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const route = `${BASE}/config/sales-orgs/assign-division`;
  const assignmentActivity = 'CFG.ORG.SALESORG.ASSIGN_DIVISION';
  const passwordHash = await hashPassword(PASSWORD);
  console.log('OVXA: verify tenant-local Division assignment, active-only F4, duplicate no-op, cross-channel removal guard, audit and exact authority');

  // Create inactive definitions through the supported services. They must remain
  // retained but must not appear in either assignment value-help dialog.
  const inactiveSalesOrg = await saveSalesOrgDefinition({
    client: CLIENT,
    changedBy: 'browser.admin',
    mode: 'CREATE',
    salesOrg: 'Z900',
    expectedVersion: 0,
    values: { name: 'OVXA Inactive Organization', address: { country: 'KW' } },
  });
  assert.equal(inactiveSalesOrg.created, true);
  await deactivateSalesOrg({
    client: CLIENT, changedBy: 'browser.admin', salesOrg: 'Z900', expectedVersion: 1,
    reason: 'OVXA browser acceptance inactive F4 fixture',
  });
  const inactiveDivision = await saveDivisionDefinition({
    client: CLIENT,
    changedBy: 'browser.admin',
    mode: 'CREATE',
    division: 'Z9',
    expectedVersion: 0,
    values: { name: 'Inactive OVXA div' },
  });
  assert.equal(inactiveDivision.created, true);
  await deactivateDivision({
    client: CLIENT, changedBy: 'browser.admin', division: 'Z9', expectedVersion: 1,
    reason: 'OVXA browser acceptance inactive F4 fixture',
  });

  const roleCapabilities = await withTenant(CLIENT, async (tx) => {
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'OVXA_ASSIGN', 'OVXA Division Assignment Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'OVXA_ASSIGN', ${assignmentActivity}, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role (client, code, name, is_read_only, created_by)
      values (${CLIENT}, 'OVXA_DIV_DEF', 'OVXA Division Definition Only', false, 'BROWSER_FIXTURE')`);
    await tx.execute(sql`insert into role_capability (client, role_code, capability_code, created_by)
      values (${CLIENT}, 'OVXA_DIV_DEF', 'CFG.ORG.DIVISION.DEFINE', 'BROWSER_FIXTURE')`);
    const assignerId = randomUUID();
    const definerId = randomUUID();
    const viewerId = randomUUID();
    for (const [id, username, fullName, roleCode] of [
      [assignerId, 'division.assigner', 'OVXA Division Assigner', 'OVXA_ASSIGN'],
      [definerId, 'division.definer', 'OVXA Division Definition-Only User', 'OVXA_DIV_DEF'],
      [viewerId, 'division.viewer', 'OVXA Auditor', 'AUDITOR'],
    ]) {
      await tx.execute(sql`insert into app_user
        (id, client, username, full_name, password_hash, must_change_password, created_by)
        values (${id}, ${CLIENT}, ${username}, ${fullName}, ${passwordHash}, false, 'BROWSER_FIXTURE')`);
      await tx.execute(sql`insert into user_role (client, user_id, role_code, created_by)
        values (${CLIENT}, ${id}, ${roleCode}, 'BROWSER_FIXTURE')`);
    }
    await tx.execute(sql`insert into config_activity_status (client, activity_code, status, created_by)
      values (${CLIENT}, ${assignmentActivity}, 'NOT_STARTED', 'BROWSER_FIXTURE') on conflict do nothing`);
    await tx.execute(sql`update config_activity_status
      set status = 'NOT_STARTED', completed_at = null, completed_by = null,
          changed_by = 'BROWSER_FIXTURE', changed_at = now()
      where client = ${CLIENT} and activity_code = ${assignmentActivity}`);
    return tx.execute(sql`select capability_code from role_capability
      where client = ${CLIENT} and role_code = 'OVXA_ASSIGN' order by capability_code`);
  }) as unknown as Array<{ capability_code: string }>;
  assert.deepEqual(roleCapabilities.map((row) => row.capability_code), [assignmentActivity]);

  const standardSetup = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select count(*)::int as pair_count,
           (select count(*)::int from sales_area
             where client = ${CLIENT} and sales_org = '1000'
               and distribution_channel = '01' and division = '01') as area_count
      from sales_org_division
     where client = ${CLIENT} and sales_org = '1000' and division = '01'
  `))) as unknown as Array<{ pair_count: number; area_count: number }>;
  assert.deepEqual(Array.from(standardSetup), [{ pair_count: 1, area_count: 1 }]);
  const defaultPairHistory = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org_division', '1000/01'));
  assert.equal(defaultPairHistory.length, 1);
  assert.equal(defaultPairHistory[0].transactionCode, assignmentActivity);
  console.log('  ✓ onboarding creates the default Sales Organization/Division pair before the dependent Sales Area and records history');

  async function signInAs(username: string) {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${BASE}/signin`, { waitUntil: 'commit' });
    await page.locator('[name="client"]').fill(CLIENT);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/', { waitUntil: 'commit' });
  }

  async function assignmentRow() {
    const rows = (await withTenant(CLIENT, (tx) => tx.execute(sql`
      select client, sales_org, division, created_by
        from sales_org_division
       where client = ${CLIENT} and sales_org = '1000' and division = '02'
    `))) as unknown as Array<{ client: string; sales_org: string; division: string; created_by: string }>;
    assert.ok(rows.length <= 1, 'OVXA pair is tenant-local and unique.');
    return rows[0];
  }

  async function chooseSalesOrg(code: string) {
    const field = page.locator('#ovxa-sales-org');
    await page.getByRole('button', { name: 'Open Sales Organization lookup (F4)', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Sales Organization lookup', exact: true }).waitFor();
    const search = dialog.getByLabel('Search by code or name');
    await search.fill('Z900');
    await dialog.getByText('No matching active Sales Organizations are available.', { exact: true }).waitFor();
    await search.fill(code);
    const choice = dialog.getByRole('button', { name: new RegExp(code) });
    await choice.waitFor();
    await choice.click();
    assert.equal(await field.inputValue(), code);
  }

  async function chooseDivision(code: string) {
    const field = page.locator('#ovxa-division');
    await page.getByRole('button', { name: 'Open Division lookup (F4)', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'Division lookup', exact: true }).waitFor();
    const search = dialog.getByLabel('Search by code or name');
    await search.fill('Z9');
    await dialog.getByText('No matching active Divisions are available.', { exact: true }).waitFor();
    await search.fill(code);
    const choice = dialog.getByRole('button', { name: new RegExp(code) });
    await choice.waitFor();
    await choice.click();
    assert.equal(await field.inputValue(), code);
  }

  await signInAs('division.assigner');
  await page.goto(route, { waitUntil: 'commit' });
  // The server-rendered shell can arrive before the client form hydrates.
  await page.waitForLoadState('load');
  await page.getByRole('heading', { level: 1, name: 'Sales Organization / Division assignments', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(mobileWidth <= 391, `OVXA must fit a 390px viewport (document width ${mobileWidth}px).`);
  await chooseSalesOrg('1000');
  await chooseDivision('02');
  console.log('  ✓ active-only Sales Organization and Division F4 lists are keyboard/button accessible and fit mobile');

  // F4 excludes inactive rows, and direct form submissions cannot bypass that rule.
  await page.locator('#ovxa-sales-org').fill('Z900');
  await page.getByRole('button', { name: 'Assign Division', exact: true }).click();
  await page.getByRole('alert').getByText(/Sales Organization Z900 is inactive/).waitFor();
  await page.locator('#ovxa-sales-org').fill('1000');
  await page.locator('#ovxa-division').fill('Z9');
  await page.getByRole('button', { name: 'Assign Division', exact: true }).click();
  await page.getByRole('alert').getByText(/Division Z9 is inactive/).waitFor();
  await page.locator('#ovxa-division').fill('02');

  // Forge tenant and actor values; the action must use the authenticated session instead.
  const assignmentForm = page.locator('form').filter({ has: page.locator('#ovxa-sales-org') });
  await assignmentForm.evaluate((form) => {
    for (const [name, value] of Object.entries({ client: '0100', changedBy: 'spoofed.actor' })) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = name; input.value = value; form.appendChild(input);
    }
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await assignmentForm.getByRole('button', { name: 'Assign Division', exact: true }).click();
  await page.getByRole('status').getByText(
    'Division 02 assigned to Sales Organization 1000; change history recorded.', { exact: true },
  ).waitFor();
  assert.deepEqual(await assignmentRow(), {
    client: CLIENT, sales_org: '1000', division: '02', created_by: 'division.assigner',
  });
  let history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org_division', '1000/02'));
  assert.equal(history.length, 1);
  assert.equal(history[0].changedBy, 'division.assigner');
  assert.equal(history[0].transactionCode, assignmentActivity);
  assert.deepEqual(history[0].items.map((item) => [item.fieldName, item.oldValue, item.newValue, item.isSecurityRelevant]), [
    ['salesOrg', null, '1000', 'true'],
    ['division', null, '02', 'true'],
  ]);
  let activity = (await withTenant(CLIENT, (tx) => tx.execute(sql`
    select status, completed_by from config_activity_status
     where client = ${CLIENT} and activity_code = ${assignmentActivity}
  `))) as unknown as Array<{ status: string; completed_by: string | null }>;
  assert.equal(activity[0]?.status, 'COMPLETED');
  assert.equal(activity[0]?.completed_by, 'division.assigner');
  console.log('  ✓ assignment uses the session tenant/actor and records a security-relevant create event');

  await assignmentForm.getByRole('button', { name: 'Assign Division', exact: true }).click();
  await page.getByRole('status').getByText(
    'Division 02 is already assigned to Sales Organization 1000; no change made.', { exact: true },
  ).waitFor();
  assert.equal((await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org_division', '1000/02'))).length, 1);
  console.log('  ✓ repeating a pair is an idempotent no-op with no duplicate history');

  // Add a valid second channel and a dependent area solely as a guarded browser fixture.
  const channelAssignment = await assignSalesOrgDistributionChannel({
    client: CLIENT, changedBy: 'browser.admin', salesOrg: '1000', distributionChannel: '02',
  });
  assert.equal(channelAssignment.assigned, true);
  await withTenant(CLIENT, (tx) => tx.execute(sql`
    insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
    values (${CLIENT}, '1000', '02', '02', 'OVXA cross-channel dependency fixture', 'BROWSER_FIXTURE')
  `));

  const list = page.getByRole('list', { name: 'Current assignments', exact: true });
  const pairItem = list.locator('li').filter({ hasText: /1000/ }).filter({ hasText: /02/ });
  assert.equal(await pairItem.count(), 1);
  await pairItem.getByRole('button', { name: 'Remove assignment', exact: true }).click();
  await pairItem.getByText(/Remove Division 02 from Sales Organization 1000\?.*across any Distribution Channel/).waitFor();
  await pairItem.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await page.getByRole('alert').getByText(/while a Sales Area uses the pair/).waitFor();
  assert.ok(await assignmentRow());
  assert.equal((await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org_division', '1000/02'))).length, 1);
  await pairItem.getByRole('button', { name: 'Keep assignment', exact: true }).click();
  console.log('  ✓ removal is blocked by a dependent Sales Area on another channel, with no audit or data loss');

  await withTenant(CLIENT, (tx) => tx.execute(sql`
    delete from sales_area
     where client = ${CLIENT} and sales_org = '1000'
       and distribution_channel = '02' and division = '02'
  `));
  const channelRemoval = await unassignSalesOrgDistributionChannel({
    client: CLIENT, changedBy: 'browser.admin', salesOrg: '1000', distributionChannel: '02',
  });
  assert.equal(channelRemoval.removed, true);

  const removableItem = page.getByRole('list', { name: 'Current assignments', exact: true })
    .locator('li').filter({ hasText: /1000/ }).filter({ hasText: /02/ });
  await removableItem.getByRole('button', { name: 'Remove assignment', exact: true }).click();
  await removableItem.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await page.getByRole('status').getByText(
    'Division 02 removed from Sales Organization 1000; change history retained.', { exact: true },
  ).waitFor();
  assert.equal(await assignmentRow(), undefined);
  history = await withTenant(CLIENT, (tx) => changeHistory(tx, CLIENT, 'sales_org_division', '1000/02'));
  assert.equal(history.length, 2);
  const deletion = history.find((entry) => entry.changeType === 'DELETE');
  assert.ok(deletion);
  assert.equal(deletion.changedBy, 'division.assigner');
  assert.equal(deletion.transactionCode, assignmentActivity);
  assert.deepEqual(deletion.items.map((item) => [item.fieldName, item.oldValue, item.newValue, item.isSecurityRelevant]), [
    ['salesOrg', '1000', null, 'true'],
    ['division', '02', null, 'true'],
  ]);
  assert.ok(await withTenant(CLIENT, async (tx) => {
    const rows = await tx.execute(sql`select 1 from sales_org_division
      where client = ${CLIENT} and sales_org = '1000' and division = '01'`);
    return (rows as unknown as unknown[]).length === 1;
  }), 'The default 1000/01 pair must remain intact.');
  console.log('  ✓ unused pair can be removed with actor-attributed delete history retained');

  // OVX5 or OVXB definition rights alone do not confer the OVXA assignment capability.
  for (const username of ['division.definer', 'division.viewer']) {
    await signInAs(username);
    await page.goto(route, { waitUntil: 'commit' });
    await page.getByRole('heading', { level: 1, name: 'Sales Organization / Division assignments', exact: true }).waitFor();
    await page.getByText('Read-only view. Changes require authority CFG.ORG.SALESORG.ASSIGN_DIVISION.', { exact: true }).waitFor();
    assert.equal(await page.locator('[name="salesOrg"], [name="division"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: /lookup \(F4\)/i }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Remove assignment', exact: true }).count(), 0);
    console.log(`  ✓ ${username} is display-only without the exact OVXA assignment authority`);
  }

  await signInAs('division.assigner');
  await page.goto(route, { waitUntil: 'commit' });
  await page.getByRole('heading', { level: 1, name: 'Sales Organization / Division assignments', exact: true }).waitFor();
}

/**
 * SCR-032 · B3: what creating a tenant does now that the standard package holds
 * general data only and the enterprise structure comes from its own screens.
 *
 * The runner onboards this target's fixture and destroys it afterwards, but it
 * destroys only that fixture. Every tenant this check creates it also destroys,
 * before the run in case a previous one failed, and after it in a `finally`, so a
 * reviewed database is never left holding a probe.
 */
async function tenantCreationScr032(ctx: BrowserContext) {
  const { page, BASE, CLIENT } = scope(ctx);
  const PROBE_NAME = 'SCR-032 creation probe';
  const EMPTY = 'ZT91';
  const STANDARD = 'ZT92';
  const SHARED_NAME = 'ZT93';
  const PROBES = [EMPTY, STANDARD, SHARED_NAME];
  const PLATFORM_MARKS = ['CFG.PLT.CLIENT.DEFINE', 'CFG.PLT.ROLE.DEFINE', 'CFG.PLT.USER.CREATE'];
  console.log('Browser: tenant creation after the package split');

  async function destroyProbe(key: string) {
    await withTenant(key, async (tx) => {
      await tx.execute(sql`set local statement_timeout = '10s'`);
      await tx.execute(sql`delete from client where client = ${key} and name = ${PROBE_NAME}`);
    }).catch(() => {});
  }
  async function completedActivities(key: string): Promise<string[]> {
    const rows = (await withTenant(key, (tx) =>
      tx.execute(
        sql`select activity_code from config_activity_status
             where status = 'COMPLETED' order by activity_code`,
      ),
    )) as unknown as Array<{ activity_code: string }>;
    return rows.map((row) => row.activity_code.trim());
  }
  async function openCreationForm() {
    await page.goto(`${BASE}/clients/new`, { waitUntil: 'commit' });
    const provisioningToken = page.locator('[name="provisioningToken"]');
    if (await provisioningToken.count()) await provisioningToken.fill(randomUUID());
    await page.locator('[name="clientKey"]').fill(EMPTY);
    await page.locator('[name="name"]').fill(PROBE_NAME);
    await page.locator('[name="currency"]').fill('KWD');
  }
  async function submitAs(username: string) {
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create tenant', exact: true }).click();
  }
  async function signInTo(key: string, username: string) {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    await page.locator('[name="client"]').fill(key);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // A sign-in with no `next` lands wherever the tenant's home is, so wait only for
    // the session and then ask for the workbench explicitly.
    await page.waitForURL((url) => url.pathname !== '/signin', { waitUntil: 'commit' });
    await page.goto(`${BASE}/config`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  }
  async function signOut() {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL(/\/signin/, { waitUntil: 'commit' });
  }

  try {
    for (const key of PROBES) await destroyProbe(key);

    // Copying is refused where the operator can see it, and cannot be submitted at all.
    await openCreationForm();
    await page.locator('input[name="creationType"][value="copy"]').check();
    const refusal = page.locator('[role="alert"]').filter({ hasText: /Copying a tenant is not available yet/ });
    await refusal.waitFor();
    assert.match(
      await refusal.innerText(),
      /Create an empty tenant/,
      'A refusal that names no way forward is not a remedy.',
    );
    assert.equal(await page.getByRole('button', { name: 'Create tenant', exact: true }).isDisabled(), true);
    console.log('  ✓ copying a tenant is refused on the screen, with a remedy, and cannot be submitted');

    // The empty path: a tenant, its first administrator, and no configuration at all.
    await page.locator('input[name="creationType"][value="empty"]').check();
    await submitAs('probe.admin');
    await page.waitForURL(/\/signin\?/, { waitUntil: 'commit' });
    assert.match(page.url(), new RegExp(`client=${EMPTY}`), 'The operator is sent to the tenant just created.');
    assert.match(page.url(), /created=1/);
    console.log('  ✓ an empty tenant is created and the operator is sent to sign in as its first administrator');

    await signInTo(EMPTY, 'probe.admin');
    assert.deepEqual(
      await completedActivities(EMPTY),
      PLATFORM_MARKS,
      'An empty tenant is told exactly what creation did, and nothing it did not do.',
    );
    console.log('  ✓ the workbench of an empty tenant reports the three platform activities and no configuration');

    await page.goto(`${BASE}/config/company-codes`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.getByText('1000', { exact: true }).count(), 0, 'Creation no longer defines a company code.');
    console.log('  ✓ an empty tenant has no company code, because creation no longer defines one');
    await signOut();

    // The standard path: general data only. Same name as the empty tenant, because
    // R-74 makes the key the only unique thing about a tenant.
    await openCreationForm();
    await page.locator('[name="clientKey"]').fill(STANDARD);
    await page.locator('input[name="creationType"][value="standard"]').check();
    await submitAs('probe.admin');
    await page.waitForURL(/\/signin\?/, { waitUntil: 'commit' });
    assert.match(page.url(), new RegExp(`client=${STANDARD}`));
    console.log('  ✓ a second tenant takes the first one\u2019s name, because only the key is unique');

    await signInTo(STANDARD, 'probe.admin');
    const marks = await completedActivities(STANDARD);
    assert.equal(marks.length, 14, `The standard package marks eleven activities beside the three platform ones; saw ${marks.length}.`);
    for (const code of ['CFG.FIN.COA.DEFINE', 'CFG.FIN.FYV.DEFINE', 'CFG.FIN.PPV.DEFINE']) {
      assert.ok(marks.includes(code), `The package still configures ${code}.`);
    }
    for (const code of ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.FIN.FYV.ASSIGN', 'CFG.FIN.PPV.ASSIGN', 'CFG.ORG.PLANT.DEFINE']) {
      assert.ok(!marks.includes(code), `${code} is company-specific and must no longer be reported as done.`);
    }
    console.log('  ✓ the standard tenant reports general data as configured and company structure as outstanding');

    await page.goto(`${BASE}/config/chart-of-accounts`, { waitUntil: 'domcontentloaded' });
    await page.getByText('CA01', { exact: true }).first().waitFor();
    console.log('  ✓ the standard tenant has the general chart of accounts the package creates');

    await page.goto(`${BASE}/config/company-codes`, { waitUntil: 'domcontentloaded' });
    assert.equal(
      await page.getByText('1000', { exact: true }).count(),
      0,
      'The package holds general data only; a company code comes from its own screen.',
    );
    console.log('  ✓ the standard tenant still has no company code, which is the point of the split');
    await signOut();

    // A third tenant, same name again, then the key that is already taken.
    await openCreationForm();
    await page.locator('[name="clientKey"]').fill(SHARED_NAME);
    await submitAs('probe.admin');
    await page.waitForURL(/\/signin\?/, { waitUntil: 'commit' });
    assert.match(page.url(), new RegExp(`client=${SHARED_NAME}`));
    console.log('  ✓ a third tenant shares the name as well, and is created without objection');

    await openCreationForm();
    await page.locator('[name="clientKey"]').fill(STANDARD);
    await submitAs('probe.admin');
    await page.waitForURL(/\/clients\/new/, { waitUntil: 'commit' });
    await page.getByText(/already exists/).first().waitFor();
    assert.equal(await completedActivities(SHARED_NAME).then((rows) => rows.length > 0), true);
    console.log('  ✓ a key already in use is refused on the form, naming the conflict');

    // The runner signs the session out after a check and then proves a protected
    // route refuses it, so a check must not end on a public form with nobody signed in.
    await signInTo(CLIENT, 'browser.admin');
  } finally {
    for (const key of PROBES) await destroyProbe(key);
    const remaining = (await listTenants()).filter((tenant) => PROBES.includes(tenant.client));
    assert.deepEqual(
      remaining.map((tenant) => tenant.client),
      [],
      'A probe this check created must not outlive it.',
    );
    console.log('  ✓ the probes are gone and the reviewed database holds only the target fixture');
  }
}

export const CHECKS: Record<BrowserTargetId, (ctx: BrowserContext) => Promise<void>> = {
  foundation,
  'company-code-definition': companyCodeDefinition,
  'controlling-area': controllingAreaDefinition,
  'controlling-area-company-assignment': ox19Assignment,
  'chart-of-accounts': ob13ChartOfAccounts,
  'chart-of-accounts-copy': chartOfAccountsCopyOby7,
  'fiscal-year-variant-assignment': fiscalYearVariantAssignmentOb37,
  'fiscal-year-variants': fiscalYearVariantsOb29,
  'gl-accounts': glAccountMasterFs00,
  'posting-period-variants': postingPeriodVariantsObbo,
  'posting-period-variant-assignment': postingPeriodVariantAssignmentObbp,
  'exchange-rates': exchangeRatesOb08,
  'tax-codes': taxCodesFtxp,
  'banks': banksBankMaster,
  'house-banks': houseBanksFi12,
  'document-types': documentTypesOba7,
  'tolerance-groups': toleranceGroupsOba4,
  'account-determination': accountDeterminationObyc,
  'cost-centers': costCentersKs01,
  'cost-center-hierarchy': costCenterHierarchyKs01,
  'activity-types': activityTypesKl01,
  'activity-rates': activityRatesKp26,
  'profit-centers': profitCentersKe51,
  'profit-center-hierarchy': profitCenterHierarchyKch1,
  'material-types': materialTypesOms2,
  'material-groups': materialGroupsOmsf,
  'number-range-objects': numberRangeObjectsSnro,
  'material-number-ranges': materialNumberRangesMmnr,
  'industry-sectors': industrySectorsOms3,
  'industries': industriesOb44,
  'material-deletion-flag': materialDeletionFlagMm06,
  'material-period-control': materialPeriodControlOmsy,
  'purchase-requisitions': purchaseRequisitionsMe51n,
  'purchase-orders': purchaseOrdersMe21n,
  'characteristics': characteristicsCt04,
  'classes': classesCl02,
  'release-strategies': releaseStrategiesConfig,
  'release-acts': releaseActs,
  'goods-receipt': goodsReceiptMigo,
  'invoice-verification': invoiceVerificationMiro,
  'payment-run': paymentRunF110,
  'vendor-clearing': vendorClearingF44,
  'vendor-balances': vendorBalancesFk10n,
  'vendor-ageing': vendorAgeingAnalysis,
  'customer-invoice': customerInvoiceFb70,
  'incoming-payment': incomingPaymentF28,
  'incoming-payment-completion': incomingPaymentCompletionF28,
  'outgoing-payment': outgoingPaymentF53,
  'outgoing-payment-completion': outgoingPaymentCompletionF53,
  'vendor-down-payment': vendorDownPaymentF48,
  'vendor-down-payment-clearing': vendorDownPaymentClearingF54,
  'customer-down-payment-clearing': customerDownPaymentClearingF39,
  'customer-down-payment-request': customerDownPaymentRequestF37,
  'vendor-down-payment-request': vendorDownPaymentRequestF47,
  'parked-journal': parkedJournalFv50,
  'journal-items': journalItemsFagll03,
  'gl-balances': glBalancesFs10n,
  'document-display': documentDisplayFb03,
  'asset-master': assetMasterAs01As02,
  'asset-acquisition': assetAcquisitionAbzon,
  'asset-retirement': assetRetirementAbavn,
  'asset-depreciation': assetDepreciationAfab,
  'asset-history': assetHistorySheet,
  'gl-document': glDocumentEntry,
  'tax-report': taxReportReturn,
  'fx-valuation': fxValuationRun,
  'grir-reclass': grIrAnalysis,
  'accrual': accrualDocument,
  'close-cockpit': closeCockpit,
  'carryforward': carryforward,
  'credit': customerCredit,
  'credit-monitor': creditMonitor,
  'credit-release': creditRelease,
  'trial-balance': trialBalance,
  'balance-sheet': balanceSheet,
  'gl-reporting': glReporting,
  'gl-reporting-suite': glReportingSuite,
  'customer-down-payment': customerDownPaymentF29,
  'customer-balances': customerBalancesFd10n,
  'customer-ageing': customerAgeingAnalysis,
  'clearing-reset': clearingResetFbra,
  'document-reversal': documentReversalFb08,
  'customer-clearing': customerClearingF32,
  'dunning': dunningF150,
  'vendor-invoice': vendorInvoiceFb60,
  'vendor-credit-memo': vendorCreditMemoFb65,
  'company-code-coa-assignment': companyCodeCoaAssignment,
  'plant-definition': plantDefinition,
  'plant-company-code-assignment': plantCompanyCodeAssignment,
  'storage-locations': storageLocations,
  'purchasing-orgs': purchasingOrgDefinition,
  'purchasing-org-company-code': purchasingOrgCompanyCodeAssignment,
  'purchasing-groups': purchasingGroups,
  'sales-orgs': salesOrgDefinition,
  'sales-org-company-code': salesOrgCompanyCodeAssignment,
  'sales-org-division': salesOrgDivisionAssignment,
  'distribution-channels': distributionChannels,
  divisions,
  'payment-terms': paymentTerms,
  'payment-methods': paymentMethods,
  'tenant-creation': tenantCreationScr032,
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
