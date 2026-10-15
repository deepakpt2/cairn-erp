/**
 * FS00 field status control (SCR-028).
 *
 * The Account Group (`KTOKS`) decides, per field, whether the screen suppresses it,
 * offers it or demands it. The matrix itself is data — a row per (group, field) —
 * so a consultant can tighten a group without a release. This module holds only the
 * vocabulary and the baseline applied where a group defines no row for a field.
 *
 * Two contract fields are deliberately absent from the matrix:
 * - `is_balance_sheet` is computed from the G/L Account Type (XBILK) and is never
 *   stored independently, so there is nothing for a group to suppress.
 * - the audit reason is conditional on the change itself (a block change or a
 *   deletion), not on the group.
 */

export type FieldStatus = 'SUPPRESS' | 'OPTIONAL' | 'MANDATORY';

/** Every field an Account Group may control. Order is the order the screen renders. */
export const GL_ACCOUNT_FIELDS = [
  'name',
  'accountType',
  'glAccountType',
  'isOpenItemManaged',
  'reconciliationType',
  'requiresCostObject',
  'isTaxRelevant',
  'groupAccountNumber',
  'languageKey',
  'sortKey',
  'isBlockedPosting',
  'isBlockedCreation',
] as const;

export type GlAccountField = (typeof GL_ACCOUNT_FIELDS)[number];

/** Field statuses for one Account Group; an absent field falls back to the baseline. */
export type FieldStatusMatrix = Partial<Record<GlAccountField, FieldStatus>>;

/**
 * Baseline field status. The keys (`account_number`, `chart_of_accounts`,
 * `account_group`) are mandatory by contract and are not matrix-controlled: without
 * them there is no record to store, so no group may suppress them.
 */
export const DEFAULT_FIELD_STATUS: Readonly<Record<GlAccountField, FieldStatus>> = {
  name: 'MANDATORY',
  accountType: 'MANDATORY',
  glAccountType: 'MANDATORY',
  isOpenItemManaged: 'OPTIONAL',
  reconciliationType: 'OPTIONAL',
  requiresCostObject: 'OPTIONAL',
  isTaxRelevant: 'OPTIONAL',
  groupAccountNumber: 'OPTIONAL',
  languageKey: 'OPTIONAL',
  sortKey: 'OPTIONAL',
  isBlockedPosting: 'OPTIONAL',
  isBlockedCreation: 'OPTIONAL',
};

/** Status of one field for one group: the group's row, else the baseline. */
export function resolveFieldStatus(
  matrix: FieldStatusMatrix | undefined,
  field: GlAccountField,
): FieldStatus {
  return matrix?.[field] ?? DEFAULT_FIELD_STATUS[field];
}

/**
 * Stored reconciliation vocabulary that predates the FS00 contract.
 *
 * Existing rows hold `MATERIAL`, which the contracted `MITKZ` list does not name even
 * though the source system's indicator does. Rendering it keeps the stored value visible
 * and stops a Change from silently rewriting an account into a different subledger;
 * whether to migrate or extend the list is an owner decision, not a display choice.
 */
export const LEGACY_RECONCILIATION_TYPES = ['MATERIAL'] as const;
export type LegacyReconciliationType = (typeof LEGACY_RECONCILIATION_TYPES)[number];

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const GL_ACCOUNT_TYPES = ['BALANCE_SHEET', 'PL_STATEMENT'] as const;
export type GlAccountType = (typeof GL_ACCOUNT_TYPES)[number];

export const RECONCILIATION_TYPES = ['CUSTOMERS', 'VENDORS', 'ASSETS'] as const;
export type ReconciliationType = (typeof RECONCILIATION_TYPES)[number];

/**
 * XBILK follows the account type: assets, liabilities and equity carry forward,
 * revenue and expense close at year end. The screen offers this as the default and
 * lets a group's field status decide whether the indicator stays editable.
 */
export function deriveGlAccountType(accountType: AccountType): GlAccountType {
  return accountType === 'ASSET' || accountType === 'LIABILITY' || accountType === 'EQUITY'
    ? 'BALANCE_SHEET'
    : 'PL_STATEMENT';
}

/** The stored balance-sheet flag is derived, never supplied freely by the browser. */
export function deriveIsBalanceSheet(glAccountType: GlAccountType): boolean {
  return glAccountType === 'BALANCE_SHEET';
}

/** One Account Group registry row as the screen consumes it. */
export interface AccountGroupRow {
  accountGroup: string;
  description: string;
  fromAccountNumber: string;
  toAccountNumber: string;
  /** Field status rows maintained for this group. */
  fieldStatus: FieldStatusMatrix;
  isActive: boolean;
  version: number;
}

export interface AccountGroupChoice {
  code: string;
  name: string;
}

/**
 * An account number belongs to a group only inside its range. Ranges are compared as
 * text of equal length, so `0010`–`0099` never swallows `1000`; a number shorter than
 * the range bounds is padded on the right, matching the reference reading of character
 * ranges.
 */
export function accountNumberInRange(
  accountNumber: string,
  fromAccountNumber: string,
  toAccountNumber: string,
): boolean {
  const width = Math.max(accountNumber.length, fromAccountNumber.length, toAccountNumber.length);
  const pad = (value: string) => value.padEnd(width, '0');
  return pad(accountNumber) >= pad(fromAccountNumber) && pad(accountNumber) <= pad(toAccountNumber);
}
