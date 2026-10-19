/**
 * Retained earnings definition vocabulary (SCR-121 /
 * CFG.FIN.RETAINED.DEFINE; OB53 as a search alias only).
 *
 * Per chart of accounts, each one-character retained earnings
 * indicator — X the standing convention — names the retained
 * earnings account its P&L accounts close to at balance
 * carryforward. The determinations live in the standing
 * account determination table, on the RETAINED_EARNINGS event
 * with the indicator in the general-modifier slot, so the
 * OBYC catalogue and this screen read one source. P&L
 * accounts carry the indicator in their chart segment, and
 * saving one refuses, naming this screen, while no
 * determination stands for its indicator. Client-safe: the
 * service lives in retained-earnings.ts.
 */

export const RETAINED_EARNINGS_ACTIVITY = 'CFG.FIN.RETAINED.DEFINE';
export const RETAINED_EARNINGS_ROUTE = '/config/retained-earnings';
export const RETAINED_EARNINGS_EVENT = 'RETAINED_EARNINGS';
export const STANDARD_RETAINED_EARNINGS_INDICATOR = 'X';

export interface RetainedEarningsRow {
  chartOfAccounts: string;
  /** One-character retained earnings indicator, A–Z / 0–9. */
  indicator: string;
  glAccount: string;
  accountName: string;
  /** P&L accounts of the chart carrying this indicator. */
  plAccounts: number;
}

export interface RetainedEarningsChartOption {
  chartOfAccounts: string;
  name: string;
}
