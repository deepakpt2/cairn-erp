import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const capability = 'CFG.ORG.SALESORG.DEFINE';
const page = readFileSync('src/app/config/sales-orgs/page.tsx', 'utf8');
const form = readFileSync('src/app/config/sales-orgs/SalesOrgDefinitionForm.tsx', 'utf8');
const deactivate = readFileSync('src/app/config/sales-orgs/DeactivateSalesOrgForm.tsx', 'utf8');
const actions = readFileSync('src/app/config/sales-orgs/actions.ts', 'utf8');
const workbench = readFileSync('src/app/config/page.tsx', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const tenancy = readFileSync('src/platform/tenancy/index.ts', 'utf8');
const session = readFileSync('src/platform/auth/session.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');

function fieldMarkup(name: string, source = form) {
  const marker = `name="${name}"`;
  const position = source.indexOf(marker);
  if (position < 0) return '';
  const candidates = ['<input', '<select', '<textarea', '<Field'];
  const start = Math.max(...candidates.map((tag) => source.lastIndexOf(tag, position)));
  const end = source.indexOf('>', position);
  return start < 0 || end < 0 ? '' : source.slice(start, end + 1);
}

describe('SCR-020 Sales Organization definition UI and action contract', () => {
  it('derives tenant, actor and logon language from the verified session and protects both writes', () => {
    expect(page).toContain(`const SALES_ORG_DEFINE = '${capability}'`);
    expect(page).toContain("requireSession('/config/sales-orgs')");
    expect(page).toContain('const client = session.user.client');
    expect(page).toContain('can(session, SALES_ORG_DEFINE)');
    expect(page).toContain('where(eq(salesOrgTable.client, client))');
    expect(page).toContain('const languageKey = session.user.logonLanguage ?? \'E\'');
    expect(session).toContain('logonLanguageKeyFromPreferences(row.preferences)');
    expect(page).not.toContain('params.client');
    for (const action of ['saveSalesOrgDefinitionAction', 'deactivateSalesOrgAction']) {
      const start = actions.indexOf(`export async function ${action}`);
      const snippet = actions.slice(start, actions.indexOf('\n}', start) + 2);
      expect(snippet).toContain('requireSession(ROUTE)');
      expect(snippet).toContain('requireCapability(ACTIVITY, session)');
      expect(snippet).toContain('client: session.user.client');
      expect(snippet).toContain('changedBy: session.user.username');
    }
    expect(actions).toContain('languageKey: session.user.logonLanguage ?? \'E\'');
    expect(actions).toContain("if (form.get('confirmDeactivation') !== 'on')");
    expect(actions).not.toMatch(/read\(form,\s*['"](client|changedBy|companyCode|isActive)['"]\)/);
  });

  it('keeps the OVX5 form definition-only and aligned to the supplied field specifications', () => {
    expect(form).toContain('useActionState<SalesOrgMaintenanceActionState, FormData>(saveSalesOrgDefinitionAction');
    expect(form).toContain('name="mode" value={mode}');
    expect(form).toContain('name="expectedVersion" value={version}');
    expect(fieldMarkup('salesOrg')).toContain('maxLength={4}');
    expect(fieldMarkup('salesOrg')).toContain('pattern="[A-Z0-9]{4}"');
    expect(fieldMarkup('salesOrg')).toContain('readOnly={editing}');
    expect(fieldMarkup('name')).toContain('maxLength={35}');
    expect(fieldMarkup('currency')).toContain('name="currency"');
    expect(fieldMarkup('currency')).not.toContain('required');
    expect(form).toContain("t('salesOrg.currencyNote')");
    expect(fieldMarkup('formText')).toContain('maxLength={12}');
    expect(form).toContain("t('salesOrg.formTextNote')");
    expect(fieldMarkup('factoryCalendar')).toContain('name="factoryCalendar"');
    expect(fieldMarkup('factoryCalendar')).not.toContain('required');
    expect(fieldMarkup('addressCountry')).toContain('name="addressCountry"');
    expect(fieldMarkup('purchasingOrganization')).toContain('name="purchasingOrganization"');
    expect(fieldMarkup('referenceSalesOrg')).toContain('name="referenceSalesOrg"');
    expect(fieldMarkup('rebateProcessingActive')).toContain('value="X"');
    expect(fieldMarkup('rebateProcessingActive')).toContain('defaultChecked={initial.rebateProcessingActive}');
    expect(fieldMarkup('alePurchaseOrders')).toContain('defaultChecked={initial.alePurchaseOrders}');
    expect(fieldMarkup('intercompanyBillingVendor')).toContain('name="intercompanyBillingVendor"');
    expect(fieldMarkup('street')).toContain('maxLength={60}');
    expect(fieldMarkup('emailAddress')).toContain('maxLength={241}');
    expect(fieldMarkup('intercompanyBillingCustomer')).toContain('name="intercompanyBillingCustomer"');
    expect(form).toContain("t('salesOrg.nameLanguageNote', { language: languageKey })");
    expect(form).toContain("t('salesOrg.addressDialogTitle')");
    expect(form).toContain('aria-modal={addressDialogOpen}');
    // B-157 regression guard: the closed dialog must be display:none. The earlier
    // markup combined the HTML `hidden` attribute with the `flex` utility class, so
    // author display:flex beat the browser's [hidden] rule, the closed overlay stayed
    // on top of the form and swallowed every click (found by browser acceptance).
    // (lookbehind keeps this from matching the legitimate aria-hidden attribute)
    expect(form).not.toMatch(/(?<![\w-])hidden=\{!addressDialogOpen\}/);
    expect(form).toContain(": 'hidden'}");
    expect(form).toContain('aria-hidden={!addressDialogOpen}');
    expect(form).toContain('setAddressDialogOpen(true)');
    expect(form).not.toMatch(/name="(client|changedBy|companyCode|isActive)"/);
    expect(form).toContain("t('salesOrg.assignmentSeparationNote')");
    for (const key of [
      'salesOrg.addressHeading', 'salesOrg.intercompanyBillingCustomer', 'salesOrg.copy',
      'salesOrg.assignmentSeparationNote', 'salesOrg.purchasingOrganization', 'salesOrg.referenceSalesOrg',
      'salesOrg.rebateProcessingActive', 'salesOrg.alePurchaseOrders', 'salesOrg.factoryCalendar',
      'salesOrg.vendor', 'salesOrg.vendorNote', 'salesOrg.currencyNote', 'salesOrg.formTextNote',
    ]) expect(messages).toContain(`'${key}':`);
  });

  it('defaults optional fields from available customizing without inventing missing tenant data', () => {
    expect(page).toContain("formText: 'STANDARD'");
    expect(page).toContain("factoryCalendars.some((item) => item.code === '01')");
    expect(page).toContain("factoryCalendar: '01'");
    expect(form).toContain("t('salesOrg.noFactoryCalendarData')");
    expect(messages).toContain('No Factory Calendar customizing is loaded for this tenant');
    expect(messages).toContain('ALE integration is not connected yet.');
    expect(messages).toContain('document-print integration is not connected yet.');
  });

  it('uses touch-friendly mobile controls and switches the overview from stacked cards to a desktop table', () => {
    expect(page).toContain('px-3 py-4 sm:p-6');
    expect(page).toContain('sm:hidden" role="list"');
    expect(page).toContain('hidden overflow-x-auto sm:block');
    expect(page).toContain('min-h-11 items-center');
    expect(form).toContain('field-input min-h-11');
    expect(form).toContain('btn btn-primary min-h-11');
    expect(deactivate).toContain('btn btn-danger min-h-11');
  });

  it('shows tenant-local descriptions and CAM detail, history and retained deactivation only', () => {
    expect(page).toContain("changeHistory(tx, client, 'sales_org', selected.salesOrg)");
    expect(page).toContain('getSalesOrgDefinitionVersion(client, selected.salesOrg)');
    expect(page).toContain('salesOrgText');
    expect(page).toContain('centralAddress');
    expect(page).toContain('addressRecord');
    expect(page).toContain('displayVendorId(selected.intercompanyBillingVendor)');
    expect(page).toContain('DeactivateSalesOrgForm');
    expect(page).toContain("selected.isActive && <Link");
    expect(deactivate).toContain('deactivateSalesOrgAction');
    expect(deactivate).toContain('name="expectedVersion"');
    expect(deactivate).toContain('name="confirmDeactivation" required');
    expect(deactivate).toContain('name="reason"');
    expect(deactivate).not.toMatch(/name="(client|changedBy|companyCode|isActive)"/);
    expect(messages).toContain('hard delete and reactivation are unavailable.');
    expect(actions).not.toMatch(/\.delete\s*\(/);
    expect(actions).not.toMatch(/reactivate|hard.delete/i);
  });

  it('registers the exact activity while keeping Company Code assignment in SCR-021', () => {
    expect(workbench).toContain("'/config/sales-orgs'");
    expect(seed).toContain(`{ code: '${capability}', module: 'SALES', action: 'CONFIGURE'`);
    expect(seed).toContain(`{ code: '${capability}', area: 'SALES'`);
    expect(seed).toContain(`{ ourCode: '${capability}', termType: 'CONFIG_ACTIVITY'`);
    expect(seed).toContain("'CFG.ORG.SALESORG.DEFINE'");
    expect(seed).toContain("then 'COMPLETED' else 'NOT_STARTED' end");
    expect(tenancy).toContain("'CFG.ORG.SALESORG.DEFINE'");
    expect(tenancy).toContain("'CFG.ORG.SALESORG.ASSIGN_COMPANY'");
  });
});
