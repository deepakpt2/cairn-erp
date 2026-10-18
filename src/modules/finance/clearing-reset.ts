/**
 * Reset cleared items — SCR-071 / R-119.
 *
 * Reset only: the clearing stamp lifts from every line the named
 * clearing document cleared, so the items stand open again. No
 * journal posts, no amount changes, no document is edited. The
 * reset itself stands on the clearing_reset record — clearing
 * document, former clearing date, items reopened, mandatory
 * reason — written in the same transaction as the stamp clearing.
 * Reversing the clearing document is a separate later act.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { clearingReset, journalEntry, journalEntryLine } from './schema';

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
    if (journal.status !== 'POSTED') {
      throw new ClearingResetError(`Clearing document ${input.clearingDocument} does not stand posted.`);
    }
    const lines = await loadCleared(tx, client, input.companyCode, input.clearingDocument);
    const reset = await loadReset(tx, client, input.companyCode, input.clearingDocument, input.fiscalYear);
    if (lines.length === 0 && !reset) {
      throw new ClearingResetError(
        `Document ${input.clearingDocument} cleared no items in company ${input.companyCode}.`,
        'FBRA resets a document that performed clearing; name the clearing document.',
      );
    }
    const items: ClearedItemView[] = lines
      .filter((l) => !(l.documentNumber === input.clearingDocument && l.fiscalYear === input.fiscalYear))
      .map((l) => ({
        documentNumber: l.documentNumber, fiscalYear: l.fiscalYear, lineNumber: l.lineNumber,
        businessPartner: l.businessPartner, glAccount: l.glAccount, debitCredit: l.debitCredit,
        amount: l.amountLocal, currency: l.currency,
      }));
    return {
      companyCode: input.companyCode, clearingDocument: input.clearingDocument,
      fiscalYear: input.fiscalYear, documentType: journal.documentType,
      documentDate: journal.documentDate, postingDate: journal.postingDate,
      clearingDate: lines[0]?.clearingDate ?? reset?.clearingDate ?? '',
      items, alreadyResetBy: lines.length === 0 && reset ? reset.resetNumber : null,
    };
  });
}

export async function resetClearing(input: {
  client: string; changedBy: string;
  companyCode: string; clearingDocument: string; fiscalYear: number;
  reason: string; requestKey?: string;
}): Promise<ClearingResetResult> {
  if (!input.reason?.trim()) {
    throw new ClearingResetError('A reason stands required for a clearing reset.', 'State why the clearing is undone.');
  }
  return withTenant(input.client, async (tx) => {
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
    const lines = await loadCleared(tx, input.client, input.companyCode, input.clearingDocument);
    if (lines.length === 0) {
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

    const clearingDate = lines[0].clearingDate!;
    const itemRefs = lines.map((l) => `${l.documentNumber}/${l.fiscalYear}/${l.lineNumber}`).join(',');
    const count = await tx.select({ n: sql<number>`count(*)::int` }).from(clearingReset)
      .where(eq(clearingReset.client, input.client));
    const resetNumber = `RST-${String((count[0]?.n ?? 0) + 1).padStart(6, '0')}`;

    await tx.update(journalEntryLine).set({ clearingDocument: null, clearingDate: null }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.companyCode, input.companyCode),
      eq(journalEntryLine.clearingDocument, input.clearingDocument),
    ));
    await tx.insert(clearingReset).values({
      client: input.client, resetNumber, companyCode: input.companyCode,
      clearingDocument: input.clearingDocument, fiscalYear: input.fiscalYear,
      clearingDate, itemsReset: lines.length, itemRefs, reason: input.reason.trim(),
      requestKey: input.requestKey ?? null,
      createdBy: input.changedBy, changedBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: RESET_CLASS, objectKey: `${input.companyCode}/${input.clearingDocument}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CLEARING_RESET_CAPABILITY,
      after: { resetNumber, clearingDocument: input.clearingDocument, itemsReset: lines.length, clearingDate, reason: input.reason.trim() },
    });

    return {
      resetNumber, clearingDocument: input.clearingDocument, fiscalYear: input.fiscalYear,
      companyCode: input.companyCode, clearingDate, itemsReset: lines.length, reason: input.reason.trim(),
    };
  });
}
