/**
 * G/L account balances by period — SCR-089 / R-137.
 *
 * Read-only derivation over the canonical journal on the SCR-069
 * precedent: no balance table stands to drift from the ledger.
 * The opening balance is the signed (debit-positive) sum of every
 * earlier year; turnover sums each period's posted lines by the
 * document's stored posting period; closing chains opening plus
 * cumulative net change. Special periods stand apart, only when
 * the caller includes them and the company's variant configures
 * them. Only documents standing POSTED count. Closed periods
 * remain reportable — period locks govern posting, not inquiry.
 *
 * Stage 1 carries the vocabulary only; derivation lands in stage 3.
 */
export const GL_BALANCE_CAPABILITY = 'FIN.GL.BALANCE';

export class GlBalanceError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'GlBalanceError';
    this.remedy = remedy;
  }
}

export interface GlBalancePeriodRow {
  period: number;
  special: boolean;
  opening: number;
  debitTurnover: number;
  creditTurnover: number;
  netChange: number;
  closing: number;
  itemCount: number;
}

export interface GlBalanceView {
  glAccount: string;
  companyCode: string;
  fiscalYear: number;
  currency: string;
  openingBalance: number;
  periods: GlBalancePeriodRow[];
  yearDebit: number;
  yearCredit: number;
  yearClosing: number;
}
