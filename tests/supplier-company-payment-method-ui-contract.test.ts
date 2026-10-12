import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panel = readFileSync('src/app/foundation/partners/SupplierCompanyPanel.tsx', 'utf8');
const page = readFileSync('src/app/foundation/partners/page.tsx', 'utf8');
const english = readFileSync('src/platform/i18n/index.ts', 'utf8');

describe('Supplier company Payment Methods UI contract', () => {
  it('renders a bounded checkbox set and submits an explicit clear value', () => {
    expect(panel).toContain('name="paymentMethods" value={selectedCodes.join');
    expect(panel).toContain('type="checkbox"');
    expect(panel).toContain('selectedCodes.length >= 10');
    expect(panel).toContain('unavailableCodes.map');
    expect(panel).toContain("const PENDING_COMPANY_DEFAULTS = ['sc.dunningProcedure', 'sc.cashDiscount', 'sc.toleranceGroup']");
  });

  it('loads company-country options and keeps display-only values visible', () => {
    expect(page).toContain('paymentMethods:companyRecord?.paymentMethods??\'\'');
    expect(page).toContain('paymentMethodOptions={choices.paymentMethods}');
    expect(panel).toContain("<Value label={t('sc.paymentMethods')} value={initial.paymentMethods || '—'} />");
    expect(english).toContain("'sc.paymentMethodsHelp'");
    expect(english).toContain("'sc.savedPaymentMethodsUnavailable'");
  });
});
