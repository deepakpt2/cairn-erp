/**
 * Accrual/deferral documents — SCR-100 / R-148 (FBS1 entry and
 * F.81 reversal processing as search aliases only).
 *
 * Stage 1 vocabulary. The posting and reversal services land in
 * stage 3.
 */
export const ACCRUAL_CAPABILITY = 'FIN.ACCRUAL.POST';

export class AccrualError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AccrualError';
    this.remedy = remedy;
  }
}

export interface AccrualLineInput {
  glAccount: string;
  debitCredit: 'S' | 'H';
  amount: string;
  costCenter?: string;
  profitCenter?: string;
  assignment?: string;
  lineText?: string;
}

export interface AccrualDocumentView {
  companyCode: string;
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  documentType: string;
  documentDate: string;
  postingDate: string;
  currency: string;
  reference: string | null;
  headerText: string | null;
  reversalDate: string;
  reversalReason: string;
  reversalStatus: 'PENDING' | 'REVERSED';
  reversalDocumentNumber: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  journalStatus: string;
  totalAmount: number;
}

import { and, eq, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { postGlDocument, GlDocumentError, type GlDocumentInput } from './gl-document';
import { reverseDocument, DocumentReversalError } from './document-reversal';
import { accrualDocument, journalEntry, journalEntryLine, reversalReason } from './schema';

export interface AccrualPostInput {
  client: string;
  changedBy: string;
  requestKey: string;
  companyCode: string;
  documentDate: string;
  postingDate: string;
  documentType: string;
  currency: string;
  reference?: string;
  headerText?: string;
  reversalDate: string;
  reversalReason: string;
  lines: AccrualLineInput[];
}

/**
 * Post an accrual/deferral document: the judged G/L posting of
 * SCR-096 with the accrual metadata written in the same
 * transaction through the posting hook.
 */
export async function postAccrualDocument(input: AccrualPostInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reversalDate)) {
    throw new AccrualError('A reversal date is required.', 'Name the date the accrual reverses.');
  }
  if (input.reversalDate < input.postingDate) {
    throw new AccrualError(
      `Reversal date ${input.reversalDate} precedes the posting date ${input.postingDate}.`,
      'Name a reversal date on or after the posting date.',
    );
  }
  const reason = input.reversalReason?.trim().toUpperCase() ?? '';
  if (reason.length !== 2) {
    throw new AccrualError('A two-character reversal reason is required.', 'Choose a standing reversal reason.');
  }
  const glInput: GlDocumentInput = {
    client: input.client, changedBy: input.changedBy, requestKey: input.requestKey,
    companyCode: input.companyCode, documentDate: input.documentDate, postingDate: input.postingDate,
    documentType: input.documentType, currency: input.currency,
    reference: input.reference, headerText: input.headerText,
    lines: input.lines,
    onPosted: async (tx, posted) => {
      const [standing] = await tx.select().from(reversalReason).where(and(
        eq(reversalReason.client, input.client), eq(reversalReason.reasonCode, reason),
      ));
      if (!standing?.isActive) {
        throw new AccrualError(
          `Reversal reason ${reason} does not stand active.`,
          'Choose one of the standing active reversal reasons.',
        );
      }
      await tx.insert(accrualDocument).values({
        client: input.client, companyCode: input.companyCode,
        documentNumber: posted.documentNumber, fiscalYear: posted.fiscalYear,
        reversalDate: input.reversalDate, reversalReason: reason,
        reversalStatus: 'PENDING', createdBy: input.changedBy,
      });
    },
  };
  try {
    const posted = await postGlDocument(glInput);
    const view = await getAccrualDocument(input.client, input.companyCode, posted.documentNumber, posted.fiscalYear);
    if (!view) throw new AccrualError('The posted accrual document could not be read back.');
    return view;
  } catch (error) {
    if (error instanceof GlDocumentError) throw new AccrualError(error.message, error.remedy);
    throw error;
  }
}

async function toView(tx: Parameters<Parameters<typeof withTenant>[1]>[0], client: string, row: typeof accrualDocument.$inferSelect): Promise<AccrualDocumentView> {
  const [header] = await tx.select().from(journalEntry).where(and(
    eq(journalEntry.client, client), eq(journalEntry.documentNumber, row.documentNumber),
    eq(journalEntry.fiscalYear, row.fiscalYear),
  ));
  const lines = await tx.select().from(journalEntryLine).where(and(
    eq(journalEntryLine.client, client), eq(journalEntryLine.documentNumber, row.documentNumber),
    eq(journalEntryLine.fiscalYear, row.fiscalYear), eq(journalEntryLine.debitCredit, 'S'),
  ));
  return {
    companyCode: row.companyCode, documentNumber: row.documentNumber,
    displayNumber: header?.displayNumber ?? row.documentNumber,
    fiscalYear: row.fiscalYear, documentType: header?.documentType ?? '',
    documentDate: header?.documentDate ?? '', postingDate: header?.postingDate ?? '',
    currency: header?.documentCurrency ?? '', reference: header?.reference ?? null,
    headerText: header?.headerText ?? null,
    reversalDate: row.reversalDate, reversalReason: row.reversalReason,
    reversalStatus: row.reversalStatus as 'PENDING' | 'REVERSED',
    reversalDocumentNumber: row.reversalDocumentNumber,
    reversedAt: row.reversedAt ? row.reversedAt.toISOString() : null,
    reversedBy: row.reversedBy, journalStatus: header?.status ?? '',
    totalAmount: Math.round(lines.reduce((s, l) => s + Number(l.amountDocument), 0) * 100) / 100,
  };
}

export async function getAccrualDocument(
  client: string, companyCode: string, documentNumber: string, fiscalYear: number,
): Promise<AccrualDocumentView | null> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(accrualDocument).where(and(
      eq(accrualDocument.client, client), eq(accrualDocument.companyCode, companyCode),
      eq(accrualDocument.documentNumber, documentNumber), eq(accrualDocument.fiscalYear, fiscalYear),
    ));
    return row ? toView(tx, client, row) : null;
  });
}

/** Accrual documents whose reversal date is due and which stand unreversed. */
export async function listDueAccruals(client: string, asOfDate: string): Promise<AccrualDocumentView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(accrualDocument).where(and(
      eq(accrualDocument.client, client), eq(accrualDocument.reversalStatus, 'PENDING'),
    )).orderBy(accrualDocument.reversalDate, accrualDocument.documentNumber);
    const views: AccrualDocumentView[] = [];
    for (const row of rows) {
      if (row.reversalDate > asOfDate) continue;
      const view = await toView(tx, client, row);
      if (view.journalStatus === 'POSTED') views.push(view);
    }
    return views;
  });
}

export async function listAccrualDocuments(client: string): Promise<AccrualDocumentView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(accrualDocument).where(eq(accrualDocument.client, client))
      .orderBy(accrualDocument.reversalDate, accrualDocument.documentNumber);
    const views: AccrualDocumentView[] = [];
    for (const row of rows) views.push(await toView(tx, client, row));
    return views;
  });
}

async function markReversed(
  client: string, companyCode: string, documentNumber: string, fiscalYear: number,
  reversalDocumentNumber: string, reversalFiscalYear: number, changedBy: string,
) {
  await withTenant(client, async (tx) => {
    await tx.update(accrualDocument).set({
      reversalStatus: 'REVERSED', reversalDocumentNumber, reversalFiscalYear,
      reversedAt: new Date(), reversedBy: changedBy,
    }).where(and(
      eq(accrualDocument.client, client), eq(accrualDocument.companyCode, companyCode),
      eq(accrualDocument.documentNumber, documentNumber), eq(accrualDocument.fiscalYear, fiscalYear),
      eq(accrualDocument.reversalStatus, 'PENDING'),
    ));
  });
}

/**
 * Execute the due reversal of one accrual document (F.81): the
 * canonical document-reversal workflow posts the mirror, then the
 * metadata is marked. A retry reconciles from the standing
 * reversal link instead of reversing twice.
 */
export async function executeAccrualReversal(input: {
  client: string; changedBy: string; companyCode: string;
  documentNumber: string; fiscalYear: number;
}): Promise<AccrualDocumentView> {
  const view = await getAccrualDocument(input.client, input.companyCode, input.documentNumber, input.fiscalYear);
  if (!view) {
    throw new AccrualError(`Accrual document ${input.documentNumber} does not stand in company ${input.companyCode}.`);
  }
  if (view.reversalStatus === 'REVERSED') return view;
  try {
    const result = await reverseDocument({
      client: input.client, changedBy: input.changedBy, companyCode: input.companyCode,
      documentNumber: input.documentNumber, fiscalYear: input.fiscalYear,
      reasonCode: view.reversalReason, documentDate: view.reversalDate,
      postingDate: view.reversalDate, confirmed: true,
      requestKey: `accrual-reversal-${input.documentNumber}-${input.fiscalYear}`,
    });
    await markReversed(input.client, input.companyCode, input.documentNumber, input.fiscalYear,
      result.reversalDocumentNumber, result.reversalFiscalYear, input.changedBy);
  } catch (error) {
    if (error instanceof DocumentReversalError && /already stands reversed/.test(error.message)) {
      // Reconcile: the canonical link stands; complete the metadata.
      const linked = await withTenant(input.client, async (tx) => {
        const rows = await tx.execute(sql`
          select reversal_document_number, reversal_fiscal_year from accounting_reversal_link
          where client = ${input.client} and original_document_number = ${input.documentNumber}
            and original_fiscal_year = ${input.fiscalYear} limit 1
        `);
        return (rows as unknown as Array<{ reversal_document_number: string; reversal_fiscal_year: number }>)[0] ?? null;
      });
      if (!linked) throw error;
      await markReversed(input.client, input.companyCode, input.documentNumber, input.fiscalYear,
        linked.reversal_document_number, linked.reversal_fiscal_year, input.changedBy);
    } else if (error instanceof DocumentReversalError) {
      throw new AccrualError(error.message, error.remedy);
    } else {
      throw error;
    }
  }
  const done = await getAccrualDocument(input.client, input.companyCode, input.documentNumber, input.fiscalYear);
  if (!done) throw new AccrualError('The reversed accrual document could not be read back.');
  return done;
}
