/**
 * FS00 vocabulary shared by the database schema, the services and the screen (SCR-028).
 *
 * Dependency-free on purpose: the FS00 screen imports this into client components, so it
 * must not pull in drizzle or the database client. One list per concept, kept here rather
 * than repeated per layer, so the field status matrix in the database, the service
 * validation and the rendered screen cannot drift apart — and a contract test compares
 * this file against migration `0036` and against the screen's baseline.
 */

/**
 * The twelve fields an Account Group controls.
 *
 * `account_number`, `chart_of_accounts` and `account_group` are absent on purpose:
 * without them there is no record to store, so no group may suppress them.
 * `is_balance_sheet` is derived rather than entered, so there is nothing to suppress.
 */
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

/** What an Account Group may decide about a field. */
export const FIELD_STATUSES = ['SUPPRESS', 'OPTIONAL', 'MANDATORY'] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

/** Account types (§8.2). */
export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Statement placement (`XBILK`); the stored balance-sheet flag is derived from it. */
export const GL_ACCOUNT_TYPES = ['BALANCE_SHEET', 'PL_STATEMENT'] as const;
export type GlAccountType = (typeof GL_ACCOUNT_TYPES)[number];

/**
 * Reconciliation account indicator (`MITKZ`).
 *
 * Plural per the FS00 contract, and `MATERIAL` is a contracted value rather than a
 * legacy one (R-52/D-124): accounts reconcile to materials as well as to the three
 * subledgers, and migrating those four accounts elsewhere would move them into a
 * subledger they do not belong to.
 */
export const RECONCILIATION_TYPES = ['CUSTOMERS', 'VENDORS', 'ASSETS', 'MATERIAL'] as const;
export type ReconciliationType = (typeof RECONCILIATION_TYPES)[number];

/** Language keys the platform supports today (`SPRAS`). */
export const SUPPORTED_LANGUAGE_KEYS = ['EN'] as const;
export const DEFAULT_LANGUAGE_KEY = 'EN';
/** Sort key (`ZUAWE`) default: three characters, no assignment rule. */
export const DEFAULT_SORT_KEY = '000';

/** Statement types whose accounts carry a balance forward instead of closing. */
const BALANCE_SHEET_ACCOUNT_TYPES: readonly AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY'];

/**
 * `XBILK` follows the account type: assets, liabilities and equity carry forward,
 * revenue and expense close at year end. The screen offers this as the default and the
 * group's field status decides whether the indicator stays editable.
 */
export function deriveGlAccountType(accountType: AccountType): GlAccountType {
  return BALANCE_SHEET_ACCOUNT_TYPES.includes(accountType) ? 'BALANCE_SHEET' : 'PL_STATEMENT';
}

/** The stored balance-sheet flag is derived, never supplied freely by a caller. */
export function deriveIsBalanceSheet(glAccountType: GlAccountType): boolean {
  return glAccountType === 'BALANCE_SHEET';
}

/** True when the account type carries a balance forward. */
export function isBalanceSheetAccountType(accountType: AccountType): boolean {
  return BALANCE_SHEET_ACCOUNT_TYPES.includes(accountType);
}

/**
 * An account number belongs to a group only inside its range.
 *
 * Ranges are compared as text right-padded to the widest of the three values, so
 * `0010`–`0099` never swallows `1000` and a six-character account is read against a
 * ten-character range bound the same way the screen reads it.
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
