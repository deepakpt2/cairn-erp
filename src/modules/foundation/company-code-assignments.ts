/**
 * Company Code's define/assign state — CAIRN.md §6.2.
 *
 * A Company Code can now exist before its chart, fiscal-year, and posting-period
 * assignments are completed. Consumers that need those assignments must fail
 * closed until the relevant values have been assigned.
 */
export const COMPANY_CODE_ASSIGNMENT_FIELDS = [
  'chartOfAccounts',
  'fiscalYearVariant',
  'postingPeriodVariant',
] as const;

export type CompanyCodeAssignmentField = (typeof COMPANY_CODE_ASSIGNMENT_FIELDS)[number];

export type CompanyCodeAssignmentValues = Partial<
  Record<CompanyCodeAssignmentField, string | null | undefined>
>;

const LABELS: Record<CompanyCodeAssignmentField, string> = {
  chartOfAccounts: 'chart of accounts',
  fiscalYearVariant: 'fiscal-year variant',
  postingPeriodVariant: 'posting-period variant',
};

/** Lists missing assignments in stable define/assign order. */
export function missingCompanyCodeAssignments(
  values: CompanyCodeAssignmentValues,
): CompanyCodeAssignmentField[] {
  return COMPANY_CODE_ASSIGNMENT_FIELDS.filter((field) => {
    const value = values[field];
    return typeof value !== 'string' || value.trim() === '';
  });
}

export function hasCompanyCodeAssignments(
  values: CompanyCodeAssignmentValues,
): values is Required<Record<CompanyCodeAssignmentField, string>> {
  return missingCompanyCodeAssignments(values).length === 0;
}

export function describeMissingCompanyCodeAssignments(
  fields: readonly CompanyCodeAssignmentField[],
): string {
  return fields.map((field) => LABELS[field]).join(', ');
}
