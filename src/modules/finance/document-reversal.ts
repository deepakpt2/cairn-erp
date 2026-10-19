/**
 * Reverse accounting document — SCR-072 / R-120.
 *
 * A posted journal is mirrored back through the standing posting
 * engine: every line returns with debit and credit swapped, exact
 * document and local amounts preserved, and the original stands
 * marked REVERSED. The reversal is its own AB document, its document
 * date stands independent of its posting date, and the posting period
 * is derived from the posting date through the company's fiscal-year
 * variant. The pair stands on accounting_reversal_link, unique both
 * ways, so exactly one successful reversal ever stands against an
 * original. Cleared items are never reversed here — the clearing is
 * reset first (SCR-071). A reversal document cannot itself be
 * reversed this round.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode, PeriodError } from '../../platform/periods';
import { PostingError, reverseJournalEntry } from '../../platform/posting';
import { accountingReversalLink, journalEntry, journalEntryLine, reversalReason } from './schema';

export const DOCUMENT_REVERSE_CAPABILITY = 'FIN.DOCUMENT.REVERSE';
const REVERSAL_DOCUMENT_TYPE = 'AB';
const REVERSAL_CLASS = 'accounting_reversal_link';

export class DocumentReversalError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'DocumentReversalError';
    this.remedy = remedy;
  }
}

export interface ReversalReasonOption {
  code: string;
  description: string;
}

export interface ReversalLineView {
  lineNumber: number;
  glAccount: string;
  debitCredit: string;
  amountDocument: string;
  amountLocal: string;
  currency: string;
  businessPartner: string | null;
  costCenter: string | null;
  profitCenter: string | null;
  taxCode: string | null;
  lineText: string | null;
  clearingDocument: string | null;
  clearingDate: string | null;
}

export interface StandingReversalView {
  reversalDocumentNumber: string;
  reversalFiscalYear: number;
  reversalDocumentDate: string;
  reversalPostingDate: string;
  reversalPostingPeriod: number;
  reasonCode: string;
  reversedBy: string;
}

export interface ReversalDocumentView {
  companyCode: string;
  documentNumber: string;
  fiscalYear: number;
  documentType: string;
  documentDate: string;
  postingDate: string;
  postingPeriod: number;
  documentCurrency: string;
  localCurrency: string;
  exchangeRate: string;
  reference: string | null;
  headerText: string | null;
  status: string;
  reversalOf: string | null;
  reversedBy: string | null;
  reversalReason: string | null;
  lines: ReversalLineView[];
  debitTotalDocument: string;
  creditTotalDocument: string;
  debitTotalLocal: string;
  creditTotalLocal: string;
  clearedLineCount: number;
  clearsItemCount: number;
  standingReversal: StandingReversalView | null;
  reasons: ReversalReasonOption[];
  canReverse: boolean;
  refusal: string | null;
  refusalRemedy: string | null;
  reversalFiscalYear: number | null;
  reversalPostingPeriod: number | null;
  reversalPeriodError: string | null;
}

export interface DocumentReversalResult {
  companyCode: string;
  originalDocumentNumber: string;
  originalFiscalYear: number;
  reversalDocumentNumber: string;
  reversalFiscalYear: number;
  reversalDocumentType: string;
  reversalDocumentDate: string;
  reversalPostingDate: string;
  reversalPostingPeriod: number;
  reasonCode: string;
  reversalAmountLocal: string;
  currency: string;
}

type JournalHeader = typeof journalEntry.$inferSelect;
type JournalLine = typeof journalEntryLine.$inferSelect;
type ReversalLink = typeof accountingReversalLink.$inferSelect;

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const money = (n: number) => round4(n).toFixed(4);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertCalendarDate(label: string, value: string): void {
  if (!DATE_RE.test(value)) {
    throw new DocumentReversalError(`${label} ${value} is not a calendar date.`, 'Use the date picker.');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new DocumentReversalError(`${label} ${value} is not a calendar date.`, 'Use the date picker.');
  }
}

function totals(lines: JournalLine[], field: 'amountDocument' | 'amountLocal') {
  const debit = lines.filter((l) => l.debitCredit === 'S').reduce((s, l) => s + Number(l[field]), 0);
  const credit = lines.filter((l) => l.debitCredit === 'H').reduce((s, l) => s + Number(l[field]), 0);
  return { debit: money(debit), credit: money(credit) };
}

async function loadHeader(tx: Tx, client: string, documentNumber: string, fiscalYear: number) {
  const [header] = await tx.select().from(journalEntry).where(and(
    eq(journalEntry.client, client),
    eq(journalEntry.documentNumber, documentNumber),
    eq(journalEntry.fiscalYear, fiscalYear),
  ));
  return header ?? null;
}

async function loadLines(tx: Tx, client: string, documentNumber: string, fiscalYear: number): Promise<JournalLine[]> {
  const rows = await tx.select().from(journalEntryLine).where(and(
    eq(journalEntryLine.client, client),
    eq(journalEntryLine.documentNumber, documentNumber),
    eq(journalEntryLine.fiscalYear, fiscalYear),
  ));
  return rows.sort((a, b) => a.lineNumber - b.lineNumber);
}

async function loadStandingLink(
  tx: Tx, client: string, companyCode: string, documentNumber: string, fiscalYear: number,
): Promise<ReversalLink | null> {
  const [row] = await tx.select().from(accountingReversalLink).where(and(
    eq(accountingReversalLink.client, client),
    eq(accountingReversalLink.originalCompanyCode, companyCode),
    eq(accountingReversalLink.originalDocumentNumber, documentNumber),
    eq(accountingReversalLink.originalFiscalYear, fiscalYear),
  ));
  return row ?? null;
}

async function loadClearsCount(tx: Tx, client: string, companyCode: string, documentNumber: string): Promise<number> {
  const rows = await tx.select({ n: sql<number>`count(*)::int` }).from(journalEntryLine).where(and(
    eq(journalEntryLine.client, client),
    eq(journalEntryLine.companyCode, companyCode),
    eq(journalEntryLine.clearingDocument, documentNumber),
  ));
  return rows[0]?.n ?? 0;
}

async function loadReasons(tx: Tx, client: string): Promise<ReversalReasonOption[]> {
  const rows = await tx.select().from(reversalReason).where(and(
    eq(reversalReason.client, client),
    eq(reversalReason.isActive, true),
  ));
  return rows
    .sort((a, b) => a.reasonCode.localeCompare(b.reasonCode))
    .map((r) => ({ code: r.reasonCode, description: r.reasonDescription }));
}

function eligibility(
  header: JournalHeader,
  lines: JournalLine[],
  clearsItemCount: number,
  standing: ReversalLink | null,
): { canReverse: boolean; refusal: string | null; remedy: string | null } {
  if (standing) {
    return {
      canReverse: false,
      refusal: `Document ${header.documentNumber} already stands reversed by ${standing.reversalDocumentNumber}.`,
      remedy: 'Exactly one reversal ever stands against an original; post a corrective entry instead.',
    };
  }
  if (header.status === 'REVERSED' || header.reversedBy) {
    return {
      canReverse: false,
      refusal: `Document ${header.documentNumber} already stands reversed by ${header.reversedBy ?? 'a standing reversal'}.`,
      remedy: 'Exactly one reversal ever stands against an original; post a corrective entry instead.',
    };
  }
  if (header.status !== 'POSTED') {
    return {
      canReverse: false,
      refusal: `Document ${header.documentNumber} does not stand posted; it stands ${header.status}.`,
      remedy: 'Only a posted accounting document can be reversed.',
    };
  }
  if (header.reversalOf) {
    return {
      canReverse: false,
      refusal: `Document ${header.documentNumber} is itself a reversal of ${header.reversalOf} and cannot be reversed.`,
      remedy: 'Reversal-of-reversal stands deferred; post a corrective entry instead.',
    };
  }
  const cleared = lines.find((l) => l.clearingDocument || l.clearingDate);
  if (cleared) {
    const by = cleared.clearingDocument ? ` by ${cleared.clearingDocument}` : '';
    const on = cleared.clearingDate ? ` on ${cleared.clearingDate}` : '';
    return {
      canReverse: false,
      refusal: `Document ${header.documentNumber} line ${cleared.lineNumber} stands cleared${by}${on}; it cannot be reversed while cleared.`,
      remedy: 'Reset the clearing first on Reset Cleared Items (FBRA), then reverse the document.',
    };
  }
  if (clearsItemCount > 0) {
    return {
      canReverse: false,
      refusal: `Document ${header.documentNumber} stands as the clearing document for ${clearsItemCount} item(s); it cannot be reversed while it clears them.`,
      remedy: 'Reset the clearing first on Reset Cleared Items (FBRA), then reverse the document.',
    };
  }
  return { canReverse: true, refusal: null, remedy: null };
}

function toStandingView(link: ReversalLink): StandingReversalView {
  return {
    reversalDocumentNumber: link.reversalDocumentNumber,
    reversalFiscalYear: link.reversalFiscalYear,
    reversalDocumentDate: link.reversalDocumentDate,
    reversalPostingDate: link.reversalPostingDate,
    reversalPostingPeriod: link.reversalPostingPeriod,
    reasonCode: link.reversalReason,
    reversedBy: link.reversedBy,
  };
}

function toResult(link: ReversalLink): DocumentReversalResult {
  return {
    companyCode: link.originalCompanyCode,
    originalDocumentNumber: link.originalDocumentNumber,
    originalFiscalYear: link.originalFiscalYear,
    reversalDocumentNumber: link.reversalDocumentNumber,
    reversalFiscalYear: link.reversalFiscalYear,
    reversalDocumentType: REVERSAL_DOCUMENT_TYPE,
    reversalDocumentDate: link.reversalDocumentDate,
    reversalPostingDate: link.reversalPostingDate,
    reversalPostingPeriod: link.reversalPostingPeriod,
    reasonCode: link.reversalReason,
    reversalAmountLocal: link.reversalAmountLocal,
    currency: link.reversalCurrency ?? '',
  };
}

export async function getDocumentForReversal(client: string, input: {
  companyCode: string;
  documentNumber: string;
  fiscalYear: number;
  reversalPostingDate?: string;
}): Promise<ReversalDocumentView> {
  if (input.reversalPostingDate) assertCalendarDate('Reversal posting date', input.reversalPostingDate);
  return withTenant(client, async (tx) => {
    const header = await loadHeader(tx, client, input.documentNumber, input.fiscalYear);
    if (!header || header.companyCode !== input.companyCode) {
      throw new DocumentReversalError(
        `Document ${input.documentNumber} does not stand in company ${input.companyCode} for ${input.fiscalYear}.`,
        'Name the company code, document number and fiscal year exactly as they stand on the journal.',
      );
    }
    const [lines, clearsItemCount, standing, reasons] = await Promise.all([
      loadLines(tx, client, input.documentNumber, input.fiscalYear),
      loadClearsCount(tx, client, input.companyCode, input.documentNumber),
      loadStandingLink(tx, client, input.companyCode, input.documentNumber, input.fiscalYear),
      loadReasons(tx, client),
    ]);
    const gate = eligibility(header, lines, clearsItemCount, standing);

    let reversalFiscalYear: number | null = null;
    let reversalPostingPeriod: number | null = null;
    let reversalPeriodError: string | null = null;
    if (input.reversalPostingDate) {
      const company = await getCompanyCode(tx, client, input.companyCode);
      if (!company?.fiscalYearVariant) {
        reversalPeriodError = `Company code ${input.companyCode} is not configured with a fiscal-year variant.`;
      } else {
        try {
          const position = await derivePosition(tx, client, company.fiscalYearVariant, input.reversalPostingDate);
          reversalFiscalYear = position.fiscalYear;
          reversalPostingPeriod = position.period;
        } catch (e) {
          reversalPeriodError = e instanceof Error ? e.message : 'The reversal period could not be derived.';
        }
      }
    }

    const docTotals = totals(lines, 'amountDocument');
    const localTotals = totals(lines, 'amountLocal');
    return {
      companyCode: input.companyCode,
      documentNumber: input.documentNumber,
      fiscalYear: input.fiscalYear,
      documentType: header.documentType,
      documentDate: header.documentDate,
      postingDate: header.postingDate,
      postingPeriod: header.postingPeriod,
      documentCurrency: header.documentCurrency,
      localCurrency: header.localCurrency,
      exchangeRate: header.exchangeRate,
      reference: header.reference,
      headerText: header.headerText,
      status: header.status,
      reversalOf: header.reversalOf,
      reversedBy: header.reversedBy,
      reversalReason: header.reversalReason,
      lines: lines.map((l) => ({
        lineNumber: l.lineNumber,
        glAccount: l.glAccount,
        debitCredit: l.debitCredit,
        amountDocument: l.amountDocument,
        amountLocal: l.amountLocal,
        currency: l.currency,
        businessPartner: l.businessPartner,
        costCenter: l.costCenter,
        profitCenter: l.profitCenter,
        taxCode: l.taxCode,
        lineText: l.lineText,
        clearingDocument: l.clearingDocument,
        clearingDate: l.clearingDate,
      })),
      debitTotalDocument: docTotals.debit,
      creditTotalDocument: docTotals.credit,
      debitTotalLocal: localTotals.debit,
      creditTotalLocal: localTotals.credit,
      clearedLineCount: lines.filter((l) => l.clearingDocument || l.clearingDate).length,
      clearsItemCount,
      standingReversal: standing ? toStandingView(standing) : null,
      reasons,
      canReverse: gate.canReverse,
      refusal: gate.refusal,
      refusalRemedy: gate.remedy,
      reversalFiscalYear,
      reversalPostingPeriod,
      reversalPeriodError,
    };
  });
}

export async function reverseDocument(input: {
  client: string;
  changedBy: string;
  companyCode: string;
  documentNumber: string;
  fiscalYear: number;
  reasonCode: string;
  documentDate: string;
  postingDate: string;
  confirmed: boolean;
  requestKey?: string;
}): Promise<DocumentReversalResult> {
  if (!input.confirmed) {
    throw new DocumentReversalError(
      'The reversal stands unconfirmed.',
      'Confirm the reversal explicitly before it can post.',
    );
  }
  const reasonCode = input.reasonCode?.trim().toUpperCase() ?? '';
  if (reasonCode.length !== 2) {
    throw new DocumentReversalError(
      'A two-character reversal reason stands required.',
      'Choose one of the standing active reversal reasons.',
    );
  }
  assertCalendarDate('Reversal document date', input.documentDate);
  assertCalendarDate('Reversal posting date', input.postingDate);

  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/docrev/${input.companyCode}/${input.documentNumber}/${input.fiscalYear}`}, 0))`);

    if (input.requestKey) {
      const [replay] = await tx.select().from(accountingReversalLink).where(and(
        eq(accountingReversalLink.client, input.client),
        eq(accountingReversalLink.requestKey, input.requestKey),
      ));
      if (replay) {
        if (
          replay.originalCompanyCode !== input.companyCode
          || replay.originalDocumentNumber !== input.documentNumber
          || replay.originalFiscalYear !== input.fiscalYear
        ) {
          throw new DocumentReversalError('The request key already stands against another document reversal.');
        }
        return toResult(replay);
      }
    }

    const standing = await loadStandingLink(tx, input.client, input.companyCode, input.documentNumber, input.fiscalYear);
    if (standing) {
      throw new DocumentReversalError(
        `Document ${input.documentNumber} already stands reversed by ${standing.reversalDocumentNumber}.`,
        'Exactly one reversal ever stands against an original; post a corrective entry instead.',
      );
    }

    const header = await loadHeader(tx, input.client, input.documentNumber, input.fiscalYear);
    if (!header || header.companyCode !== input.companyCode) {
      throw new DocumentReversalError(
        `Document ${input.documentNumber} does not stand in company ${input.companyCode} for ${input.fiscalYear}.`,
        'Name the company code, document number and fiscal year exactly as they stand on the journal.',
      );
    }
    if (header.originClass === 'asset_acquisition') {
      throw new DocumentReversalError(
        `Document ${input.documentNumber} is an asset acquisition; reversing it here would orphan its asset values.`,
        'Reverse it from Asset Acquisition, where the asset transaction is reversed with its journal.',
      );
    }
    if (header.originClass === 'asset_retirement') {
      throw new DocumentReversalError(
        `Document ${input.documentNumber} is an asset retirement; reversing it here would orphan its asset values.`,
        'Reverse it from Asset Retirement, where the retirement record and asset eligibility are restored with its journal.',
      );
    }
    const lines = await loadLines(tx, input.client, input.documentNumber, input.fiscalYear);
    const clearsItemCount = await loadClearsCount(tx, input.client, input.companyCode, input.documentNumber);
    const gate = eligibility(header, lines, clearsItemCount, standing);
    if (!gate.canReverse) throw new DocumentReversalError(gate.refusal!, gate.remedy ?? undefined);

    const [reason] = await tx.select().from(reversalReason).where(and(
      eq(reversalReason.client, input.client),
      eq(reversalReason.reasonCode, reasonCode),
    ));
    if (!reason) {
      throw new DocumentReversalError(
        `Reversal reason ${reasonCode} does not stand configured for this tenant.`,
        'Choose one of the standing active reversal reasons.',
      );
    }
    if (!reason.isActive) {
      throw new DocumentReversalError(
        `Reversal reason ${reasonCode} stands inactive.`,
        'Choose one of the standing active reversal reasons.',
      );
    }

    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) {
      throw new DocumentReversalError(`Company code ${input.companyCode} is not configured with a fiscal-year variant.`);
    }
    let position;
    try {
      position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    } catch (e) {
      if (e instanceof PeriodError) throw new DocumentReversalError(e.message, e.remedy);
      throw e;
    }

    let reversal;
    try {
      reversal = await reverseJournalEntry(tx, {
        client: input.client,
        documentNumber: input.documentNumber,
        fiscalYear: input.fiscalYear,
        reversalDate: input.postingDate,
        reversalDocumentDate: input.documentDate,
        reversalDocumentType: REVERSAL_DOCUMENT_TYPE,
        reason: reasonCode,
        reversedBy: input.changedBy,
        transactionCode: DOCUMENT_REVERSE_CAPABILITY,
      });
    } catch (e) {
      if (e instanceof PostingError || e instanceof PeriodError) {
        throw new DocumentReversalError(e.message, e.remedy);
      }
      throw e;
    }

    const localTotals = totals(lines, 'amountLocal');
    const [link] = await tx.insert(accountingReversalLink).values({
      client: input.client,
      originalCompanyCode: input.companyCode,
      originalDocumentNumber: input.documentNumber,
      originalFiscalYear: input.fiscalYear,
      reversalCompanyCode: input.companyCode,
      reversalDocumentNumber: reversal.documentNumber,
      reversalFiscalYear: reversal.fiscalYear,
      reversalReason: reasonCode,
      reversalDocumentDate: input.documentDate,
      reversalPostingPeriod: position.period,
      reversalPostingDate: input.postingDate,
      reversalCurrency: header.documentCurrency,
      reversedBy: input.changedBy,
      reversalAmountLocal: localTotals.debit,
      requestKey: input.requestKey ?? null,
      createdBy: input.changedBy,
      changedBy: input.changedBy,
    }).returning();

    await recordChange(tx, {
      client: input.client,
      objectClass: REVERSAL_CLASS,
      objectKey: `${input.companyCode}/${input.documentNumber}/${input.fiscalYear}`,
      changeType: 'REVERSE',
      changedBy: input.changedBy,
      transactionCode: DOCUMENT_REVERSE_CAPABILITY,
      reason: reasonCode,
      before: { status: header.status, reversedBy: null },
      after: {
        status: 'REVERSED',
        reversalDocumentNumber: reversal.documentNumber,
        reversalFiscalYear: reversal.fiscalYear,
        reversalPostingPeriod: position.period,
        reasonCode,
      },
    });

    return toResult(link);
  });
}
