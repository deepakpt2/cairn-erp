import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { companyCodeDefinitionInputSchema } from '../src/modules/foundation/company-code-definition';

const actions = readFileSync('src/app/config/company-codes/actions.ts', 'utf8');
const action = actions.slice(
  actions.indexOf('export async function defineCompanyCodeAction'),
  actions.indexOf('export interface CompanyCodeCoaAssignmentState'),
);
const service = readFileSync('src/modules/foundation/company-code-definition.ts', 'utf8');

const valid = {
  client: 'T001',
  changedBy: 'TEST',
  companyCode: ' 2000 ',
  name: ' Second company ',
  country: 'kw',
  currency: 'kwd',
  city: ' Al Jahra ',
  taxRegistrationNumber: ' TAX-2 ',
};

describe('protected Company Code define contract', () => {
  it('normalizes definition values and leaves optional legal details empty when omitted', () => {
    expect(companyCodeDefinitionInputSchema.parse({ ...valid, city: '', taxRegistrationNumber: '' })).toMatchObject({
      client: 'T001',
      changedBy: 'TEST',
      companyCode: '2000',
      name: 'Second company',
      country: 'KW',
      currency: 'KWD',
      city: undefined,
      taxRegistrationNumber: undefined,
    });
  });

  it('bounds fields to the current Company Code schema and rejects assignment fields', () => {
    expect(() => companyCodeDefinitionInputSchema.parse({ ...valid, companyCode: 'C'.repeat(11) })).toThrow();
    expect(() => companyCodeDefinitionInputSchema.parse({ ...valid, name: 'N'.repeat(161) })).toThrow();
    expect(() => companyCodeDefinitionInputSchema.parse({ ...valid, currency: 'US' })).toThrow();
    expect(() => companyCodeDefinitionInputSchema.parse({ ...valid, country: 'KWT' })).toThrow();
    expect(() => companyCodeDefinitionInputSchema.parse({ ...valid, chartOfAccounts: 'CAIRN' })).toThrow();
    expect(() => companyCodeDefinitionInputSchema.parse({ ...valid, fiscalYearVariant: 'K4' })).toThrow();
    expect(() => companyCodeDefinitionInputSchema.parse({ ...valid, postingPeriodVariant: 'C001' })).toThrow();
  });

  it('requires a verified session and the exact Company Code define capability before service invocation', () => {
    expect(action).toContain("requireSession('/config/company-codes')");
    expect(action).toContain("requireCapability('CFG.ORG.COMPANYCODE.DEFINE', session)");
    expect(action.indexOf('await requireCapability')).toBeLessThan(action.indexOf('await defineCompanyCode'));
    expect(action).toContain('client: session.user.client');
    expect(action).toContain('changedBy: session.user.username');
    expect(action).not.toMatch(/client:\s*read\(/);
    expect(action).not.toMatch(/changedBy:\s*read\(/);
  });

  it('uses a create-only audited service and inserts all three assignments as null', () => {
    expect(service).toContain('.strict()');
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain('if (existing)');
    expect(service).toContain('chartOfAccounts: null');
    expect(service).toContain('fiscalYearVariant: null');
    expect(service).toContain('postingPeriodVariant: null');
    expect(service).toContain("changeType: 'CREATE'");
    expect(service).toContain("transactionCode: 'CFG.ORG.COMPANYCODE.DEFINE'");
    expect(service).not.toMatch(/tx\.update\(companyCode\)/);
    expect(action).not.toMatch(/chartOfAccounts|fiscalYearVariant|postingPeriodVariant|upsertCompanyCode/);
  });
});
