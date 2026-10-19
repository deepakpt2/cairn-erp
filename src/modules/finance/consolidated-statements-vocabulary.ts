/**
 * Consolidated statements vocabulary (SCR-118 /
 * FIN.RPT.CONSOLIDATE.STMT).
 *
 * A read-only report over UCWB configuration and the posted
 * journal — the SAP global parameters for consolidation
 * (version, fiscal year/period, consolidation chart of FS
 * items, consolidation group and unit) drive the selection.
 * Rows are the consolidation chart's group accounts (FS
 * items), classified from their mapped source accounts.
 * The report posts nothing and stores nothing; totals
 * aggregate reported data until the translation and
 * elimination engines stand (intercompany last, B-663).
 * Client-safe: the service lives in
 * consolidated-statements.ts.
 */

export const CONSOLIDATED_STATEMENTS_CAPABILITY = 'FIN.RPT.CONSOLIDATE.STMT';
export const CONSOLIDATED_STATEMENTS_ROUTE = '/finance/consolidated-statements';

export const STATEMENT_VIEWS = ['BALANCE_SHEET', 'INCOME_STATEMENT'] as const;
export type StatementView = (typeof STATEMENT_VIEWS)[number];

export const STATEMENT_VIEW_LABELS: Record<StatementView, string> = {
  BALANCE_SHEET: 'Consolidated Balance Sheet',
  INCOME_STATEMENT: 'Consolidated Income Statement',
};

export const STATEMENT_SECTIONS = [
  'ASSETS', 'LIABILITIES', 'EQUITY', 'REVENUE', 'EXPENSES', 'UNCLASSIFIED',
] as const;
export type StatementSection = (typeof STATEMENT_SECTIONS)[number];

export const SECTION_LABELS: Record<StatementSection, string> = {
  ASSETS: 'Assets',
  LIABILITIES: 'Liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  EXPENSES: 'Expenses',
  UNCLASSIFIED: 'Unclassified FS items',
};

export interface ConsolidatedStatementsSelection {
  area: string;
  group: string;
  version: string;
  fiscalYear: number;
  period: number;
  view: StatementView;
  /** Optional consolidation unit inside the selected group. */
  unit: string;
  /** Compare against the previous fiscal year, same period. */
  comparative: boolean;
}

export interface ConsolidatedStatementUnitColumn {
  unit: string;
  title: string;
  companyCode: string;
}

export interface ConsolidatedStatementRow {
  groupAccount: string;
  title: string;
  section: StatementSection;
  /** Signed debit-minus-credit local amounts, keyed by unit. */
  unitAmounts: Record<string, string>;
  groupTotal: string;
  periodMovement: string;
  comparativeTotal: string | null;
}

export interface ConsolidatedStatementsResult {
  selection: ConsolidatedStatementsSelection;
  areaTitle: string;
  consChart: string;
  fiscalYearVariant: string;
  periodLabel: string;
  units: ConsolidatedStatementUnitColumn[];
  rows: ConsolidatedStatementRow[];
  sectionTotals: Array<{ section: StatementSection; total: string }>;
  /** Signed sum over every mapped and unmapped line; zero when the ledger balances into the chart. */
  balanceCheck: string;
  unmapped: { lines: number; amount: string };
  warnings: string[];
  monitorStanding: Array<{
    unit: string;
    task: string;
    status: string;
    mode: string;
    executedAt: string;
  }>;
}
