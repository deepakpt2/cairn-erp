/**
 * Cash flow statement vocabulary (SCR-119 / FIN.RPT.CASHFLOW;
 * S_ALR_87012271/72/73 search aliases).
 *
 * A read-only statement over the posted journal in the SAP
 * three-section structure (operating / investing / financing),
 * by the direct or indirect method. Cash is defined by the
 * house-bank G/L accounts; every other account classifies
 * from standing configuration, and anything unclassifiable
 * stands named. The report posts nothing and stores nothing.
 * Client-safe: the service lives in cash-flow.ts.
 */

export const CASHFLOW_CAPABILITY = 'FIN.RPT.CASHFLOW';
export const CASHFLOW_ROUTE = '/finance/cash-flow';
export const CASHFLOW_LEDGER = '0L';

export const CASHFLOW_METHODS = ['INDIRECT', 'DIRECT'] as const;
export type CashflowMethod = (typeof CASHFLOW_METHODS)[number];

export const CASHFLOW_METHOD_LABELS: Record<CashflowMethod, string> = {
  INDIRECT: 'Indirect method',
  DIRECT: 'Direct method',
};

export const ACCOUNT_CLASSES = [
  'CASH', 'RECEIVABLES', 'PAYABLES', 'INVENTORY', 'FIXED_ASSETS', 'FINANCING', 'OPERATING_PL', 'UNCLASSIFIED',
] as const;
export type CashflowAccountClass = (typeof ACCOUNT_CLASSES)[number];

export interface CashflowSelection {
  companyCodes: string[];
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  method: CashflowMethod;
  ledger: string;
  comparative: boolean;
}

export interface CashflowLine {
  key: string;
  label: string;
  /** Amounts keyed by company code, cash perspective: inflow +, outflow −. */
  amountsByCompany: Record<string, string>;
  total: string | null;
  comparativeTotal: string | null;
  kind: 'DETAIL' | 'SUBTOTAL' | 'TOTAL';
}

export interface CashflowSection {
  key: 'OPERATING' | 'INVESTING' | 'FINANCING';
  title: string;
  lines: CashflowLine[];
  total: string | null;
}

export interface CashflowResult {
  selection: CashflowSelection;
  companies: Array<{ companyCode: string; currency: string }>;
  /** True when every selected company shares one currency and totals are meaningful. */
  totalsComparable: boolean;
  sections: CashflowSection[];
  openingCash: string | null;
  closingCash: string | null;
  netCashChange: string | null;
  /** Sections total minus cash movement; explained by unclassified lines, never forced. */
  reconciliationDifference: string | null;
  unclassified: Array<{ companyCode: string; account: string; amount: string; lines: number }>;
  warnings: string[];
}
