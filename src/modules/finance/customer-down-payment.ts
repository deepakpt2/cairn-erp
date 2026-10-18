/**
 * Customer down payment entry — SCR-083 / R-131.
 *
 * A down payment received from a customer against a special G/L
 * indicator: the bank debits and the indicator's configured
 * alternative customer reconciliation account credits (a DZ
 * journal), so the advance stands open outside the customer's
 * ordinary receivables until it is cleared against invoices —
 * clearing stands deferred to its own round (F-39). The indicator
 * is configuration, never a hardcoded letter: it resolves
 * company-scope first, then the tenant-wide default, and an
 * unconfigured indicator is refused by name. Requests (F-37) are
 * a separate process and stand deferred; the receipt replays by
 * request key and revalidates under its advisory lock.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { customerCompany } from '../foundation/customer-company-schema';
import { customerDownPayment, journalEntryLine } from './schema';
import { resolveSpecialGlAccount } from './vendor-down-payment';

export const CUSTOMER_DOWN_PAYMENT_CAPABILITY = 'FIN.AR.DOWNPAYMENT.POST';
const JOURNAL_DOCUMENT_TYPE = 'DZ';
const PAYMENT_CLASS = 'customer_down_payment';

export class CustomerDownPaymentError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerDownPaymentError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

async function judgeCustomer(tx: Tx, client: string, customerNumber: string, companyCode: string) {
  const [standing] = await tx.select().from(customerCompany).where(and(
    eq(customerCompany.client, client),
    eq(customerCompany.partnerNumber, customerNumber),
    eq(customerCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new CustomerDownPaymentError(
      `Customer ${customerNumber} does not stand extended to company ${companyCode}.`,
      'Extend the customer to the company code, then enter the down payment.',
    );
  }
  if (standing.isBlocked) throw new CustomerDownPaymentError(`Customer ${customerNumber} is blocked for company ${companyCode}.`);
  return standing;
}

async function resolveIndicator(
  tx: Tx, client: string, companyCode: string, indicator: string,
): Promise<string> {
  try {
    return await resolveSpecialGlAccount(tx, client, companyCode, indicator, 'AR');
  } catch (error) {
    if (error instanceof Error) throw new CustomerDownPaymentError(error.message);
    throw error;
  }
}

export interface PostedCustomerDownPayment {
  paymentNumber: string;
  journalDocumentNumber: string;
  amount: string;
  alternativeAccount: string;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<PostedCustomerDownPayment | null> {
  const [row] = await tx.select().from(customerDownPayment).where(and(
    eq(customerDownPayment.client, client), eq(customerDownPayment.requestKey, requestKey),
  ));
  return row ? {
    paymentNumber: row.paymentNumber, journalDocumentNumber: row.journalDocumentNumber,
    amount: row.amount, alternativeAccount: row.alternativeReconciliationAccount,
  } : null;
}

export async function postCustomerDownPayment(input: {
  client: string; changedBy: string;
  customerNumber: string; companyCode: string;
  documentDate: string; postingDate: string;
  bankGlAccount: string; amount: number; currency: string;
  specialGlIndicator: string;
  reference?: string; valueDate?: string; text?: string; requestKey: string;
}): Promise<PostedCustomerDownPayment> {
  if (!(input.amount > 0)) throw new CustomerDownPaymentError('The down payment amount must stand above zero.');
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CustomerDownPaymentError(`${label} ${value} is not a calendar date.`);
  }
  if (input.valueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.valueDate)) {
    throw new CustomerDownPaymentError(`Value date ${input.valueDate} is not a calendar date.`);
  }
  if (!/^[A-Za-z0-9]$/.test(input.specialGlIndicator)) {
    throw new CustomerDownPaymentError('The special G/L indicator is a single character.', 'Enter the configured one-character indicator.');
  }
  if (input.reference && input.reference.length > 16) {
    throw new CustomerDownPaymentError('The reference may be at most 16 characters.', 'Shorten the receipt reference.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/custdownpay/${input.companyCode}/${input.customerNumber}`}, 0))`);
    const replayLocked = await byRequestKey(tx, input.client, input.requestKey);
    if (replayLocked) return replayLocked;

    await judgeCustomer(tx, input.client, input.customerNumber, input.companyCode);
    const alternativeAccount = await resolveIndicator(tx, input.client, input.companyCode, input.specialGlIndicator);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new CustomerDownPaymentError(`Company code ${input.companyCode} is not configured.`);

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
      headerText: input.text || `Customer down payment ${input.customerNumber}`,
      lines: [
        { glAccount: input.bankGlAccount, debitCredit: 'S' as const, amount: round4(input.amount).toFixed(2) },
        {
          glAccount: alternativeAccount, debitCredit: 'H' as const,
          amount: round4(input.amount).toFixed(2), businessPartner: input.customerNumber,
          lineText: `Down payment ${input.specialGlIndicator}`,
        },
      ],
      origin: { documentClass: PAYMENT_CLASS, documentKey: `${input.companyCode}/${input.customerNumber}` },
      postedBy: input.changedBy,
      transactionCode: CUSTOMER_DOWN_PAYMENT_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new CustomerDownPaymentError(error.message, error.remedy);
      throw error;
    });

    const paymentNumber = journal.documentNumber;
    await tx.insert(customerDownPayment).values({
      client: input.client, paymentNumber, fiscalYear: journal.fiscalYear,
      customerNumber: input.customerNumber, companyCode: input.companyCode,
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
      objectKey: `${input.companyCode}/${input.customerNumber}/${paymentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CUSTOMER_DOWN_PAYMENT_CAPABILITY,
      after: { journal: journal.documentNumber, amount: round4(input.amount), indicator: input.specialGlIndicator },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}

// The receipt's own credit line stands open until clearing; it is
// listed here so screens and later clearing can find them.
export async function getCustomerDownPayments(
  client: string, customerNumber: string, companyCode: string,
): Promise<Array<{ documentNumber: string; fiscalYear: number; amount: string; postingDate: string }>> {
  return withTenant(client, async (tx) => {
    await judgeCustomer(tx, client, customerNumber, companyCode);
    const rows = await tx.select({
      documentNumber: journalEntryLine.documentNumber,
      fiscalYear: journalEntryLine.fiscalYear,
      amount: journalEntryLine.amountLocal,
      postingDate: customerDownPayment.postingDate,
    }).from(journalEntryLine)
      .innerJoin(customerDownPayment, and(
        eq(customerDownPayment.client, journalEntryLine.client),
        eq(customerDownPayment.journalDocumentNumber, journalEntryLine.documentNumber),
      ))
      .where(and(
        eq(journalEntryLine.client, client),
        eq(journalEntryLine.companyCode, companyCode),
        eq(journalEntryLine.businessPartner, customerNumber),
        sql`${journalEntryLine.clearingDocument} is null`,
        sql`${journalEntryLine.lineText} like 'Down payment %'`,
      ));
    return rows.map((r) => ({
      documentNumber: r.documentNumber, fiscalYear: r.fiscalYear,
      amount: r.amount, postingDate: r.postingDate,
    }));
  });
}
