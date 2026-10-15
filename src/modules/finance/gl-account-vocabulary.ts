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

/* ── Field status matrix (SCR-028) ─────────────────────────────────────────── */

/** Field statuses for one Account Group; an absent field falls back to the baseline. */
export type FieldStatusMatrix = Partial<Record<GlAccountField, FieldStatus>>;

/**
 * Baseline field status, applied where a group defines no row for a field.
 *
 * It lives here rather than in the screen because the services validate against the same
 * baseline: a group with no matrix rows still demands a short text and an account type,
 * and the write must agree with what the screen showed. The keys (`account_number`,
 * `chart_of_accounts`, `account_group`) are mandatory by contract and are not
 * matrix-controlled: without them there is no record to store, so no group may suppress
 * them.
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
 * Fields the matrix may not relax below MANDATORY.
 *
 * Both are `NOT NULL` with no database default and mandatory by contract, so a group that
 * suppressed them would leave the write with nothing to store. Every other controlled
 * field either carries a default or is nullable, so suppressing it is honest: the screen
 * does not ask and the stored value is the default.
 */
export const STORAGE_MANDATORY_FIELDS: readonly GlAccountField[] = ['name', 'accountType'];

/**
 * Human labels for the twelve controlled fields.
 *
 * One map serves the change log and the validation messages, so an auditor and the person
 * who just got refused a save read the same name for the same field. The source-system
 * equivalent stays in the label because that is how the field contract names it.
 */
export const GL_ACCOUNT_FIELD_LABELS: Readonly<Record<GlAccountField, string>> = {
  name: 'Short Text (TXT20)',
  accountType: 'Account Type',
  glAccountType: 'G/L Account Type (XBILK)',
  isOpenItemManaged: 'Open Item Management (XOPVW)',
  reconciliationType: 'Reconciliation Account (MITKZ)',
  requiresCostObject: 'Cost Object Required',
  isTaxRelevant: 'Tax Relevant',
  groupAccountNumber: 'Group Account Number',
  languageKey: 'Language Key (SPRAS)',
  sortKey: 'Sort Key (ZUAWE)',
  isBlockedPosting: 'Posting Block (XSPEB)',
  isBlockedCreation: 'Creation Block (XSPEA)',
};

