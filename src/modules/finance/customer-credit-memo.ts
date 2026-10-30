/**
 * Customer credit memo posting — DI-020.
 *
 * A credit against a customer: a credit memo is a customer invoice of its own
 * category, carrying an optional link to the original billing document it stands
 * against. Partial credits are permitted, and all credits against an original
 * may never exceed its gross. A posted memo is never edited or deleted;
 * cancellation is the invoice's own linked mirror. The receivable posts through
 * the posting engine (`postJournalEntry`) with the credit-memo direction — the
 * customer is credited (receivable reduced) and revenue/tax are debited — the
 * mirror image of a customer invoice.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { accountDetermination, profitCenter, taxCode as taxCodeTable } from '../foundation/schema';
import { customerCompany } from '../foundation/customer-company-schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import { customerInvoice, customerInvoiceLine } from '../purchasing/schema';
import { billingDocument } from '../sales/schema';

export const CUSTOMER_CREDIT_MEMO_CAPABILITY = 'FIN.AR.CREDITMEMO.POST';
const JOURNAL_DOCUMENT_TYPE = 'DR';
const INVOICE_CLASS = 'customer_invoice';
const NUMBER_OBJECT = 'CUSTINV';

export class CustomerCreditMemoError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerCreditMemoError';
    this.remedy = remedy;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

interface BillingHeader {
  billingNumber: string;
  status: string;
  customerNumber: string;
  companyCode: string;
  currency: string;
  grossValue: string;
  customerInvoiceNumber: string | null;
}

interface OriginalInvoice {
  invoiceNumber: string;
  grossAmount: string;
  currency: string;
}

async function loadBilling(tx: Tx, client: string, billingNumber: string): Promise<BillingHeader | null> {
  const [row] = await tx.select().from(billingDocument).where(and(
    eq(billingDocument.client, client), eq(billingDocument.billingNumber, billingNumber),
  )).limit(1);
  return row ? {
    billingNumber: row.billingNumber,
    status: row.status,
    customerNumber: row.customerNumber,
    companyCode: row.companyCode,
    currency: row.currency,
    grossValue: row.grossValue,
    customerInvoiceNumber: row.customerInvoiceNumber,
  } : null;
}

export interface PostCustomerCreditMemoInput {
  client: string; changedBy: string;
  customerNumber: string; companyCode: string;
  documentDate: string; postingDate: string;
  reference: string; currency: string;
  paymentTermsCode?: string;
  grossAmount: number;
  /** Original billing document this credit memo stands against. */
  creditOfBilling?: string;
  /** Original customer invoice this credit memo stands against (defaults to the billing document's invoice). */
  creditOfInvoice?: string;
  headerText?: string;
  requestKey: string;
  lines: Array<{
    glAccount: string; netAmount: number; taxCode?: string;
    profitCenter?: string; lineText?: string;
  }>;
}

export interface CustomerCreditMemoView {
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

async function loadView(tx: Tx, client: string, number: string): Promise<CustomerCreditMemoView | null> {
  const [header] = await tx.select().from(customerInvoice).where(and(
    eq(customerInvoice.client, client), eq(customerInvoice.invoiceNumber, number),
  ));
  if (!header) return null;
  const lines = await tx.select().from(customerInvoiceLine).where(and(
    eq(customerInvoiceLine.client, client), eq(customerInvoiceLine.invoiceNumber, number),
  )).orderBy(customerInvoiceLine.lineNumber);
  return {
    invoiceNumber: header.invoiceNumber, fiscalYear: header.fiscalYear,
    category: header.category, creditOf: header.creditOf,
    customerNumber: header.customerNumber, companyCode: header.companyCode,
    documentDate: header.documentDate, postingDate: header.postingDate,
    reference: header.reference, currency: header.currency,
    grossAmount: header.grossAmount, taxAmount: header.taxAmount,
    paymentTerms: header.paymentTerms, baselineDate: header.baselineDate, dueDate: header.dueDate,
    status: header.status, journalDocumentNumber: header.journalDocumentNumber,
    cancelledBy: header.cancelledBy, cancellationOf: header.cancellationOf,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber, glAccount: l.glAccount, netAmount: l.netAmount,
      taxCode: l.taxCode, taxAmount: l.taxAmount, profitCenter: l.profitCenter, lineText: l.lineText,
    })),
  };
}

export async function getCustomerCreditMemo(client: string, number: string): Promise<CustomerCreditMemoView | null> {
  return withTenant(client, (tx) => loadView(tx, client, number));
}

async function byRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(customerInvoice).where(and(
    eq(customerInvoice.client, client), eq(customerInvoice.requestKey, requestKey),
  ));
  return header ? loadView(tx, client, header.invoiceNumber) : null;
}

async function taxAccount(tx: Tx, client: string, chart: string): Promise<string> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, 'TAX'),
  ));
  const row = rows.find((r) => r.valuationClass === '') ?? rows[0];
  if (!row) {
    throw new CustomerCreditMemoError(
      `Account determination for TAX does not stand in chart ${chart}.`,
      'Maintain the account determination for the tax event, then post again.',
    );
  }
  return row.glAccount;
}

export async function postCustomerCreditMemo(input: PostCustomerCreditMemoInput): Promise<CustomerCreditMemoView> {
  if (input.lines.length === 0) {
    throw new CustomerCreditMemoError('Enter at least one offset line.', 'Add a G/L line with its net amount.');
  }
  if (!input.reference?.trim()) {
    throw new CustomerCreditMemoError('The credit memo reference stands required.', 'Enter the reference printed on the credit memo.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/custcm/${input.companyCode}/${input.customerNumber}`}, 0))`);

    const [customer] = await tx.select().from(customerCompany).where(and(
      eq(customerCompany.client, input.client),
      eq(customerCompany.partnerNumber, input.customerNumber),
      eq(customerCompany.companyCode, input.companyCode),
    ));
    if (!customer) {
      throw new CustomerCreditMemoError(
        `Customer ${input.customerNumber} does not stand extended to company ${input.companyCode}.`,
        'Extend the customer to the company code, then post.',
      );
    }
    if (customer.isBlocked) throw new CustomerCreditMemoError(`Customer ${input.customerNumber} is blocked for company ${input.companyCode}.`);
    if (!customer.reconciliationAccount) {
      throw new CustomerCreditMemoError(
        `Customer ${input.customerNumber} carries no reconciliation account in company ${input.companyCode}.`,
        'Maintain the customer company data, then post.',
      );
    }
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant || !company.country) {
      throw new CustomerCreditMemoError(`Company code ${input.companyCode} is not configured.`);
    }
    const chart = customer.chartOfAccounts;

    // The optional original billing document link: validate it stands posted for this customer and company.
    let originalBilling: BillingHeader | null = null;
    if (input.creditOfBilling) {
      originalBilling = await loadBilling(tx, input.client, input.creditOfBilling);
      if (!originalBilling) {
        throw new CustomerCreditMemoError(
          `Billing document ${input.creditOfBilling} does not exist in this tenant.`,
          'Name a standing billing document, or leave the reference blank.',
        );
      }
      if (originalBilling.status !== 'POSTED') {
        throw new CustomerCreditMemoError(
          `Billing document ${originalBilling.billingNumber} stands ${originalBilling.status}; only a posted billing can be credited.`,
          'Credit a posted billing document, or correct the reference.',
        );
      }
      if (originalBilling.customerNumber !== input.customerNumber || originalBilling.companyCode !== input.companyCode) {
        throw new CustomerCreditMemoError(
          `Billing document ${originalBilling.billingNumber} belongs to customer ${originalBilling.customerNumber} in company ${originalBilling.companyCode}, not ${input.customerNumber} / ${input.companyCode}.`,
          'Name a billing document for this customer and company.',
        );
      }
      if (originalBilling.currency !== input.currency) {
        throw new CustomerCreditMemoError(
          `Billing document ${originalBilling.billingNumber} is in currency ${originalBilling.currency}, not ${input.currency}.`,
          "Credit in the billing document's currency, or correct the currency.",
        );
      }
    }

    // Resolve the original customer invoice: explicit creditOfInvoice, or the billing document's invoice.
    let originalInvoice: OriginalInvoice | null = null;
    if (input.creditOfInvoice) {
      const [inv] = await tx.select().from(customerInvoice).where(and(
        eq(customerInvoice.client, input.client), eq(customerInvoice.invoiceNumber, input.creditOfInvoice),
      )).limit(1);
      if (!inv) {
        throw new CustomerCreditMemoError(
          `Customer invoice ${input.creditOfInvoice} does not exist.`,
          'Name a standing invoice, or leave the reference blank.',
        );
      }
      if (inv.category !== 'INVOICE' || inv.status !== 'POSTED'
        || inv.customerNumber !== input.customerNumber || inv.companyCode !== input.companyCode) {
        throw new CustomerCreditMemoError(
          `Original invoice ${input.creditOfInvoice} does not stand posted for this customer and company.`,
          'Name a standing posted invoice, or leave the original blank.',
        );
      }
      originalInvoice = {
        invoiceNumber: inv.invoiceNumber,
        grossAmount: inv.grossAmount,
        currency: inv.currency,
      };
    } else if (originalBilling?.customerInvoiceNumber) {
      const [inv] = await tx.select().from(customerInvoice).where(and(
        eq(customerInvoice.client, input.client), eq(customerInvoice.invoiceNumber, originalBilling.customerInvoiceNumber),
      )).limit(1);
      if (inv) {
        originalInvoice = {
          invoiceNumber: inv.invoiceNumber,
          grossAmount: inv.grossAmount,
          currency: inv.currency,
        };
      }
    }

    // The credit cap: all posted credits against an original may never exceed its gross.
    // Cancelled memos (those carrying cancellationOf) are excluded from the running total.
    if (originalInvoice) {
      if (originalInvoice.currency !== input.currency) {
        throw new CustomerCreditMemoError(
          `Original invoice ${originalInvoice.invoiceNumber} is in currency ${originalInvoice.currency}, not ${input.currency}.`,
          "Credit in the original invoice's currency.",
        );
      }
      const credited = await tx.select().from(customerInvoice).where(and(
        eq(customerInvoice.client, input.client),
        eq(customerInvoice.category, 'CREDIT_MEMO'),
        eq(customerInvoice.creditOf, originalInvoice.invoiceNumber),
        eq(customerInvoice.status, 'POSTED'),
      ));
      const alreadyCredited = credited
        .filter((d) => !d.cancellationOf)
        .reduce((s, d) => round2(s + Number(d.grossAmount)), 0);
      if (round2(alreadyCredited + round2(input.grossAmount)) - Number(originalInvoice.grossAmount) > 0.005) {
        throw new CustomerCreditMemoError(
          `The credits against invoice ${originalInvoice.invoiceNumber} would stand at ${(alreadyCredited + round2(input.grossAmount)).toFixed(2)} against its gross of ${Number(originalInvoice.grossAmount).toFixed(2)}.`,
          'Credit no more than the original invoice stands at.',
        );
      }
    }

    // Duplicate reference: a standing posted document with the same reference for this customer/company refuses.
    const duplicates = await tx.select().from(customerInvoice).where(and(
      eq(customerInvoice.client, input.client),
      eq(customerInvoice.companyCode, input.companyCode),
      eq(customerInvoice.customerNumber, input.customerNumber),
      eq(customerInvoice.reference, input.reference),
      eq(customerInvoice.status, 'POSTED'),
    ));
    const standing = duplicates.find((d) => !d.cancellationOf);
    if (standing) {
      throw new CustomerCreditMemoError(
        `Reference ${input.reference} already stands posted for this customer as document ${standing.invoiceNumber}.`,
        'Load the standing document, or correct the reference.',
      );
    }

    const rates = new Map<string, number>();
    for (const row of await tx.select().from(taxCodeTable).where(and(
      eq(taxCodeTable.client, input.client), eq(taxCodeTable.country, company.country),
    ))) rates.set(row.taxCode, Number(row.ratePercent));

    interface Prepared {
      glAccount: string; net: number; taxCode: string | null; tax: number;
      profitCenter: string | null; lineText: string | null;
    }
    const prepared: Prepared[] = [];
    for (const line of input.lines) {
      if (!(line.netAmount > 0)) throw new CustomerCreditMemoError('Every line amount must stand above zero.');
      const code = (line.taxCode ?? '').toUpperCase() || null;
      let tax = 0;
      if (code) {
        const rate = rates.get(code);
        if (rate === undefined) {
          throw new CustomerCreditMemoError(
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
          throw new CustomerCreditMemoError(
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
      throw new CustomerCreditMemoError(
        `The gross credit ${round2(input.grossAmount).toFixed(2)} does not reconcile: lines net ${netTotal.toFixed(2)} plus tax ${taxTotal.toFixed(2)} is ${round2(netTotal + taxTotal).toFixed(2)}.`,
        'Correct the gross credit or the line amounts so the document balances.',
      );
    }

    const termsCode = input.paymentTermsCode || customer.paymentTermsCode;
    let baseline: string | null = null;
    let due: string | null = null;
    if (termsCode) {
      const [terms] = await tx.select().from(paymentTerms).where(and(
        eq(paymentTerms.client, input.client), eq(paymentTerms.termsCode, termsCode),
      ));
      if (!terms) {
        throw new CustomerCreditMemoError(
          `Payment terms ${termsCode} do not stand.`,
          'Use standing payment terms, or clear the field to take the customer default.',
        );
      }
      baseline = terms.baselineSource === 'POSTING_DATE' ? input.postingDate : input.documentDate;
      const d = new Date(`${baseline}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + terms.netDays);
      due = d.toISOString().slice(0, 10);
    }

    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);

    // Allocate the CUSTINV number before posting so the journal's origin key
    // names the invoice document it creates, giving complete document flow.
    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: NUMBER_OBJECT, allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    // Credit memo journal direction — mirror image of a customer invoice:
    //   Credit (H) the customer reconciliation account at gross — receivable reduces.
    //   Debit (S) each revenue line at net — revenue reduces.
    //   Debit (S) the tax account at tax — output tax reduces.
    const journalLines: Array<{
      glAccount: string; debitCredit: 'S' | 'H'; amount: string;
      businessPartner?: string; taxCode?: string; profitCenter?: string;
    }> = [{
      glAccount: customer.reconciliationAccount, debitCredit: 'H',
      amount: round2(input.grossAmount).toFixed(2), businessPartner: input.customerNumber,
    }];
    for (const p of prepared) {
      journalLines.push({
        glAccount: p.glAccount, debitCredit: 'S', amount: p.net.toFixed(2),
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
        journalLines.push({ glAccount: account, debitCredit: 'S', amount: amount.toFixed(2), taxCode: code });
      }
    }

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
      transactionCode: CUSTOMER_CREDIT_MEMO_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new CustomerCreditMemoError(error.message, error.remedy);
      throw error;
    });

    await tx.insert(customerInvoice).values({
      client: input.client, invoiceNumber: number, fiscalYear: position.fiscalYear,
      category: 'CREDIT_MEMO', customerNumber: input.customerNumber, companyCode: input.companyCode,
      documentDate: input.documentDate, postingDate: input.postingDate,
      reference: input.reference, currency: input.currency.toUpperCase(),
      grossAmount: String(round2(input.grossAmount)), taxAmount: String(taxTotal),
      paymentTerms: termsCode ?? null, baselineDate: baseline, dueDate: due,
      headerText: input.headerText ?? null, status: 'POSTED',
      journalDocumentNumber: journal.documentNumber, requestKey: input.requestKey,
      creditOf: originalInvoice?.invoiceNumber ?? null,
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
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CUSTOMER_CREDIT_MEMO_CAPABILITY,
      after: {
        customer: input.customerNumber, gross: round2(input.grossAmount), tax: taxTotal,
        journal: journal.documentNumber, creditOf: originalInvoice?.invoiceNumber ?? null,
      },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}
