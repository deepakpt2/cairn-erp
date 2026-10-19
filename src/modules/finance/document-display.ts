/**
 * Accounting document display with flow — SCR-090 / R-138.
 *
 * A faithful, read-only window into the canonical posted
 * document: retrieved by its complete supplied key (number,
 * company, fiscal year — the year never derived or replaced),
 * lines in stable number order with every assignment, totals
 * judged independently per stored currency, and flow navigation
 * to the reversal chain, clearing documents and origin. Parked
 * documents are a distinct lifecycle and are answered as such,
 * never conflated with the ledger. Reading mutates nothing and
 * checks no posting period.
 *
 * Stage 1 carries the vocabulary only; retrieval lands in stage 3.
 */
export const DOCUMENT_FLOW_CAPABILITY = 'FIN.DOC.FLOW';

export class DocumentDisplayError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'DocumentDisplayError';
    this.remedy = remedy;
  }
}

export interface DocumentKeyInput {
  documentNumber: string;
  companyCode: string;
  fiscalYear: number;
}

export interface DocumentLineView {
  lineNumber: number;
  glAccount: string;
  debitCredit: 'S' | 'H';
  amountDocument: number;
  currency: string;
  amountLocal: number;
  costCenter: string | null;
  profitCenter: string | null;
  internalOrder: string | null;
  businessPartner: string | null;
  material: string | null;
  plant: string | null;
  taxCode: string | null;
  lineText: string | null;
  clearingDocument: string | null;
  clearingDate: string | null;
}

export interface DocumentFlowLink {
  kind: 'REVERSAL_OF' | 'REVERSED_BY' | 'ORIGIN' | 'CLEARING' | 'PREVIOUS' | 'NEXT';
  label: string;
  documentNumber: string | null;
  fiscalYear: number | null;
  href: string | null;
}

export interface DocumentHistoryEntry {
  changedAt: string;
  changedBy: string;
  changeType: string;
  reason: string | null;
}

export interface JournalDocumentView {
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  companyCode: string;
  documentType: string;
  documentDate: string;
  postingDate: string;
  postingPeriod: number;
  documentCurrency: string;
  localCurrency: string;
  exchangeRate: number;
  reference: string | null;
  headerText: string | null;
  status: string;
  originClass: string | null;
  originKey: string | null;
  postedBy: string;
  postedAt: string;
  lines: DocumentLineView[];
  debitDocument: number;
  creditDocument: number;
  debitLocal: number;
  creditLocal: number;
  flow: DocumentFlowLink[];
  history: DocumentHistoryEntry[];
}

export type DocumentLookup =
  | { kind: 'FOUND'; document: JournalDocumentView }
  | { kind: 'NOT_FOUND' }
  | { kind: 'PARKED'; parkedNumber: string };

import { and, asc, eq } from 'drizzle-orm';

import { changeHistory } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { journalEntry, journalEntryLine, parkedJournalHeader } from './schema';

const round2 = (n: number) => Math.round(n * 100) / 100;

const docHref = (documentNumber: string, companyCode: string, fiscalYear: number) =>
  `/finance/journal/document?document=${encodeURIComponent(documentNumber)}&company=${encodeURIComponent(companyCode)}&year=${fiscalYear}`;

export async function getJournalDocument(
  client: string, key: DocumentKeyInput,
): Promise<DocumentLookup> {
  const documentNumber = key.documentNumber.trim();
  if (!documentNumber || !key.companyCode.trim() || !Number.isInteger(key.fiscalYear)) {
    throw new DocumentDisplayError(
      'Enter the document number, company code and fiscal year.',
      'The complete key retrieves the document; the year is never guessed.',
    );
  }
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(journalEntry).where(and(
      eq(journalEntry.client, client),
      eq(journalEntry.documentNumber, documentNumber),
      eq(journalEntry.fiscalYear, key.fiscalYear),
    ));
    if (!header || header.companyCode !== key.companyCode.trim()) {
      const [parked] = await tx.select({ parkedNumber: parkedJournalHeader.parkedNumber })
        .from(parkedJournalHeader).where(and(
          eq(parkedJournalHeader.client, client),
          eq(parkedJournalHeader.parkedNumber, documentNumber),
        ));
      return parked ? { kind: 'PARKED', parkedNumber: parked.parkedNumber } : { kind: 'NOT_FOUND' };
    }

    const lineRows = await tx.select().from(journalEntryLine).where(and(
      eq(journalEntryLine.client, client),
      eq(journalEntryLine.documentNumber, documentNumber),
      eq(journalEntryLine.fiscalYear, key.fiscalYear),
    )).orderBy(asc(journalEntryLine.lineNumber));

    const lines: DocumentLineView[] = lineRows.map((l) => ({
      lineNumber: l.lineNumber, glAccount: l.glAccount,
      debitCredit: l.debitCredit as 'S' | 'H',
      amountDocument: Number(l.amountDocument), currency: l.currency,
      amountLocal: Number(l.amountLocal),
      costCenter: l.costCenter, profitCenter: l.profitCenter,
      internalOrder: l.internalOrder, businessPartner: l.businessPartner,
      material: l.material, plant: l.plant, taxCode: l.taxCode,
      lineText: l.lineText, clearingDocument: l.clearingDocument,
      clearingDate: l.clearingDate,
    }));
    const sum = (side: 'S' | 'H', pick: (l: DocumentLineView) => number) =>
      round2(lines.filter((l) => l.debitCredit === side).reduce((s, l) => s + pick(l), 0));

    const flow: DocumentFlowLink[] = [];
    const findDoc = async (number: string) => {
      const [row] = await tx.select({
        documentNumber: journalEntry.documentNumber,
        fiscalYear: journalEntry.fiscalYear,
        companyCode: journalEntry.companyCode,
      }).from(journalEntry).where(and(
        eq(journalEntry.client, client), eq(journalEntry.documentNumber, number),
      ));
      return row ?? null;
    };
    if (header.reversalOf) {
      const target = await findDoc(header.reversalOf);
      flow.push({
        kind: 'REVERSAL_OF', label: `Reversal of ${header.reversalOf}`,
        documentNumber: header.reversalOf, fiscalYear: target?.fiscalYear ?? null,
        href: target ? docHref(target.documentNumber, target.companyCode, target.fiscalYear) : null,
      });
    }
    if (header.reversedBy) {
      const target = await findDoc(header.reversedBy);
      flow.push({
        kind: 'REVERSED_BY', label: `Reversed by ${header.reversedBy}`,
        documentNumber: header.reversedBy, fiscalYear: target?.fiscalYear ?? null,
        href: target ? docHref(target.documentNumber, target.companyCode, target.fiscalYear) : null,
      });
    }
    if (header.originClass && header.originKey) {
      flow.push({
        kind: 'ORIGIN',
        label: header.originClass === 'parked_journal'
          ? `Parked document ${header.originKey}`
          : `${header.originClass} ${header.originKey}`,
        documentNumber: null, fiscalYear: null,
        href: header.originClass === 'parked_journal'
          ? `/finance/journal/park?edit=${encodeURIComponent(header.originKey)}`
          : null,
      });
    }
    for (const clearing of [...new Set(lines.map((l) => l.clearingDocument).filter(Boolean))] as string[]) {
      const target = await findDoc(clearing);
      flow.push({
        kind: 'CLEARING', label: `Cleared by ${clearing}`,
        documentNumber: clearing, fiscalYear: target?.fiscalYear ?? null,
        href: target ? docHref(target.documentNumber, target.companyCode, target.fiscalYear) : null,
      });
    }
    const siblings = await tx.select({ documentNumber: journalEntry.documentNumber })
      .from(journalEntry).where(and(
        eq(journalEntry.client, client), eq(journalEntry.companyCode, header.companyCode),
        eq(journalEntry.fiscalYear, key.fiscalYear),
      )).orderBy(asc(journalEntry.documentNumber));
    const numbers = siblings.map((s) => s.documentNumber);
    const at = numbers.indexOf(documentNumber);
    if (at > 0) {
      flow.push({
        kind: 'PREVIOUS', label: `Previous document ${numbers[at - 1]}`,
        documentNumber: numbers[at - 1], fiscalYear: key.fiscalYear,
        href: docHref(numbers[at - 1], header.companyCode, key.fiscalYear),
      });
    }
    if (at >= 0 && at < numbers.length - 1) {
      flow.push({
        kind: 'NEXT', label: `Next document ${numbers[at + 1]}`,
        documentNumber: numbers[at + 1], fiscalYear: key.fiscalYear,
        href: docHref(numbers[at + 1], header.companyCode, key.fiscalYear),
      });
    }

    const historyRows = await changeHistory(tx, client, 'journal_entry', `${documentNumber}/${key.fiscalYear}`);
    const history: DocumentHistoryEntry[] = historyRows.map((h) => ({
      changedAt: h.changedAt instanceof Date ? h.changedAt.toISOString() : String(h.changedAt),
      changedBy: h.changedBy, changeType: h.changeType,
      reason: (h as { reason?: string | null }).reason ?? null,
    }));

    return {
      kind: 'FOUND',
      document: {
        documentNumber: header.documentNumber,
        displayNumber: header.displayNumber,
        fiscalYear: header.fiscalYear, companyCode: header.companyCode,
        documentType: header.documentType,
        documentDate: String(header.documentDate), postingDate: String(header.postingDate),
        postingPeriod: header.postingPeriod,
        documentCurrency: header.documentCurrency, localCurrency: header.localCurrency,
        exchangeRate: Number(header.exchangeRate),
        reference: header.reference, headerText: header.headerText,
        status: header.status,
        originClass: header.originClass, originKey: header.originKey,
        postedBy: header.createdBy,
        postedAt: header.postedAt instanceof Date ? header.postedAt.toISOString() : String(header.postedAt),
        lines,
        debitDocument: sum('S', (l) => l.amountDocument),
        creditDocument: sum('H', (l) => l.amountDocument),
        debitLocal: sum('S', (l) => l.amountLocal),
        creditLocal: sum('H', (l) => l.amountLocal),
        flow, history,
      },
    };
  });
}

/**
 * Resolve a bare document number from an older link: the unique
 * document, or an ambiguity refusal naming the years standing.
 */
export async function resolveDocumentNumber(
  client: string, documentNumber: string,
): Promise<{ companyCode: string; fiscalYear: number } | null> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      companyCode: journalEntry.companyCode, fiscalYear: journalEntry.fiscalYear,
    }).from(journalEntry).where(and(
      eq(journalEntry.client, client), eq(journalEntry.documentNumber, documentNumber),
    ));
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new DocumentDisplayError(
        `Document ${documentNumber} stands in ${rows.map((r) => r.fiscalYear).join(' and ')}; name the fiscal year to display it.`,
      );
    }
    return rows[0];
  });
}
