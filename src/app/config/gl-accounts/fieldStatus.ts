/**
 * FS00 field status control (SCR-028).
 *
 * The Account Group (`KTOKS`) decides, per field, whether the screen suppresses it,
 * offers it or demands it. The matrix itself is data — a row per (group, field) in
 * `gl_account_group_field_status` — so a consultant can tighten a group without a
 * release. This module holds the shapes the screen renders; the vocabulary, the baseline
 * matrix and the resolver live in `@/modules/finance/gl-account-vocabulary`, because the
 * services validate a write against the same baseline the screen displays.
 *
 * The vocabulary module is dependency-free so a client component may import it without
 * dragging the database layer into the browser bundle. Everything is re-exported here so
 * the screen has one import to reach for, and so the database, the services and the
 * screen share one list each.
 *
 * Two contract fields are deliberately absent from the matrix:
 * - `is_balance_sheet` is computed from the G/L Account Type (`XBILK`) and is never
 *   stored independently, so there is nothing for a group to suppress.
 * - the audit reason is conditional on the change itself (a block change or a
 *   deletion), not on the group.
 */
// Local, not only re-exported: AccountGroupRow below is typed with it.
import type { FieldStatusMatrix } from '@/modules/finance/gl-account-vocabulary';

export {
  ACCOUNT_TYPES,
  DEFAULT_FIELD_STATUS,
  DEFAULT_LANGUAGE_KEY,
  DEFAULT_SORT_KEY,
  FIELD_STATUSES,
  GL_ACCOUNT_FIELDS,
  GL_ACCOUNT_TYPES,
  RECONCILIATION_TYPES,
  STORAGE_MANDATORY_FIELDS,
  SUPPORTED_LANGUAGE_KEYS,
  accountNumberInRange,
  deriveGlAccountType,
  deriveIsBalanceSheet,
  isBalanceSheetAccountType,
  resolveFieldStatus,
} from '@/modules/finance/gl-account-vocabulary';
export type {
  AccountType,
  FieldStatus,
  FieldStatusMatrix,
  GlAccountField,
  GlAccountType,
  ReconciliationType,
} from '@/modules/finance/gl-account-vocabulary';

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
