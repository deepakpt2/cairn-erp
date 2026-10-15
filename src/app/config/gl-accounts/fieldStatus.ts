/**
 * FS00 field status control (SCR-028).
 *
 * The Account Group (`KTOKS`) decides, per field, whether the screen suppresses it,
 * offers it or demands it. The matrix itself is data — a row per (group, field) in
 * `gl_account_group_field_status` — so a consultant can tighten a group without a
 * release. This module holds the baseline applied where a group defines no row, and the
 * shapes the screen renders.
 *
 * The vocabulary (fields, statuses, account types, statement types, reconciliation
 * values) and the derivations live in `@/modules/finance/gl-account-vocabulary`, which
 * is dependency-free so a client component may import it without dragging the database
 * layer into the browser bundle. It is re-exported here so the screen has one import to
 * reach for, and so the database, the services and the screen share one list each.
 *
 * Two contract fields are deliberately absent from the matrix:
 * - `is_balance_sheet` is computed from the G/L Account Type (`XBILK`) and is never
 *   stored independently, so there is nothing for a group to suppress.
 * - the audit reason is conditional on the change itself (a block change or a
 *   deletion), not on the group.
 */
import type { FieldStatus, GlAccountField } from '@/modules/finance/gl-account-vocabulary';

export {
  ACCOUNT_TYPES,
  DEFAULT_LANGUAGE_KEY,
  DEFAULT_SORT_KEY,
  FIELD_STATUSES,
  GL_ACCOUNT_FIELDS,
  GL_ACCOUNT_TYPES,
  RECONCILIATION_TYPES,
  SUPPORTED_LANGUAGE_KEYS,
  accountNumberInRange,
  deriveGlAccountType,
  deriveIsBalanceSheet,
  isBalanceSheetAccountType,
} from '@/modules/finance/gl-account-vocabulary';
export type {
  AccountType,
  FieldStatus,
  GlAccountField,
  GlAccountType,
  ReconciliationType,
} from '@/modules/finance/gl-account-vocabulary';

/** Field statuses for one Account Group; an absent field falls back to the baseline. */
export type FieldStatusMatrix = Partial<Record<GlAccountField, FieldStatus>>;

/**
 * Baseline field status, applied where a group defines no row for a field. The keys
 * (`account_number`, `chart_of_accounts`, `account_group`) are mandatory by contract and
 * are not matrix-controlled: without them there is no record to store, so no group may
 * suppress them.
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
 * One Account Group registry row as the screen consumes it.
 *
 * The registry is chart-scoped, because a chart owns the account-number length (`KTKTB`)
 * its ranges are read against, so the chart key is part of the row's identity.
 */
export interface AccountGroupRow {
  chartOfAccounts: string;
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
