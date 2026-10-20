/**
 * Clear G/L account — manual clearing (SCR-114 / FIN.GL.CLEAR;
 * F-03 search alias).
 *
 * Open items of an open-item-managed G/L account clear against
 * each other when their signed sum stands at zero. Following
 * the FIN.AR.CLEAR house pattern: one clearing journal posted
 * through the standing posting engine carries the audit trail;
 * the cleared lines are stamped in place with the clearing
 * document and clearing date. A posted clearing is history —
 * reset rides the standing FBRA workflow, never an edit.
 *
 * The account must stand extended to the company and stand
 * open-item managed, judged segment-first with the chart flag
 * as fallback (SCR-110 settlement). The clearing document
 * type is operator-selected and validated against configured
 * document types — never a universal hardcoded type.
 * A difference within the default tolerance group's limits
 * (SCR-114 follow-up, OBA4 canon) posts as one PAYMENT_DIFFERENCE
 * line of the clearing journal; beyond tolerance it refuses by
 * name — a difference is never silently discarded. Partial and
 * residual clearing remain deferred by name.
 *
 * Stage 1 carries the vocabulary only; the schema/index
 * check lands in stage 2 and the clearing service in stage 3.
 */
export const GL_CLEARING_CAPABILITY = 'FIN.GL.CLEAR';

export class GlClearingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'GlClearingError';
    this.remedy = remedy;
  }
}

export interface GlClearingItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  documentType: string;
  assignment: string;
  reference: string;
  debitCredit: string;
  currency: string;
  amount: string;
  /** Local-currency amount signed by debit/credit (debit positive). */
  signed: number;
  clearingDocument: string | null;
  clearingDate: string | null;
}

export interface GlClearingView {
  companyCode: string;
  glAccount: string;
  accountCurrency: string;
  openItems: GlClearingItem[];
  clearedItems: GlClearingItem[];
  openBalance: number;
  /** The default tolerance group's payment-difference limits, when one stands. */
  differenceTolerance: {
    revenueAmount: number; revenuePercent: number;
    expenseAmount: number; expensePercent: number;
  } | null;
}

export interface GlClearingFilters {
  documentNumber?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  assignment?: string;
  reference?: string;
}

import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { changeDocument, changeDocumentItem } from '../../platform/tables/audit-trail';
import { accountDetermination, documentType, employeeToleranceGroup } from '../foundation/schema';
import { glAccount, glAccountCompany, journalEntry, journalEntryLine } from './schema';

const CLEARING_CLASS = 'gl_clearing';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The default tolerance group of the company scope, else the tenant-wide default. */
async function defaultTolerance(tx: Tx, client: string, companyCode: string) {
  const groups = await tx.select().from(employeeToleranceGroup)
    .where(eq(employeeToleranceGroup.client, client));
  return groups.find((g) => g.companyCode === companyCode && g.groupKey === '')
    ?? groups.find((g) => g.companyCode === '' && g.groupKey === '')
    ?? null;
}

/** Determination by event and modifier, falling back to the unmodified row. */
async function determinationAccount(
  tx: Tx, client: string, chart: string, event: string, modifier = '',
): Promise<string | null> {
  const pick = async (mod: string) => {
    const rows = await tx.select().from(accountDetermination).where(and(
      eq(accountDetermination.client, client),
      eq(accountDetermination.chartOfAccounts, chart),
      eq(accountDetermination.event, event),
      eq(accountDetermination.generalModifier, mod),
    ));
    return rows[0]?.glAccount ?? null;
  };
  return (modifier ? await pick(modifier) : null) ?? (await pick(''));
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

interface JudgedAccount { accountCurrency: string }

async function judgeAccount(
  tx: Tx, client: string, companyCode: string, account: string,
): Promise<JudgedAccount> {
  const company = await getCompanyCode(tx, client, companyCode);
  if (!company?.fiscalYearVariant) {
    throw new GlClearingError(`Company code ${companyCode} is not configured.`);
  }
  const [segment] = await tx.select().from(glAccountCompany).where(and(
    eq(glAccountCompany.client, client),
    eq(glAccountCompany.companyCode, companyCode),
    eq(glAccountCompany.glAccount, account),
  ));
  const [chart] = await tx.select().from(glAccount).where(and(
    eq(glAccount.client, client),
    eq(glAccount.chartOfAccounts, company.chartOfAccounts ?? ''),
    eq(glAccount.accountNumber, account),
  ));
  if (!segment && !chart) {
    throw new GlClearingError(
      `G/L account ${account} does not stand extended to company ${companyCode}.`,
      'Extend the account to the company code, then load the open items.',
    );
  }
  // Segment-first (SCR-110): a standing segment governs; the chart flag is the fallback.
  const openItemManaged = segment ? segment.isOpenItemManaged : chart!.isOpenItemManaged;
  if (!openItemManaged) {
    throw new GlClearingError(
      `G/L account ${account} in company ${companyCode} does not stand open-item managed.`,
      'Open-item clearing needs an open-item-managed account; choose such an account.',
    );
  }
  return { accountCurrency: segment?.accountCurrency ?? company.currency };
}

async function loadItems(
  tx: Tx, client: string, companyCode: string, account: string,
  cleared: boolean, filters?: GlClearingFilters,
): Promise<GlClearingItem[]> {
  const rows = await tx.select({
    documentNumber: journalEntryLine.documentNumber,
    fiscalYear: journalEntryLine.fiscalYear,
    lineNumber: journalEntryLine.lineNumber,
    postingDate: journalEntry.postingDate,
    documentType: journalEntry.documentType,
    assignment: journalEntryLine.assignment,
    reference: journalEntry.reference,
    debitCredit: journalEntryLine.debitCredit,
    currency: journalEntryLine.currency,
    amount: journalEntryLine.amountLocal,
    clearingDocument: journalEntryLine.clearingDocument,
    clearingDate: journalEntryLine.clearingDate,
  }).from(journalEntryLine)
    .innerJoin(journalEntry, and(
      eq(journalEntry.client, journalEntryLine.client),
      eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
      eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
    ))
    .where(and(
      eq(journalEntryLine.client, client),
      eq(journalEntryLine.companyCode, companyCode),
      eq(journalEntryLine.glAccount, account),
      eq(journalEntry.status, 'POSTED'),
      cleared
        ? sql`${journalEntryLine.clearingDocument} is not null`
        : sql`${journalEntryLine.clearingDocument} is null`,
      filters?.documentNumber ? eq(journalEntryLine.documentNumber, filters.documentNumber) : undefined,
      filters?.assignment ? eq(journalEntryLine.assignment, filters.assignment) : undefined,
      filters?.reference ? eq(journalEntry.reference, filters.reference) : undefined,
      filters?.postingDateFrom ? sql`${journalEntry.postingDate} >= ${filters.postingDateFrom}` : undefined,
      filters?.postingDateTo ? sql`${journalEntry.postingDate} <= ${filters.postingDateTo}` : undefined,
    ))
    .orderBy(journalEntry.postingDate, journalEntryLine.documentNumber, journalEntryLine.lineNumber);
  return rows.map((r) => ({
    documentNumber: r.documentNumber, fiscalYear: r.fiscalYear, lineNumber: r.lineNumber,
    postingDate: r.postingDate, documentType: r.documentType,
    assignment: r.assignment ?? '', reference: r.reference ?? '',
    debitCredit: r.debitCredit, currency: r.currency, amount: r.amount,
    signed: r.debitCredit === 'S' ? Number(r.amount) : -Number(r.amount),
    clearingDocument: r.clearingDocument, clearingDate: r.clearingDate,
  }));
}

async function loadView(
  tx: Tx, client: string, companyCode: string, account: string,
  judged: JudgedAccount, filters?: GlClearingFilters,
): Promise<GlClearingView> {
  const openItems = await loadItems(tx, client, companyCode, account, false, filters);
  const clearedItems = await loadItems(tx, client, companyCode, account, true, filters);
  const tolerance = await defaultTolerance(tx, client, companyCode);
  return {
    companyCode, glAccount: account, accountCurrency: judged.accountCurrency,
    openItems, clearedItems,
    openBalance: round4(openItems.reduce((s, i) => s + i.signed, 0)),
    differenceTolerance: tolerance ? {
      revenueAmount: Number(tolerance.paymentDiffRevenueAmount),
      revenuePercent: Number(tolerance.paymentDiffRevenuePercent),
      expenseAmount: Number(tolerance.paymentDiffExpenseAmount),
      expensePercent: Number(tolerance.paymentDiffExpensePercent),
    } : null,
  };
}

export async function getGlClearing(input: {
  client: string; companyCode: string; glAccount: string; filters?: GlClearingFilters;
}): Promise<GlClearingView> {
  return withTenant(input.client, async (tx) => {
    const judged = await judgeAccount(tx, input.client, input.companyCode, input.glAccount);
    return loadView(tx, input.client, input.companyCode, input.glAccount, judged, input.filters);
  });
}

export interface GlClearingItemRef {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
}

async function standingClearingForRequestKey(
  tx: Tx, client: string, requestKey: string,
): Promise<string | null> {
  const [row] = await tx.select({ id: changeDocument.id })
    .from(changeDocument)
    .innerJoin(changeDocumentItem, and(
      eq(changeDocumentItem.client, changeDocument.client),
      eq(changeDocumentItem.changeDocumentId, changeDocument.id),
    ))
    .where(and(
      eq(changeDocument.client, client),
      eq(changeDocument.objectClass, CLEARING_CLASS),
      eq(changeDocumentItem.fieldName, 'requestKey'),
      eq(changeDocumentItem.newValue, requestKey),
    ));
  if (!row) return null;
  const [doc] = await tx.select({ newValue: changeDocumentItem.newValue })
    .from(changeDocumentItem)
    .where(and(
      eq(changeDocumentItem.client, client),
      eq(changeDocumentItem.changeDocumentId, row.id),
      eq(changeDocumentItem.fieldName, 'clearingDocument'),
    ));
  return doc?.newValue ?? null;
}

export async function clearGlItems(input: {
  client: string; changedBy: string;
  companyCode: string; glAccount: string; documentType: string;
  clearingDate: string; postingDate: string; documentDate: string;
  confirmed: boolean; requestKey: string;
  items: GlClearingItemRef[];
}): Promise<GlClearingView & { clearingDocumentNumber: string; clearingFiscalYear: number }> {
  if (!input.confirmed) {
    throw new GlClearingError('The clearing stands unconfirmed.', 'Tick the confirmation, then post the clearing.');
  }
  if (input.items.length === 0) {
    throw new GlClearingError('Select at least one open item to clear.', 'Tick the items that settle each other.');
  }
  for (const [label, value] of [['Clearing date', input.clearingDate], ['Posting date', input.postingDate], ['Document date', input.documentDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new GlClearingError(`${label} ${value} is not a calendar date.`);
  }
  if (!/^[A-Z0-9]{2}$/.test(input.documentType)) {
    throw new GlClearingError(`Document type ${input.documentType} is not a two-character document type.`, 'Choose a configured document type.');
  }
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/glclear/${input.companyCode}/${input.glAccount}`}, 0))`);
    const judged = await judgeAccount(tx, input.client, input.companyCode, input.glAccount);
    const replay = input.requestKey
      ? await standingClearingForRequestKey(tx, input.client, input.requestKey)
      : null;
    if (replay) {
      const view = await loadView(tx, input.client, input.companyCode, input.glAccount, judged);
      const [yearRow] = await tx.select({ fiscalYear: journalEntry.fiscalYear }).from(journalEntry).where(and(
        eq(journalEntry.client, input.client), eq(journalEntry.documentNumber, replay),
      ));
      return { ...view, clearingDocumentNumber: replay, clearingFiscalYear: yearRow?.fiscalYear ?? 0 };
    }
    const [typeRow] = await tx.select().from(documentType).where(and(
      eq(documentType.client, input.client),
      eq(documentType.documentType, input.documentType),
    ));
    if (!typeRow) {
      throw new GlClearingError(`Document type ${input.documentType} is not configured.`, 'Choose a configured document type (OBA7).');
    }
    const company = await getCompanyCode(tx, input.client, input.companyCode);

    interface Held { ref: GlClearingItemRef; currency: string; amount: string; signed: number }
    const held: Held[] = [];
    for (const ref of input.items) {
      // Row lock: a competing clearing that already took the item is refused here.
      const rows = await tx.execute(sql`
        select l.document_number, l.fiscal_year, l.line_number, l.company_code, l.gl_account,
               l.currency, l.amount_local::text as amount_local, l.debit_credit,
               l.clearing_document, e.status as header_status
        from journal_entry_line l
        join journal_entry e
          on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
        where l.client = ${input.client}
          and l.document_number = ${ref.documentNumber}
          and l.fiscal_year = ${ref.fiscalYear}
          and l.line_number = ${ref.lineNumber}
        for update of l
      `) as unknown as Array<{
        company_code: string; gl_account: string; currency: string;
        amount_local: string; debit_credit: string;
        clearing_document: string | null; header_status: string;
      }>;
      const line = rows[0];
      if (!line || line.company_code !== input.companyCode || line.gl_account !== input.glAccount) {
        throw new GlClearingError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} is not an open item of account ${input.glAccount} in company ${input.companyCode}.`,
          'Reload the open items, then clear.',
        );
      }
      if (line.header_status !== 'POSTED') {
        throw new GlClearingError(`Document ${ref.documentNumber} does not stand posted.`, 'Reload the open items, then clear.');
      }
      if (line.clearing_document) {
        throw new GlClearingError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} already stands cleared by ${line.clearing_document}.`,
          'Reload the open items, then clear.',
        );
      }
      held.push({
        ref, currency: line.currency, amount: line.amount_local,
        signed: line.debit_credit === 'S' ? Number(line.amount_local) : -Number(line.amount_local),
      });
    }

    const currencies = [...new Set(held.map((h) => h.currency))];
    if (currencies.length > 1) {
      throw new GlClearingError(
        `The selected items stand in ${currencies.join(' and ')}; one clearing settles one currency.`,
        'Select items in a single currency.',
      );
    }
    const difference = round4(held.reduce((s, h) => s + h.signed, 0));
    let differenceLine: { glAccount: string; debitCredit: 'S' | 'H'; amount: number } | null = null;
    if (difference !== 0) {
      // A debit difference judges on the expense limits, a credit on the
      // revenue limits; both the absolute and the percentage limit must
      // hold (the smaller binds), exactly as the payment screens judge.
      const expense = difference > 0;
      const fail = (remedy: string) => new GlClearingError(
        `The selected items do not balance: the difference stands at ${Math.abs(difference).toFixed(2)} ${currencies[0]}.`,
        remedy,
      );
      const tolerance = await defaultTolerance(tx, input.client, input.companyCode);
      if (!tolerance) {
        throw fail('Select items whose signed sum stands at zero, or maintain the default tolerance group so a difference within tolerance can post.');
      }
      const amountLimit = Number(expense ? tolerance.paymentDiffExpenseAmount : tolerance.paymentDiffRevenueAmount);
      const percentLimit = Number(expense ? tolerance.paymentDiffExpensePercent : tolerance.paymentDiffRevenuePercent);
      const gross = round4(held.reduce((s, h) => s + Math.abs(h.signed), 0));
      const percentAmount = round2(gross * percentLimit / 100);
      if (Math.abs(difference) - Math.min(amountLimit, percentAmount) > 0.005) {
        throw fail(`The difference stands beyond the tolerance of the default group (at most ${Math.min(amountLimit, percentAmount).toFixed(2)} ${currencies[0]} on this selection). Select items whose signed sum stands at zero, or widen the tolerance group.`);
      }
      const chart = company!.chartOfAccounts ?? '';
      const account = await determinationAccount(tx, input.client, chart, 'PAYMENT_DIFFERENCE', expense ? 'EXP' : 'REV');
      if (!account) {
        throw new GlClearingError(
          `Account determination for PAYMENT_DIFFERENCE does not stand in chart ${chart}.`,
          'Maintain the account determination for the payment difference event, then post again.',
        );
      }
      differenceLine = { glAccount: account, debitCredit: expense ? 'S' : 'H', amount: Math.abs(difference) };
    }

    const position = await derivePosition(tx, input.client, company!.fiscalYearVariant!, input.postingDate);
    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: input.companyCode,
      documentType: input.documentType,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: currencies[0]!,
      localCurrency: company!.currency,
      reference: input.glAccount,
      headerText: `G/L clearing ${input.glAccount}`,
      lines: [
        ...held.map((h) => ({
          glAccount: input.glAccount,
          debitCredit: h.signed > 0 ? 'H' as const : 'S' as const,
          amount: Number(h.amount).toFixed(2),
        })),
        ...(differenceLine ? [{
          glAccount: differenceLine.glAccount,
          debitCredit: differenceLine.debitCredit,
          amount: differenceLine.amount.toFixed(2),
        }] : []),
      ],
      origin: { documentClass: CLEARING_CLASS, documentKey: `${input.companyCode}/${input.glAccount}` },
      postedBy: input.changedBy,
      transactionCode: GL_CLEARING_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new GlClearingError(error.message, error.remedy);
      throw error;
    });

    for (const h of held) {
      await tx.update(journalEntryLine).set({
        clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
      }).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, h.ref.documentNumber),
        eq(journalEntryLine.fiscalYear, h.ref.fiscalYear),
        eq(journalEntryLine.lineNumber, h.ref.lineNumber),
      ));
    }
    await tx.update(journalEntryLine).set({
      clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
    }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, journal.documentNumber),
      eq(journalEntryLine.fiscalYear, journal.fiscalYear),
      eq(journalEntryLine.glAccount, input.glAccount),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: CLEARING_CLASS,
      objectKey: `${input.companyCode}/${input.glAccount}/${journal.documentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: GL_CLEARING_CAPABILITY,
      after: {
        clearingDocument: journal.documentNumber, items: held.length,
        clearingDate: input.clearingDate, requestKey: input.requestKey,
        documentType: input.documentType, glAccount: input.glAccount,
        companyCode: input.companyCode,
        ...(differenceLine ? {
          difference: differenceLine.amount.toFixed(2),
          differenceAccount: differenceLine.glAccount,
        } : {}),
      },
    });

    const view = await loadView(tx, input.client, input.companyCode, input.glAccount, judged);
    return { ...view, clearingDocumentNumber: journal.documentNumber, clearingFiscalYear: journal.fiscalYear };
  });
}
