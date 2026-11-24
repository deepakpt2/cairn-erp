/**
 * Customer down payment clearing — SCR-084 / R-132.
 *
 * Applies standing customer down payments (F-29) to open customer
 * invoices by a real transfer posting (DZ): the indicator's
 * configured alternative reconciliation account debits per down
 * payment applied (`Applied from …`) and the customer's ordinary
 * reconciliation account credits per invoice settled
 * (`Settles …`) — a clearing transfers value between the advance
 * and the receivable; it never merely marks items cleared and it
 * never creates value, so the document balances by construction
 * and there is no unassigned difference. The unit of work is a
 * pairwise allocation (one down-payment item, one invoice item,
 * one amount); partial allocations leave the remainders standing
 * open beside their offsetting lines (the standing partial model),
 * and items applied to their full remaining amount clear in place
 * with those lines. Remaining balances derive from the posted
 * journal lines — the original line less the offsetting lines
 * naming it — while the clearing's mapping rows remember which
 * allocation settled what; the header total is reconciled to them
 * at posting. The indicator resolves through the AR special G/L
 * configuration (company scope, then tenant-wide), never
 * hardcoded. Replay by request key, revalidation under the
 * advisory lock, exactly as the standing clearings.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { moneyFor } from '../../platform/posting/money';
import { customerCompany } from '../foundation/customer-company-schema';
import { customerInvoice } from '../purchasing/schema';
import {
  customerDownPayment, customerDownPaymentClearing, customerDownPaymentClearingItem,
  journalEntry, journalEntryLine,
} from './schema';
import {
  activeValuationConflict, fxDifferenceAccount, lockValuationSettlement,
  proportionalLocal, realizedFxDirection, realizedFxLine,
} from './fx-settlement';
import { openItemBalances } from './open-item-netting';
import { resolveSpecialGlAccount } from './vendor-down-payment';

export const CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY = 'FIN.AR.DOWNPAYMENT.CLEAR';
const JOURNAL_DOCUMENT_TYPE = 'DZ';
const CLEARING_CLASS = 'customer_down_payment_clearing';

export class CustomerDownPaymentClearingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerDownPaymentClearingError';
    this.remedy = remedy;
  }
}

export interface CustomerDownPaymentItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  currency: string;
  /** Amount, applied and remaining are in the item's document currency. */
  amount: number;
  applied: number;
  remaining: number;
  /** The local-currency equivalents, labelled with `localCurrency` at the view level. */
  amountLocal: number;
  appliedLocal: number;
  remainingLocal: number;
  indicator: string;
}

export interface CustomerClearingInvoiceItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  /** Amount, applied and remaining are in the item's document currency. */
  amount: number;
  applied: number;
  remaining: number;
  /** The local-currency equivalents, labelled with `localCurrency` at the view level. */
  amountLocal: number;
  appliedLocal: number;
  remainingLocal: number;
}

export interface CustomerDownPaymentClearingView {
  customer: string;
  companyCode: string;
  indicator: string;
  alternativeAccount: string;
  reconciliationAccount: string;
  /** The company's local currency, which labels every `*Local` amount. */
  localCurrency: string;
  downPayments: CustomerDownPaymentItem[];
  invoices: CustomerClearingInvoiceItem[];
}

export interface ClearingItemRef {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
}

/** One pairwise application of advance to invoice. */
export interface ClearingAllocation {
  downPayment: ClearingItemRef;
  invoice: ClearingItemRef;
  amount: number;
}

export interface PostedCustomerClearing {
  clearingNumber: string;
  journalDocumentNumber: string;
  totalApplied: string;
  itemsCleared: number;
  clearingDate: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const itemKey = (i: ClearingItemRef) => `${i.documentNumber}|${i.fiscalYear}|${i.lineNumber}`;

async function judgeCustomer(tx: Tx, client: string, customerNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(customerCompany).where(and(
    eq(customerCompany.client, client),
    eq(customerCompany.partnerNumber, customerNumber),
    eq(customerCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new CustomerDownPaymentClearingError(
      `Customer ${customerNumber} does not stand extended to company ${companyCode}.`,
      'Extend the customer to the company code, then clear.',
    );
  }
  if (standing.isBlocked) throw new CustomerDownPaymentClearingError(`Customer ${customerNumber} is blocked for company ${companyCode}.`);
  if (!standing.reconciliationAccount) {
    throw new CustomerDownPaymentClearingError(
      `Customer ${customerNumber} carries no reconciliation account in company ${companyCode}.`,
      'Maintain the customer company data, then clear.',
    );
  }
  return standing;
}

async function resolveIndicator(
  tx: Tx, client: string, companyCode: string, indicator: string,
): Promise<string> {
  try {
    return await resolveSpecialGlAccount(tx, client, companyCode, indicator, 'AR');
  } catch (error) {
    if (error instanceof Error) throw new CustomerDownPaymentClearingError(error.message);
    throw error;
  }
}

/**
 * The document- and local-currency amounts already applied against one open item, read through the
 * shared netting helper so the units cannot drift from the reporting side.
 */
async function appliedBalances(
  tx: Tx, client: string, line: {
    documentNumber: string; companyCode: string; businessPartner: string;
    glAccount: string; currency: string; debitCredit: 'S' | 'H';
  },
): Promise<{ document: bigint; local: bigint }> {
  return (await openItemBalances(tx, client, line)).liability;
}

interface OpenLine {
  documentNumber: string; fiscalYear: number; lineNumber: number;
  postingDate: string; currency: string; amountDocument: string; amountLocal: string;
}

async function openLines(
  tx: Tx, client: string, companyCode: string, account: string,
  partner: string, debitCredit: 'S' | 'H',
): Promise<OpenLine[]> {
  return tx.select({
    documentNumber: journalEntryLine.documentNumber,
    fiscalYear: journalEntryLine.fiscalYear,
    lineNumber: journalEntryLine.lineNumber,
    postingDate: journalEntry.postingDate,
    currency: journalEntryLine.currency,
    amountDocument: journalEntryLine.amountDocument,
    amountLocal: journalEntryLine.amountLocal,
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
      eq(journalEntryLine.businessPartner, partner),
      eq(journalEntryLine.debitCredit, debitCredit),
      eq(journalEntry.status, 'POSTED'),
      sql`${journalEntryLine.clearingDocument} is null`,
    ))
    .orderBy(journalEntry.postingDate, journalEntryLine.documentNumber);
}

export async function getCustomerDownPaymentClearing(
  client: string, customerNumber: string, companyCode: string, indicator: string,
): Promise<CustomerDownPaymentClearingView> {
  return withTenant(client, (tx) => getCustomerDownPaymentClearingTx(tx, client, customerNumber, companyCode, indicator));
}

/** The open items an advance may be settled against, read inside a transaction the caller holds. */
export async function getCustomerDownPaymentClearingTx(
  tx: Tx, client: string, customerNumber: string, companyCode: string, indicator: string,
): Promise<CustomerDownPaymentClearingView> {
  const customer = await judgeCustomer(tx, client, customerNumber, companyCode);
  const alternativeAccount = await resolveIndicator(tx, client, companyCode, indicator);
  const recon = customer.reconciliationAccount!;

  // Down payments: the open advance lines of this indicator.
  const dpRecords = await tx.select().from(customerDownPayment).where(and(
    eq(customerDownPayment.client, client),
    eq(customerDownPayment.customerNumber, customerNumber),
    eq(customerDownPayment.companyCode, companyCode),
    eq(customerDownPayment.specialGlIndicator, indicator),
  ));
  const company = await getCompanyCode(tx, client, companyCode);
  const localCurrency = company?.currency ?? '';
  const dpDocs = new Set(dpRecords.map((r) => r.journalDocumentNumber));
  const dpLines = (await openLines(tx, client, companyCode, alternativeAccount, customerNumber, 'H'))
    .filter((l) => dpDocs.has(l.documentNumber));
  const downPayments: CustomerDownPaymentItem[] = [];
  for (const line of dpLines) {
    const applied = await appliedBalances(tx, client, {
      documentNumber: line.documentNumber, companyCode, businessPartner: customerNumber,
      glAccount: alternativeAccount, currency: line.currency, debitCredit: 'H',
    });
    const amountDocument = toScaled(line.amountDocument);
    const amountLocal = toScaled(line.amountLocal);
    const remainingDocument = amountDocument - applied.document;
    const remainingLocal = amountLocal - applied.local;
    if (remainingDocument <= 0n) continue;
    downPayments.push({
      documentNumber: line.documentNumber, fiscalYear: line.fiscalYear, lineNumber: line.lineNumber,
      postingDate: line.postingDate, currency: line.currency,
      amount: Number(fromScaled(amountDocument)),
      applied: Number(fromScaled(applied.document)),
      remaining: Number(fromScaled(remainingDocument)),
      amountLocal: Number(fromScaled(amountLocal)),
      appliedLocal: Number(fromScaled(applied.local)),
      remainingLocal: Number(fromScaled(remainingLocal)),
      indicator,
    });
  }

  // Invoices: the open debit items on the ordinary account.
  const dueDates = new Map<string, string>();
  for (const inv of await tx.select().from(customerInvoice).where(eq(customerInvoice.client, client))) {
    if (inv.dueDate) dueDates.set(inv.invoiceNumber, inv.dueDate);
  }
  const originKeys = new Map<string, string>();
  for (const entry of await tx.select().from(journalEntry).where(eq(journalEntry.client, client))) {
    if (entry.originClass === 'customer_invoice' && entry.originKey) {
      originKeys.set(entry.documentNumber, entry.originKey);
    }
  }
  const invLines = await openLines(tx, client, companyCode, recon, customerNumber, 'S');
  const invoices: CustomerClearingInvoiceItem[] = [];
  for (const line of invLines) {
    const applied = await appliedBalances(tx, client, {
      documentNumber: line.documentNumber, companyCode, businessPartner: customerNumber,
      glAccount: recon, currency: line.currency, debitCredit: 'S',
    });
    const amountDocument = toScaled(line.amountDocument);
    const amountLocal = toScaled(line.amountLocal);
    const remainingDocument = amountDocument - applied.document;
    const remainingLocal = amountLocal - applied.local;
    if (remainingDocument <= 0n) continue;
    const originKey = originKeys.get(line.documentNumber);
    invoices.push({
      documentNumber: line.documentNumber, fiscalYear: line.fiscalYear, lineNumber: line.lineNumber,
      postingDate: line.postingDate,
      dueDate: originKey ? (dueDates.get(originKey) ?? line.postingDate) : line.postingDate,
      currency: line.currency,
      amount: Number(fromScaled(amountDocument)),
      applied: Number(fromScaled(applied.document)),
      remaining: Number(fromScaled(remainingDocument)),
      amountLocal: Number(fromScaled(amountLocal)),
      appliedLocal: Number(fromScaled(applied.local)),
      remainingLocal: Number(fromScaled(remainingLocal)),
    });
  }
  return {
    customer: customerNumber, companyCode, indicator,
    alternativeAccount, reconciliationAccount: recon, localCurrency, downPayments, invoices,
  };
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<PostedCustomerClearing | null> {
  const [row] = await tx.select().from(customerDownPaymentClearing).where(and(
    eq(customerDownPaymentClearing.client, client), eq(customerDownPaymentClearing.requestKey, requestKey),
  ));
  return row ? {
    clearingNumber: row.clearingNumber, journalDocumentNumber: row.journalDocumentNumber,
    totalApplied: row.totalApplied, itemsCleared: 0, clearingDate: row.clearingDate,
  } : null;
}

export async function clearCustomerDownPayments(input: {
  client: string; changedBy: string;
  customerNumber: string; companyCode: string; indicator: string;
  documentDate: string; postingDate: string; clearingDate: string;
  currency: string; reference?: string; requestKey: string;
  allocations: ClearingAllocation[];
}): Promise<PostedCustomerClearing> {
  return withTenant(input.client, (tx) => clearCustomerDownPaymentsTx(tx, input));
}

/**
 * The same act, inside a transaction the caller already holds.
 *
 * Sales settles the advance an invoice consumed from inside the transaction that records what it
 * consumed: the transfer posting and the advance it settles are one act, and a clearing written on a
 * second connection would stand whether or not the sale recorded it.
 */
export async function clearCustomerDownPaymentsTx(tx: Tx, input: {
  client: string; changedBy: string;
  customerNumber: string; companyCode: string; indicator: string;
  documentDate: string; postingDate: string; clearingDate: string;
  currency: string; reference?: string; requestKey: string;
  allocations: ClearingAllocation[];
}): Promise<PostedCustomerClearing> {
  if (input.allocations.length === 0) {
    throw new CustomerDownPaymentClearingError(
      'Allocate at least one down payment to an invoice.', 'Add an allocation row, then post.',
    );
  }
  for (const a of input.allocations) {
    if (!(round2(a.amount) > 0)) {
      throw new CustomerDownPaymentClearingError(
        `The allocation from document ${a.downPayment.documentNumber} to document ${a.invoice.documentNumber} must stand above zero.`,
      );
    }
  }
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate], ['Clearing date', input.clearingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CustomerDownPaymentClearingError(`${label} ${value} is not a calendar date.`);
  }
  if (!/^[A-Za-z0-9]$/.test(input.indicator)) {
    throw new CustomerDownPaymentClearingError('The special G/L indicator is a single character.', 'Enter the configured one-character indicator.');
  }
  if (input.reference && input.reference.length > 16) {
    throw new CustomerDownPaymentClearingError('The reference may be at most 16 characters.', 'Shorten the clearing reference.');
  }

  const replay = await byRequestKey(tx, input.client, input.requestKey);
  if (replay) return replay;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/custdpclr/${input.companyCode}/${input.customerNumber}`}, 0))`);
  // Serialize with payments, clearings and period-end valuation for this company, the same
  // company-scoped settlement lock every other settlement path takes.
  await lockValuationSettlement(tx, input.client, input.companyCode);
  const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
  if (replayLocked) return replayLocked;

  const customer = await judgeCustomer(tx, input.client, input.customerNumber, input.companyCode);
  const alternativeAccount = await resolveIndicator(tx, input.client, input.companyCode, input.indicator);
  const company = await getCompanyCode(tx, input.client, input.companyCode);
  if (!company?.fiscalYearVariant) throw new CustomerDownPaymentClearingError(`Company code ${input.companyCode} is not configured.`);
  const recon = customer.reconciliationAccount!;

  // The down-payment documents standing under this indicator.
  const dpRecords = await tx.select().from(customerDownPayment).where(and(
    eq(customerDownPayment.client, input.client),
    eq(customerDownPayment.customerNumber, input.customerNumber),
    eq(customerDownPayment.companyCode, input.companyCode),
    eq(customerDownPayment.specialGlIndicator, input.indicator),
  ));
  const dpDocs = new Set(dpRecords.map((r) => r.journalDocumentNumber));

  const localMoney = await moneyFor(tx, company.currency);
  const localScale = localMoney.scale;

  interface Held {
    ref: ClearingItemRef;
    account: string;
    /** Document-currency amount applied by this clearing. */
    appliedDocument: bigint;
    /** The carrying local amount released, pro-rata of the item's posted local amount. */
    releasedLocal: bigint;
    /** Document-currency amount the item stood open at before this clearing. */
    remainingDocument: bigint;
    currency: string;
    lineText: string;
  }
  const holdItem = async (
    ref: ClearingItemRef, account: string, debitCredit: 'S' | 'H',
    kind: 'down payment' | 'invoice', textOf: (doc: string) => string,
    allocatedDocument: bigint,
  ): Promise<Held> => {
    const [line] = await tx.select().from(journalEntryLine).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, ref.documentNumber),
      eq(journalEntryLine.fiscalYear, ref.fiscalYear),
      eq(journalEntryLine.lineNumber, ref.lineNumber),
    ));
    if (!line || line.businessPartner !== input.customerNumber || line.companyCode !== input.companyCode
      || line.glAccount !== account || line.debitCredit !== debitCredit) {
      throw new CustomerDownPaymentClearingError(
        `Document ${ref.documentNumber} line ${ref.lineNumber} is not an open ${kind} of customer ${input.customerNumber} in company ${input.companyCode}.`,
        'Reload the open items, then post.',
      );
    }
    if (kind === 'down payment' && !dpDocs.has(ref.documentNumber)) {
      throw new CustomerDownPaymentClearingError(
        `Document ${ref.documentNumber} line ${ref.lineNumber} is not a down payment of customer ${input.customerNumber} under indicator ${input.indicator}.`,
        'Reload the open items, then post.',
      );
    }
    if (line.clearingDocument) {
      throw new CustomerDownPaymentClearingError(
        `Document ${ref.documentNumber} line ${ref.lineNumber} already stands cleared by ${line.clearingDocument}.`,
        'Reload the open items, then post.',
      );
    }
    const applied = await appliedBalances(tx, input.client, {
      documentNumber: ref.documentNumber, companyCode: input.companyCode,
      businessPartner: input.customerNumber, glAccount: account,
      currency: line.currency, debitCredit,
    });
    const openDocument = toScaled(line.amountDocument) - applied.document;
    const openLocal = toScaled(line.amountLocal) - applied.local;
    if (openDocument < 0n || openLocal < 0n) {
      throw new CustomerDownPaymentClearingError(
        `Document ${ref.documentNumber} line ${ref.lineNumber} carries applications that exceed it.`,
        'Investigate the applications on this item before clearing it.',
      );
    }
    if (!(allocatedDocument > 0n)) {
      throw new CustomerDownPaymentClearingError(
        `Document ${ref.documentNumber} line ${ref.lineNumber}: the applied amount must stand above zero.`,
      );
    }
    if (allocatedDocument > openDocument) {
      throw new CustomerDownPaymentClearingError(
        `The allocated ${fromScaled(allocatedDocument)} on document ${ref.documentNumber} exceeds its remaining ${fromScaled(openDocument)} ${line.currency}.`,
        'Allocate no more than the item stands open at.',
      );
    }
    // The released local amount is the item's own carrying amount, pro-rata. When the item is
    // applied in full, `proportionalLocal` returns the exact open local amount, so there is no
    // rounding drift across several partial allocations.
    const releasedLocal = proportionalLocal(openLocal, openDocument, allocatedDocument, localScale);
    return {
      ref, account, appliedDocument: allocatedDocument, releasedLocal,
      remainingDocument: openDocument, currency: line.currency, lineText: textOf(ref.documentNumber),
    };
  };

  const sumBy = (side: 'downPayment' | 'invoice') => {
    const sums = new Map<string, { ref: ClearingItemRef; total: bigint }>();
    for (const a of input.allocations) {
      const ref = a[side];
      const entry = sums.get(itemKey(ref)) ?? { ref, total: 0n };
      entry.total += toScaled(a.amount);
      sums.set(itemKey(ref), entry);
    }
    return [...sums.values()];
  };

  const dpHeld: Held[] = [];
  for (const { ref, total } of sumBy('downPayment')) {
    dpHeld.push(await holdItem(ref, alternativeAccount, 'H', 'down payment', (doc) => `Applied from ${doc}`, total));
  }
  const invHeld: Held[] = [];
  for (const { ref, total } of sumBy('invoice')) {
    invHeld.push(await holdItem(ref, recon, 'S', 'invoice', (doc) => `Settles ${doc}`, total));
  }

  const totalAppliedDocument = input.allocations.reduce((s, a) => s + toScaled(a.amount), 0n);
  const currencies = [...new Set([
    ...dpHeld.map((h) => h.currency), ...invHeld.map((h) => h.currency), input.currency.toUpperCase(),
  ])];
  if (currencies.length > 1) {
    throw new CustomerDownPaymentClearingError(
      `The clearing and its items stand in ${currencies.join(' and ')}; one clearing settles one currency.`,
      'Clear items in the clearing currency.',
    );
  }

  // A clearing over an item a period-end valuation already adjusted would count the same exchange
  // difference twice. Refuse until that valuation is reversed, exactly as the ordinary clearing does.
  for (const h of [...dpHeld, ...invHeld]) {
    const conflict = await activeValuationConflict(tx, input.client, input.companyCode, {
      documentNumber: h.ref.documentNumber, lineNumber: h.ref.lineNumber,
      accountNumber: h.account, currency: h.currency,
    }, input.postingDate);
    if (conflict) {
      throw new CustomerDownPaymentClearingError(
        `Document ${h.ref.documentNumber} line ${h.ref.lineNumber} was valued at period end by run ${conflict.runId} (key date ${conflict.valuationKeyDate}).`,
        'Reverse that FX valuation document first, then clear. Clearing over an active valuation would count the same exchange difference twice. Nothing has been posted.',
      );
    }
  }

  const lines: Array<{
    glAccount: string; debitCredit: 'S' | 'H'; amount: string; amountLocal: string;
    localOnly?: boolean; businessPartner?: string; lineText?: string;
  }> = [
    ...dpHeld.map((h) => ({
      glAccount: alternativeAccount, debitCredit: 'S' as const,
      amount: fromScaled(h.appliedDocument), amountLocal: fromScaled(h.releasedLocal),
      businessPartner: input.customerNumber, lineText: h.lineText,
    })),
    ...invHeld.map((h) => ({
      glAccount: recon, debitCredit: 'H' as const,
      amount: fromScaled(h.appliedDocument), amountLocal: fromScaled(h.releasedLocal),
      businessPartner: input.customerNumber, lineText: h.lineText,
    })),
  ];
  // The two legs carry different carrying amounts when the advance and the invoice stand at
  // different rates. Their difference is the realized exchange difference (AR: a credit gain when
  // the advance's carrying amount is the higher one).
  const localSigned = dpHeld.reduce((s, h) => s + h.releasedLocal, 0n)
    - invHeld.reduce((s, h) => s + h.releasedLocal, 0n);
  if (localSigned !== 0n) {
    const { event } = realizedFxDirection(localSigned);
    const account = await fxDifferenceAccount(tx, input.client, company.chartOfAccounts ?? '', event);
    if (!account) {
      throw new CustomerDownPaymentClearingError(
        `Account determination for ${event} does not stand in chart ${company.chartOfAccounts ?? ''}, so the realized exchange difference cannot be posted.`,
        `Maintain the ${event} account determination, then clear again. Nothing has been posted.`,
      );
    }
    lines.push(realizedFxLine(localSigned, account));
  }

  const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
  const journal = await postJournalEntry(tx, {
    client: input.client,
    companyCode: input.companyCode,
    documentType: JOURNAL_DOCUMENT_TYPE,
    documentDate: input.documentDate,
    postingDate: input.postingDate,
    fiscalYear: position.fiscalYear,
    postingPeriod: position.period,
    currency: currencies[0],
    localCurrency: company.currency,
    reference: input.reference,
    headerText: `Down payment clearing ${input.customerNumber}`,
    lines,
    origin: { documentClass: CLEARING_CLASS, documentKey: `${input.companyCode}/${input.customerNumber}` },
    postedBy: input.changedBy,
    transactionCode: CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY,
  }).catch((error: unknown) => {
    if (error instanceof PostingError) throw new CustomerDownPaymentClearingError(error.message, error.remedy);
    throw error;
  });

  // Full application stamps the original item and its offsetting
  // lines; partial application leaves the netting pair standing.
  let itemsCleared = 0;
  const stampItem = async (h: Held, account: string) => {
    itemsCleared += 1;
    await tx.update(journalEntryLine).set({
      clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
    }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, h.ref.documentNumber),
      eq(journalEntryLine.fiscalYear, h.ref.fiscalYear),
      eq(journalEntryLine.lineNumber, h.ref.lineNumber),
    ));
    await tx.update(journalEntryLine).set({
      clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
    }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.companyCode, input.companyCode),
      eq(journalEntryLine.glAccount, account),
      eq(journalEntryLine.businessPartner, input.customerNumber),
      eq(journalEntryLine.lineText, h.lineText),
      sql`${journalEntryLine.clearingDocument} is null`,
    ));
  };
  for (const h of dpHeld) {
    if (h.appliedDocument === h.remainingDocument) await stampItem(h, alternativeAccount);
  }
  for (const h of invHeld) {
    if (h.appliedDocument === h.remainingDocument) await stampItem(h, recon);
  }

  const clearingNumber = journal.documentNumber;
  await tx.insert(customerDownPaymentClearing).values({
    client: input.client, clearingNumber, fiscalYear: journal.fiscalYear,
    customerNumber: input.customerNumber, companyCode: input.companyCode,
    specialGlIndicator: input.indicator,
    alternativeReconciliationAccount: alternativeAccount,
    documentDate: input.documentDate, postingDate: input.postingDate, clearingDate: input.clearingDate,
    totalApplied: fromScaled(totalAppliedDocument),
    currency: currencies[0], reference: input.reference ?? null,
    journalDocumentNumber: journal.documentNumber,
    requestKey: input.requestKey, createdBy: input.changedBy,
  });
  let mappingTotal = 0n;
  for (const [index, a] of input.allocations.entries()) {
    const amount = toScaled(a.amount);
    mappingTotal += amount;
    await tx.insert(customerDownPaymentClearingItem).values({
      client: input.client, clearingNumber, fiscalYear: journal.fiscalYear,
      mappingNumber: index + 1,
      downPaymentDocumentNumber: a.downPayment.documentNumber,
      downPaymentFiscalYear: a.downPayment.fiscalYear,
      downPaymentLineNumber: a.downPayment.lineNumber,
      invoiceDocumentNumber: a.invoice.documentNumber,
      invoiceFiscalYear: a.invoice.fiscalYear,
      invoiceLineNumber: a.invoice.lineNumber,
      allocationCurrency: currencies[0],
      allocatedAmount: fromScaled(amount),
      createdBy: input.changedBy,
    });
  }
  if (mappingTotal !== totalAppliedDocument) {
    throw new CustomerDownPaymentClearingError(
      'The allocation rows do not reconcile to the cleared total.', 'Reload the open items, then post.',
    );
  }
  await recordChange(tx, {
    client: input.client, objectClass: CLEARING_CLASS,
    objectKey: `${input.companyCode}/${input.customerNumber}/${clearingNumber}`,
    changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY,
    after: {
      journal: journal.documentNumber, totalApplied: fromScaled(totalAppliedDocument),
      itemsCleared, allocations: input.allocations.length,
    },
  });
  const result = await byRequestKey(tx, input.client, input.requestKey);
  return { ...result!, itemsCleared };
}
