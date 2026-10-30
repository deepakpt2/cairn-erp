/**
 * Customer invoice posting, direct — SCR-067 / R-115.
 *
 * Revenue lines carry tax-exclusive net amounts; output tax
 * calculates at the standing rate per line tax code. The gross is
 * judged: net plus tax must equal it. The journal debits the
 * customer's reconciliation account at gross with the customer as
 * partner — the receivable open item — credits each revenue line
 * and the tax account. Cancellation is a linked mirror by journal
 * reversal. A posted invoice is never edited or deleted.
 */
import { and, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { accountDetermination, profitCenter, taxCode } from '../foundation/schema';
import { customerCompany } from '../foundation/customer-company-schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import { customerInvoice, customerInvoiceLine } from '../purchasing/schema';
import { sql } from 'drizzle-orm';

export const CUSTOMER_INVOICE_CAPABILITY = 'FIN.AR.INVOICE.POST';
const JOURNAL_DOCUMENT_TYPE = 'DR';
const INVOICE_CLASS = 'customer_invoice';

export class CustomerInvoiceError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerInvoiceError';
    this.remedy = remedy;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CustomerInvoiceView {
  invoiceNumber: string;
  fiscalYear: number;
  category: string;
  creditOf: string | null;
  customerNumber: string;
  companyCode: string;
  documentDate: string;
  postingDate: string;
  reference: string;
  currency: string;
  grossAmount: string;
  taxAmount: string;
  paymentTerms: string | null;
  baselineDate: string | null;
  dueDate: string | null;
  status: string;
  journalDocumentNumber: string | null;
  cancelledBy: string | null;
  cancellationOf: string | null;
  lines: Array<{
    lineNumber: number; glAccount: string; netAmount: string;
    taxCode: string | null; taxAmount: string; profitCenter: string | null; lineText: string | null;
  }>;
}

function toView(
  header: typeof customerInvoice.$inferSelect,
  lines: Array<typeof customerInvoiceLine.$inferSelect>,
): CustomerInvoiceView {
  return {
    invoiceNumber: header.invoiceNumber, fiscalYear: header.fiscalYear,
    category: header.category, creditOf: header.creditOf,
    customerNumber: header.customerNumber,
    companyCode: header.companyCode, documentDate: header.documentDate,
    postingDate: header.postingDate, reference: header.reference,
    currency: header.currency, grossAmount: header.grossAmount, taxAmount: header.taxAmount,
    paymentTerms: header.paymentTerms, baselineDate: header.baselineDate, dueDate: header.dueDate,
    status: header.status, journalDocumentNumber: header.journalDocumentNumber,
    cancelledBy: header.cancelledBy, cancellationOf: header.cancellationOf,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber, glAccount: l.glAccount, netAmount: l.netAmount,
      taxCode: l.taxCode, taxAmount: l.taxAmount, profitCenter: l.profitCenter, lineText: l.lineText,
    })),
  };
}

async function loadView(tx: Tx, client: string, number: string): Promise<CustomerInvoiceView | null> {
  const [header] = await tx.select().from(customerInvoice).where(and(
    eq(customerInvoice.client, client), eq(customerInvoice.invoiceNumber, number),
  ));
  if (!header) return null;
  const lines = await tx.select().from(customerInvoiceLine).where(and(
    eq(customerInvoiceLine.client, client), eq(customerInvoiceLine.invoiceNumber, number),
  )).orderBy(customerInvoiceLine.lineNumber);
  return toView(header, lines);
}

export async function getCustomerInvoice(client: string, number: string): Promise<CustomerInvoiceView | null> {
  return withTenant(client, (tx) => loadView(tx, client, number));
}

async function byRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(customerInvoice).where(and(
    eq(customerInvoice.client, client), eq(customerInvoice.requestKey, requestKey),
  ));
  return header ? loadView(tx, client, header.invoiceNumber) : null;
}

export interface TaxCodeChoice { code: string; ratePercent: string; name: string }

export async function listCustomerInvoiceTaxCodes(client: string, companyCode: string): Promise<TaxCodeChoice[]> {
  return withTenant(client, async (tx) => {
    const company = await getCompanyCode(tx, client, companyCode);
    if (!company?.country) return [];
    const rows = await tx.select().from(taxCode).where(and(
      eq(taxCode.client, client), eq(taxCode.country, company.country),
    ));
    return rows.map((r) => ({ code: r.taxCode, ratePercent: r.ratePercent, name: r.name }));
  });
}

async function taxAccount(tx: Tx, client: string, chart: string): Promise<string> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, 'TAX'),
  ));
  const row = rows.find((r) => r.valuationClass === '') ?? rows[0];
  if (!row) {
    throw new CustomerInvoiceError(
      `Account determination for TAX does not stand in chart ${chart}.`,
      'Maintain the account determination for the tax event, then post again.',
    );
  }
  return row.glAccount;
}

export interface PostCustomerInvoiceInput {
  client: string; changedBy: string;
  customerNumber: string; companyCode: string;
  documentDate: string; postingDate: string;
  reference: string; currency: string;
  paymentTermsCode?: string;
  grossAmount: number;
  /** INVOICE | CREDIT_MEMO — defaults to INVOICE. */
  category?: string;
  /** Optional link to the original customer invoice this document stands against. */
  creditOf?: string;
  headerText?: string;
  requestKey: string;
  lines: Array<{
    glAccount: string; netAmount: number; taxCode?: string;
    profitCenter?: string; lineText?: string;
  }>;
}

export async function postCustomerInvoice(input: PostCustomerInvoiceInput): Promise<CustomerInvoiceView> {
  if (input.lines.length === 0) {
    throw new CustomerInvoiceError('Enter at least one revenue line.', 'Add a G/L line with its net amount.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/custinv/${input.companyCode}/${input.customerNumber}`}, 0))`);

    const [customer] = await tx.select().from(customerCompany).where(and(
      eq(customerCompany.client, input.client),
      eq(customerCompany.partnerNumber, input.customerNumber),
      eq(customerCompany.companyCode, input.companyCode),
    ));
    if (!customer) {
      throw new CustomerInvoiceError(
        `Customer ${input.customerNumber} does not stand extended to company ${input.companyCode}.`,
        'Extend the customer to the company code, then post.',
      );
    }
    if (customer.isBlocked) throw new CustomerInvoiceError(`Customer ${input.customerNumber} is blocked for company ${input.companyCode}.`);
    if (!customer.reconciliationAccount) {
      throw new CustomerInvoiceError(
        `Customer ${input.customerNumber} carries no reconciliation account in company ${input.companyCode}.`,
        'Maintain the customer company data, then post.',
      );
    }
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant || !company.country) {
      throw new CustomerInvoiceError(`Company code ${input.companyCode} is not configured.`);
    }
    const chart = customer.chartOfAccounts;

    const duplicates = await tx.select().from(customerInvoice).where(and(
      eq(customerInvoice.client, input.client),
      eq(customerInvoice.companyCode, input.companyCode),
      eq(customerInvoice.customerNumber, input.customerNumber),
      eq(customerInvoice.reference, input.reference),
      eq(customerInvoice.status, 'POSTED'),
    ));
    const standing = duplicates.find((d) => !d.cancellationOf);
    if (standing) {
      throw new CustomerInvoiceError(
        `Reference ${input.reference} already stands posted for this customer as invoice ${standing.invoiceNumber}.`,
        'Load the standing invoice, or correct the reference.',
      );
    }

    // Tax per line at the standing rate for the company country.
    const rates = new Map<string, number>();
    for (const row of await tx.select().from(taxCode).where(and(
      eq(taxCode.client, input.client), eq(taxCode.country, company.country),
    ))) rates.set(row.taxCode, Number(row.ratePercent));

    interface Prepared { glAccount: string; net: number; taxCode: string | null; tax: number; profitCenter: string | null; lineText: string | null }
    const prepared: Prepared[] = [];
    for (const line of input.lines) {
      if (!(line.netAmount > 0)) throw new CustomerInvoiceError('Every line amount must stand above zero.');
      const code = (line.taxCode ?? '').toUpperCase() || null;
      let tax = 0;
      if (code) {
        const rate = rates.get(code);
        if (rate === undefined) {
          throw new CustomerInvoiceError(
            `Tax code ${code} does not stand for country ${company.country}.`,
            'Use a standing tax code, or leave the line untaxed.',
          );
        }
        tax = round2((line.netAmount * rate) / 100);
      }
      if (line.profitCenter) {
        const [pc] = await tx.select().from(profitCenter).where(and(
          eq(profitCenter.client, input.client), eq(profitCenter.profitCenter, line.profitCenter),
        ));
        if (!pc) {
          throw new CustomerInvoiceError(
            `Profit centre ${line.profitCenter} does not stand.`,
            'Use a standing profit centre, or leave it blank.',
          );
        }
      }
      prepared.push({
        glAccount: line.glAccount, net: round2(line.netAmount), taxCode: code, tax,
        profitCenter: line.profitCenter || null, lineText: line.lineText || null,
      });
    }

    const netTotal = round2(prepared.reduce((s, p) => s + p.net, 0));
    const taxTotal = round2(prepared.reduce((s, p) => s + p.tax, 0));
    if (Math.abs(round2(netTotal + taxTotal) - round2(input.grossAmount)) > 0.005) {
      throw new CustomerInvoiceError(
        `The gross amount ${round2(input.grossAmount).toFixed(2)} does not reconcile: lines net ${netTotal.toFixed(2)} plus tax ${taxTotal.toFixed(2)} is ${round2(netTotal + taxTotal).toFixed(2)}.`,
        'Correct the gross amount or the line amounts so the document balances.',
      );
    }

    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const journalLines: Array<{
      glAccount: string; debitCredit: 'S' | 'H'; amount: string;
      businessPartner?: string; taxCode?: string; profitCenter?: string;
    }> = [{
      glAccount: customer.reconciliationAccount, debitCredit: 'S',
      amount: round2(input.grossAmount).toFixed(2), businessPartner: input.customerNumber,
    }];
    for (const p of prepared) {
      journalLines.push({
        glAccount: p.glAccount, debitCredit: 'H', amount: p.net.toFixed(2),
        ...(p.profitCenter ? { profitCenter: p.profitCenter } : {}),
      });
    }
    const taxByCode = new Map<string, number>();
    for (const p of prepared) {
      if (p.tax > 0 && p.taxCode) taxByCode.set(p.taxCode, round2((taxByCode.get(p.taxCode) ?? 0) + p.tax));
    }
    if (taxByCode.size > 0) {
      const account = await taxAccount(tx, input.client, chart);
      for (const [code, amount] of taxByCode) {
        journalLines.push({ glAccount: account, debitCredit: 'H', amount: amount.toFixed(2), taxCode: code });
      }
    }

    // Payment terms and the due date they compute.
    const termsCode = input.paymentTermsCode || customer.paymentTermsCode;
    let baseline: string | null = null;
    let due: string | null = null;
    if (termsCode) {
      const [terms] = await tx.select().from(paymentTerms).where(and(
        eq(paymentTerms.client, input.client), eq(paymentTerms.termsCode, termsCode),
      ));
      if (!terms) {
        throw new CustomerInvoiceError(
          `Payment terms ${termsCode} do not stand.`,
          'Use standing payment terms, or clear the field to take the customer default.',
        );
      }
      baseline = terms.baselineSource === 'POSTING_DATE' ? input.postingDate : input.documentDate;
      const d = new Date(`${baseline}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + terms.netDays);
      due = d.toISOString().slice(0, 10);
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'CUSTINV', allocatedBy: input.changedBy,
    });
    const number = allocated.display;
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
      headerText: input.headerText,
      lines: journalLines,
      origin: { documentClass: INVOICE_CLASS, documentKey: number },
      postedBy: input.changedBy,
      transactionCode: CUSTOMER_INVOICE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new CustomerInvoiceError(error.message, error.remedy);
      throw error;
    });

    await tx.insert(customerInvoice).values({
      client: input.client, invoiceNumber: number, fiscalYear: position.fiscalYear,
      category: input.category ?? 'INVOICE', customerNumber: input.customerNumber, companyCode: input.companyCode,
      documentDate: input.documentDate, postingDate: input.postingDate,
      reference: input.reference, currency: input.currency.toUpperCase(),
      grossAmount: String(round2(input.grossAmount)), taxAmount: String(taxTotal),
      paymentTerms: termsCode ?? null, baselineDate: baseline, dueDate: due,
      headerText: input.headerText ?? null, status: 'POSTED',
      journalDocumentNumber: journal.documentNumber, requestKey: input.requestKey,
      creditOf: input.creditOf ?? null,
      createdBy: input.changedBy,
    });
    let lineNumber = 0;
    for (const p of prepared) {
      lineNumber += 1;
      await tx.insert(customerInvoiceLine).values({
        client: input.client, invoiceNumber: number, lineNumber,
        glAccount: p.glAccount, netAmount: String(p.net), taxCode: p.taxCode,
        taxAmount: String(p.tax), profitCenter: p.profitCenter, lineText: p.lineText,
        createdBy: input.changedBy,
      });
    }
    await recordChange(tx, {
      client: input.client, objectClass: INVOICE_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CUSTOMER_INVOICE_CAPABILITY,
      after: { customer: input.customerNumber, gross: round2(input.grossAmount), tax: taxTotal, journal: journal.documentNumber },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}

export async function cancelCustomerInvoice(input: {
  client: string; changedBy: string; invoiceNumber: string; postingDate: string; requestKey: string;
}): Promise<CustomerInvoiceView> {
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    const original = await loadView(tx, input.client, input.invoiceNumber);
    if (!original) throw new CustomerInvoiceError(`Invoice ${input.invoiceNumber} does not exist.`);
    if (original.status === 'CANCELLED') {
      throw new CustomerInvoiceError(`Invoice ${input.invoiceNumber} has already been cancelled by ${original.cancelledBy}.`);
    }
    if (original.cancellationOf) {
      throw new CustomerInvoiceError('A cancellation document cannot itself be cancelled.', 'Cancel the original invoice instead.');
    }
    if (!original.journalDocumentNumber) throw new CustomerInvoiceError('The invoice carries no journal to mirror.');

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'CUSTINV', allocatedBy: input.changedBy,
    });
    const number = allocated.display;
    const journalYear = Number(original.journalDocumentNumber.split('/')[1]);
    const reversal = await reverseJournalEntry(tx, {
      client: input.client,
      documentNumber: original.journalDocumentNumber,
      fiscalYear: journalYear,
      reversalDate: input.postingDate,
      reason: `Invoice cancellation ${number}`,
      reversedBy: input.changedBy,
      transactionCode: CUSTOMER_INVOICE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new CustomerInvoiceError(error.message, error.remedy);
      throw error;
    });

    const company = await getCompanyCode(tx, input.client, original.companyCode);
    const position = company?.fiscalYearVariant
      ? await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate)
      : { fiscalYear: Number(input.postingDate.slice(0, 4)), period: Number(input.postingDate.slice(5, 7)) };

    await tx.insert(customerInvoice).values({
      client: input.client, invoiceNumber: number, fiscalYear: position.fiscalYear,
      category: original.category, customerNumber: original.customerNumber,
      companyCode: original.companyCode, documentDate: original.documentDate,
      postingDate: input.postingDate, reference: original.reference,
      currency: original.currency, grossAmount: original.grossAmount, taxAmount: original.taxAmount,
      paymentTerms: original.paymentTerms, baselineDate: original.baselineDate,
      dueDate: original.dueDate, headerText: `Cancellation of ${original.invoiceNumber}`,
      status: 'POSTED', journalDocumentNumber: reversal.documentNumber,
      cancellationOf: original.invoiceNumber, creditOf: original.creditOf,
      requestKey: input.requestKey,
      createdBy: input.changedBy,
    });
    let lineNumber = 0;
    for (const line of original.lines) {
      lineNumber += 1;
      await tx.insert(customerInvoiceLine).values({
        client: input.client, invoiceNumber: number, lineNumber,
        glAccount: line.glAccount, netAmount: line.netAmount, taxCode: line.taxCode,
        taxAmount: line.taxAmount, profitCenter: line.profitCenter, lineText: line.lineText,
        createdBy: input.changedBy,
      });
    }
    await tx.update(customerInvoice).set({
      status: 'CANCELLED', cancelledBy: number, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(customerInvoice.client, input.client), eq(customerInvoice.invoiceNumber, original.invoiceNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: INVOICE_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CUSTOMER_INVOICE_CAPABILITY,
      after: { cancellationOf: original.invoiceNumber, journal: reversal.documentNumber },
    });
    return (await loadView(tx, input.client, number))!;
  });
}
