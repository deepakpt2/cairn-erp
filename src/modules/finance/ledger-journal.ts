import { sql, type SQL } from 'drizzle-orm';

/**
 * Current balances read the ledger, not a lifecycle label.
 *
 * A journal affects balances once it has been posted. REVERSED is the
 * mark set after the offsetting reversal document is posted. The
 * original amounts stay, so the pair nets; the status does not void
 * them. PARKED has not entered the ledger and is excluded.
 *
 * Historical lists and document display do not use this predicate:
 * they show the original and the reversal, including the link.
 * Selections that act on a document (payment, clearing, dunning,
 * revaluation) stay on POSTED so a reversed document is not processed
 * again.
 */
export const LEDGER_JOURNAL_STATUSES = ['POSTED', 'REVERSED'] as const;

export function ledgerJournalStatus(alias: 'e' | 'h'): SQL {
  return alias === 'h'
    ? sql`h.status in ('POSTED', 'REVERSED')`
    : sql`e.status in ('POSTED', 'REVERSED')`;
}
