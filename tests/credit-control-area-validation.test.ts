import { describe, expect, it } from 'vitest';

import {
  creditControlAreaSetupValuesSchema,
  filterCreditControlAreaSetupByCompanyScope,
} from '../src/modules/finance/credit-control-area-maintenance';

describe('credit-control area setup validation', () => {
  const valid = {
    creditControlArea: '9001',
    name: 'Isolated test area',
    companyCode: '9009',
    warningThresholdPercent: 90,
    reason: 'Initial setup test',
  };

  it('normalizes area and company keys and preserves the approved threshold', () => {
    expect(creditControlAreaSetupValuesSchema.parse({
      ...valid,
      creditControlArea: 'ab9x',
      companyCode: 'c009',
      reason: '  Initial setup test  ',
    })).toEqual({
      creditControlArea: 'AB9X',
      name: 'Isolated test area',
      companyCode: 'C009',
      warningThresholdPercent: 90,
      reason: 'Initial setup test',
    });
  });

  it('filters the setup read model to explicit Company Code scope', () => {
    const data = {
      areas: [
        { creditControlArea: '9001', name: 'In scope', currency: 'AED', warningThresholdPercent: 90, isActive: true },
        { creditControlArea: '9002', name: 'Out of scope', currency: 'AED', warningThresholdPercent: 90, isActive: true },
      ],
      companies: [
        { companyCode: '9009', name: 'Scoped company', currency: 'AED', creditControlArea: '9001', isActive: true },
        { companyCode: '9010', name: 'Other company', currency: 'AED', creditControlArea: '9002', isActive: true },
      ],
      availableCompanies: [
        { companyCode: '9011', name: 'Scoped available', currency: 'AED', creditControlArea: null, isActive: true },
        { companyCode: '9012', name: 'Other available', currency: 'AED', creditControlArea: null, isActive: true },
      ],
    };

    expect(filterCreditControlAreaSetupByCompanyScope(data, [
      { scopeType: 'COMPANY_CODE', scopeValue: '9009' },
      { scopeType: 'COMPANY_CODE', scopeValue: '9011' },
    ])).toEqual({
      areas: [data.areas[0]],
      companies: [data.companies[0]],
      availableCompanies: [data.availableCompanies[0]],
    });
  });

  it.each([
    { creditControlArea: '1' },
    { creditControlArea: '00 1' },
    { name: '   ' },
    { warningThresholdPercent: -1 },
    { warningThresholdPercent: 101 },
    { warningThresholdPercent: 90.5 },
    { reason: '  ' },
  ])('rejects invalid setup values %j', (patch) => {
    expect(creditControlAreaSetupValuesSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
