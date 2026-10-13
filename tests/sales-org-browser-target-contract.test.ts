import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TARGETS } from '../scripts/browser-smoke/targets';
import { ACCEPTANCE_DATABASE_GUARDS } from '../scripts/browser-smoke/database-guards';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
const runner = readFileSync('scripts/browser-smoke.ts', 'utf8');
const checks = readFileSync('scripts/browser-smoke/checks.ts', 'utf8');
const statusBar = readFileSync('src/ui/shell/StatusBar.tsx', 'utf8');
const start = checks.indexOf('async function salesOrgDefinition(ctx: BrowserContext)');
const end = checks.indexOf('\nasync function purchasingOrgCompanyCodeAssignment', start);
const check = checks.slice(start, end);

describe('SCR-020 isolated live-browser target contract', () => {
  it('reserves a unique tenant and an isolated disposable PostgreSQL guard separate from service acceptance', () => {
    const target = TARGETS.find((item) => item.id === 'sales-orgs');
    const guard = ACCEPTANCE_DATABASE_GUARDS['sales-orgs'];
    expect(target).toMatchObject({ client: 'T977' });
    expect(TARGETS.filter((item) => item.client === 'T977')).toHaveLength(1);
    expect(guard).toMatchObject({ database: 'cairn_b153', port: '55530', batch: 'B-153' });
    expect(guard?.database).not.toBe('cairn_b152');
    expect(guard?.port).not.toBe('55529');
    expect(runner).toContain('if (databaseGuard) await verifyAcceptanceDatabase(databaseGuard)');
    expect(runner).toContain("if (target.id === 'sales-orgs') return '/config/sales-orgs'");
  });

  it('renders the current UI build marker in every environment, including production', () => {
    expect(statusBar).toContain("const DEVELOPMENT_UI_BUILD_CODE = 'DEV-SCR020-SALESORG-20261013'");
    expect(statusBar).toContain('data-testid="development-ui-build-code"');
    expect(statusBar).not.toContain('showDevelopmentBuildCode');
    expect(statusBar).toContain('Intentionally visible in every environment, including production');
  });

  it('registers one target command and exercises OVX5, CAM, localized text and the exact capability', () => {
    expect(packageJson.scripts['smoke:browser:sales-orgs'])
      .toBe('tsx scripts/browser-smoke.ts --target sales-orgs');
    expect(checks).toContain("'sales-orgs': salesOrgDefinition,");
    expect(check).toContain("'CFG.ORG.SALESORG.DEFINE'");
    for (const marker of [
      'salesorg.definer',
      'salesorg.viewer',
      'name="salesOrg"',
      'name="name"',
      'name="currency"',
      'name="formText"',
      'name="factoryCalendar"',
      'name="purchasingOrganization"',
      'name="referenceSalesOrg"',
      'name="alePurchaseOrders"',
      'name="rebateProcessingActive"',
      'name="intercompanyBillingVendor"',
      'name="addressCountry"',
      "street: 'Gulf Road'",
      'name="intercompanyBillingCustomer"',
      'language_key: \'D\'',
      'form_text: \'STANDARD\'',
      'factory_calendar: \'01\'',
      'company_code: null',
      "purchasing_organization: '1000'",
      "reference_sales_org: '1000'",
      'rebate_processing_active: true',
      'intercompany_billing_vendor: vendorNumber',
      "newValue === '0000012345'",
      'fixed ten-digit ID',
      'createSupplierRoleThroughUi',
      'createCustomerRoleThroughUi',
      'is_active: false',
      'companyCode',
      'still referenced by sales-area configuration',
      'sales_org',
      'changeHistory',
      'Read-only view. Changes require authority CFG.ORG.SALESORG.DEFINE.',
      'salesorg.definer',
    ]) expect(check, marker).toContain(marker);
    expect(check).not.toMatch(/(?:insert\s+into|update|delete\s+from)\s+sales_org/i);
    expect(check).toContain("page.goto(`${BASE}/config/sales-orgs?new=1&client=0100`");
    expect(check).toContain("page.goto(`${BASE}/config/sales-orgs?salesOrg=${code}&history=1`");
  });
});
