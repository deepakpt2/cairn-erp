/**
 * The suggestion vocabulary the screen can import without opening a database.
 * The search itself stays on the server.
 */

export const CONSTRAINED_KINDS = [
  'company',
  'plant',
  'currency',
  'purchasing-org',
  'purchasing-group',
  'storage-location',
  'unit',
  'material-order',
  'material-info',
  'material-rfq',
  'material-stock',
  'material-issue',
  'supplier-purchasing',
  'supplier-company',
  'customer-company',
  'tax',
  'gl',
  'cost-center',
  'profit-center',
] as const;

export type ConstrainedKind = (typeof CONSTRAINED_KINDS)[number];

/** Kinds whose legal set is small enough to show as a dropdown. */
export const CLOSED_KINDS = new Set<ConstrainedKind>([
  'company',
  'plant',
  'currency',
  'purchasing-org',
  'purchasing-group',
  'storage-location',
  'tax',
]);

export interface ConstrainedContext {
  companyCode?: string;
  plant?: string;
  purchasingOrg?: string;
  /** When set, a unit suggestion is the material's base unit or a conversion that already stands. */
  materialNumber?: string;
  /** MASS for a weight unit. Any other value is ignored. */
  dimension?: string;
  /** Posting date for a cost or profit centre. Defaults to today. */
  postingDate?: string;
}

export interface ConstrainedValue {
  code: string;
  label: string;
  /** Extra fact the screen may need, such as a tax rate. Not a second code. */
  meta?: string;
}
