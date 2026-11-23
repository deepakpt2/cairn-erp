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
import { MONEY_SCALE, fromScaled, roundToScale, toScaled } from '../../platform/posting/decimal';
import { MoneyError, moneyFor, type Money } from '../../platform/posting/money';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { customerCompany } from '../foundation/customer-company-schema';
import { accountDetermination, employeeToleranceGroup } from '../foundation/schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import { customerInvoice } from '../purchasing/schema';
import { incomingPayment, journalEntry, journalEntryLine } from './schema';
import { requireExchangeRate } from './exchange-rate-lookup';
import {
  activeValuationConflict, bankCurrencyForGl, bankCurrencyRefusal,
  fxDifferenceAccount, localUnitsOf, lockValuationSettlement, proportionalLocal,
} from './fx-settlement';

import { hasOrgAccess } from '../../platform/auth/session';
import {
  type ServiceAuthorityContext, verifyServiceAuthorityInTx,
} from '../../platform/auth/service-authority';

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
      amount: journalEntryLine.amountDocument,
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
    // Each item's discount is rounded at its own currency's decimals.
    const itemMoney = new Map<string, Money>();
    for (const code of new Set(rows.map((r) => String(r.currency).trim()))) itemMoney.set(code, await moneyFor(tx, code));
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
        discountAmount: itemMoney.get(String(r.currency).trim())!.round(itemMoney.get(String(r.currency).trim())!.fromUnits(itemMoney.get(String(r.currency).trim())!.percentOf(r.amount, percent))),
      };
    });
    return {
      customer: customerNumber, companyCode, openItems,
      openBalance: Number(fromScaled(openItems.reduce((s, i) => s + roundToScale(i.amount, MONEY_SCALE), 0n))),
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
  const pick = async (mod: string) => {
    const rows = await tx.select().from(accountDetermination).where(and(
      eq(accountDetermination.client, client),
      eq(accountDetermination.chartOfAccounts, chart),
      eq(accountDetermination.event, event),
      eq(accountDetermination.generalModifier, mod),
    ));
    const row = rows.find((r) => r.valuationClass === '') ?? rows[0];
    return row?.glAccount ?? null;
  };
  return (await pick(modifier)) ?? (modifier !== '' ? pick('') : null);
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
  bankGlAccount: string;
  bankAmount: string;
  bankCurrency: string | null;
  bankAmountSource: string;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<PostedPayment | null> {
  const [row] = await tx.select().from(incomingPayment).where(and(
    eq(incomingPayment.client, client), eq(incomingPayment.requestKey, requestKey),
  ));
  return row ? {
    paymentNumber: row.paymentNumber, journalDocumentNumber: row.journalDocumentNumber,
    amount: row.amount, itemsCleared: row.itemsCleared, clearingDate: row.clearingDate,
    bankGlAccount: row.bankGlAccount, bankAmount: row.bankAmount,
    bankCurrency: row.bankCurrency?.trim() ?? null, bankAmountSource: row.bankAmountSource,
  } : null;
}

/**
 * A reused request key must describe the same transaction. In particular it may not silently
 * return a payment whose bank movement differs from the one now being asked for.
 */
function assertReplayEvidence(
  replay: PostedPayment,
  input: { bankGlAccount: string; bankAmount?: string | number },
): void {
  if (replay.bankGlAccount.trim().toUpperCase() !== input.bankGlAccount.trim().toUpperCase()) {
    throw new IncomingPaymentError(
      `Request key ${replay.paymentNumber} was already used for bank G/L ${replay.bankGlAccount}.`,
      'Use a new request key for a different bank account.',
    );
  }
  if (input.bankAmount === undefined || String(input.bankAmount).trim() === '') return;
  if (replay.bankAmountSource === 'NOT_RECORDED') return;
  if (toScaled(String(input.bankAmount)) !== toScaled(replay.bankAmount)) {
    throw new IncomingPaymentError(
      `Request key ${replay.paymentNumber} was already used with actual bank amount ${replay.bankAmount} ${replay.bankCurrency ?? ''}.`,
      'Use a new request key when the actual bank amount differs.',
    );
  }
}

/** The authority a customer payment is banked under. */
export const INCOMING_PAYMENT_CAPABILITY = 'FIN.AR.PAYMENT.ENTER';

export async function postIncomingPayment(input: {
  client: string; changedBy: string;
  customerNumber: string; companyCode: string;
  documentDate: string; postingDate: string; clearingDate: string;
  bankGlAccount: string; amount: number; currency: string;
  /**
   * The actual amount the bank account moved, in the bank account's own currency. Required when the
   * chosen bank account is held in the company local currency and the payment is in another
   * currency; the master rate may not stand in for it. Same-currency accounts need no second entry.
   */
  bankAmount?: string | number;
  reference?: string; requestKey: string;
  /** Remainder of the receipt left standing as an open customer credit. */
  onAccountAmount?: number;
  items: PaymentItemRef[];
  /**
   * Who is banking the money. A payment settles a receivable the company code owns,
   * so the actor is judged on the company code alone — a plant grant is not asked
   * for, because a payment is not made in a plant.
   */
  authorization?: ServiceAuthorityContext;
}): Promise<PostedPayment> {
  if (input.items.length === 0) {
    throw new IncomingPaymentError('Select at least one open item to settle.', 'Tick the items this receipt settles.');
  }
  if (!(input.amount > 0)) throw new IncomingPaymentError('The incoming amount must stand above zero.');
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate], ['Clearing date', input.clearingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new IncomingPaymentError(`${label} ${value} is not a calendar date.`);
  }
  return withTenant(input.client, async (tx) => {
    const authority = await verifyServiceAuthorityInTx(
      tx, input.client, input.authorization, INCOMING_PAYMENT_CAPABILITY,
      { requirePlantScope: false },
    );
    if (!authority.ok) throw new IncomingPaymentError(authority.refusal.message, authority.refusal.remedy);
    if (!hasOrgAccess(authority.restrictions, 'COMPANY_CODE', input.companyCode)) {
      throw new IncomingPaymentError(
        `Your Company Code scope does not cover company code ${input.companyCode}.`,
        'Ask an administrator to extend your Company Code scope, then repeat the action.',
      );
    }
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) { assertReplayEvidence(replay, input); return replay; }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/incpay/${input.companyCode}/${input.customerNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) { assertReplayEvidence(replayLocked, input); return replayLocked; }

    const customer = await judgeCustomer(tx, input.client, input.customerNumber, input.companyCode);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new IncomingPaymentError(`Company code ${input.companyCode} is not configured.`);
    // Serialize with period-end valuation before any item is read or judged.
    await lockValuationSettlement(tx, input.client, input.companyCode);

    interface Held {
      ref: PaymentItemRef; amount: string; amountLocal: string; currency: string;
      reconAccount: string;
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
      held.push({
        ref, amount: line.amountDocument, amountLocal: line.amountLocal, currency: line.currency,
        reconAccount: line.glAccount, termsCode, baseline,
      });
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

    // Every amount below is a scaled integer at the PAYMENT currency's decimals: entered amounts are refused
    // when they carry more, calculated ones (eligible discount, tolerance percent) are rounded once, and every
    // comparison is exact. There is no implicit half-cent tolerance; only the tolerance group's stated limits.
    const money = await moneyFor(tx, currencies[0]!).catch((error: unknown) => {
      if (error instanceof MoneyError) throw new IncomingPaymentError(error.message, error.remedy);
      throw error;
    });
    // What the money is worth in the company's books on the posting date. A foreign receipt without
    // a maintained rate is refused; it is never booked at 1.
    const rate = await requireExchangeRate(
      tx, input.client, currencies[0]!, company.currency, input.postingDate,
    ).catch((error: unknown) => {
      if (error instanceof Error && 'remedy' in error) {
        throw new IncomingPaymentError(error.message, (error as { remedy?: string }).remedy);
      }
      throw error;
    });
    const localMoney = await moneyFor(tx, company.currency).catch((error: unknown) => {
      if (error instanceof MoneyError) throw new IncomingPaymentError(error.message, error.remedy);
      throw error;
    });
    const localScale = localMoney.scale;
    const sameCurrency = currencies[0]!.toUpperCase() === company.currency.toUpperCase();

    // Which bank account owns the G/L, and whether its currency can be represented by this journal.
    const bank = await bankCurrencyForGl(tx, input.client, input.companyCode, input.bankGlAccount);
    if (bank.kind === 'ambiguous') {
      throw new IncomingPaymentError(
        `G/L account ${input.bankGlAccount} belongs to ${bank.count} bank accounts in company ${input.companyCode}.`,
        'Give each bank account its own bank G/L account, then enter the payment.',
      );
    }
    if (bank.kind === 'unique') {
      const refusal = bankCurrencyRefusal(company.currency, currencies[0]!, bank.currency);
      if (refusal) {
        throw new IncomingPaymentError(
          refusal,
          'Receive through a bank account held in the payment currency or in the company local currency. A third-currency bank movement cannot be represented safely by one journal.',
        );
      }
    }

    // A period-end valuation already adjusted this item (or its account/currency). Settling it now
    // would count the same difference twice.
    for (const h of held) {
      const conflict = await activeValuationConflict(tx, input.client, input.companyCode, {
        documentNumber: h.ref.documentNumber, lineNumber: h.ref.lineNumber,
        accountNumber: h.reconAccount, currency: h.currency,
      }, input.postingDate);
      if (conflict) {
        throw new IncomingPaymentError(
          `Document ${h.ref.documentNumber} line ${h.ref.lineNumber} was valued at period end by run ${conflict.runId} (key date ${conflict.valuationKeyDate}).`,
          'Reverse that FX valuation document first, then settle the item. Settling over an active valuation would count the same exchange difference twice.',
        );
      }
    }
    const enter = (value: number, label: string): bigint => {
      try { return money.entered(value, label); } catch (error) {
        if (error instanceof MoneyError) throw new IncomingPaymentError(error.message, error.remedy);
        throw error;
      }
    };
    const paymentUnits = enter(input.amount, 'The incoming amount');

    // The bank account's own movement. Where the account is held in the company local currency and
    // the receipt is foreign, the clerk must state what the bank actually moved: the master rate is
    // an accounting rate, never evidence of the bank's debit. Same-currency accounts need no entry.
    const bankCurrency = bank.kind === 'unique' ? bank.currency.trim().toUpperCase() : null;
    let bankLocalUnits: bigint;
    let bankAccountAmount: string;
    let bankAccountCurrency: string | null;
    let bankAmountSource: 'SAME_CURRENCY' | 'PAYMENT_CURRENCY' | 'USER_ACTUAL' | 'BANK_NOT_IDENTIFIED';
    const statedBankAmount = input.bankAmount === undefined || String(input.bankAmount).trim() === ''
      ? null : input.bankAmount;
    if (bankCurrency !== null && bankCurrency === company.currency.trim().toUpperCase() && !sameCurrency) {
      if (statedBankAmount === null) {
        throw new IncomingPaymentError(
          `Bank account ${input.bankGlAccount} is held in ${bankCurrency}, but the receipt stands in ${currencies[0]}. The actual bank amount is required.`,
          `Enter the amount the bank actually credited, in ${bankCurrency}. The posting-date rate is used for the receivable, not invented as the bank movement.`,
        );
      }
      let enteredUnits: bigint;
      try {
        enteredUnits = localMoney.entered(statedBankAmount, 'The actual bank amount');
      } catch (error) {
        if (error instanceof MoneyError) throw new IncomingPaymentError(error.message, error.remedy);
        throw error;
      }
      if (enteredUnits <= 0n) throw new IncomingPaymentError('The actual bank amount must stand above zero.');
      // Local arithmetic stays at the 4-decimal storage scale; the minor unit is the local currency's.
      bankLocalUnits = enteredUnits * 10n ** BigInt(MONEY_SCALE - localScale);
      bankAccountAmount = localMoney.fromUnits(enteredUnits);
      bankAccountCurrency = bankCurrency;
      bankAmountSource = 'USER_ACTUAL';
    } else if (bankCurrency !== null && bankCurrency === currencies[0]!.trim().toUpperCase()) {
      if (statedBankAmount !== null) {
        let stated: bigint;
        try { stated = money.entered(statedBankAmount, 'The actual bank amount'); } catch (error) {
          if (error instanceof MoneyError) throw new IncomingPaymentError(error.message, error.remedy);
          throw error;
        }
        if (stated !== paymentUnits) {
          throw new IncomingPaymentError(
            `The actual bank amount ${money.fromUnits(stated)} ${bankCurrency} does not equal the receipt of ${money.fromUnits(paymentUnits)} ${currencies[0]}.`,
            'When the bank account is held in the payment currency its movement is the receipt amount; do not restate it.',
          );
        }
      }
      bankLocalUnits = localUnitsOf(paymentUnits, money.scale, localScale, rate);
      bankAccountAmount = money.fromUnits(paymentUnits);
      bankAccountCurrency = bankCurrency;
      bankAmountSource = sameCurrency ? 'SAME_CURRENCY' : 'PAYMENT_CURRENCY';
    } else if (bankCurrency === null) {
      if (statedBankAmount !== null) {
        throw new IncomingPaymentError(
          `G/L account ${input.bankGlAccount} is not identified as a bank account, so the actual bank amount ${statedBankAmount} cannot be validated.`,
          'Maintain the bank account for this G/L (one bank account per G/L), then enter the actual amount.',
        );
      }
      bankLocalUnits = localUnitsOf(paymentUnits, money.scale, localScale, rate);
      bankAccountAmount = money.fromUnits(paymentUnits);
      bankAccountCurrency = null;
      bankAmountSource = 'BANK_NOT_IDENTIFIED';
    } else {
      // bankCurrencyRefusal already refused a third currency; this is unreachable but kept explicit.
      throw new IncomingPaymentError(
        `Bank currency ${bankCurrency} is neither the receipt currency nor the local currency.`,
        'Receive through a bank account held in the payment currency or in the company local currency.',
      );
    }

    interface Settled {
      h: Held; open: bigint; applied: bigint; discount: bigint;
      outcome: 'FULL' | 'RESIDUAL' | 'PARTIAL'; residual: bigint;
      /** The item's local carrying amount, and the parts of it this payment relieves. */
      openLocal: bigint; releasedLocal: bigint; discountLocal: bigint; residualLocal: bigint;
    }
    const settled: Settled[] = [];
    for (const h of held) {
      const open = money.units(h.amount);
      const discount = enter(h.ref.discount ?? 0, 'The discount');
      const applied = h.ref.applied === undefined ? open - discount : enter(h.ref.applied, 'The applied amount');
      if (applied < 0n || discount < 0n) {
        throw new IncomingPaymentError(
          `Document ${h.ref.documentNumber} line ${h.ref.lineNumber}: applied and discount amounts may not stand negative.`,
        );
      }
      if (applied + discount > open) {
        throw new IncomingPaymentError(
          `Document ${h.ref.documentNumber} line ${h.ref.lineNumber}: applied ${money.fromUnits(applied)} plus discount ${money.fromUnits(discount)} exceeds the open amount of ${money.fromUnits(open)}.`,
          'Apply no more than the item stands open at.',
        );
      }
      if (discount > 0n) {
        if (!h.termsCode) {
          throw new IncomingPaymentError(
            `Document ${h.ref.documentNumber} line ${h.ref.lineNumber} carries no payment terms, so no cash discount stands eligible on it.`,
            'Take the discount only on items whose invoice terms allow it.',
          );
        }
        const percent = eligiblePercent(termsByCode.get(h.termsCode) ?? null, h.baseline, input.postingDate);
        const eligible = money.percentOf(money.fromUnits(open), percent);
        if (discount > eligible) {
          throw new IncomingPaymentError(
            `The discount of ${money.fromUnits(discount)} on document ${h.ref.documentNumber} exceeds the eligible ${money.fromUnits(eligible)} (${percent}% under terms ${h.termsCode} at the posting date).`,
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
        const cap = money.percentOf(money.fromUnits(open), capPercent);
        if (discount > cap) {
          throw new IncomingPaymentError(
            `The discount of ${money.fromUnits(discount)} on document ${h.ref.documentNumber} exceeds the tolerance maximum of ${capPercent}% (${money.fromUnits(cap)}).`,
            'Take no more than the tolerance group permits.',
          );
        }
      }
      const shortfall = open - applied - discount;
      // A part-settlement closes the original item and leaves the remainder as a residual open item.
      // Leaving the original fully open beside a payment line would let the same carrying amount be
      // relieved twice on a later settlement, over-realizing FX.
      const outcome: Settled['outcome'] = shortfall <= 0n ? 'FULL' : 'RESIDUAL';
      const openLocal = toScaled(h.amountLocal);
      // The portion actually settled (cash applied plus discount), at its original carrying rate.
      const releasedLocal = proportionalLocal(openLocal, open, applied + discount, localScale);
      const discountLocal = discount > 0n ? proportionalLocal(openLocal, open, discount, localScale) : 0n;
      settled.push({
        h, open, applied, discount, outcome,
        residual: outcome === 'RESIDUAL' ? shortfall : 0n,
        openLocal, releasedLocal, discountLocal,
        residualLocal: outcome === 'RESIDUAL' ? openLocal - releasedLocal : 0n,
      });
    }

    const cashApplied = settled.reduce((s, x) => s + x.applied, 0n);
    const discountTotal = settled.reduce((s, x) => s + x.discount, 0n);
    const onAccount = enter(input.onAccountAmount ?? 0, 'The on-account amount');
    if (onAccount < 0n) throw new IncomingPaymentError('The on-account amount may not stand negative.');

    // The unassigned remainder: tolerated as a posted difference, else refused.
    const unassigned = paymentUnits - cashApplied - onAccount;
    let differenceLine: { debitCredit: 'S' | 'H'; amount: bigint } | null = null;
    if (unassigned !== 0n) {
      const revenue = unassigned > 0n;
      const magnitude = unassigned < 0n ? -unassigned : unassigned;
      const fail = () => new IncomingPaymentError(
        `The receipt leaves an unassigned difference of ${money.fromUnits(unassigned)} ${currencies[0]} beyond the tolerance of the default group.`,
        'Allocate the difference to items, post it on account, or widen the tolerance group.',
      );
      if (!tolerance) throw fail();
      const amountLimit = money.units(Number(revenue ? tolerance.paymentDiffRevenueAmount : tolerance.paymentDiffExpenseAmount));
      const percentLimit = Number(revenue ? tolerance.paymentDiffRevenuePercent : tolerance.paymentDiffExpensePercent);
      const percentAmount = money.percentOf(money.fromUnits(paymentUnits), percentLimit);
      if (magnitude > (amountLimit < percentAmount ? amountLimit : percentAmount)) throw fail();
      differenceLine = { debitCredit: revenue ? 'H' : 'S', amount: magnitude };
    }

    const chart = customer.chartOfAccounts;
    let discountAccount: string | null = null;
    if (discountTotal > 0n) {
      discountAccount = await determinationAccount(tx, input.client, chart, 'CASH_DISCOUNT', 'EXP');
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
        tx, input.client, chart, 'PAYMENT_DIFFERENCE', differenceLine.debitCredit === 'H' ? 'REV' : 'EXP',
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
      glAccount: string; debitCredit: 'S' | 'H'; amount: string; amountLocal: string;
      localOnly?: boolean; businessPartner?: string; lineText?: string;
    };
    // Same currency means the local amount is the document amount exactly; only a foreign document
    // is translated. This also keeps proportional rounding from masquerading as an exchange
    // difference in a same-currency partial or residual settlement.
    const localText = (unitsDocument: bigint) => sameCurrency
      ? money.fromUnits(unitsDocument)
      : fromScaled(localUnitsOf(unitsDocument, money.scale, localScale, rate));
    const lines: Line[] = [
      {
        glAccount: input.bankGlAccount, debitCredit: 'S',
        amount: money.fromUnits(paymentUnits), amountLocal: fromScaled(bankLocalUnits),
      },
    ];
    if (discountAccount && discountTotal > 0n) {
      lines.push({
        glAccount: discountAccount, debitCredit: 'S', amount: money.fromUnits(discountTotal),
        amountLocal: sameCurrency
          ? money.fromUnits(discountTotal)
          : fromScaled(settled.reduce((s, x) => s + x.discountLocal, 0n)),
        lineText: 'Cash discount granted',
      });
    }
    if (differenceAccount && differenceLine?.debitCredit === 'S') {
      lines.push({
        glAccount: differenceAccount, debitCredit: 'S', amount: money.fromUnits(differenceLine.amount),
        amountLocal: localText(differenceLine.amount), lineText: 'Payment difference',
      });
    }
    for (const x of settled) {
      lines.push({
        glAccount: recon, debitCredit: 'H', amount: money.fromUnits(x.open),
        amountLocal: sameCurrency ? money.fromUnits(x.open) : fromScaled(x.openLocal),
        businessPartner: input.customerNumber, lineText: `Settles ${x.h.ref.documentNumber}`,
      });
      if (x.outcome === 'RESIDUAL') {
        lines.push({
          glAccount: recon, debitCredit: 'S', amount: money.fromUnits(x.residual),
          amountLocal: sameCurrency ? money.fromUnits(x.residual) : fromScaled(x.residualLocal),
          businessPartner: input.customerNumber, lineText: `Residual of ${x.h.ref.documentNumber}`,
        });
      }
    }
    if (onAccount > 0n) {
      lines.push({
        glAccount: recon, debitCredit: 'H', amount: money.fromUnits(onAccount),
        amountLocal: localText(onAccount),
        businessPartner: input.customerNumber, lineText: 'On account',
      });
    }
    if (differenceAccount && differenceLine?.debitCredit === 'H') {
      lines.push({
        glAccount: differenceAccount, debitCredit: 'H', amount: money.fromUnits(differenceLine.amount),
        amountLocal: localText(differenceLine.amount), lineText: 'Payment difference',
      });
    }

    // The realized exchange difference: the bank moved at the payment rate, the receivable is
    // relieved at its carrying amount. Whatever remains is a gain (credit) or a loss (debit), and a
    // local-only line represents it without inventing a document-currency amount.
    const localSigned = lines.reduce(
      (total, line) => total + (line.debitCredit === 'S' ? toScaled(line.amountLocal) : -toScaled(line.amountLocal)),
      0n,
    );
    let realizedLocal = 0n;
    if (sameCurrency && localSigned !== 0n) {
      throw new IncomingPaymentError(
        'The same-currency payment does not balance in the local currency.',
        'Reload the open items and try again; nothing has been posted.',
      );
    }
    if (!sameCurrency && localSigned !== 0n) {
      realizedLocal = localSigned < 0n ? -localSigned : localSigned;
      const event = localSigned > 0n ? 'FXGAIN' : 'FXLOSS';
      const account = await fxDifferenceAccount(tx, input.client, chart, event);
      if (!account) {
        throw new IncomingPaymentError(
          `Account determination for ${event} does not stand in chart ${chart}, so the realized exchange difference cannot be posted.`,
          `Maintain the ${event} account determination, then post again. Nothing has been posted.`,
        );
      }
      lines.push({
        glAccount: account,
        debitCredit: localSigned > 0n ? 'H' : 'S',
        amount: '0',
        amountLocal: fromScaled(realizedLocal),
        localOnly: true,
        lineText: localSigned > 0n ? 'Realized exchange gain' : 'Realized exchange loss',
      });
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
      rate,
      reference: input.reference,
      headerText: `Incoming payment ${input.customerNumber}`,
      lines,
      origin: { documentClass: PAYMENT_CLASS, documentKey: `${input.companyCode}/${input.customerNumber}` },
      postedBy: input.changedBy,
      transactionCode: INCOMING_PAYMENT_CAPABILITY,
      precision: 'CURRENCY',
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new IncomingPaymentError(error.message, error.remedy);
      throw error;
    });

    // Fully and residually settled items clear; residual, partial and
    // on-account lines of the payment itself stand open.
    let clearedCount = 0;
    for (const x of settled) {
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
      bankGlAccount: input.bankGlAccount, amount: money.fromUnits(paymentUnits),
      discountAmount: money.fromUnits(discountTotal), onAccountAmount: money.fromUnits(onAccount),
      currency: currencies[0], exchangeRate: rate.effectiveRate,
      localAmount: localText(paymentUnits),
      bankAmount: bankAccountAmount, bankCurrency: bankAccountCurrency, bankAmountSource,
      reference: input.reference ?? null,
      journalDocumentNumber: journal.documentNumber, itemsCleared: clearedCount,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: PAYMENT_CLASS,
      objectKey: `${input.companyCode}/${input.customerNumber}/${paymentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: INCOMING_PAYMENT_CAPABILITY,
      after: {
        journal: journal.documentNumber, amount: money.fromUnits(paymentUnits),
        localAmount: localText(paymentUnits), exchangeRate: rate.effectiveRate,
        realizedDifference: fromScaled(realizedLocal), items: held.length,
        bankAmount: bankAccountAmount, bankCurrency: bankAccountCurrency, bankAmountSource,
      },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}
