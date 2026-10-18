/**
 * Vendor down payment entry — SCR-081 / R-129.
 *
 * A down payment pays a vendor in advance against a special G/L
 * indicator: the indicator's configured alternative reconciliation
 * account debits and the bank credits (a KA journal), so the
 * advance stands open outside the vendor's ordinary payables until
 * it is cleared against invoices — clearing stands deferred to
 * its own round (F-54). The indicator is configuration, never a
 * hardcoded letter: it resolves company-scope first, then the
 * tenant-wide default, and an unconfigured indicator is refused
 * by name. Requests (F-47) are a separate process and stand
 * deferred; the payment replays by request key and revalidates
 * under its advisory lock.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { specialGlConfig } from '../foundation/schema';
import { journalEntryLine, vendorDownPayment } from './schema';

export const VENDOR_DOWN_PAYMENT_CAPABILITY = 'FIN.AP.DOWNPAYMENT.POST';
const JOURNAL_DOCUMENT_TYPE = 'KA';
const PAYMENT_CLASS = 'vendor_down_payment';

export class VendorDownPaymentError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'VendorDownPaymentError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

async function judgeVendor(tx: Tx, client: string, vendorNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(supplierCompany).where(and(
    eq(supplierCompany.client, client),
    eq(supplierCompany.partnerNumber, vendorNumber),
    eq(supplierCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new VendorDownPaymentError(
      `Vendor ${vendorNumber} does not stand extended to company ${companyCode}.`,
      'Extend the vendor to the company code, then enter the down payment.',
    );
  }
  if (standing.isBlocked) throw new VendorDownPaymentError(`Vendor ${vendorNumber} is blocked for company ${companyCode}.`);
  return standing;
}

/** The alternative reconciliation account an indicator resolves to. */
export async function resolveSpecialGlAccount(
  tx: Tx, client: string, companyCode: string, indicator: string, accountType: 'AP' | 'AR' = 'AP',
): Promise<string> {
  const rows = await tx.select().from(specialGlConfig).where(and(
    eq(specialGlConfig.client, client),
    eq(specialGlConfig.accountType, accountType),
    eq(specialGlConfig.indicator, indicator),
  ));
  const row = rows.find((r) => r.companyCode === companyCode) ?? rows.find((r) => r.companyCode === '');
  if (!row) {
    throw new VendorDownPaymentError(
      `Special G/L indicator ${indicator} is not configured for ${accountType === 'AP' ? 'vendors' : 'customers'} in company ${companyCode}.`,
      'Maintain the special G/L configuration for the indicator, then post again.',
    );
  }
  return row.alternativeReconciliationAccount;
}

export interface PostedDownPayment {
  paymentNumber: string;
  journalDocumentNumber: string;
  amount: string;
  alternativeAccount: string;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<PostedDownPayment | null> {
  const [row] = await tx.select().from(vendorDownPayment).where(and(
    eq(vendorDownPayment.client, client), eq(vendorDownPayment.requestKey, requestKey),
  ));
  return row ? {
    paymentNumber: row.paymentNumber, journalDocumentNumber: row.journalDocumentNumber,
    amount: row.amount, alternativeAccount: row.alternativeReconciliationAccount,
  } : null;
}

export async function postVendorDownPayment(input: {
  client: string; changedBy: string;
  vendorNumber: string; companyCode: string;
  documentDate: string; postingDate: string;
  bankGlAccount: string; amount: number; currency: string;
  specialGlIndicator: string;
  reference?: string; valueDate?: string; text?: string; requestKey: string;
}): Promise<PostedDownPayment> {
  if (!(input.amount > 0)) throw new VendorDownPaymentError('The down payment amount must stand above zero.');
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new VendorDownPaymentError(`${label} ${value} is not a calendar date.`);
  }
  if (input.valueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.valueDate)) {
    throw new VendorDownPaymentError(`Value date ${input.valueDate} is not a calendar date.`);
  }
  if (!/^[A-Za-z0-9]$/.test(input.specialGlIndicator)) {
    throw new VendorDownPaymentError('The special G/L indicator is a single character.', 'Enter the configured one-character indicator.');
  }
  if (input.reference && input.reference.length > 16) {
    throw new VendorDownPaymentError('The reference may be at most 16 characters.', 'Shorten the payment reference.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/downpay/${input.companyCode}/${input.vendorNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) return replayLocked;

    await judgeVendor(tx, input.client, input.vendorNumber, input.companyCode);
    const alternativeAccount = await resolveSpecialGlAccount(tx, input.client, input.companyCode, input.specialGlIndicator);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new VendorDownPaymentError(`Company code ${input.companyCode} is not configured.`);

    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: input.companyCode,
      documentType: JOURNAL_DOCUMENT_TYPE,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: input.currency.toUpperCase(),
      localCurrency: company.currency,
      reference: input.reference,
      headerText: input.text || `Vendor down payment ${input.vendorNumber}`,
      lines: [
        {
          glAccount: alternativeAccount, debitCredit: 'S' as const,
          amount: round4(input.amount).toFixed(2), businessPartner: input.vendorNumber,
          lineText: `Down payment ${input.specialGlIndicator}`,
        },
        { glAccount: input.bankGlAccount, debitCredit: 'H' as const, amount: round4(input.amount).toFixed(2) },
      ],
      origin: { documentClass: PAYMENT_CLASS, documentKey: `${input.companyCode}/${input.vendorNumber}` },
      postedBy: input.changedBy,
      transactionCode: VENDOR_DOWN_PAYMENT_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new VendorDownPaymentError(error.message, error.remedy);
      throw error;
    });

    const paymentNumber = journal.documentNumber;
    await tx.insert(vendorDownPayment).values({
      client: input.client, paymentNumber, fiscalYear: journal.fiscalYear,
      vendorNumber: input.vendorNumber, companyCode: input.companyCode,
      documentDate: input.documentDate, postingDate: input.postingDate,
      valueDate: input.valueDate ?? null,
      bankGlAccount: input.bankGlAccount,
      specialGlIndicator: input.specialGlIndicator,
      alternativeReconciliationAccount: alternativeAccount,
      amount: String(round4(input.amount)),
      currency: input.currency.toUpperCase(), reference: input.reference ?? null,
      headerText: input.text ?? null,
      journalDocumentNumber: journal.documentNumber,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client, objectClass: PAYMENT_CLASS,
      objectKey: `${input.companyCode}/${input.vendorNumber}/${paymentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: VENDOR_DOWN_PAYMENT_CAPABILITY,
      after: { journal: journal.documentNumber, amount: round4(input.amount), indicator: input.specialGlIndicator },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}

// The down payment's own journal line stands open until clearing;
// it is listed here so screens and later clearing can find them.
export async function getVendorDownPayments(
  client: string, vendorNumber: string, companyCode: string,
): Promise<Array<{ documentNumber: string; fiscalYear: number; amount: string; postingDate: string }>> {
  return withTenant(client, async (tx) => {
    await judgeVendor(tx, client, vendorNumber, companyCode);
    const rows = await tx.select({
      documentNumber: journalEntryLine.documentNumber,
      fiscalYear: journalEntryLine.fiscalYear,
      amount: journalEntryLine.amountLocal,
      postingDate: vendorDownPayment.postingDate,
    }).from(journalEntryLine)
      .innerJoin(vendorDownPayment, and(
        eq(vendorDownPayment.client, journalEntryLine.client),
        eq(vendorDownPayment.journalDocumentNumber, journalEntryLine.documentNumber),
      ))
      .where(and(
        eq(journalEntryLine.client, client),
        eq(journalEntryLine.companyCode, companyCode),
        eq(journalEntryLine.businessPartner, vendorNumber),
        sql`${journalEntryLine.clearingDocument} is null`,
        sql`${journalEntryLine.lineText} like 'Down payment %'`,
      ));
    return rows.map((r) => ({
      documentNumber: r.documentNumber, fiscalYear: r.fiscalYear,
      amount: r.amount, postingDate: r.postingDate,
    }));
  });
}
