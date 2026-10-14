import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';

const capability = 'CFG.ORG.SALESORG.ASSIGN_COMPANY';
const placeholder = 'CFG.SALES.SALESORG.ASSIGN_COMPANY';
const service = readFileSync('src/modules/foundation/sales-org-company-code-assignment.ts', 'utf8');
const migration = readFileSync('drizzle/0027_sales_org_assign_activity_code.sql', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const tenancy = readFileSync('src/platform/tenancy/index.ts', 'utf8');
const action = readFileSync('src/app/config/sales-orgs/assign-company/actions.ts', 'utf8');
const page = readFileSync('src/app/config/sales-orgs/assign-company/page.tsx', 'utf8');
const form = readFileSync('src/app/config/sales-orgs/assign-company/SalesOrgCompanyCodeAssignmentForm.tsx', 'utf8');
const overview = readFileSync('src/app/config/sales-orgs/page.tsx', 'utf8');
const i18n = readFileSync('src/platform/i18n/index.ts', 'utf8');
const seedActivities = seed.slice(seed.indexOf('const ACTIVITIES'), seed.indexOf('const CAPABILITIES'));
const seedCapabilities = seed.slice(seed.indexOf('const CAPABILITIES'), seed.indexOf('const REGISTRY'));

describe('SCR-021 Sales Organization -> Company Code assignment contract', () => {
  it('limits the assignment to one active same-tenant Company Code and audits replacement', () => {
    expect(service).toContain(`const ASSIGNMENT_ACTIVITY = '${capability}'`);
    expect(service).toContain("eq(companyCode.client, client)");
    expect(service).toContain('eq(companyCode.isActive, true)');
    expect(service).toContain('eq(salesOrg.isActive, true)');
    expect(service).toContain('isNull(salesOrg.companyCode)');
    expect(service).toContain('replacement records an audited change');
    expect(service).toContain('before: { companyCode: previousCompanyCode }');
    expect(service).toContain('reassigned: previousCompanyCode !== null');
    expect(service).not.toContain('cannot replace or clear an existing Company Code assignment');
    expect(service).toContain("objectClass: 'sales_org'");
    expect(service).toContain("securityRelevantFields: ['companyCode']");
  });

  it('requires both workbench prerequisites and refuses inactive or foreign Sales Organizations', () => {
    expect(service).toContain("const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.ORG.SALESORG.DEFINE'] as const");
    expect(service).toContain('is inactive.');
    expect(service).toContain('does not exist in this tenant.');
    expect(service).toContain('Active Company Code');
  });

  it('uses Cairn field names only in the application and keeps source-system codes out of UI text', () => {
    expect(i18n).toContain("'salesOrg.salesOrgField': 'Sales Organization'");
    expect(i18n).toContain("'salesOrg.companyCodeField': 'Company Code'");
    const appSources = [service, action, page, form, overview, i18n].join('\n');
    expect(appSources).not.toMatch(/\b(?:VKORG|BUKRS)\b/i);
  });

  it('enforces OVX3 four-character codes and keeps assignment inputs separate from tenant and actor', () => {
    expect(service).toContain("salesOrg: z.string().trim().regex(/^[A-Z0-9]{4}$/");
    expect(service).toContain("companyCode: z.string().trim().regex(/^[A-Z0-9]{4}$/");
    expect(service).toContain('}).strict();');
    expect(action).toContain('requireSession(ROUTE)');
    expect(action).toContain('requireCapability(ACTIVITY, session)');
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).not.toContain("read(form, 'client')");
    expect(action).not.toContain("read(form, 'changedBy')");
  });

  it('offers explicit F4 / keyboard value help for both required fields using tenant data', () => {
    expect(page).toContain('eq(salesOrg.client, client)');
    expect(page).toContain('eq(companyCode.client, client)');
    expect(page).toContain('eq(companyCode.isActive, true)');
    expect(page).toContain("/^[A-Z0-9]{4}$/.test(row.code)");
    expect(form).toContain('name="salesOrg"');
    expect(form).toContain('name="companyCode"');
    expect(form).toContain('required');
    expect(form).toContain('maxLength={4}');
    expect(form).toContain("event.key === 'F4'");
    expect(form).toContain('role="dialog"');
    expect(form).toContain('disabled={!eligible}');
    expect(form).toContain('const eligible = item.isActive;');
    expect(form).toContain("t('salesOrg.salesOrgField')");
    expect(form).toContain("t('salesOrg.companyCodeField')");
  });

  it('links the assignment activity from the Sales Organization definition screen only for authorized users', () => {
    expect(overview).toContain("const SALES_ORG_ASSIGN_COMPANY = 'CFG.ORG.SALESORG.ASSIGN_COMPANY'");
    expect(overview).toContain('const canAssignCompany = can(session, SALES_ORG_ASSIGN_COMPANY)');
    expect(overview).toContain('canAssignCompany && <Link href="/config/sales-orgs/assign-company"');
  });

  it('registers the dedicated non-posting Sales configure capability without role grants', () => {
    expect(seedCapabilities).toContain(
      "{ code: 'CFG.ORG.SALESORG.ASSIGN_COMPANY', module: 'SALES', action: 'CONFIGURE', posting: false, description: 'Assign an active tenant Sales Organization to one active Company Code' },",
    );
    expect(seedCapabilities).not.toMatch(/role_capability/i);
  });

  it('registers the assignment activity with its two prerequisites and the OVX3 route', () => {
    expect(seedActivities).toContain(
      "{ code: 'CFG.ORG.SALESORG.ASSIGN_COMPANY', area: 'SALES', title: 'Assign Sales Organization to Company Code', kind: 'ASSIGN', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.ORG.SALESORG.DEFINE'], enables: 'Sales accounting', wizardStage: 'ONBOARDING', route: '/config/sales-orgs/assign-company' },",
    );
    expect(seed).toContain("aliases: ['OVX3']");
    expect(seed).toContain("route: '/config/sales-orgs/assign-company'");
  });

  it('preserves exact, code-prefix wildcard and Administrator-wildcard capability semantics', () => {
    // Matching is segment-based on the capability code, so the module-wide wildcard is CFG.*
    // (the business module field is SALES, but the code prefix governs authorization).
    expect(hasCapability([capability], capability)).toBe(true);
    expect(hasCapability(['CFG.*'], capability)).toBe(true);
    expect(hasCapability(['*'], capability)).toBe(true);
    expect(hasCapability(['SALES.*'], capability)).toBe(false);
    expect(hasCapability(['PROC.*'], capability)).toBe(false);
    expect(hasCapability([], capability)).toBe(false);
  });

  it('retires the placeholder activity code and repairs its downstream references', () => {
    expect(migration).toContain("'CFG.ORG.SALESORG.ASSIGN_COMPANY'");
    expect(migration).toContain("'CFG.SALES.SALESORG.ASSIGN_COMPANY'");
    expect(migration).toContain("SET prerequisites = replace(prerequisites, 'CFG.SALES.SALESORG.ASSIGN_COMPANY', 'CFG.ORG.SALESORG.ASSIGN_COMPANY')");
    expect(migration).toContain('DELETE FROM config_activity_status');
    expect(migration).toContain('DELETE FROM config_activity');
    expect(migration).toContain('SCR021_MIGRATION');
    // The placeholder must be gone from runtime code: onboarding marks the approved code,
    // and no source, script or test still references the old one.
    expect(tenancy).toContain(`'${capability}'`);
    expect(tenancy).not.toContain(`'${placeholder}'`);
    expect(seed).not.toContain(`'${placeholder}'`);
  });
});
