import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const action = readFileSync('src/app/foundation/partners/company-actions.ts', 'utf8');
const service = readFileSync('src/modules/foundation/supplier-companies.ts', 'utf8');

describe('Supplier company Payment Methods action and choice contract', () => {
  it('uses the existing maintain capability and session-derived tenant and actor', () => {
    expect(action).toContain("requireCapability('FIN.SUPPLIER.COMPANY.MAINTAIN',session)");
    expect(action).toContain('client:session.user.client');
    expect(action).toContain('changedBy:session.user.username');
    expect(action).toContain("paymentMethods:form.has('paymentMethods')?read('paymentMethods'):undefined");
  });

  it('offers only active outbound-or-both methods for the selected company country and tenant', () => {
    expect(service).toContain('country:companyCode.country');
    expect(service).toContain('eq(paymentMethod.client,client)');
    expect(service).toContain('eq(paymentMethod.country,selected.country)');
    expect(service).toContain('eq(paymentMethod.isActive,true)');
    expect(service).toContain("eq(paymentMethod.allowedDirection,'OUTGOING')");
    expect(service).toContain("eq(paymentMethod.allowedDirection,'BOTH')");
  });
});
