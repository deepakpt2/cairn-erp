/**
 * Reset cleared items — SCR-071 / R-119.
 *
 * The clearing stamp lifts from every line the named clearing document cleared, so the items
 * stand open again. When the clearing posted a realized exchange difference, the clearing journal
 * is also reversed — an exact mirror at the original rates — because lifting the stamps alone
 * would leave that difference posted. Otherwise no journal posts and no document is edited. The
 * reset itself stands on the clearing_reset record — clearing document, former clearing date,
 * items reopened, mandatory reason — written in the same transaction as the stamp clearing.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { PostingError, reverseJournalEntry } from '../../platform/posting';
import { activeBankMatchForJournal } from './bank-reconciliation';
import { clearingReset, glClearingAllocation, journalEntry, journalEntryLine } from './schema';

export const CLEARING_RESET_CAPABILITY = 'FIN.CLEARING.RESET';
const RESET_CLASS = 'clearing_reset';

export class ClearingResetError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ClearingResetError';
    this.remedy = remedy;
  }
}

export interface ClearedItemView {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  businessPartner: string | null;
  glAccount: string;
  debitCredit: string;
  amount: string;
  currency: string;
}

export interface ClearingDocumentView {
  companyCode: string;
  clearingDocument: string;
  fiscalYear: number;
  documentType: string;
  documentDate: string;
  postingDate: string;
  clearingDate: string;
  items: ClearedItemView[];
  alreadyResetBy: string | null;
}

export interface ClearingResetResult {
  resetNumber: string;
  clearingDocument: string;
  fiscalYear: number;
  companyCode: string;
  clearingDate: string;
  itemsReset: number;
  reason: string;
}

interface Tx {
  select: (...args: never[]) => never;
}

async function loadCleared(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  client: string, companyCode: string, clearingDocument: string,
): Promise<Array<typeof journalEntryLine.$inferSelect>> {
  return tx.select().from(journalEntryLine).where(and(
    eq(journalEntryLine.client, client),
    eq(journalEntryLine.companyCode, companyCode),
    eq(journalEntryLine.clearingDocument, clearingDocument),
  ));
}

async function loadReset(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  client: string, companyCode: string, clearingDocument: string, fiscalYear: number,
) {
  const [row] = await tx.select().from(clearingReset).where(and(
    eq(clearingReset.client, client),
    eq(clearingReset.companyCode, companyCode),
    eq(clearingReset.clearingDocument, clearingDocument),
    eq(clearingReset.fiscalYear, fiscalYear),
  ));
  return row ?? null;
}

export async function getClearingDocument(client: string, input: {
  companyCode: string; clearingDocument: string; fiscalYear: number;
}): Promise<ClearingDocumentView> {
  return withTenant(client, async (tx) => {
    const [journal] = await tx.select().from(journalEntry).where(and(
      eq(journalEntry.client, client),
      eq(journalEntry.documentNumber, input.clearingDocument),
      eq(journalEntry.fiscalYear, input.fiscalYear),
    ));
    if (!journal || journal.companyCode !== input.companyCode) {
      throw new ClearingResetError(
        `Clearing document ${input.clearingDocument} does not stand in company ${input.companyCode} for ${input.fiscalYear}.`,
        'Name the clearing document exactly as it stands stamped on the cleared items.',
      );
    }
    const reset = await loadReset(tx, client, input.companyCode, input.clearingDocument, input.fiscalYear);
    // A reset that carried realized FX reverses the clearing journal; the reset record is then the
    // authoritative evidence and the view must still open, not claim the document vanished.
    if (journal.status !== 'POSTED' && !reset) {
      throw new ClearingResetError(`Clearing document ${input.clearingDocument} does not stand posted.`);
    }
    const stamped = await loadCleared(tx, client, input.companyCode, input.clearingDocument);
    const sourceItems = stamped.filter((l) =>
      !(l.documentNumber === input.clearingDocument && l.fiscalYear === input.fiscalYear));
    if (sourceItems.length === 0 && !reset) {
      throw new ClearingResetError(
        `Document ${input.clearingDocument} cleared no items in company ${input.companyCode}.`,
        'FBRA resets a document that performed clearing; name the clearing document.',
      );
    }
    const items: ClearedItemView[] = sourceItems.map((l) => ({
      documentNumber: l.documentNumber, fiscalYear: l.fiscalYear, lineNumber: l.lineNumber,
      businessPartner: l.businessPartner, glAccount: l.glAccount, debitCredit: l.debitCredit,
      amount: l.amountLocal, currency: l.currency,
    }));
    return {
      companyCode: input.companyCode, clearingDocument: input.clearingDocument,
      fiscalYear: input.fiscalYear, documentType: journal.documentType,
      documentDate: journal.documentDate, postingDate: journal.postingDate,
      clearingDate: sourceItems[0]?.clearingDate ?? stamped[0]?.clearingDate ?? reset?.clearingDate ?? '',
      items, alreadyResetBy: sourceItems.length === 0 && reset ? reset.resetNumber : null,
    };
  });
}

export interface ResetClearingInput {
  client: string; changedBy: string;
  companyCode: string; clearingDocument: string; fiscalYear: number;
  reason: string; requestKey?: string;
}

/**
 * The reset itself, on a transaction the caller already owns.
 *
 * Reversing an invoice has to undo the settlements that were made against it, and
 * undo them in the same movement: an advance that stayed cleared while the invoice
 * came off the books would be spent twice. So the reset takes the caller's
 * transaction rather than committing on its own — a reset that committed early
 * could not be taken back when the cancellation it belongs to later failed.
 */
export async function resetClearingTx(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0], input: ResetClearingInput,
): Promise<ClearingResetResult> {
  if (!input.reason?.trim()) {
    throw new ClearingResetError('A reason stands required for a clearing reset.', 'State why the clearing is undone.');
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/clearreset`}, 0))`);

  if (input.requestKey) {
    const [standing] = await tx.select().from(clearingReset).where(and(
      eq(clearingReset.client, input.client),
      eq(clearingReset.requestKey, input.requestKey),
    ));
    if (standing) {
      return {
        resetNumber: standing.resetNumber, clearingDocument: standing.clearingDocument,
        fiscalYear: standing.fiscalYear, companyCode: standing.companyCode,
        clearingDate: standing.clearingDate, itemsReset: standing.itemsReset, reason: standing.reason,
      };
    }
  }

  const [journal] = await tx.select().from(journalEntry).where(and(
    eq(journalEntry.client, input.client),
    eq(journalEntry.documentNumber, input.clearingDocument),
    eq(journalEntry.fiscalYear, input.fiscalYear),
  ));
  if (!journal || journal.companyCode !== input.companyCode || journal.status !== 'POSTED') {
    throw new ClearingResetError(
      `Clearing document ${input.clearingDocument} does not stand posted in company ${input.companyCode} for ${input.fiscalYear}.`,
      'Name the clearing document exactly as it stands stamped on the cleared items.',
    );
  }
  const stamped = await loadCleared(tx, input.client, input.companyCode, input.clearingDocument);
  // The source items are what the user recognises as "cleared items"; the clearing journal's own
  // stamped lines are the accounting offsets and reopen with them so the economic position is whole.
  const items = stamped.filter((l) => !(l.documentNumber === input.clearingDocument && l.fiscalYear === input.fiscalYear));
  if (items.length === 0) {
    const reset = await loadReset(tx, input.client, input.companyCode, input.clearingDocument, input.fiscalYear);
    if (reset) {
      throw new ClearingResetError(
        `Clearing document ${input.clearingDocument} already stands reset by ${reset.resetNumber}.`,
        'The items stand open again; clear them anew if they settle.',
      );
    }
    throw new ClearingResetError(
      `Document ${input.clearingDocument} cleared no items in company ${input.companyCode}.`,
      'FBRA resets a document that performed clearing; name the clearing document.',
    );
  }

  // A clearing that posted a realized exchange difference cannot be reset by lifting stamps alone:
  // the local-only FX line would remain posted while the items reopen. Its journal is reversed
  // below, as an exact mirror at the original rates.
  const fxRows = await tx.execute(sql`
    select count(*)::int as n from journal_entry_line
     where client = ${input.client} and company_code = ${input.companyCode}
       and document_number = ${input.clearingDocument} and fiscal_year = ${input.fiscalYear}
       and is_local_only
  `) as unknown as Array<{ n: number }>;
  const hasRealizedFx = (fxRows[0]?.n ?? 0) > 0;

  // A cleared item whose own journal is reversed (or is a reversal mirror) is invalid evidence: the
  // reset would reopen a line that no longer stands as a genuine open item. Surface it, never guess.
  const staleItems = await tx.execute(sql`
    select count(*)::int as n
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
     where l.client = ${input.client} and l.company_code = ${input.companyCode}
       and l.clearing_document = ${input.clearingDocument}
       and l.document_number <> ${input.clearingDocument}
       and (e.status <> 'POSTED' or e.reversal_of is not null)
  `) as unknown as Array<{ n: number }>;
  if ((staleItems[0]?.n ?? 0) > 0) {
    throw new ClearingResetError(
      `Clearing document ${input.clearingDocument} stamped ${staleItems[0]!.n} item line(s) whose journal is reversed or is a reversal mirror.`,
      'Correct the clearing evidence explicitly; the reset will not reopen a reversed or mirrored item as if it still stood open.',
    );
  }

  // A clearing that generated residual items cannot simply be reset: the
  // residual line is a posted open item of the clearing document, so lifting
  // the stamps alone would leave it open beside the reopened originals.
  const residualRows = await tx.execute(sql`
    select count(*)::int as n from gl_clearing_residual
    where client = ${input.client} and clearing_document = ${input.clearingDocument} and is_active
  `) as unknown as Array<{ n: number }>;
  if ((residualRows[0]?.n ?? 0) > 0) {
    throw new ClearingResetError(
      `Clearing document ${input.clearingDocument} generated ${residualRows[0]!.n} residual item(s); a reset would leave them open beside the reopened originals.`,
      'Reverse the clearing document through the standing reversal workflow, which cancels the residual line, then reset.',
    );
  }

  const clearingDate = items[0].clearingDate!;

  if (hasRealizedFx) {
    // A payment journal can itself carry residual or on-account lines that a later clearing
    // consumed. Reversing the payment here would reverse the evidence underneath that later
    // settlement. Detect the dependency by the line's clearing document, not by gl_clearing_residual.
    const downstream = await tx.execute(sql`
      select distinct l.clearing_document
        from journal_entry_line l
       where l.client = ${input.client} and l.company_code = ${input.companyCode}
         and l.document_number = ${input.clearingDocument} and l.fiscal_year = ${input.fiscalYear}
         and l.clearing_document is not null
         and l.clearing_document <> ${input.clearingDocument}
       order by l.clearing_document
    `) as unknown as Array<{ clearing_document: string }>;
    if (downstream.length > 0) {
      throw new ClearingResetError(
        `Clearing document ${input.clearingDocument} has payment-side line(s) subsequently settled by ${downstream.map((row) => row.clearing_document).join(', ')}. Reversing it now would reverse evidence underneath that later settlement.`,
        'Reset the downstream clearing document(s) first, then reset this payment. Nothing has been changed.',
      );
    }
    // The same authoritative bank-match guard as the ordinary document reversal. It also takes the
    // journal-scoped lock, so a concurrent match cannot slip between this check and the reversal.
    const bankMatch = await activeBankMatchForJournal(
      tx, input.client, input.clearingDocument, input.fiscalYear,
    );
    if (bankMatch) {
      throw new ClearingResetError(
        `Clearing document ${input.clearingDocument} line ${bankMatch.lineNumber} stands in bank reconciliation match ${bankMatch.matchId} on statement ${bankMatch.statementReference}.`,
        'Reopen the bank statement and unmatch the line first; then the reset can reverse the clearing journal and reopen the items explicitly.',
      );
    }
    await reverseJournalEntry(tx, {
      client: input.client,
      documentNumber: input.clearingDocument,
      fiscalYear: input.fiscalYear,
      reversalDate: clearingDate,
      reason: `Clearing reset: ${input.reason.trim()}`,
      reversedBy: input.changedBy,
      transactionCode: CLEARING_RESET_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) {
        throw new ClearingResetError(
          `The clearing carries a realized exchange difference and its reversal was refused: ${error.message}`,
          `${error.remedy} The items were not reopened.`,
        );
      }
      throw error;
    });
  }

  // The reset record names every line whose stamp was lifted, including the clearing journal's own
  // accounting offsets. Valuation's as-of clearing history uses these refs.
  const itemRefs = stamped.map((l) => `${l.documentNumber}/${l.fiscalYear}/${l.lineNumber}`).join(',');
  const count = await tx.select({ n: sql<number>`count(*)::int` }).from(clearingReset)
    .where(eq(clearingReset.client, input.client));
  const resetNumber = `RST-${String((count[0]?.n ?? 0) + 1).padStart(6, '0')}`;

  // Reopen both the source items and the clearing journal's own offset lines. Leaving the offsets
  // self-stamped would hide the payment/clearing side while the source item reopened, so a later
  // settlement would find no available offset. A reversed journal's originals are REVERSED and the
  // mirror stays hidden by the reversal filters, so this cannot expose duplicates.
  await tx.update(journalEntryLine).set({ clearingDocument: null, clearingDate: null }).where(and(
    eq(journalEntryLine.client, input.client),
    eq(journalEntryLine.companyCode, input.companyCode),
    eq(journalEntryLine.clearingDocument, input.clearingDocument),
  ));
  // Allocations lift as history, never as a delete: the rows stand inactive
  // and the source items' remaining balances restore.
  await tx.update(glClearingAllocation).set({
    isActive: false, resetNumber, changedBy: input.changedBy, changedAt: new Date(),
  }).where(and(
    eq(glClearingAllocation.client, input.client),
    eq(glClearingAllocation.clearingDocument, input.clearingDocument),
    eq(glClearingAllocation.isActive, true),
  ));
  await tx.insert(clearingReset).values({
    client: input.client, resetNumber, companyCode: input.companyCode,
    clearingDocument: input.clearingDocument, fiscalYear: input.fiscalYear,
    clearingDate, itemsReset: items.length, itemRefs, reason: input.reason.trim(),
    requestKey: input.requestKey ?? null,
    createdBy: input.changedBy, changedBy: input.changedBy,
  });
  await recordChange(tx, {
    client: input.client, objectClass: RESET_CLASS, objectKey: `${input.companyCode}/${input.clearingDocument}`,
    changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CLEARING_RESET_CAPABILITY,
    after: { resetNumber, clearingDocument: input.clearingDocument, itemsReset: items.length, clearingDate, reason: input.reason.trim() },
  });

  return {
    resetNumber, clearingDocument: input.clearingDocument, fiscalYear: input.fiscalYear,
    companyCode: input.companyCode, clearingDate, itemsReset: items.length, reason: input.reason.trim(),
  };
}

export async function resetClearing(input: ResetClearingInput): Promise<ClearingResetResult> {
  return withTenant(input.client, (tx) => resetClearingTx(tx, input));
}
