/**
 * G/L to subledger tie-out (SCR-115 / FIN.RPT.SUBLEDGER.TIE;
 * F.03 and FAGLB03 search aliases, FS10N staying with the
 * G/L balance report and FBL1N/FBL5N with the partner reports).
 *
 * Per owner research the tie-out matches the G/L balance of
 * each reconciliation account against the subledger total:
 * per company, fiscal year and cumulative periods
 * 1..period-to, every account whose reconciliation type
 * stands CUSTOMERS or VENDORS shows its total over all POSTED
 * journal lines beside the total over lines carrying a
 * business partner. The difference is named TIED or
 * EXCEPTION, never netted away; partnerless lines — direct
 * postings to a reconciliation account, which should only
 * ever move through its subledger — stand as the exception
 * detail, and partners posting to an account other than the
 * one their company segment assigns are named.
 *
 * Read-only; closed periods report normally; balances stand
 * in company local currency. Deferred by name: ASSETS and
 * MATERIAL reconciliation types, non-cumulative movement
 * comparison, and multi-ledger (ledger `0L` only, refused
 * by name as elsewhere).
 *
 * Stage 1 carries the vocabulary only; the index check
 * lands in stage 2 and the tie-out service in stage 3.
 */
export const SUBLEDGER_TIE_CAPABILITY = 'FIN.RPT.SUBLEDGER.TIE';
export const TIE_LEDGER = '0L';

export interface SubledgerTieSelection {
  companyCode: string;
  fiscalYear: number;
  periodTo: number;
  ledger: string;
  accountFrom?: string;
  accountTo?: string;
}

export type TieStatus = 'TIED' | 'EXCEPTION';

export interface SubledgerTieRow {
  kind: 'ACCOUNT' | 'PARTNER';
  key: string;
  companyCode: string;
  accountNumber: string;
  reconciliationType: string;
  businessPartner?: string;
  /** Account total over all posted lines (ACCOUNT rows). */
  glTotal: number;
  /** Total over partner-carrying lines (ACCOUNT: subledger total; PARTNER: that partner). */
  subledgerTotal: number;
  difference: number | null;
  status: TieStatus | null;
  lineCount: number;
}

export interface SubledgerTieResult {
  companyCode: string;
  currency: string;
  fiscalYear: number;
  periodTo: number;
  ledger: string;
  rows: SubledgerTieRow[];
  /** Partnerless lines standing on reconciliation accounts, the exception detail. */
  partnerlessLines: number;
  partnerlessAmount: number;
  warnings: string[];
  calculatedAt: string;
}
