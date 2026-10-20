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
 * name — a difference is never silently discarded.
 * Partial/residual clearing remains deferred by name.
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
  /** The item's original amount (local currency). */
  amount: string;
  /** Amount already applied by active allocations, in the item's currency. */
  applied: number;
  /** Remaining open amount (local currency, positive). */
  remaining: number;
  /** Remaining amount signed by debit/credit (debit positive). */
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
import { accountDetermination, documentType, employeeToleranceGroup, exchangeRate } from '../foundation/schema';
import {
  glAccount, glAccountCompany, glClearingAllocation, glClearingResidual,
  journalEntry, journalEntryLine, residualReason,
} from './schema';

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
    amountDocument: journalEntryLine.amountDocument,
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
  const appliedRows = await tx.execute(sql`
    select source_document, source_fiscal_year, source_line_number,
           coalesce(sum(allocated_amount), 0)::text as applied
    from gl_clearing_allocation
    where client = ${client} and company_code = ${companyCode}
      and gl_account = ${account} and is_active
    group by source_document, source_fiscal_year, source_line_number
  `) as unknown as Array<{
    source_document: string; source_fiscal_year: number; source_line_number: number; applied: string;
  }>;
  const appliedBy = new Map(appliedRows.map((r) =>
    [`${r.source_document}|${r.source_fiscal_year}|${r.source_line_number}`, Number(r.applied)]));
  return rows.map((r) => {
    const applied = appliedBy.get(`${r.documentNumber}|${r.fiscalYear}|${r.lineNumber}`) ?? 0;
    const amountDocument = Number(r.amountDocument);
    const amountLocal = Number(r.amount);
    const remainingDocument = Math.max(0, round4(amountDocument - applied));
    // Carrying value carves proportionally: an item settled in full leaves nothing.
    const remaining = amountDocument === 0 ? 0 : round4(amountLocal * remainingDocument / amountDocument);
    return {
      documentNumber: r.documentNumber, fiscalYear: r.fiscalYear, lineNumber: r.lineNumber,
      postingDate: r.postingDate, documentType: r.documentType,
      assignment: r.assignment ?? '', reference: r.reference ?? '',
      debitCredit: r.debitCredit, currency: r.currency, amount: r.amount,
      applied, remaining, signed: r.debitCredit === 'S' ? remaining : -remaining,
      clearingDocument: r.clearingDocument, clearingDate: r.clearingDate,
    };
  });
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
  /** Amount to apply in the item's currency; omitted applies the full remaining balance. */
  settlementAmount?: string;
}

export type GlClearingMethod = 'STANDARD' | 'PARTIAL' | 'RESIDUAL';

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

/** Latest AVERAGE rate from a currency to the company's local currency on or before a date. */
async function rateToLocal(
  tx: Tx, client: string, currency: string, localCurrency: string, onDate: string,
): Promise<number | null> {
  if (currency === localCurrency) return 1;
  const [row] = await tx.select().from(exchangeRate).where(and(
    eq(exchangeRate.client, client),
    eq(exchangeRate.rateType, 'AVERAGE'),
    eq(exchangeRate.fromCurrency, currency),
    eq(exchangeRate.toCurrency, localCurrency),
  )).orderBy(sql`${exchangeRate.validFrom} desc`);
  if (!row || row.validFrom > onDate) return null;
  return Number(row.rate) * row.ratioTo / row.ratioFrom;
}

export async function clearGlItems(input: {
  client: string; changedBy: string;
  companyCode: string; glAccount: string; documentType: string;
  clearingDate: string; postingDate: string; documentDate: string;
  confirmed: boolean; requestKey: string;
  items: GlClearingItemRef[];
  /** STANDARD clears in full; PARTIAL leaves a short-settled item open; RESIDUAL re-stands its remainder as a new item. */
  method?: GlClearingMethod;
  /** Required when a residual item is generated; configured three-character key. */
  residualReasonCode?: string;
  /** Permit a selection spanning currencies, translated at the clearing date. */
  crossCurrency?: boolean;
}): Promise<GlClearingView & {
  clearingDocumentNumber: string;
  clearingFiscalYear: number;
  residualItems: Array<{ documentNumber: string; fiscalYear: number; lineNumber: number; amount: string; reasonCode: string }>;
}> {
  if (!input.confirmed) {
    throw new GlClearingError('The clearing stands unconfirmed.', 'Tick the confirmation, then post the clearing.');
  }
  if (input.items.length === 0) {
    throw new GlClearingError('Select at least one open item to clear.', 'Tick the items that settle each other.');
  }
  const method: GlClearingMethod = input.method ?? 'STANDARD';
  if (!['STANDARD', 'PARTIAL', 'RESIDUAL'].includes(method)) {
    throw new GlClearingError(`Clearing method ${method} is not one of STANDARD, PARTIAL or RESIDUAL.`, 'Choose the method, then post.');
  }
  if (method === 'RESIDUAL' && !input.residualReasonCode?.trim()) {
    throw new GlClearingError(
      'Residual clearing requires a residual reason code.',
      'Name the configured residual reason that justifies the new open item.',
    );
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
      return {
        ...view, clearingDocumentNumber: replay,
        clearingFiscalYear: yearRow?.fiscalYear ?? 0, residualItems: [],
      };
    }
    const [typeRow] = await tx.select().from(documentType).where(and(
      eq(documentType.client, input.client),
      eq(documentType.documentType, input.documentType),
    ));
    if (!typeRow) {
      throw new GlClearingError(`Document type ${input.documentType} is not configured.`, 'Choose a configured document type (OBA7).');
    }
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    const localCurrency = company!.currency;
    const chart = company!.chartOfAccounts ?? '';

    if (method === 'RESIDUAL') {
      const [reason] = await tx.select().from(residualReason).where(and(
        eq(residualReason.client, input.client),
        eq(residualReason.reasonCode, input.residualReasonCode!.trim()),
      ));
      if (!reason || !reason.isActive) {
        throw new GlClearingError(
          `Residual reason ${input.residualReasonCode} does not stand configured and active.`,
          'Maintain the residual reason master, then post.',
        );
      }
    }

    interface Held {
      ref: GlClearingItemRef;
      currency: string;
      debitCredit: string;
      businessPartner: string | null;
      amountDocument: number;
      amountLocal: number;
      /** Applied by standing allocations, in the item's currency. */
      priorApplied: number;
      /** The settlement this clearing applies, in the item's currency. */
      applied: number;
      /** Carrying value released by this clearing (local currency). */
      appliedLocal: number;
    }
    const held: Held[] = [];
    for (const ref of input.items) {
      // Row lock: a competing clearing that already took the item is refused here.
      const rows = await tx.execute(sql`
        select l.document_number, l.fiscal_year, l.line_number, l.company_code, l.gl_account,
               l.currency, l.amount_local::text as amount_local, l.amount_document::text as amount_document,
               l.debit_credit, l.business_partner, l.clearing_document, e.status as header_status,
               coalesce((select sum(a.allocated_amount) from gl_clearing_allocation a
                 where a.client = l.client and a.company_code = l.company_code and a.gl_account = l.gl_account
                   and a.source_document = l.document_number and a.source_fiscal_year = l.fiscal_year
                   and a.source_line_number = l.line_number and a.is_active), 0)::text as prior_applied
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
        amount_local: string; amount_document: string; debit_credit: string;
        business_partner: string | null;
        clearing_document: string | null; header_status: string; prior_applied: string;
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
      const amountDocument = Number(line.amount_document);
      const amountLocal = Number(line.amount_local);
      const priorApplied = Number(line.prior_applied);
      const remainingDocument = round4(amountDocument - priorApplied);
      if (remainingDocument <= 0) {
        throw new GlClearingError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} stands settled in full by its allocations.`,
          'Reload the open items, then clear.',
        );
      }
      const applied = ref.settlementAmount === undefined || ref.settlementAmount === ''
        ? remainingDocument
        : Number(ref.settlementAmount);
      if (!Number.isFinite(applied) || applied <= 0) {
        throw new GlClearingError(
          `The settlement on document ${ref.documentNumber} must stand positive; ${ref.settlementAmount} does not.`,
          'Enter a settlement above zero, or leave it blank to settle the item in full.',
        );
      }
      if (applied - remainingDocument > 0.005) {
        throw new GlClearingError(
          `The settlement of ${applied.toFixed(2)} on document ${ref.documentNumber} exceeds its remaining ${remainingDocument.toFixed(2)}.`,
          'Settle no more than the item leaves open.',
        );
      }
      if (method === 'STANDARD' && remainingDocument - applied > 0.005) {
        throw new GlClearingError(
          `Standard clearing settles document ${ref.documentNumber} in full; ${applied.toFixed(2)} of ${remainingDocument.toFixed(2)} stands entered.`,
          'Choose partial clearing to leave a balance open, or residual clearing to re-stand it.',
        );
      }
      // Carrying value released proportionally, so the account reverses exactly.
      const appliedLocal = amountDocument === 0 ? 0 : round4(amountLocal * applied / amountDocument);
      held.push({
        ref, currency: line.currency, debitCredit: line.debit_credit,
        businessPartner: line.business_partner,
        amountDocument, amountLocal, priorApplied, applied, appliedLocal,
      });
    }

    const currencies = [...new Set(held.map((h) => h.currency))];
    const crossMode = currencies.length > 1;
    if (crossMode && !input.crossCurrency) {
      throw new GlClearingError(
        `The selected items stand in ${currencies.join(' and ')}; one clearing settles one currency unless cross-currency clearing is asked for.`,
        'Select items in a single currency, or tick cross-currency clearing.',
      );
    }
    if (crossMode && method !== 'STANDARD') {
      throw new GlClearingError(
        `Cross-currency clearing stands for standard clearing only; ${method} clearing stays within one currency.`,
        'Clear the items in full across currencies, or settle the balance in its own currency.',
      );
    }

    // ── Balance the settlements ───────────────────────────────────────────────
    // The settlements must offset. A remainder within an item is a residual
    // (RESIDUAL) or a balance that stays open (PARTIAL) — never an imbalance.
    const documentCurrency = crossMode ? localCurrency : currencies[0]!;
    const rates = new Map<string, number>();
    if (crossMode || documentCurrency !== localCurrency) {
      for (const currency of currencies) {
        const rate = await rateToLocal(tx, input.client, currency, localCurrency, input.clearingDate);
        if (rate === null) {
          throw new GlClearingError(
            `No AVERAGE rate stands from ${currency} to ${localCurrency} on or before ${input.clearingDate}.`,
            'Maintain the exchange rate (SCR-034), then clear.',
          );
        }
        rates.set(currency, rate);
      }
    }
    const localValue = (h: Held) => crossMode
      ? round4(h.applied * rates.get(h.currency)!)
      : h.appliedLocal;
    const signedLocal = held.reduce((s, h) => s + (h.debitCredit === 'S' ? localValue(h) : -localValue(h)), 0);
    const settleDifference = round4(signedLocal);

    let toleranceLine: { glAccount: string; debitCredit: 'S' | 'H'; amountLocal: number } | null = null;
    if (settleDifference !== 0) {
      if (crossMode) {
        throw new GlClearingError(
          `The settlements translate to ${Math.abs(settleDifference).toFixed(2)} ${localCurrency} apart at the clearing date.`,
          'Settle items whose translated values offset, then clear.',
        );
      }
      // A debit difference judges on the expense limits, a credit on the
      // revenue limits; both the absolute and the percentage limit must
      // hold (the smaller binds), exactly as the payment screens judge.
      const expense = settleDifference > 0;
      const fail = (remedy: string) => new GlClearingError(
        `The selected items do not balance: the difference stands at ${Math.abs(settleDifference).toFixed(2)} ${currencies[0]}.`,
        remedy,
      );
      const tolerance = await defaultTolerance(tx, input.client, input.companyCode);
      if (!tolerance) {
        throw fail('Select items whose settlements offset, or maintain the default tolerance group so a difference within tolerance can post.');
      }
      const amountLimit = Number(expense ? tolerance.paymentDiffExpenseAmount : tolerance.paymentDiffRevenueAmount);
      const percentLimit = Number(expense ? tolerance.paymentDiffExpensePercent : tolerance.paymentDiffRevenuePercent);
      const gross = round4(held.reduce((s, h) => s + Math.abs(localValue(h)), 0));
      const percentAmount = round2(gross * percentLimit / 100);
      if (Math.abs(settleDifference) - Math.min(amountLimit, percentAmount) > 0.005) {
        throw fail(`The difference stands beyond the tolerance of the default group (at most ${Math.min(amountLimit, percentAmount).toFixed(2)} ${documentCurrency} on this selection). Select items whose settlements offset, or widen the tolerance group.`);
      }
      const account = await determinationAccount(tx, input.client, chart, 'PAYMENT_DIFFERENCE', expense ? 'EXP' : 'REV');
      if (!account) {
        throw new GlClearingError(
          `Account determination for PAYMENT_DIFFERENCE does not stand in chart ${chart}.`,
          'Maintain the account determination for the payment difference event, then post again.',
        );
      }
      toleranceLine = { glAccount: account, debitCredit: expense ? 'S' : 'H', amountLocal: Math.abs(settleDifference) };
    }

    // ── Build the document ────────────────────────────────────────────────────
    interface DocLine { glAccount: string; debitCredit: 'S' | 'H'; amount: number; amountLocal: number; businessPartner?: string | null }
    const lines: DocLine[] = [];
    const residualDrafts: Array<{ held: Held; amount: number; amountLocal: number }> = [];
    const offsetLineNumbers = new Map<Held, number>();
    for (const h of held) {
      // Standard and residual clearings offset the item in full; partial clears
      // only what it settles. A debit item is credited, a credit item debited.
      const clearingAmount = method === 'PARTIAL' ? h.applied : round4(h.amountDocument - h.priorApplied);
      const clearingLocal = method === 'PARTIAL'
        ? h.appliedLocal
        : round4(h.amountLocal - (h.amountDocument === 0 ? 0 : round4(h.amountLocal * h.priorApplied / h.amountDocument)));
      const direction: 'S' | 'H' = h.debitCredit === 'S' ? 'H' : 'S';
      if (method === 'RESIDUAL' && clearingAmount - h.applied > 0.005) {
        residualDrafts.push({
          held: h,
          amount: round4(clearingAmount - h.applied),
          amountLocal: round4(clearingLocal - h.appliedLocal),
        });
      }
      lines.push({ glAccount: input.glAccount, debitCredit: direction, amount: clearingAmount, amountLocal: clearingLocal });
      offsetLineNumbers.set(h, lines.length);
    }
    if (method === 'RESIDUAL' && residualDrafts.length === 0) {
      throw new GlClearingError(
        'Residual clearing found no remainder to re-stand — every item settles in full.',
        'Settle an item below its remaining balance to generate a residual, or clear it as a standard clearing.',
      );
    }
    // A residual is a new open item: it carries the original item's side and partner.
    for (const draft of residualDrafts) {
      lines.push({
        glAccount: input.glAccount, debitCredit: draft.held.debitCredit as 'S' | 'H',
        amount: draft.amount, amountLocal: draft.amountLocal,
        businessPartner: draft.held.businessPartner,
      });
    }
    if (toleranceLine) {
      lines.push({
        glAccount: toleranceLine.glAccount, debitCredit: toleranceLine.debitCredit,
        amount: documentCurrency === localCurrency ? toleranceLine.amountLocal : round4(toleranceLine.amountLocal / (rates.get(documentCurrency) ?? 1)),
        amountLocal: toleranceLine.amountLocal,
      });
    }
    // Realized exchange difference: the carrying values released need not offset
    // when items were carried at different rates; the net posts to FXGAIN/FXLOSS.
    const carryingDifference = round4(lines.reduce(
      (s, l) => s + (l.debitCredit === 'S' ? l.amountLocal : -l.amountLocal), 0));
    let fxLine: { glAccount: string; debitCredit: 'S' | 'H'; amountLocal: number } | null = null;
    if (carryingDifference !== 0) {
      const gain = carryingDifference > 0; // credits exceed debits: settle above carrying
      const event = gain ? 'FXGAIN' : 'FXLOSS';
      const account = await determinationAccount(tx, input.client, chart, event);
      if (!account) {
        throw new GlClearingError(
          `Account determination for ${event} does not stand in chart ${chart}.`,
          `Maintain the account determination for the ${gain ? 'exchange gain' : 'exchange loss'} event, then post again.`,
        );
      }
      fxLine = {
        glAccount: account, debitCredit: gain ? 'H' : 'S',
        amountLocal: Math.abs(carryingDifference),
      };
      lines.push({
        glAccount: account, debitCredit: fxLine.debitCredit,
        amount: documentCurrency === localCurrency ? fxLine.amountLocal : round4(fxLine.amountLocal / (rates.get(documentCurrency) ?? 1)),
        amountLocal: fxLine.amountLocal,
      });
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
      currency: documentCurrency,
      localCurrency,
      exchangeRate: documentCurrency === localCurrency ? '1' : String(rates.get(documentCurrency)),
      reference: input.glAccount,
      headerText: `${method === 'STANDARD' ? 'G/L clearing' : method === 'PARTIAL' ? 'G/L partial clearing' : 'G/L residual clearing'} ${input.glAccount}`,
      lines: lines.map((l) => ({
        glAccount: l.glAccount,
        debitCredit: l.debitCredit,
        amount: Math.abs(l.amount).toFixed(2),
        amountLocal: Math.abs(l.amountLocal).toFixed(2),
        ...(l.businessPartner ? { businessPartner: l.businessPartner } : {}),
      })),
      origin: { documentClass: CLEARING_CLASS, documentKey: `${input.companyCode}/${input.glAccount}` },
      postedBy: input.changedBy,
      transactionCode: GL_CLEARING_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new GlClearingError(error.message, error.remedy);
      throw error;
    });

    // Stamp the offsets of the items this clearing closes in full; a partially
    // settled item stays open, and a residual line is a new open item.
    const closed = held.filter((h) =>
      method !== 'PARTIAL' || h.applied - (h.amountDocument - h.priorApplied) > -0.005);
    for (const h of closed) {
      await tx.update(journalEntryLine).set({
        clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
      }).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, h.ref.documentNumber),
        eq(journalEntryLine.fiscalYear, h.ref.fiscalYear),
        eq(journalEntryLine.lineNumber, h.ref.lineNumber),
      ));
    }
    const offsetNumbers = [...held.map((h) => offsetLineNumbers.get(h)!)];
    await tx.update(journalEntryLine).set({
      clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
    }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, journal.documentNumber),
      eq(journalEntryLine.fiscalYear, journal.fiscalYear),
      sql`${journalEntryLine.lineNumber} in (${sql.join(offsetNumbers.map((n) => sql`${n}`), sql`, `)})`,
    ));

    // Normalized allocations: one row per offset line × source line.
    for (const h of held) {
      await tx.insert(glClearingAllocation).values({
        client: input.client, companyCode: input.companyCode, glAccount: input.glAccount,
        clearingDocument: journal.documentNumber, clearingFiscalYear: journal.fiscalYear,
        clearingLineNumber: offsetLineNumbers.get(h)!,
        sourceDocument: h.ref.documentNumber, sourceFiscalYear: h.ref.fiscalYear,
        sourceLineNumber: h.ref.lineNumber,
        allocatedAmount: h.applied.toFixed(4), currency: h.currency,
        clearingMethod: method, createdBy: input.changedBy,
      });
    }

    // Residual lineage: each generated residual line, its original item and reason.
    const residualItems: Array<{ documentNumber: string; fiscalYear: number; lineNumber: number; amount: string; reasonCode: string }> = [];
    let lineCursor = held.length;
    for (const draft of residualDrafts) {
      lineCursor += 1;
      await tx.insert(glClearingResidual).values({
        client: input.client, companyCode: input.companyCode, glAccount: input.glAccount,
        clearingDocument: journal.documentNumber, clearingFiscalYear: journal.fiscalYear,
        clearingLineNumber: offsetLineNumbers.get(draft.held)!,
        originalDocument: draft.held.ref.documentNumber, originalFiscalYear: draft.held.ref.fiscalYear,
        originalLineNumber: draft.held.ref.lineNumber,
        residualDocument: journal.documentNumber, residualFiscalYear: journal.fiscalYear,
        residualLineNumber: lineCursor,
        reasonCode: input.residualReasonCode!.trim(),
        generatedAmount: draft.amount.toFixed(4), currency: draft.held.currency,
        createdBy: input.changedBy,
      });
      residualItems.push({
        documentNumber: journal.documentNumber, fiscalYear: journal.fiscalYear,
        lineNumber: lineCursor, amount: draft.amount.toFixed(2),
        reasonCode: input.residualReasonCode!.trim(),
      });
    }

    await recordChange(tx, {
      client: input.client, objectClass: CLEARING_CLASS,
      objectKey: `${input.companyCode}/${input.glAccount}/${journal.documentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: GL_CLEARING_CAPABILITY,
      after: {
        clearingDocument: journal.documentNumber, items: held.length,
        clearingDate: input.clearingDate, requestKey: input.requestKey,
        documentType: input.documentType, glAccount: input.glAccount,
        companyCode: input.companyCode, method,
        ...(residualItems.length ? { residualItems: residualItems.length, residualReasonCode: input.residualReasonCode } : {}),
        ...(fxLine ? { exchangeDifference: fxLine.amountLocal.toFixed(2), exchangeAccount: fxLine.glAccount } : {}),
        ...(toleranceLine ? { difference: toleranceLine.amountLocal.toFixed(2), differenceAccount: toleranceLine.glAccount } : {}),
        ...(crossMode ? { crossCurrency: currencies } : {}),
      },
    });

    const view = await loadView(tx, input.client, input.companyCode, input.glAccount, judged);
    return {
      ...view, clearingDocumentNumber: journal.documentNumber,
      clearingFiscalYear: journal.fiscalYear, residualItems,
    };
  });
}
