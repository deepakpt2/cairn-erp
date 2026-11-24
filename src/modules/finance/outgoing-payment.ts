/**
 * Outgoing payment entry and allocation — SCR-078 / R-126.
 *
 * A payment allocates in full against the vendor's open payable
 * items: the vendor debits per allocation, the bank credits, and
 * every settled item clears in place under the payment document
 * and the clearing date. Credit items — the vendor side of credit
 * memos — count against the payment, so the selected items net.
 *
 * SCR-080 / R-128 completes the payment as SCR-079 did for the
 * incoming side: per item the clerk states amount applied and
 * discount taken, the discount judged against the vendor invoice's
 * terms tiers and the default tolerance group; an item settles in
 * full, leaves a residual open item, or stands partial beside the
 * payment's own debit line; on-account amounts stand open; and an
 * unassigned remainder within tolerance posts as a payment
 * difference, beyond it refused by name.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { hasOrgAccess } from '../../platform/auth/session';
import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { MONEY_SCALE, fromScaled, roundToScale, toScaled } from '../../platform/posting/decimal';
import { MoneyError, moneyFor, type Money } from '../../platform/posting/money';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { accountDetermination, employeeToleranceGroup } from '../foundation/schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import {
  journalEntry, journalEntryLine, outgoingPayment, vendorInvoice,
} from './schema';
import { requireExchangeRate } from './exchange-rate-lookup';
import {
  notValidApplicationLineSql, openItemBalances, unappliedPaymentCreditSql, validApplicationSql,
} from './open-item-netting';
import {
  activeValuationConflict, bankCurrencyForGl, bankCurrencyRefusal,
  fxDifferenceAccount, localUnitsOf, lockValuationSettlement, proportionalLocal,
} from './fx-settlement';

export const OUTGOING_PAYMENT_CAPABILITY = 'FIN.AP.PAYMENT.POST';
const JOURNAL_DOCUMENT_TYPE = 'KZ';
const PAYMENT_CLASS = 'outgoing_payment';

export class OutgoingPaymentError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'OutgoingPaymentError';
    this.remedy = remedy;
  }
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

// ── Open items ─────────────────────────────────────────────────────────

export interface PayableItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  currency: string;
  amount: string;
  /** Credit payables positive; debit credit items negative. */
  signed: number;
  termsCode: string | null;
  discountPercent: number;
  discountAmount: number;
}

export interface OutgoingPaymentView {
  vendor: string;
  companyCode: string;
  openItems: PayableItem[];
  openBalance: number;
}

async function judgeVendor(tx: Tx, client: string, vendorNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(supplierCompany).where(and(
    eq(supplierCompany.client, client),
    eq(supplierCompany.partnerNumber, vendorNumber),
    eq(supplierCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new OutgoingPaymentError(
      `Vendor ${vendorNumber} does not stand extended to company ${companyCode}.`,
      'Extend the vendor to the company code, then enter the payment.',
    );
  }
  if (standing.isBlocked) throw new OutgoingPaymentError(`Vendor ${vendorNumber} is blocked for company ${companyCode}.`);
  if (!standing.reconciliationAccount) {
    throw new OutgoingPaymentError(
      `Vendor ${vendorNumber} carries no reconciliation account in company ${companyCode}.`,
      'Maintain the vendor company data, then enter the payment.',
    );
  }
  return standing;
}

export async function getPayables(
  client: string, vendorNumber: string, companyCode: string,
): Promise<OutgoingPaymentView> {
  return withTenant(client, async (tx) => {
    const vendor = await judgeVendor(tx, client, vendorNumber, companyCode);
    const dueDates = new Map<string, string>();
    const invoiceTerms = new Map<string, { termsCode: string | null; baseline: string | null }>();
    for (const inv of await tx.select().from(vendorInvoice).where(eq(vendorInvoice.client, client))) {
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
      valid: validApplicationSql('document'),
      paymentCredit: unappliedPaymentCreditSql('document'),
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
        eq(journalEntryLine.businessPartner, vendorNumber),
        eq(journalEntryLine.glAccount, vendor.reconciliationAccount!),
        eq(journalEntry.status, 'POSTED'),
        sql`${journalEntry.reversalOf} is null`,
        sql`${journalEntryLine.clearingDocument} is null`,
        // The source line is netted below; an application line must not stand beside it.
        // Reset offsets are already netted through `unappliedPaymentCreditSql`.
        notValidApplicationLineSql(undefined, { keepResetOffsets: false }),
      ))
      .orderBy(journalEntry.postingDate, journalEntryLine.documentNumber);
    // Each item's discount is rounded at its own currency's decimals.
    const itemMoney = new Map<string, Money>();
    for (const code of new Set(rows.map((r) => String(r.currency).trim()))) itemMoney.set(code, await moneyFor(tx, code));
    const openItems = rows.flatMap((r) => {
      // Open invoice liability: the debit less valid applications (advances and settlements).
      const liabilityUnits = toScaled(r.amount) - toScaled(String(r.valid ?? '0'));
      if (liabilityUnits < 0n) {
        throw new OutgoingPaymentError(
          `Payable ${r.documentNumber}/${r.fiscalYear}/${r.lineNumber} stands at ${fromScaled(liabilityUnits)} ${r.currency} after valid applications; they exceed the item.`,
          'Investigate the applications on this item before paying it.',
        );
      }
      // Payable: the liability less unapplied payment credits. An unapplied advance is not
      // netted here; it stays available for an explicit clearing.
      const payableUnits = liabilityUnits - toScaled(String(r.paymentCredit ?? '0'));
      if (payableUnits <= 0n) return [];
      const amount = fromScaled(payableUnits);
      const m = itemMoney.get(String(r.currency).trim())!;
      const signed = r.debitCredit === 'H' ? Number(amount) : -Number(amount);
      const terms = r.originClass === 'vendor_invoice' && r.originKey
        ? invoiceTerms.get(r.originKey) : undefined;
      const percent = signed > 0 && terms?.termsCode
        ? eligiblePercent(termsByCode.get(terms.termsCode) ?? null, terms.baseline, today)
        : 0;
      return [{
        documentNumber: r.documentNumber, fiscalYear: r.fiscalYear, lineNumber: r.lineNumber,
        postingDate: r.postingDate,
        dueDate: r.originClass === 'vendor_invoice' && r.originKey
          ? (dueDates.get(r.originKey) ?? r.postingDate)
          : r.postingDate,
        currency: r.currency, amount, signed,
        termsCode: terms?.termsCode ?? null,
        discountPercent: percent,
        discountAmount: m.round(m.fromUnits(m.percentOf(signed, percent))),
      }];
    });
    return {
      vendor: vendorNumber, companyCode, openItems,
      openBalance: Number(fromScaled(openItems.reduce((s, i) => s + roundToScale(i.signed, MONEY_SCALE), 0n))),
    };
  });
}

// ── Posting ────────────────────────────────────────────────────────────

export interface PaymentItemRef {
  documentNumber: string; fiscalYear: number; lineNumber: number;
  /** Cash applied to this item; defaults to its open amount minus any discount (SCR-080). */
  applied?: number;
  /** Cash discount taken on this item, judged against its terms. */
  discount?: number;
  /** When applied plus discount falls short: residual (default) or partial. */
  outcome?: 'RESIDUAL' | 'PARTIAL';
}

export interface PostedOutgoingPayment {
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

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<PostedOutgoingPayment | null> {
  const [row] = await tx.select().from(outgoingPayment).where(and(
    eq(outgoingPayment.client, client), eq(outgoingPayment.requestKey, requestKey),
  ));
  return row ? {
    paymentNumber: row.paymentNumber, journalDocumentNumber: row.journalDocumentNumber,
    amount: row.amount, itemsCleared: row.itemsCleared, clearingDate: row.clearingDate,
    bankGlAccount: row.bankGlAccount, bankAmount: row.bankAmount,
    bankCurrency: row.bankCurrency?.trim() ?? null, bankAmountSource: row.bankAmountSource,
  } : null;
}

function assertReplayEvidence(
  replay: PostedOutgoingPayment,
  input: { bankGlAccount: string; bankAmount?: string | number },
): void {
  if (replay.bankGlAccount.trim().toUpperCase() !== input.bankGlAccount.trim().toUpperCase()) {
    throw new OutgoingPaymentError(
      `Request key ${replay.paymentNumber} was already used for bank G/L ${replay.bankGlAccount}.`,
      'Use a new request key for a different bank account.',
    );
  }
  if (input.bankAmount === undefined || String(input.bankAmount).trim() === '') return;
  if (replay.bankAmountSource === 'NOT_RECORDED') return;
  if (toScaled(String(input.bankAmount)) !== toScaled(replay.bankAmount)) {
    throw new OutgoingPaymentError(
      `Request key ${replay.paymentNumber} was already used with actual bank amount ${replay.bankAmount} ${replay.bankCurrency ?? ''}.`,
      'Use a new request key when the actual bank amount differs.',
    );
  }
}

export async function postOutgoingPayment(input: {
  client: string; changedBy: string;
  vendorNumber: string; companyCode: string;
  documentDate: string; postingDate: string; clearingDate: string;
  bankGlAccount: string; amount: number; currency: string;
  /** The actual amount the bank account moved, in its own currency (required when it is local). */
  bankAmount?: string | number;
  reference?: string; valueDate?: string; requestKey: string;
  /** Remainder of the payment left standing as an open vendor debit. */
  onAccountAmount?: number;
  items: PaymentItemRef[];
}, options: { authorization?: ServiceAuthorityContext } = {}
): Promise<PostedOutgoingPayment> {
  if (input.items.length === 0 && !(Number(input.onAccountAmount ?? 0) > 0)) {
    throw new OutgoingPaymentError('Select at least one open item to settle.', 'Tick the items this payment settles, or enter an on-account amount.');
  }
  if (!(input.amount > 0)) throw new OutgoingPaymentError('The payment amount must stand above zero.');
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate], ['Clearing date', input.clearingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OutgoingPaymentError(`${label} ${value} is not a calendar date.`);
  }
  if (input.valueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.valueDate)) {
    throw new OutgoingPaymentError(`Value date ${input.valueDate} is not a calendar date.`);
  }
  if (input.reference && input.reference.length > 16) {
    throw new OutgoingPaymentError('The reference may be at most 16 characters.', 'Shorten the cheque or transfer reference.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    // The company's money leaves on this document, so it is paid by somebody: a
    // session that stands, the authority to pay, and a Company Code reach that covers
    // the company the vendor was bought from. A payment is a company's, not a
    // plant's — no plant grant is asked for.
    const authority = await verifyServiceAuthorityInTx(
      tx, input.client, options.authorization, OUTGOING_PAYMENT_CAPABILITY, { requirePlantScope: false },
    );
    if (!authority.ok) throw new OutgoingPaymentError(authority.refusal.message, authority.refusal.remedy);
    if (!hasOrgAccess(authority.restrictions, 'COMPANY_CODE', input.companyCode)) {
      throw new OutgoingPaymentError(
        `Your Company Code scope does not cover company code ${input.companyCode}.`,
        'Ask an administrator to extend your Company Code scope, then repeat the action.',
      );
    }

    if (replay) { assertReplayEvidence(replay, input); return replay; }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/outpay/${input.companyCode}/${input.vendorNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) { assertReplayEvidence(replayLocked, input); return replayLocked; }

    const vendor = await judgeVendor(tx, input.client, input.vendorNumber, input.companyCode);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new OutgoingPaymentError(`Company code ${input.companyCode} is not configured.`);
    await lockValuationSettlement(tx, input.client, input.companyCode);

    interface Held {
      ref: PaymentItemRef; amount: string; amountLocal: string; currency: string; debitCredit: 'S' | 'H';
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
      if (!line || line.businessPartner !== input.vendorNumber || line.companyCode !== input.companyCode
        || line.glAccount !== vendor.reconciliationAccount) {
        throw new OutgoingPaymentError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} is not an open payable of vendor ${input.vendorNumber} in company ${input.companyCode}.`,
          'Reload the open items, then post.',
        );
      }
      if (line.clearingDocument) {
        throw new OutgoingPaymentError(
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
      if (header?.originClass === 'vendor_invoice' && header.originKey) {
        const [inv] = await tx.select().from(vendorInvoice).where(and(
          eq(vendorInvoice.client, input.client), eq(vendorInvoice.invoiceNumber, header.originKey),
        ));
        if (inv) {
          termsCode = inv.paymentTerms;
          baseline = inv.baselineDate ?? inv.documentDate;
        }
      }
      // Recompute the eligible payable inside this transaction: the open liability less
      // unapplied payment credits. The proposal amount is never trusted on its own.
      const balances = await openItemBalances(tx, input.client, {
        documentNumber: line.documentNumber, companyCode: line.companyCode,
        businessPartner: line.businessPartner, glAccount: line.glAccount,
        currency: line.currency, debitCredit: line.debitCredit,
      });
      const liabilityDocument = toScaled(line.amountDocument) - balances.liability.document;
      const liabilityLocal = toScaled(line.amountLocal) - balances.liability.local;
      if (liabilityDocument < 0n || liabilityLocal < 0n) {
        throw new OutgoingPaymentError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} carries applications beyond its amount; the payable position cannot be proved.`,
          'Investigate the applications on this item before paying it.',
        );
      }
      const netDocument = liabilityDocument - balances.paymentCredit.document;
      const netLocal = liabilityLocal - balances.paymentCredit.local;
      if (netDocument <= 0n || netLocal < 0n) {
        throw new OutgoingPaymentError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} stands fully covered by applications and unapplied payment credits and cannot be paid again.`,
          'Reload the open items, then post.',
        );
      }
      held.push({
        ref, amount: fromScaled(netDocument), amountLocal: fromScaled(netLocal), currency: line.currency,
        debitCredit: line.debitCredit as 'S' | 'H', reconAccount: line.glAccount,
        termsCode, baseline,
      });
    }

    const currencies = [...new Set([...held.map((h) => h.currency), input.currency.toUpperCase()])];
    if (currencies.length > 1) {
      throw new OutgoingPaymentError(
        `The payment and its items stand in ${currencies.join(' and ')}; one payment settles one currency.`,
        'Allocate items in the payment currency.',
      );
    }
    // ── Completion judging (SCR-080 / R-128) ──────────────────────────
    const tolerance = await defaultTolerance(tx, input.client, input.companyCode);
    const termsByCode = new Map<string, typeof paymentTerms.$inferSelect>();
    for (const row of await tx.select().from(paymentTerms).where(eq(paymentTerms.client, input.client))) {
      termsByCode.set(row.termsCode, row);
    }

    // Every amount below is a scaled integer at the PAYMENT currency's decimals (see incoming-payment.ts):
    // entered amounts with excess precision are refused, calculated ones rounded once, comparisons exact.
    const money = await moneyFor(tx, currencies[0]!).catch((error: unknown) => {
      if (error instanceof MoneyError) throw new OutgoingPaymentError(error.message, error.remedy);
      throw error;
    });
    // What the payment costs the company on the posting date. A foreign payable without a
    // maintained rate is refused; it is never booked at 1.
    const rate = await requireExchangeRate(
      tx, input.client, currencies[0]!, company.currency, input.postingDate,
    ).catch((error: unknown) => {
      if (error instanceof Error && 'remedy' in error) {
        throw new OutgoingPaymentError(error.message, (error as { remedy?: string }).remedy);
      }
      throw error;
    });
    const localMoney = await moneyFor(tx, company.currency).catch((error: unknown) => {
      if (error instanceof MoneyError) throw new OutgoingPaymentError(error.message, error.remedy);
      throw error;
    });
    const localScale = localMoney.scale;
    const sameCurrency = currencies[0]!.toUpperCase() === company.currency.toUpperCase();

    const bank = await bankCurrencyForGl(tx, input.client, input.companyCode, input.bankGlAccount);
    if (bank.kind === 'ambiguous') {
      throw new OutgoingPaymentError(
        `G/L account ${input.bankGlAccount} belongs to ${bank.count} bank accounts in company ${input.companyCode}.`,
        'Give each bank account its own bank G/L account, then enter the payment.',
      );
    }
    if (bank.kind === 'unique') {
      const refusal = bankCurrencyRefusal(company.currency, currencies[0]!, bank.currency);
      if (refusal) {
        throw new OutgoingPaymentError(
          refusal,
          'Pay through a bank account held in the payment currency or in the company local currency. A third-currency bank movement cannot be represented safely by one journal.',
        );
      }
    }

    for (const h of held) {
      const conflict = await activeValuationConflict(tx, input.client, input.companyCode, {
        documentNumber: h.ref.documentNumber, lineNumber: h.ref.lineNumber,
        accountNumber: h.reconAccount, currency: h.currency,
      }, input.postingDate);
      if (conflict) {
        throw new OutgoingPaymentError(
          `Document ${h.ref.documentNumber} line ${h.ref.lineNumber} was valued at period end by run ${conflict.runId} (key date ${conflict.valuationKeyDate}).`,
          'Reverse that FX valuation document first, then settle the item. Settling over an active valuation would count the same exchange difference twice.',
        );
      }
    }
    const enter = (value: number, label: string): bigint => {
      try { return money.entered(value, label); } catch (error) {
        if (error instanceof MoneyError) throw new OutgoingPaymentError(error.message, error.remedy);
        throw error;
      }
    };
    const paymentUnits = enter(input.amount, 'The outgoing amount');

    // The bank account's own movement. A local-currency bank paying a foreign invoice can debit a
    // different local amount than the master rate implies; the clerk states it. Same-currency
    // accounts need no second entry, and a third currency is refused above.
    const bankCurrency = bank.kind === 'unique' ? bank.currency.trim().toUpperCase() : null;
    let bankLocalUnits: bigint;
    let bankAccountAmount: string;
    let bankAccountCurrency: string | null;
    let bankAmountSource: 'SAME_CURRENCY' | 'PAYMENT_CURRENCY' | 'USER_ACTUAL' | 'BANK_NOT_IDENTIFIED';
    const statedBankAmount = input.bankAmount === undefined || String(input.bankAmount).trim() === ''
      ? null : input.bankAmount;
    if (bankCurrency !== null && bankCurrency === company.currency.trim().toUpperCase() && !sameCurrency) {
      if (statedBankAmount === null) {
        throw new OutgoingPaymentError(
          `Bank account ${input.bankGlAccount} is held in ${bankCurrency}, but the payment stands in ${currencies[0]}. The actual bank amount is required.`,
          `Enter the amount the bank actually debited, in ${bankCurrency}. The posting-date rate is used for the payable, not invented as the bank movement.`,
        );
      }
      let enteredUnits: bigint;
      try {
        enteredUnits = localMoney.entered(statedBankAmount, 'The actual bank amount');
      } catch (error) {
        if (error instanceof MoneyError) throw new OutgoingPaymentError(error.message, error.remedy);
        throw error;
      }
      if (enteredUnits <= 0n) throw new OutgoingPaymentError('The actual bank amount must stand above zero.');
      bankLocalUnits = enteredUnits * 10n ** BigInt(MONEY_SCALE - localScale);
      bankAccountAmount = localMoney.fromUnits(enteredUnits);
      bankAccountCurrency = bankCurrency;
      bankAmountSource = 'USER_ACTUAL';
    } else if (bankCurrency !== null && bankCurrency === currencies[0]!.trim().toUpperCase()) {
      if (statedBankAmount !== null) {
        let stated: bigint;
        try { stated = money.entered(statedBankAmount, 'The actual bank amount'); } catch (error) {
          if (error instanceof MoneyError) throw new OutgoingPaymentError(error.message, error.remedy);
          throw error;
        }
        if (stated !== paymentUnits) {
          throw new OutgoingPaymentError(
            `The actual bank amount ${money.fromUnits(stated)} ${bankCurrency} does not equal the payment of ${money.fromUnits(paymentUnits)} ${currencies[0]}.`,
            'When the bank account is held in the payment currency its movement is the payment amount; do not restate it.',
          );
        }
      }
      bankLocalUnits = localUnitsOf(paymentUnits, money.scale, localScale, rate);
      bankAccountAmount = money.fromUnits(paymentUnits);
      bankAccountCurrency = bankCurrency;
      bankAmountSource = sameCurrency ? 'SAME_CURRENCY' : 'PAYMENT_CURRENCY';
    } else if (bankCurrency === null) {
      if (statedBankAmount !== null) {
        throw new OutgoingPaymentError(
          `G/L account ${input.bankGlAccount} is not identified as a bank account, so the actual bank amount ${statedBankAmount} cannot be validated.`,
          'Maintain the bank account for this G/L (one bank account per G/L), then enter the actual amount.',
        );
      }
      bankLocalUnits = localUnitsOf(paymentUnits, money.scale, localScale, rate);
      bankAccountAmount = money.fromUnits(paymentUnits);
      bankAccountCurrency = null;
      bankAmountSource = 'BANK_NOT_IDENTIFIED';
    } else {
      throw new OutgoingPaymentError(
        `Bank currency ${bankCurrency} is neither the payment currency nor the local currency.`,
        'Pay through a bank account held in the payment currency or in the company local currency.',
      );
    }

    interface Settled {
      h: Held; open: bigint; applied: bigint; discount: bigint;
      outcome: 'FULL' | 'RESIDUAL' | 'PARTIAL'; residual: bigint;
      openLocal: bigint; releasedLocal: bigint; discountLocal: bigint; residualLocal: bigint;
    }
    const settled: Settled[] = [];
    for (const h of held) {
      const open = h.debitCredit === 'H' ? money.units(h.amount) : -money.units(h.amount);
      const discount = enter(h.ref.discount ?? 0, 'The discount');
      if (open < 0n) {
        // A debit item (the vendor side of a credit memo) nets in full.
        const applied = h.ref.applied === undefined ? open : enter(h.ref.applied, 'The applied amount');
        if (discount !== 0n || applied !== open) {
          throw new OutgoingPaymentError(
            `Document ${h.ref.documentNumber} line ${h.ref.lineNumber} is a debit item and settles in full without discount.`,
            'Take debit items whole; they net against the payment.',
          );
        }
        const openLocal = toScaled(h.amountLocal);
        settled.push({
          h, open, applied, discount: 0n, outcome: 'FULL', residual: 0n,
          openLocal, releasedLocal: openLocal, discountLocal: 0n, residualLocal: 0n,
        });
        continue;
      }
      const applied = h.ref.applied === undefined ? open - discount : enter(h.ref.applied, 'The applied amount');
      if (applied < 0n || discount < 0n) {
        throw new OutgoingPaymentError(
          `Document ${h.ref.documentNumber} line ${h.ref.lineNumber}: applied and discount amounts may not stand negative.`,
        );
      }
      if (applied + discount > open) {
        throw new OutgoingPaymentError(
          `Document ${h.ref.documentNumber} line ${h.ref.lineNumber}: applied ${money.fromUnits(applied)} plus discount ${money.fromUnits(discount)} exceeds the open amount of ${money.fromUnits(open)}.`,
          'Apply no more than the item stands open at.',
        );
      }
      if (discount > 0n) {
        if (!h.termsCode) {
          throw new OutgoingPaymentError(
            `Document ${h.ref.documentNumber} line ${h.ref.lineNumber} carries no payment terms, so no cash discount stands eligible on it.`,
            'Take the discount only on items whose invoice terms allow it.',
          );
        }
        const percent = eligiblePercent(termsByCode.get(h.termsCode) ?? null, h.baseline, input.postingDate);
        const eligible = money.percentOf(money.fromUnits(open), percent);
        if (discount > eligible) {
          throw new OutgoingPaymentError(
            `The discount of ${money.fromUnits(discount)} on document ${h.ref.documentNumber} exceeds the eligible ${money.fromUnits(eligible)} (${percent}% under terms ${h.termsCode} at the posting date).`,
            'Take no more than the terms allow, or post without the discount.',
          );
        }
        if (!tolerance) {
          throw new OutgoingPaymentError(
            'No default tolerance group stands for this company scope, so a cash discount cannot be judged.',
            'Maintain the tolerance groups, then post.',
          );
        }
        const capPercent = Number(tolerance.maxCashDiscountPercent);
        const cap = money.percentOf(money.fromUnits(open), capPercent);
        if (discount > cap) {
          throw new OutgoingPaymentError(
            `The discount of ${money.fromUnits(discount)} on document ${h.ref.documentNumber} exceeds the tolerance maximum of ${capPercent}% (${money.fromUnits(cap)}).`,
            'Take no more than the tolerance group permits.',
          );
        }
      }
      const shortfall = open - applied - discount;
      // A part-settlement closes the original and carries the remainder as a residual open item;
      // leaving the original fully open would relieve the same carrying amount twice later.
      const outcome: Settled['outcome'] = shortfall <= 0n ? 'FULL' : 'RESIDUAL';
      const openLocal = toScaled(h.amountLocal);
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
    if (onAccount < 0n) throw new OutgoingPaymentError('The on-account amount may not stand negative.');

    // The unassigned remainder: tolerated as a posted difference, else refused.
    const unassigned = paymentUnits - cashApplied - onAccount;
    let differenceLine: { debitCredit: 'S' | 'H'; amount: bigint } | null = null;
    if (unassigned !== 0n) {
      const expense = unassigned > 0n;
      const magnitude = unassigned < 0n ? -unassigned : unassigned;
      const fail = () => new OutgoingPaymentError(
        `The payment leaves an unassigned difference of ${money.fromUnits(unassigned)} ${currencies[0]} beyond the tolerance of the default group.`,
        'Allocate the difference to items, post it on account, or widen the tolerance group.',
      );
      if (!tolerance) throw fail();
      const amountLimit = money.units(Number(expense ? tolerance.paymentDiffExpenseAmount : tolerance.paymentDiffRevenueAmount));
      const percentLimit = Number(expense ? tolerance.paymentDiffExpensePercent : tolerance.paymentDiffRevenuePercent);
      const percentAmount = money.percentOf(money.fromUnits(paymentUnits), percentLimit);
      if (magnitude > (amountLimit < percentAmount ? amountLimit : percentAmount)) throw fail();
      differenceLine = { debitCredit: expense ? 'S' : 'H', amount: magnitude };
    }

    const chart = vendor.chartOfAccounts;
    let discountAccount: string | null = null;
    if (discountTotal > 0n) {
      discountAccount = await determinationAccount(tx, input.client, chart, 'CASH_DISCOUNT', 'REV');
      if (!discountAccount) {
        throw new OutgoingPaymentError(
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
        throw new OutgoingPaymentError(
          `Account determination for PAYMENT_DIFFERENCE does not stand in chart ${chart}.`,
          'Maintain the account determination for the payment difference event, then post again.',
        );
      }
    }

    const recon = vendor.reconciliationAccount!;
    type Line = {
      glAccount: string; debitCredit: 'S' | 'H'; amount: string; amountLocal: string;
      localOnly?: boolean; businessPartner?: string; lineText?: string;
    };
    const localText = (unitsDocument: bigint) => sameCurrency
      ? money.fromUnits(unitsDocument)
      : fromScaled(localUnitsOf(unitsDocument, money.scale, localScale, rate));
    const lines: Line[] = [];
    for (const x of settled) {
      if (x.open < 0n) {
        lines.push({
          glAccount: recon, debitCredit: 'H', amount: money.fromUnits(-x.open),
          amountLocal: sameCurrency ? money.fromUnits(-x.open) : fromScaled(x.openLocal),
          businessPartner: input.vendorNumber, lineText: `Settles ${x.h.ref.documentNumber}`,
        });
      } else {
        lines.push({
          glAccount: recon, debitCredit: 'S', amount: money.fromUnits(x.open),
          amountLocal: sameCurrency ? money.fromUnits(x.open) : fromScaled(x.openLocal),
          businessPartner: input.vendorNumber, lineText: `Settles ${x.h.ref.documentNumber}`,
        });
        if (x.outcome === 'RESIDUAL') {
          lines.push({
            glAccount: recon, debitCredit: 'H', amount: money.fromUnits(x.residual),
            amountLocal: sameCurrency ? money.fromUnits(x.residual) : fromScaled(x.residualLocal),
            businessPartner: input.vendorNumber, lineText: `Residual item for ${x.h.ref.documentNumber}`,
          });
        }
      }
    }
    if (onAccount > 0n) {
      lines.push({
        glAccount: recon, debitCredit: 'S', amount: money.fromUnits(onAccount),
        amountLocal: localText(onAccount),
        businessPartner: input.vendorNumber, lineText: 'On account',
      });
    }
    if (discountAccount && discountTotal > 0n) {
      lines.push({
        glAccount: discountAccount, debitCredit: 'H', amount: money.fromUnits(discountTotal),
        amountLocal: sameCurrency
          ? money.fromUnits(discountTotal)
          : fromScaled(settled.reduce((s, x) => s + x.discountLocal, 0n)),
        lineText: 'Cash discount received',
      });
    }
    if (differenceAccount && differenceLine) {
      lines.push({
        glAccount: differenceAccount, debitCredit: differenceLine.debitCredit,
        amount: money.fromUnits(differenceLine.amount), amountLocal: localText(differenceLine.amount),
        lineText: 'Payment difference',
      });
    }
    lines.push({
      glAccount: input.bankGlAccount, debitCredit: 'H', amount: money.fromUnits(paymentUnits),
      amountLocal: fromScaled(bankLocalUnits),
    });

    // Realized exchange difference: paying more local than the payable carried is a loss; paying
    // less is a gain. The local-only line carries the difference without a document amount.
    const localSigned = lines.reduce(
      (total, line) => total + (line.debitCredit === 'S' ? toScaled(line.amountLocal) : -toScaled(line.amountLocal)),
      0n,
    );
    let realizedLocal = 0n;
    if (sameCurrency && localSigned !== 0n) {
      throw new OutgoingPaymentError(
        'The same-currency payment does not balance in the local currency.',
        'Reload the open items and try again; nothing has been posted.',
      );
    }
    if (!sameCurrency && localSigned !== 0n) {
      realizedLocal = localSigned < 0n ? -localSigned : localSigned;
      const event = localSigned > 0n ? 'FXGAIN' : 'FXLOSS';
      const account = await fxDifferenceAccount(tx, input.client, chart, event);
      if (!account) {
        throw new OutgoingPaymentError(
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
      headerText: `Outgoing payment ${input.vendorNumber}`,
      lines,
      origin: { documentClass: PAYMENT_CLASS, documentKey: `${input.companyCode}/${input.vendorNumber}` },
      postedBy: input.changedBy,
      transactionCode: OUTGOING_PAYMENT_CAPABILITY,
      precision: 'CURRENCY',
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new OutgoingPaymentError(error.message, error.remedy);
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
      eq(journalEntryLine.businessPartner, input.vendorNumber),
      sql`${journalEntryLine.lineText} like 'Settles %'`,
    ));

    const paymentNumber = journal.documentNumber;
    await tx.insert(outgoingPayment).values({
      client: input.client, paymentNumber, fiscalYear: journal.fiscalYear,
      vendorNumber: input.vendorNumber, companyCode: input.companyCode,
      documentDate: input.documentDate, postingDate: input.postingDate, clearingDate: input.clearingDate,
      valueDate: input.valueDate ?? null,
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
      objectKey: `${input.companyCode}/${input.vendorNumber}/${paymentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: OUTGOING_PAYMENT_CAPABILITY,
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
