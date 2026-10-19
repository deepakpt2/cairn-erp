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
import { customerCompany } from '../foundation/customer-company-schema';
import { customerInvoice } from '../purchasing/schema';
import {
  customerDownPayment, customerDownPaymentClearing, customerDownPaymentClearingItem,
  journalEntry, journalEntryLine,
} from './schema';
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
  amount: number;
  applied: number;
  remaining: number;
  indicator: string;
}

export interface CustomerClearingInvoiceItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  amount: number;
  applied: number;
  remaining: number;
}

export interface CustomerDownPaymentClearingView {
  customer: string;
  companyCode: string;
  indicator: string;
  alternativeAccount: string;
  reconciliationAccount: string;
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

/** Net amount of the offsetting lines naming an item, reversals netting out. */
async function offsetSum(
  tx: Tx, client: string, companyCode: string, account: string,
  partner: string, lineText: string, offsetSide: 'S' | 'H',
): Promise<number> {
  const rows = await tx.select({
    debitCredit: journalEntryLine.debitCredit, amount: journalEntryLine.amountLocal,
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
      eq(journalEntryLine.lineText, lineText),
      eq(journalEntry.status, 'POSTED'),
    ));
  return round2(rows.reduce((s, r) => s + (r.debitCredit === offsetSide ? Number(r.amount) : -Number(r.amount)), 0));
}

interface OpenLine {
  documentNumber: string; fiscalYear: number; lineNumber: number;
  postingDate: string; currency: string; amount: string;
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
    amount: journalEntryLine.amountLocal,
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
  return withTenant(client, async (tx) => {
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
    const dpDocs = new Set(dpRecords.map((r) => r.journalDocumentNumber));
    const dpLines = (await openLines(tx, client, companyCode, alternativeAccount, customerNumber, 'H'))
      .filter((l) => dpDocs.has(l.documentNumber));
    const downPayments: CustomerDownPaymentItem[] = [];
    for (const line of dpLines) {
      const applied = await offsetSum(
        tx, client, companyCode, alternativeAccount, customerNumber, `Applied from ${line.documentNumber}`, 'S',
      );
      const amount = Number(line.amount);
      const remaining = round2(amount - applied);
      if (remaining <= 0.005) continue;
      downPayments.push({
        documentNumber: line.documentNumber, fiscalYear: line.fiscalYear, lineNumber: line.lineNumber,
        postingDate: line.postingDate, currency: line.currency,
        amount, applied, remaining, indicator,
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
      const applied = await offsetSum(
        tx, client, companyCode, recon, customerNumber, `Settles ${line.documentNumber}`, 'H',
      );
      const amount = Number(line.amount);
      const remaining = round2(amount - applied);
      if (remaining <= 0.005) continue;
      const originKey = originKeys.get(line.documentNumber);
      invoices.push({
        documentNumber: line.documentNumber, fiscalYear: line.fiscalYear, lineNumber: line.lineNumber,
        postingDate: line.postingDate,
        dueDate: originKey ? (dueDates.get(originKey) ?? line.postingDate) : line.postingDate,
        currency: line.currency,
        amount, applied, remaining,
      });
    }
    return {
      customer: customerNumber, companyCode, indicator,
      alternativeAccount, reconciliationAccount: recon, downPayments, invoices,
    };
  });
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

  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/custdpclr/${input.companyCode}/${input.customerNumber}`}, 0))`);
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

    interface Held {
      ref: ClearingItemRef; allocated: number; remaining: number; currency: string; lineText: string;
    }
    const holdItem = async (
      ref: ClearingItemRef, account: string, debitCredit: 'S' | 'H',
      kind: 'down payment' | 'invoice', textOf: (doc: string) => string, offsetSide: 'S' | 'H',
      allocated: number,
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
      const already = await offsetSum(
        tx, input.client, input.companyCode, account, input.customerNumber, textOf(ref.documentNumber), offsetSide,
      );
      const remaining = round2(Number(line.amountLocal) - already);
      if (allocated - remaining > 0.005) {
        throw new CustomerDownPaymentClearingError(
          `The allocated ${allocated.toFixed(2)} on document ${ref.documentNumber} exceeds its remaining ${remaining.toFixed(2)}.`,
          'Allocate no more than the item stands open at.',
        );
      }
      return { ref, allocated, remaining, currency: line.currency, lineText: textOf(ref.documentNumber) };
    };

    const sumBy = (side: 'downPayment' | 'invoice') => {
      const sums = new Map<string, { ref: ClearingItemRef; total: number }>();
      for (const a of input.allocations) {
        const ref = a[side];
        const entry = sums.get(itemKey(ref)) ?? { ref, total: 0 };
        entry.total = round2(entry.total + round2(a.amount));
        sums.set(itemKey(ref), entry);
      }
      return [...sums.values()];
    };

    const dpHeld: Held[] = [];
    for (const { ref, total } of sumBy('downPayment')) {
      dpHeld.push(await holdItem(ref, alternativeAccount, 'H', 'down payment', (doc) => `Applied from ${doc}`, 'S', total));
    }
    const invHeld: Held[] = [];
    for (const { ref, total } of sumBy('invoice')) {
      invHeld.push(await holdItem(ref, recon, 'S', 'invoice', (doc) => `Settles ${doc}`, 'H', total));
    }

    const totalApplied = round2(input.allocations.reduce((s, a) => s + round2(a.amount), 0));
    const currencies = [...new Set([
      ...dpHeld.map((h) => h.currency), ...invHeld.map((h) => h.currency), input.currency.toUpperCase(),
    ])];
    if (currencies.length > 1) {
      throw new CustomerDownPaymentClearingError(
        `The clearing and its items stand in ${currencies.join(' and ')}; one clearing settles one currency.`,
        'Clear items in the clearing currency.',
      );
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
      lines: [
        ...dpHeld.map((h) => ({
          glAccount: alternativeAccount, debitCredit: 'S' as const,
          amount: h.allocated.toFixed(2), businessPartner: input.customerNumber,
          lineText: h.lineText,
        })),
        ...invHeld.map((h) => ({
          glAccount: recon, debitCredit: 'H' as const,
          amount: h.allocated.toFixed(2), businessPartner: input.customerNumber,
          lineText: h.lineText,
        })),
      ],
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
      if (h.allocated >= h.remaining - 0.005) await stampItem(h, alternativeAccount);
    }
    for (const h of invHeld) {
      if (h.allocated >= h.remaining - 0.005) await stampItem(h, recon);
    }

    const clearingNumber = journal.documentNumber;
    await tx.insert(customerDownPaymentClearing).values({
      client: input.client, clearingNumber, fiscalYear: journal.fiscalYear,
      customerNumber: input.customerNumber, companyCode: input.companyCode,
      specialGlIndicator: input.indicator,
      alternativeReconciliationAccount: alternativeAccount,
      documentDate: input.documentDate, postingDate: input.postingDate, clearingDate: input.clearingDate,
      totalApplied: String(totalApplied),
      currency: currencies[0], reference: input.reference ?? null,
      journalDocumentNumber: journal.documentNumber,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    let mappingTotal = 0;
    for (const [index, a] of input.allocations.entries()) {
      const amount = round2(a.amount);
      mappingTotal = round2(mappingTotal + amount);
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
        allocatedAmount: String(amount),
        createdBy: input.changedBy,
      });
    }
    if (mappingTotal !== totalApplied) {
      throw new CustomerDownPaymentClearingError(
        'The allocation rows do not reconcile to the cleared total.', 'Reload the open items, then post.',
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: CLEARING_CLASS,
      objectKey: `${input.companyCode}/${input.customerNumber}/${clearingNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CUSTOMER_DOWN_PAYMENT_CLEARING_CAPABILITY,
      after: { journal: journal.documentNumber, totalApplied, itemsCleared, allocations: input.allocations.length },
    });
    const result = await byRequestKey(tx, input.client, input.requestKey);
    return { ...result!, itemsCleared };
  });
}
