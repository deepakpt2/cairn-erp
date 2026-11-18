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

export interface DocumentJournalLink {
  /** SENDING | RECEIVING | PRICE_DIFFERENCE for a stock transport order movement; SINGLE for a legacy document. */
  role: string;
  companyCode: string;
  journalDocumentNumber: string;
  fiscalYear: number;
  status: string;
}

/**
 * Every accounting document a material document wrote, from the link table, falling back to the one journal
 * a legacy document stores on its header. A viewer who may not see a company's books is not shown that
 * company's journal: it is withheld and counted, never leaked.
 */
export async function journalLinksFor(
  tx: Tx, client: string, documentNumber: string, headerJournal: string | null, viewerUserId?: string,
): Promise<{ links: DocumentJournalLink[]; withheld: number }> {
  const rows = await tx.execute(sql`
    select l.role, l.company_code, l.journal_document_number, l.fiscal_year, coalesce(j.status, 'ABSENT') as status
      from material_document_journal l
      left join journal_entry j on j.client = l.client and j.document_number = l.journal_document_number and j.fiscal_year = l.fiscal_year
     where l.client = ${client} and l.material_document_number = ${documentNumber}
     order by l.role
  `) as unknown as Array<{ role: string; company_code: string; journal_document_number: string; fiscal_year: number; status: string }>;
  let links: DocumentJournalLink[] = rows.map((r) => ({
    role: r.role, companyCode: r.company_code, journalDocumentNumber: r.journal_document_number,
    fiscalYear: Number(r.fiscal_year), status: r.status,
  }));
  if (links.length === 0 && headerJournal) {
    const [company, year] = headerJournal.split('/');
    links = [{
      role: 'SINGLE', companyCode: company ?? '', journalDocumentNumber: headerJournal,
      fiscalYear: Number(year), status: await readJournalStatus(tx, client, headerJournal),
    }];
  }
  if (!viewerUserId) return { links, withheld: 0 };
  const { loadOrgRestrictions, hasOrgAccess } = await import('../../platform/auth/session');
  const restrictions = await loadOrgRestrictions(tx, client, viewerUserId);
  const visible = links.filter((l) => !l.companyCode || hasOrgAccess(restrictions, 'COMPANY_CODE', l.companyCode));
  return { links: visible, withheld: links.length - visible.length };
}
