import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/company-codes/assign-chart-of-accounts/page.tsx', 'utf8');
const form = readFileSync('src/app/config/company-codes/assign-chart-of-accounts/CoaAssignmentForm.tsx', 'utf8');
const action = readFileSync('src/app/config/company-codes/assign-chart-of-accounts/actions.ts', 'utf8');
const companyCodesPage = readFileSync('src/app/config/company-codes/page.tsx', 'utf8');
const seed = readFileSync('scripts/seed.ts', 'utf8');

describe('Company Code CoA assignment dedicated screen contract', () => {
  it('stands on its own route under the assignment capability only', () => {
    expect(page).toContain("const ROUTE = '/config/company-codes/assign-chart-of-accounts'");
    expect(page).toContain("const ACTIVITY = 'CFG.ORG.COMPANYCODE.ASSIGN_COA'");
    expect(page).toContain('can(session, ACTIVITY)');
    expect(action).toContain("requireCapability(COMPANY_CODE_ASSIGN_COA, session)");
    expect(action).not.toContain('COMPANYCODE.DEFINE');
  });

  it('requires a reason and submits only company, chart and reason from the session tenant', () => {
    expect(action).toContain("const reason = read('reason')");
    expect(action).toContain('coaAssign.reasonRequired');
    expect(action).toContain('client: session.user.client');
    expect(form).toContain('name="companyCode"');
    expect(form).toContain('name="chartOfAccounts"');
    expect(form).toContain('name="reason"');
    expect(form).not.toMatch(/name="(client|changedBy)"/);
  });

  it('offers only active, unblocked charts and shows every standing assignment', () => {
    expect(page).toContain('r.isActive && !r.isBlocked');
    expect(page).toContain("t('coaAssign.standingHeading')");
    expect(page).toContain("t('cc.initialCoaNote')");
  });

  it('is findable: the Company Codes screen links to it and the term registry names it', () => {
    expect(companyCodesPage).toContain('href="/config/company-codes/assign-chart-of-accounts"');
    expect(seed).toContain("ourCode: 'CFG.ORG.COMPANYCODE.ASSIGN_COA'");
    expect(seed).toContain("route: '/config/company-codes/assign-chart-of-accounts'");
  });
});
