/**
 * Incoming payment entry and allocation — SCR-068 / R-116.
 *
 * A receipt allocates in full against the customer's open
 * receivable items: the bank debits, the customer credits per
 * allocation, and every settled item clears in place under the
 * payment document and the clearing date. The allocation must
 * equal the receipt — a difference is named, never discarded.
 * Partial, residual and on-account outcomes stand deferred.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { customerCompany } from '../foundation/customer-company-schema';
import { accountDetermination, employeeToleranceGroup } from '../foundation/schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import { customerInvoice } from '../purchasing/schema';
import { incomingPayment, journalEntry, journalEntryLine } from './schema';

export const INCOMING_PAYMENT_CAPABILITY = 'FIN.AR.PAYMENT.ENTER';
const JOURNAL_DOCUMENT_TYPE = 'DZ';
const PAYMENT_CLASS = 'incoming_payment';

export class IncomingPaymentError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'IncomingPaymentError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export interface ReceivableItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  amount: string;
  signed: number;
  /** Cash-discount suggestion from the item's own terms, as of today (SCR-079). */
  termsCode: string | null;
  discountPercent: number;
  discountAmount: number;
}

export interface IncomingPaymentView {
  customer: string;
  companyCode: string;
  openItems: ReceivableItem[];
  openBalance: number;
}

async function judgeCustomer(tx: Tx, client: string, customerNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(customerCompany).where(and(
    eq(customerCompany.client, client),
    eq(customerCompany.partnerNumber, customerNumber),
    eq(customerCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new IncomingPaymentError(
      `Customer ${customerNumber} does not stand extended to company ${companyCode}.`,
      'Extend the customer to the company code, then enter the payment.',
    );
  }
  if (standing.isBlocked) throw new IncomingPaymentError(`Customer ${customerNumber} is blocked for company ${companyCode}.`);
  if (!standing.reconciliationAccount) {
    throw new IncomingPaymentError(
      `Customer ${customerNumber} carries no reconciliation account in company ${companyCode}.`,
      'Maintain the customer company data, then enter the payment.',
    );
  }
  return standing;
}

export async function getReceivables(
  client: string, customerNumber: string, companyCode: string,
): Promise<IncomingPaymentView> {
  return withTenant(client, async (tx) => {
    await judgeCustomer(tx, client, customerNumber, companyCode);
    const dueDates = new Map<string, string>();
    const invoiceTerms = new Map<string, { termsCode: string | null; baseline: string | null }>();
    for (const inv of await tx.select().from(customerInvoice).where(eq(customerInvoice.client, client))) {
      if (inv.dueDate) dueDates.set(inv.invoiceNumber, inv.dueDate);
      invoiceTerms.set(inv.invoiceNumber, {
        termsCode: inv.paymentTerms, baseline: inv.baselineDate ?? inv.documentDate,
      });
    }
    const termsByCode = new Map<string, typeof paymentTerms.$inferSelect>();
    for (const row of await tx.select().from(paymentTerms).where(eq(paymentTerms.client, client))) {
      termsByCode.set(row.termsCode, row);
    }
    const today = new Date().toISOString().slice(0, 10);
    const rows = await tx.select({
      documentNumber: journalEntryLine.documentNumber,
      fiscalYear: journalEntryLine.fiscalYear,
      lineNumber: journalEntryLine.lineNumber,
      postingDate: journalEntry.postingDate,
      originClass: journalEntry.originClass,
      originKey: journalEntry.originKey,
      currency: journalEntryLine.currency,
      amount: journalEntryLine.amountLocal,
      debitCredit: journalEntryLine.debitCredit,
    }).from(journalEntryLine)
      .innerJoin(journalEntry, and(
        eq(journalEntry.client, journalEntryLine.client),
        eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
        eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
      ))
      .where(and(
        eq(journalEntryLine.client, client),
        eq(journalEntryLine.companyCode, companyCode),
        eq(journalEntryLine.businessPartner, customerNumber),
        eq(journalEntryLine.debitCredit, 'S'),
        eq(journalEntry.status, 'POSTED'),
        sql`${journalEntryLine.clearingDocument} is null`,
      ))
      .orderBy(journalEntry.postingDate, journalEntryLine.documentNumber);
    const openItems = rows.map((r) => {
      const terms = r.originClass === 'customer_invoice' && r.originKey
        ? invoiceTerms.get(r.originKey) : undefined;
      const percent = terms?.termsCode
        ? eligiblePercent(termsByCode.get(terms.termsCode) ?? null, terms.baseline, today)
        : 0;
      return {
        documentNumber: r.documentNumber, fiscalYear: r.fiscalYear, lineNumber: r.lineNumber,
        postingDate: r.postingDate,
        dueDate: r.originClass === 'customer_invoice' && r.originKey
          ? (dueDates.get(r.originKey) ?? r.postingDate)
          : r.postingDate,
        currency: r.currency, amount: r.amount, signed: Number(r.amount),
        termsCode: terms?.termsCode ?? null,
        discountPercent: percent,
        discountAmount: round2(Number(r.amount) * percent / 100),
      };
    });
    return {
      customer: customerNumber, companyCode, openItems,
      openBalance: round4(openItems.reduce((s, i) => s + i.signed, 0)),
    };
  });
}

export interface PaymentItemRef {
  documentNumber: string; fiscalYear: number; lineNumber: number;
  /** Cash applied to this item; defaults to its open amount (SCR-079). */
  applied?: number;
  /** Cash discount taken on this item, judged against its terms. */
  discount?: number;
  /** When applied plus discount falls short: residual (default) or partial. */
  outcome?: 'RESIDUAL' | 'PARTIAL';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/** The default tolerance group of the company scope, else the tenant-wide default. */
async function defaultTolerance(tx: Tx, client: string, companyCode: string) {
  const groups = await tx.select().from(employeeToleranceGroup)
    .where(eq(employeeToleranceGroup.client, client));
  return groups.find((g) => g.companyCode === companyCode && g.groupKey === '')
    ?? groups.find((g) => g.companyCode === '' && g.groupKey === '')
    ?? null;
}

async function determinationAccount(
  tx: Tx, client: string, chart: string, event: string, modifier = '',
): Promise<string | null> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
    eq(accountDetermination.generalModifier, modifier),
  ));
  const row = rows.find((r) => r.valuationClass === '') ?? rows[0];
  return row?.glAccount ?? null;
}

/** The discount percentage an item's own terms allow on a given date. */
function eligiblePercent(
  terms: { discount1Days: number | null; discount1Percent: string; discount2Days: number | null; discount2Percent: string } | null,
  baseline: string | null, postingDate: string,
): number {
  if (!terms || !baseline) return 0;
  const days = daysBetween(baseline, postingDate);
  if (terms.discount1Days != null && days <= terms.discount1Days) return Number(terms.discount1Percent);
  if (terms.discount2Days != null && days <= terms.discount2Days) return Number(terms.discount2Percent);
  return 0;
}

export interface PostedPayment {
  paymentNumber: string;
  journalDocumentNumber: string;
  amount: string;
  itemsCleared: number;
  clearingDate: string;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<PostedPayment | null> {
  const [row] = await tx.select().from(incomingPayment).where(and(
    eq(incomingPayment.client, client), eq(incomingPayment.requestKey, requestKey),
  ));
  return row ? {
    paymentNumber: row.paymentNumber, journalDocumentNumber: row.journalDocumentNumber,
    amount: row.amount, itemsCleared: row.itemsCleared, clearingDate: row.clearingDate,
  } : null;
}

export async function postIncomingPayment(input: {
  client: string; changedBy: string;
  customerNumber: string; companyCode: string;
  documentDate: string; postingDate: string; clearingDate: string;
  bankGlAccount: string; amount: number; currency: string;
  reference?: string; requestKey: string;
  /** Remainder of the receipt left standing as an open customer credit. */
  onAccountAmount?: number;
  items: PaymentItemRef[];
}): Promise<PostedPayment> {
  if (input.items.length === 0) {
    throw new IncomingPaymentError('Select at least one open item to settle.', 'Tick the items this receipt settles.');
  }
  if (!(input.amount > 0)) throw new IncomingPaymentError('The incoming amount must stand above zero.');
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate], ['Clearing date', input.clearingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new IncomingPaymentError(`${label} ${value} is not a calendar date.`);
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/incpay/${input.companyCode}/${input.customerNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) return replayLocked;

    const customer = await judgeCustomer(tx, input.client, input.customerNumber, input.companyCode);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new IncomingPaymentError(`Company code ${input.companyCode} is not configured.`);

    interface Held {
      ref: PaymentItemRef; amount: string; currency: string;
      termsCode: string | null; baseline: string | null;
    }
    const held: Held[] = [];
    for (const ref of input.items) {
      const [line] = await tx.select().from(journalEntryLine).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, ref.documentNumber),
        eq(journalEntryLine.fiscalYear, ref.fiscalYear),
        eq(journalEntryLine.lineNumber, ref.lineNumber),
      ));
      if (!line || line.businessPartner !== input.customerNumber || line.companyCode !== input.companyCode || line.debitCredit !== 'S') {
        throw new IncomingPaymentError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} is not an open receivable of customer ${input.customerNumber} in company ${input.companyCode}.`,
          'Reload the open items, then post.',
        );
      }
      if (line.clearingDocument) {
        throw new IncomingPaymentError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} already stands cleared by ${line.clearingDocument}.`,
          'Reload the open items, then post.',
        );
      }
      let termsCode: string | null = null;
      let baseline: string | null = null;
      const [header] = await tx.select().from(journalEntry).where(and(
        eq(journalEntry.client, input.client),
        eq(journalEntry.documentNumber, ref.documentNumber),
        eq(journalEntry.fiscalYear, ref.fiscalYear),
      ));
      if (header?.originClass === 'customer_invoice' && header.originKey) {
        const [inv] = await tx.select().from(customerInvoice).where(and(
          eq(customerInvoice.client, input.client), eq(customerInvoice.invoiceNumber, header.originKey),
        ));
        if (inv) {
          termsCode = inv.paymentTerms;
          baseline = inv.baselineDate ?? inv.documentDate;
        }
      }
      held.push({ ref, amount: line.amountLocal, currency: line.currency, termsCode, baseline });
    }

    const currencies = [...new Set([...held.map((h) => h.currency), input.currency.toUpperCase()])];
    if (currencies.length > 1) {
      throw new IncomingPaymentError(
        `The payment and its items stand in ${currencies.join(' and ')}; one payment settles one currency.`,
        'Allocate items in the payment currency.',
      );
    }
    // ── Completion judging (SCR-079 / R-127) ──────────────────────────
    const tolerance = await defaultTolerance(tx, input.client, input.companyCode);
    const termsByCode = new Map<string, typeof paymentTerms.$inferSelect>();
    for (const row of await tx.select().from(paymentTerms).where(eq(paymentTerms.client, input.client))) {
      termsByCode.set(row.termsCode, row);
    }

    interface Settled {
      h: Held; open: number; applied: number; discount: number;
      outcome: 'FULL' | 'RESIDUAL' | 'PARTIAL'; residual: number;
    }
    const settled: Settled[] = [];
    for (const h of held) {
      const open = Number(h.amount);
      const applied = h.ref.applied === undefined ? open : Number(h.ref.applied);
      const discount = Number(h.ref.discount ?? 0);
      if (!(applied >= 0) || !(discount >= 0)) {
        throw new IncomingPaymentError(
          `Document ${h.ref.documentNumber} line ${h.ref.lineNumber}: applied and discount amounts may not stand negative.`,
        );
      }
      if (round2(applied + discount) - open > 0.005) {
        throw new IncomingPaymentError(
          `Document ${h.ref.documentNumber} line ${h.ref.lineNumber}: applied ${applied.toFixed(2)} plus discount ${discount.toFixed(2)} exceeds the open amount of ${open.toFixed(2)}.`,
          'Apply no more than the item stands open at.',
        );
      }
      if (discount > 0) {
        if (!h.termsCode) {
          throw new IncomingPaymentError(
            `Document ${h.ref.documentNumber} line ${h.ref.lineNumber} carries no payment terms, so no cash discount stands eligible on it.`,
            'Take the discount only on items whose invoice terms allow it.',
          );
        }
        const percent = eligiblePercent(termsByCode.get(h.termsCode) ?? null, h.baseline, input.postingDate);
        const eligible = round2(open * percent / 100);
        if (discount - eligible > 0.005) {
          throw new IncomingPaymentError(
            `The discount of ${discount.toFixed(2)} on document ${h.ref.documentNumber} exceeds the eligible ${eligible.toFixed(2)} (${percent}% under terms ${h.termsCode} at the posting date).`,
            'Take no more than the terms allow, or post without the discount.',
          );
        }
        if (!tolerance) {
          throw new IncomingPaymentError(
            'No default tolerance group stands for this company scope, so a cash discount cannot be judged.',
            'Maintain the tolerance groups, then post.',
          );
        }
        const capPercent = Number(tolerance.maxCashDiscountPercent);
        if (discount - round2(open * capPercent / 100) > 0.005) {
          throw new IncomingPaymentError(
            `The discount of ${discount.toFixed(2)} on document ${h.ref.documentNumber} exceeds the tolerance maximum of ${capPercent}% (${round2(open * capPercent / 100).toFixed(2)}).`,
            'Take no more than the tolerance group permits.',
          );
        }
      }
      const shortfall = round2(open - applied - discount);
      const outcome: Settled['outcome'] = shortfall <= 0.005
        ? 'FULL'
        : (h.ref.outcome === 'PARTIAL' ? 'PARTIAL' : 'RESIDUAL');
      settled.push({ h, open, applied, discount, outcome, residual: outcome === 'RESIDUAL' ? shortfall : 0 });
    }

    const cashApplied = round2(settled.reduce((s, x) => s + x.applied, 0));
    const discountTotal = round2(settled.reduce((s, x) => s + x.discount, 0));
    const onAccount = round2(input.onAccountAmount ?? 0);
    if (onAccount < 0) throw new IncomingPaymentError('The on-account amount may not stand negative.');

    // The unassigned remainder: tolerated as a posted difference, else refused.
    const unassigned = round2(round4(input.amount) - cashApplied - onAccount);
    let differenceLine: { debitCredit: 'S' | 'H'; amount: number } | null = null;
    if (Math.abs(unassigned) > 0.005) {
      const revenue = unassigned > 0;
      const fail = () => new IncomingPaymentError(
        `The receipt leaves an unassigned difference of ${unassigned.toFixed(2)} ${currencies[0]} beyond the tolerance of the default group.`,
        'Allocate the difference to items, post it on account, or widen the tolerance group.',
      );
      if (!tolerance) throw fail();
      const amountLimit = Number(revenue ? tolerance.paymentDiffRevenueAmount : tolerance.paymentDiffExpenseAmount);
      const percentLimit = Number(revenue ? tolerance.paymentDiffRevenuePercent : tolerance.paymentDiffExpensePercent);
      const percentAmount = round2(round4(input.amount) * percentLimit / 100);
      if (Math.abs(unassigned) - Math.min(amountLimit, percentAmount) > 0.005) throw fail();
      differenceLine = { debitCredit: revenue ? 'H' : 'S', amount: Math.abs(unassigned) };
    }

    const chart = customer.chartOfAccounts;
    let discountAccount: string | null = null;
    if (discountTotal > 0) {
      discountAccount = await determinationAccount(tx, input.client, chart, 'CASH_DISCOUNT');
      if (!discountAccount) {
        throw new IncomingPaymentError(
          `Account determination for CASH_DISCOUNT does not stand in chart ${chart}.`,
          'Maintain the account determination for the cash discount event, then post again.',
        );
      }
    }
    let differenceAccount: string | null = null;
    if (differenceLine) {
      differenceAccount = await determinationAccount(
        tx, input.client, chart, 'PAYMENT_DIFFERENCE', differenceLine.debitCredit === 'H' ? 'REVENUE' : 'EXPENSE',
      );
      if (!differenceAccount) {
        throw new IncomingPaymentError(
          `Account determination for PAYMENT_DIFFERENCE does not stand in chart ${chart}.`,
          'Maintain the account determination for the payment difference event, then post again.',
        );
      }
    }

    const recon = customer.reconciliationAccount!;
    type Line = {
      glAccount: string; debitCredit: 'S' | 'H'; amount: string;
      businessPartner?: string; lineText?: string;
    };
    const lines: Line[] = [
      { glAccount: input.bankGlAccount, debitCredit: 'S', amount: round4(input.amount).toFixed(2) },
    ];
    if (discountAccount && discountTotal > 0) {
      lines.push({ glAccount: discountAccount, debitCredit: 'S', amount: discountTotal.toFixed(2), lineText: 'Cash discount granted' });
    }
    if (differenceAccount && differenceLine?.debitCredit === 'S') {
      lines.push({ glAccount: differenceAccount, debitCredit: 'S', amount: differenceLine.amount.toFixed(2), lineText: 'Payment difference' });
    }
    for (const x of settled) {
      if (x.outcome === 'PARTIAL') {
        lines.push({
          glAccount: recon, debitCredit: 'H', amount: round2(x.applied + x.discount).toFixed(2),
          businessPartner: input.customerNumber, lineText: `Partial payment for ${x.h.ref.documentNumber}`,
        });
      } else {
        lines.push({
          glAccount: recon, debitCredit: 'H', amount: x.open.toFixed(2),
          businessPartner: input.customerNumber, lineText: `Settles ${x.h.ref.documentNumber}`,
        });
        if (x.outcome === 'RESIDUAL') {
          lines.push({
            glAccount: recon, debitCredit: 'S', amount: x.residual.toFixed(2),
            businessPartner: input.customerNumber, lineText: `Residual of ${x.h.ref.documentNumber}`,
          });
        }
      }
    }
    if (onAccount > 0) {
      lines.push({
        glAccount: recon, debitCredit: 'H', amount: onAccount.toFixed(2),
        businessPartner: input.customerNumber, lineText: 'On account',
      });
    }
    if (differenceAccount && differenceLine?.debitCredit === 'H') {
      lines.push({ glAccount: differenceAccount, debitCredit: 'H', amount: differenceLine.amount.toFixed(2), lineText: 'Payment difference' });
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
      headerText: `Incoming payment ${input.customerNumber}`,
      lines,
      origin: { documentClass: PAYMENT_CLASS, documentKey: `${input.companyCode}/${input.customerNumber}` },
      postedBy: input.changedBy,
      transactionCode: INCOMING_PAYMENT_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new IncomingPaymentError(error.message, error.remedy);
      throw error;
    });

    // Fully and residually settled items clear; residual, partial and
    // on-account lines of the payment itself stand open.
    let clearedCount = 0;
    for (const x of settled) {
      if (x.outcome === 'PARTIAL') continue;
      clearedCount += 1;
      await tx.update(journalEntryLine).set({
        clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
      }).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, x.h.ref.documentNumber),
        eq(journalEntryLine.fiscalYear, x.h.ref.fiscalYear),
        eq(journalEntryLine.lineNumber, x.h.ref.lineNumber),
      ));
    }
    await tx.update(journalEntryLine).set({
      clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
    }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, journal.documentNumber),
      eq(journalEntryLine.fiscalYear, journal.fiscalYear),
      eq(journalEntryLine.businessPartner, input.customerNumber),
      sql`${journalEntryLine.lineText} like 'Settles %'`,
    ));

    const paymentNumber = journal.documentNumber;
    await tx.insert(incomingPayment).values({
      client: input.client, paymentNumber, fiscalYear: journal.fiscalYear,
      customerNumber: input.customerNumber, companyCode: input.companyCode,
      documentDate: input.documentDate, postingDate: input.postingDate, clearingDate: input.clearingDate,
      bankGlAccount: input.bankGlAccount, amount: String(round4(input.amount)),
      discountAmount: String(discountTotal), onAccountAmount: String(onAccount),
      currency: currencies[0], reference: input.reference ?? null,
      journalDocumentNumber: journal.documentNumber, itemsCleared: clearedCount,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: PAYMENT_CLASS,
      objectKey: `${input.companyCode}/${input.customerNumber}/${paymentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: INCOMING_PAYMENT_CAPABILITY,
      after: { journal: journal.documentNumber, amount: round4(input.amount), items: held.length },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}
