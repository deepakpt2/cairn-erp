import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/config/company-codes/page.tsx', 'utf8');
const form = readFileSync('src/app/config/company-codes/CompanyCodeDefinitionForm.tsx', 'utf8');

describe('Company Code definition form contract', () => {
  it('renders the write form and loads reference choices only for the define capability', () => {
    expect(page).toContain("can(session, COMPANY_CODE_DEFINE)");
    expect(page).toContain('{canDefine && references && (');
    expect(page).toContain('currencies: (await tx');
    expect(page).toContain('row.code.trim()');
    expect(page).toContain('eq(currencyReference.isActive, true)');
    expect(page).toContain("t('auth.readOnly', { authority: COMPANY_CODE_DEFINE })");
  });

  it('submits only definition fields through the protected Company Code action', () => {
    expect(form).toContain('useActionState(defineCompanyCodeAction, INITIAL)');
    for (const field of ['companyCode', 'name', 'country', 'currency', 'city', 'taxRegistrationNumber']) {
      expect(form).toContain(`name="${field}"`);
    }
    expect(form).not.toMatch(/name="(client|changedBy|chartOfAccounts|fiscalYearVariant|postingPeriodVariant)"/);
    expect(form).toContain('state.message');
    expect(form).toContain('disabled={pending || !referencesReady}');
  });
});
