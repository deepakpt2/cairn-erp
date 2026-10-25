import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';

/**
 * A material-document journal is one accounting entry. MBST can reverse
 * selected lines, but it cannot allocate part of that journal. Stock and
 * value follow the reversed line. The journal stays posted until every line
 * is reversed, and it is reversed once. Displays must not call accounting
 * reversed before that journal reversal stands.
 */
export type JournalAccountingState =
  | 'NONE'
  | 'POSTED'
  | 'PARTIAL'
  | 'COMPLETE'
  | 'MISSING'
  | 'MISMATCH'
  | 'DEFERRED'
  | 'ABSENT';

export interface JournalAccounting {
  state: JournalAccountingState;
  note: string;
}

export const JOURNAL_ACCOUNTING_NOTE = {
  none: 'This movement carried no journal.',
  posted: 'The journal is posted. Nothing on this document has been reversed.',
  partial: 'Some lines are reversed. Stock and value of those lines have moved. The journal is still posted, so accounting is not reversed. It is reversed once, when the last line is reversed.',
  complete: 'Every line is reversed and the journal reversal is posted. Material and accounting reversal are complete.',
  missing: 'Every material line is reversed, but the journal reversal is missing. Accounting is not reversed.',
  journalAbsent: 'The journal number is stored, but the accounting document does not stand. Accounting is not reversed.',
  mismatch: 'The journal is already reversed, but material lines remain open. Accounting does not match those open lines. A second journal reversal is not posted.',
  deferred: 'This reversal moved stock and value for the selected lines only. The journal stays on the original document until every line is reversed. Accounting is not reversed yet.',
} as const;

export type StoredJournalStatus = 'POSTED' | 'REVERSED' | 'ABSENT' | 'OTHER';

export async function readJournalStatus(
  tx: Tx, client: string, journalNumber: string | null,
): Promise<StoredJournalStatus> {
  if (!journalNumber) return 'ABSENT';
  const year = Number(journalNumber.split('/')[1]);
  if (!Number.isFinite(year)) return 'ABSENT';
  const rows = await tx.execute(sql`
    select status from journal_entry
     where client = ${client} and document_number = ${journalNumber} and fiscal_year = ${year}
  `) as unknown as Array<{ status: string }>;
  const status = rows[0]?.status;
  if (status === 'POSTED' || status === 'REVERSED') return status;
  return status ? 'OTHER' : 'ABSENT';
}

export function describeJournalAccounting(input: {
  reversalOf: string | null;
  ownJournalNumber: string | null;
  ownJournalStatus: StoredJournalStatus;
  originalJournalStatus: StoredJournalStatus | null;
  linesOpen: boolean;
}): JournalAccounting {
  if (input.reversalOf) {
    if (input.ownJournalNumber) {
      return { state: 'COMPLETE', note: JOURNAL_ACCOUNTING_NOTE.complete };
    }
    if (input.originalJournalStatus === 'POSTED') {
      return { state: 'DEFERRED', note: JOURNAL_ACCOUNTING_NOTE.deferred };
    }
    if (input.originalJournalStatus === 'REVERSED') {
      return { state: 'COMPLETE', note: JOURNAL_ACCOUNTING_NOTE.complete };
    }
    if (input.originalJournalStatus == null || input.originalJournalStatus === 'ABSENT') {
      return { state: 'NONE', note: JOURNAL_ACCOUNTING_NOTE.none };
    }
    return { state: 'MISSING', note: JOURNAL_ACCOUNTING_NOTE.missing };
  }
  if (!input.ownJournalNumber && input.ownJournalStatus === 'ABSENT') {
    return { state: 'NONE', note: JOURNAL_ACCOUNTING_NOTE.none };
  }
  if (input.linesOpen && input.ownJournalStatus === 'REVERSED') {
    return { state: 'MISMATCH', note: JOURNAL_ACCOUNTING_NOTE.mismatch };
  }
  if (!input.linesOpen) {
    if (input.ownJournalStatus === 'REVERSED') {
      return { state: 'COMPLETE', note: JOURNAL_ACCOUNTING_NOTE.complete };
    }
    return { state: 'MISSING', note: JOURNAL_ACCOUNTING_NOTE.missing };
  }
  if (input.ownJournalStatus === 'POSTED') {
    // Caller distinguishes nothing-reversed from some-reversed by document status.
    return { state: 'PARTIAL', note: JOURNAL_ACCOUNTING_NOTE.partial };
  }
  return { state: 'ABSENT', note: JOURNAL_ACCOUNTING_NOTE.journalAbsent };
}

/** Nothing reversed yet is not a partial reversal. The journal is simply posted. */
export function accountingForOriginal(input: {
  status: string;
  reversalOf: string | null;
  journalNumber: string | null;
  journalStatus: StoredJournalStatus;
  originalJournalStatus: StoredJournalStatus | null;
  linesOpen: boolean;
}): JournalAccounting {
  const described = describeJournalAccounting({
    reversalOf: input.reversalOf,
    ownJournalNumber: input.journalNumber,
    ownJournalStatus: input.journalStatus,
    originalJournalStatus: input.originalJournalStatus,
    linesOpen: input.linesOpen,
  });
  if (!input.reversalOf && input.status === 'POSTED' && described.state === 'PARTIAL') {
    return { state: 'POSTED', note: JOURNAL_ACCOUNTING_NOTE.posted };
  }
  if (!input.reversalOf && input.status === 'PARTIALLY_REVERSED' && input.journalStatus === 'POSTED') {
    return { state: 'PARTIAL', note: JOURNAL_ACCOUNTING_NOTE.partial };
  }
  return described;
}
