import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/chart-of-accounts/page.tsx', 'utf8');
const action = readFileSync('src/app/config/chart-of-accounts/actions.ts', 'utf8');
const form = readFileSync('src/app/config/chart-of-accounts/ChartOfAccountsForm.tsx', 'utf8');
const valueHelp = readFileSync('src/app/config/chart-of-accounts/ChartOfAccountsValueHelp.tsx', 'utf8');
const list = readFileSync('src/app/config/chart-of-accounts/ChartOfAccountsList.tsx', 'utf8');
const lifecycle = readFileSync('src/app/config/chart-of-accounts/ChartLifecycleControl.tsx', 'utf8');
const groupPanel = readFileSync('src/app/config/chart-of-accounts/GroupChartOfAccounts.tsx', 'utf8');
const maintenance = readFileSync('src/modules/foundation/chart-of-accounts-maintenance.ts', 'utf8');
const i18n = readFileSync('src/platform/i18n/index.ts', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');
const companyCodePage = readFileSync('src/app/config/company-codes/page.tsx', 'utf8');
const services = readFileSync('src/modules/foundation/services.ts', 'utf8');

describe('SCR-026 / OB13 Chart of Accounts UI contract', () => {
  it('registers the protected workbench activity, capability and searchable OB13 alias', () => {
    expect(seed).toContain("{ code: 'CFG.FIN.COA.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define chart of accounts'");
    expect(seed).toContain("{ code: 'CFG.FIN.COA.DEFINE', module: 'FIN', action: 'CONFIGURE'");
    expect(seed).toContain("ourCode: 'CFG.FIN.COA.DEFINE', termType: 'CONFIG_ACTIVITY'");
    expect(seed).toContain("aliases: ['OB13']");
    expect(seed).toContain("'CFG.FIN.COA.DEFINE',\n             case when exists (select 1 from chart_of_accounts coa where coa.client = c.client)");
    expect(page).toContain("const ACTIVITY = 'CFG.FIN.COA.DEFINE'");
    expect(page).toContain("const ROUTE = '/config/chart-of-accounts'");
    expect(page).toContain('requireSession(ROUTE)');
    expect(page).toContain('can(session, ACTIVITY)');
  });

  it('derives the tenant and actor from the session and requires the exact maintenance authority', () => {
    expect(action).toContain('requireSession(ROUTE)');
    expect(action).toContain('requireCapability(ACTIVITY, session)');
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).not.toMatch(/client:\s*read\(/);
    expect(action).not.toMatch(/changedBy:\s*read\(/);
  });

  it('renders Char 4 and OB13 defaults, accessibly labeled F4 help and locked account length', () => {
    expect(form).toContain('initial?.accountNumberLength ?? 10');
    expect(form).toContain("initial?.language ?? 'EN'");
    expect(form).toContain("initial?.costElementIntegration ?? 'AUTOMATIC'");
    expect(form).toContain('initial?.isBlocked ?? false');
    expect(form).toContain('maxLength={4}');
    expect(form).toContain('maxLength={50}');
    expect(form).toContain('readOnly={lengthLocked}');
    expect(valueHelp).toContain('aria-modal="true"');
    expect(list).toContain('role="dialog" aria-modal="true"');
    expect(list).toMatch(/aria-label=\{`.*chartOfAccounts\.changeTitle.*chart\.chartOfAccounts.*`\}/);
  });

  it('keeps blocked charts visible but rejects new G/L or Company Code segments and hides them from assignment choices', () => {
    expect(services).toContain('new G/L accounts cannot be created');
    expect(services).toContain('cannot be assigned to a Company Code');
    expect(companyCodePage).toContain('eq(chartOfAccountsTable.isBlocked, false)');
    expect(list).toContain('chart.isBlocked && <span className="chip chip-warn">');
  });
});

describe('SCR-026 / OB13 amendment: Group CoA registry and lifecycle UI contract', () => {
  it('maintains the Group CoA registry on the same protected OB13 screen', () => {
    expect(page).toContain('listGroupChartsOfAccounts(client)');
    expect(page).toContain('<GroupChartOfAccountsPanel entries={groupEntries} languages={languages} canMaintain={canMaintain} />');
    expect(groupPanel).toContain('id="ob13-group-panel-title"');
    expect(groupPanel).toContain('maxLength={4}');
    expect(groupPanel).toContain('maxLength={50}');
    expect(groupPanel).toContain('pattern="[A-Z0-9]{4}"');
    expect(groupPanel).toContain('<ChartLanguageField');
    expect(groupPanel).toContain('entry.referencedBy');
    expect(groupPanel).toContain('role="dialog"');
    expect(groupPanel).toContain('aria-modal="true"');
    // The registry is read-only for a user without the maintenance authority.
    expect(groupPanel).toContain("t('auth.readOnly', { authority: 'CFG.FIN.COA.DEFINE' })");
    expect(i18n).toContain("'chartOfAccounts.groupPanelTitle': 'Group Charts of Accounts'");
    expect(i18n).toContain("'chartOfAccounts.groupCode': 'Group CoA (KTOKL)'");
  });

  it('sources Group CoA F4 from the registry and reserves keys in both directions', () => {
    expect(maintenance).toContain('GROUP_OBJECT_CLASS = \'group_chart_of_accounts\'');
    expect(maintenance).toContain('.from(groupChartOfAccounts)');
    expect(maintenance).toContain('eq(groupChartOfAccounts.isActive, true)');
    expect(maintenance).toContain('async function requireKeyNotReservedByGroup');
    expect(maintenance).toContain('async function requireKeyNotReservedByChart');
    expect(maintenance).toContain('is reserved as a Group CoA in this SAP client');
    expect(maintenance).toContain('is reserved as an operational Chart of Accounts in this SAP client');
    // An unchanged reference is never re-validated, so a deactivated entry cannot strand a chart.
    expect(maintenance).toContain('const groupChartChanged = !current || (current.groupChart?.trim() || null) !== values.groupChart;');
    expect(maintenance).toContain('if (values.groupChart && groupChartChanged)');
    expect(i18n).toContain('operational Chart of Accounts or a Group CoA, never both');
  });

  it('requires an audited reason for every lifecycle change and keeps deactivated records visible', () => {
    expect(action).toContain('export async function setChartOfAccountsActiveAction');
    expect(action).toContain('export async function saveGroupChartOfAccountsAction');
    expect(action).toContain('export async function setGroupChartOfAccountsActiveAction');
    expect(action.match(/requireCapability\(ACTIVITY, session\)/g)).toHaveLength(4);
    expect(action).not.toMatch(/client:\s*read\(/);
    expect(action).not.toMatch(/changedBy:\s*read\(/);

    expect(lifecycle).toContain('name="reason"');
    expect(lifecycle).toContain('required');
    expect(lifecycle).toContain('minLength={1}');
    expect(lifecycle).toContain('maxLength={500}');
    // The stored flag is inverted server-side from the current state, never supplied freely.
    expect(lifecycle).toContain('value={isActive ? \'false\' : \'true\'}');
    expect(lifecycle).toContain("t('chartOfAccounts.deactivateButton')");
    expect(lifecycle).toContain("t('chartOfAccounts.reactivateButton')");
    expect(maintenance).toContain('.min(1, \'A reason is required for a Chart of Accounts lifecycle change.\')');

    expect(list).toContain('ChartLifecycleControl');
    expect(list).toContain('setChartOfAccountsActiveAction');
    expect(list).toContain("t(chart.isActive ? 'chartOfAccounts.active' : 'chartOfAccounts.deactivated')");
    expect(list).toContain("t('chartOfAccounts.inactiveRetained')");
    expect(groupPanel).toContain('setGroupChartOfAccountsActiveAction');
    // Deactivation flips a flag; nothing is deleted from either registry.
    expect(maintenance).not.toMatch(/\.delete\(/);
    expect(maintenance).toContain('await tx.update(chartOfAccounts).set({ isActive, changedBy, changedAt: new Date() })');
    expect(maintenance).toContain('await tx.update(groupChartOfAccounts).set({ isActive, changedBy, changedAt: new Date() })');
    expect(i18n).toContain("'chartOfAccounts.deactivated': 'Deactivated'");
    expect(i18n).toContain("'chartOfAccounts.lifecycleReason': 'Reason / change note (required)'");
  });

  it('keeps every OB13 row dialog browser-controlled so a save cannot dismiss its own outcome', () => {
    // Regression guard: a React-controlled `open` prop fought the native toggle and closed
    // the dialog before the result of the save was readable.
    for (const [name, source] of [['list', list], ['group panel', groupPanel], ['lifecycle', lifecycle]] as const) {
      expect(source, `${name} must not control <details open>`).not.toMatch(/<details[^>]*\sopen=\{/);
    }
    expect(list).toContain('details.open = false');
    expect(groupPanel).toContain('details.open = false');
    expect(lifecycle).toContain('details.open = false');
    // A stable key keeps the mounted form (and its message) alive across the refresh.
    expect(list).toContain('key={chart.chartOfAccounts}');
    expect(groupPanel).toContain('key={entry.groupChartOfAccounts}');
    expect(list).not.toContain('${chart.version}');
  });
});
