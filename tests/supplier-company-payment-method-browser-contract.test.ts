import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const checks = readFileSync('scripts/browser-smoke/checks.ts', 'utf8');
const targets = readFileSync('scripts/browser-smoke/targets.ts', 'utf8');
const supplierCheck = checks.slice(
  checks.indexOf('async function supplierCompany(ctx: BrowserContext)'),
  checks.indexOf('\nasync function supplierPartnerFunctionEditor', checks.indexOf('async function supplierCompany(ctx: BrowserContext)')),
);

describe('Supplier company Payment Methods browser acceptance contract', () => {
  it('keeps the three unfinished defaults disabled and starts with an explicit empty field', () => {
    expect(targets).toContain("{ id: 'supplier-company'");
    expect(supplierCheck).toContain("pendingDefaults.locator('input').count(),3");
    expect(supplierCheck).toContain('input[name="paymentMethods"]');
    expect(supplierCheck).toContain('No active outgoing or BOTH methods');
  });

  it('covers same-country outgoing choices, saved selections, and the ten-code limit', () => {
    expect(checks).toContain("import { getPaymentMethod, savePaymentMethod }");
    expect(supplierCheck).toContain("createMethodFixture('KW','I1','INCOMING')");
    expect(supplierCheck).toContain("createMethodFixture('US','U1','OUTGOING')");
    expect(supplierCheck).toContain('Only same-country outgoing/BOTH methods are selectable.');
    expect(supplierCheck).toContain('An eleventh selection must be disabled.');
    expect(supplierCheck).toContain('completedSupplierCompany?.paymentMethods,savedPaymentMethods');
  });

  it('checks authorized display-only access, stale-choice removal, and explicit clearing', () => {
    expect(supplierCheck).toContain("'FIN.SUPPLIER.COMPANY.DISPLAY'");
    expect(supplierCheck).toContain("'PARTNER_VIEWER','FND.PARTNER.DISPLAY'");
    expect(supplierCheck).toContain('authorized display-only user sees saved Payment Methods without controls');
    expect(supplierCheck).toContain('Some saved methods are no longer eligible for this company code.');
    expect(supplierCheck).toContain('Browser explicitly clear all supplier Payment Methods');
    expect(supplierCheck).toContain("?.value===''");
    expect(supplierCheck).toContain("?.value==='6'");
    expect(supplierCheck).toContain("?.value==='7'");
  });
});
