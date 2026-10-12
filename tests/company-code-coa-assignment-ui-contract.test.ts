import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/company-codes/page.tsx', 'utf8');
const form = readFileSync('src/app/config/company-codes/CompanyCodeCoaAssignmentForm.tsx', 'utf8');

describe('Company Code CoA assignment UI contract', () => {
  it('loads active CoA choices only for the separate assignment capability and session tenant', () => {
    expect(page).toContain("can(session, COMPANY_CODE_ASSIGN_COA)");
    expect(page).toContain('canAssign && hasUnassignedCoa');
    expect(page).toContain('await withTenant(client, async (tx) =>');
    expect(page).toContain('eq(chartOfAccountsTable.client, client)');
    expect(page).toContain('eq(chartOfAccountsTable.isActive, true)');
    expect(page).toContain('orderBy(asc(chartOfAccountsTable.chartOfAccounts))');
    expect(page).toContain('!canAssign && hasUnassignedCoa');
  });

  it('renders the assignment control only for an authorized user, an unassigned code and available choices', () => {
    expect(page).toContain('canAssign && !company.chartOfAccounts && chartChoices.length > 0');
    expect(page).toContain("t('cc.noActiveCharts')");
    expect(page).toContain("t('cc.initialCoaNote')");
    expect(page).toContain('canDefine && references');
    expect(page).toContain('!canDefine &&');
  });

  it('submits only the selected CoA and Company Code to the protected action', () => {
    expect(form).toContain('useActionState(assignCompanyCodeCoaAction, INITIAL)');
    expect(form).toContain('type="hidden" name="companyCode" value={companyCode}');
    expect(form).toContain('name="chartOfAccounts"');
    expect(form).toContain('defaultValue=""');
    expect(form).not.toMatch(/name="(client|changedBy|fiscalYearVariant|postingPeriodVariant)"/);
    expect(form).toContain('state.message');
    expect(form).toContain('disabled={pending || charts.length === 0}');
  });
});
