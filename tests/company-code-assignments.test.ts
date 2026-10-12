import { describe, expect, it } from 'vitest';
import {
  describeMissingCompanyCodeAssignments,
  hasCompanyCodeAssignments,
  missingCompanyCodeAssignments,
} from '../src/modules/foundation/company-code-assignments';

describe('Company Code define/assign sequence', () => {
  it('reports all three assignments as pending for a newly defined Company Code', () => {
    const missing = missingCompanyCodeAssignments({
      chartOfAccounts: null,
      fiscalYearVariant: null,
      postingPeriodVariant: null,
    });

    expect(missing).toEqual([
      'chartOfAccounts',
      'fiscalYearVariant',
      'postingPeriodVariant',
    ]);
    expect(describeMissingCompanyCodeAssignments(missing)).toBe(
      'chart of accounts, fiscal-year variant, posting-period variant',
    );
    expect(hasCompanyCodeAssignments({
      chartOfAccounts: null,
      fiscalYearVariant: null,
      postingPeriodVariant: null,
    })).toBe(false);
  });

  it('reports partial assignments in §6.2 order and permits a fully assigned code', () => {
    expect(
      missingCompanyCodeAssignments({
        chartOfAccounts: 'INTL',
        fiscalYearVariant: '',
        postingPeriodVariant: 'OPEN',
      }),
    ).toEqual(['fiscalYearVariant']);
    const complete = {
      chartOfAccounts: 'INTL',
      fiscalYearVariant: 'K4',
      postingPeriodVariant: 'C001',
    };
    expect(missingCompanyCodeAssignments(complete)).toEqual([]);
    expect(hasCompanyCodeAssignments(complete)).toBe(true);
  });
});
