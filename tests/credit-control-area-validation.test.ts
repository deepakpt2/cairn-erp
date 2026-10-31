import { describe, expect, it } from 'vitest';

import { creditControlAreaSetupValuesSchema } from '../src/modules/finance/credit-control-area-maintenance';

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
