import { describe, expect, it } from 'vitest';
import { walkthroughCreditPrerequisiteError } from '../src/modules/finance/walkthrough-credit-preflight';

const base = {
  company: { isActive: true, currency: 'AED', creditControlArea: '0001' },
  area: { isActive: true, currency: 'AED' },
  companyCode: '1000',
  areaCode: '0001',
  expectedCurrency: 'AED',
};

describe('walkthrough credit read-only prerequisite preflight', () => {
  it('accepts an active AED area mapped to the active AED company code', () => {
    expect(walkthroughCreditPrerequisiteError(base)).toBeNull();
  });

  it('allows the supported standard-structure path only when the company code is absent', () => {
    expect(walkthroughCreditPrerequisiteError({ ...base, company: null })).toBeNull();
  });

  it('stops when an existing company code has no supported CCA master-maintenance path', () => {
    const message = walkthroughCreditPrerequisiteError({ ...base, area: null });
    expect(message).toContain('active credit control area 0001 is missing');
    expect(message).toContain('no supported CCA master-maintenance activity');
    expect(message).toContain('Do not create it through SQL');
  });

  it('stops on inactive or wrong-currency financial configuration', () => {
    expect(walkthroughCreditPrerequisiteError({ ...base, area: { isActive: false, currency: 'AED' } }))
      .toContain('exists but is inactive');
    expect(walkthroughCreditPrerequisiteError({ ...base, area: { isActive: true, currency: 'USD' } }))
      .toContain('uses USD');
  });

  it('stops rather than repairing an incorrect company mapping or company currency', () => {
    expect(walkthroughCreditPrerequisiteError({ ...base, company: { ...base.company!, creditControlArea: null } }))
      .toContain('not 0001');
    expect(walkthroughCreditPrerequisiteError({ ...base, company: { ...base.company!, currency: 'USD' } }))
      .toContain('uses USD');
  });
});
