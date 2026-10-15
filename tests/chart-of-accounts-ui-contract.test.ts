import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/chart-of-accounts/page.tsx', 'utf8');
const action = readFileSync('src/app/config/chart-of-accounts/actions.ts', 'utf8');
const form = readFileSync('src/app/config/chart-of-accounts/ChartOfAccountsForm.tsx', 'utf8');
const valueHelp = readFileSync('src/app/config/chart-of-accounts/ChartOfAccountsValueHelp.tsx', 'utf8');
const list = readFileSync('src/app/config/chart-of-accounts/ChartOfAccountsList.tsx', 'utf8');
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
