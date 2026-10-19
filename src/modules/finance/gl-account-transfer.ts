/**
 * Transfer G/L account master data between company codes —
 * SCR-110 / FS15 as a search alias only, SAP parity scope.
 *
 * Parity first builds the company-code segment of the G/L
 * master (gl_account_company): account currency, tax category,
 * open-item management, sort key and posting block per company.
 * Where a segment row stands it governs; the chart-level flag
 * remains the fallback, so standing behavior is preserved.
 * The transfer copies segment rows source -> target company
 * under test-run / with-company-data / overwrite policy, and
 * every run (test runs included, as execution metadata) leaves
 * a run header plus per-account protocol. Chart-level records
 * are never overwritten for a company difference.
 *
 * Stage 1 carries the vocabulary only; schema lands in stage 2
 * and the transfer service in stage 3.
 */
export const GL_ACCOUNT_TRANSFER_CAPABILITY = 'CFG.FIN.GLACCOUNT.TRANSFER';

export interface GlAccountCompanySegment {
  companyCode: string;
  glAccount: string;
  accountCurrency: string;
  taxCategory: string | null;
  isOpenItemManaged: boolean;
  sortKey: string;
  isBlockedPosting: boolean;
}

export interface GlAccountTransferSelection {
  sourceCompanyCode: string;
  targetCompanyCode: string;
  chartOfAccounts: string;
  accountFrom?: string;
  accountTo?: string;
  testRun: boolean;
  withCompanyData: boolean;
  overwriteExisting: boolean;
}

export type TransferAction = 'CREATED' | 'UPDATED' | 'SKIPPED' | 'ERROR';

export interface GlAccountTransferLine {
  glAccount: string;
  action: TransferAction;
  reason: string;
}

export interface GlAccountTransferResult {
  runId: string;
  testRun: boolean;
  status: 'COMPLETED' | 'PARTIALLY_FAILED' | 'FAILED';
  lines: GlAccountTransferLine[];
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  executedAt: string;
  executedBy: string;
}
