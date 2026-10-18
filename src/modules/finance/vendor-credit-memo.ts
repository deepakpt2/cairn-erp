/**
 * Vendor credit memo posting — SCR-076 / R-124.
 *
 * A credit against a vendor: offset lines carry tax-exclusive net
 * amounts, the input tax reverses at the standing rate, and the
 * journal debits the vendor's reconciliation account at the gross
 * — the payable reducing. The gross credit is judged: net plus
 * tax must equal it. A memo may stand against an original
 * invoice; partial credits are permitted, and all credits
 * against an original may never exceed its gross. Cancellation
 * is the invoice's linked mirror. A posted memo is never edited
 * or deleted.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { accountDetermination, costCenter, profitCenter, taxCode } from '../foundation/schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { vendorInvoice, vendorInvoiceLine } from './schema';
import { type VendorInvoiceView } from './vendor-invoice';

export const VENDOR_CREDIT_MEMO_CAPABILITY = 'FIN.AP.CREDITMEMO.POST';
const JOURNAL_DOCUMENT_TYPE = 'KG';
const INVOICE_CLASS = 'vendor_invoice';
const NUMBER_OBJECT = 'VENDINV';

export class VendorCreditMemoError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'VendorCreditMemoError';
    this.remedy = remedy;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function loadView(tx: Tx, client: string, number: string): Promise<VendorInvoiceView | null> {
  const [header] = await tx.select().from(vendorInvoice).where(and(
    eq(vendorInvoice.client, client), eq(vendorInvoice.invoiceNumber, number),
  ));
  if (!header) return null;
  const lines = await tx.select().from(vendorInvoiceLine).where(and(
    eq(vendorInvoiceLine.client, client), eq(vendorInvoiceLine.invoiceNumber, number),
  )).orderBy(vendorInvoiceLine.lineNumber);
  return {
    invoiceNumber: header.invoiceNumber, fiscalYear: header.fiscalYear,
    category: header.category, creditOf: header.creditOf,
    vendorNumber: header.vendorNumber, companyCode: header.companyCode,
    documentDate: header.documentDate, postingDate: header.postingDate,
    reference: header.reference, currency: header.currency,
    grossAmount: header.grossAmount, taxAmount: header.taxAmount,
    paymentTerms: header.paymentTerms, baselineDate: header.baselineDate, dueDate: header.dueDate,
    status: header.status, journalDocumentNumber: header.journalDocumentNumber,
    cancelledBy: header.cancelledBy, cancellationOf: header.cancellationOf,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber, glAccount: l.glAccount, netAmount: l.netAmount,
      taxCode: l.taxCode, taxAmount: l.taxAmount, costCenter: l.costCenter,
      profitCenter: l.profitCenter, lineText: l.lineText,
    })),
  };
}

export async function getVendorCreditMemo(client: string, number: string): Promise<VendorInvoiceView | null> {
  return withTenant(client, (tx) => loadView(tx, client, number));
}

async function byRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(vendorInvoice).where(and(
    eq(vendorInvoice.client, client), eq(vendorInvoice.requestKey, requestKey),
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
    throw new VendorCreditMemoError(
      `Account determination for TAX does not stand in chart ${chart}.`,
      'Maintain the account determination for the tax event, then post again.',
    );
  }
  return row.glAccount;
}

export interface PostVendorCreditMemoInput {
  client: string; changedBy: string;
  vendorNumber: string; companyCode: string;
  documentDate: string; postingDate: string;
  reference: string; currency: string;
  paymentTermsCode?: string;
  grossAmount: number;
  creditOf?: string;
  headerText?: string;
  requestKey: string;
  lines: Array<{
    glAccount: string; netAmount: number; taxCode?: string;
    costCenter?: string; profitCenter?: string; lineText?: string;
  }>;
}

export async function postVendorCreditMemo(input: PostVendorCreditMemoInput): Promise<VendorInvoiceView> {
  if (input.lines.length === 0) {
    throw new VendorCreditMemoError('Enter at least one offset line.', 'Add a G/L line with its net amount.');
  }
  if (!input.reference?.trim()) {
    throw new VendorCreditMemoError('The credit memo reference stands required.', 'Enter the reference printed on the vendor credit memo.');
  }
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/vendinv/${input.companyCode}/${input.vendorNumber}`}, 0))`);

    const [vendor] = await tx.select().from(supplierCompany).where(and(
      eq(supplierCompany.client, input.client),
      eq(supplierCompany.partnerNumber, input.vendorNumber),
      eq(supplierCompany.companyCode, input.companyCode),
    ));
    if (!vendor) {
      throw new VendorCreditMemoError(
        `Vendor ${input.vendorNumber} does not stand extended to company ${input.companyCode}.`,
        'Extend the vendor to the company code, then post.',
      );
    }
    if (vendor.isBlocked) throw new VendorCreditMemoError(`Vendor ${input.vendorNumber} is blocked for company ${input.companyCode}.`);
    if (!vendor.reconciliationAccount) {
      throw new VendorCreditMemoError(
        `Vendor ${input.vendorNumber} carries no reconciliation account in company ${input.companyCode}.`,
        'Maintain the vendor company data, then post.',
      );
    }
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant || !company.country) {
      throw new VendorCreditMemoError(`Company code ${input.companyCode} is not configured.`);
    }
    const chart = vendor.chartOfAccounts;

    const duplicates = await tx.select().from(vendorInvoice).where(and(
      eq(vendorInvoice.client, input.client),
      eq(vendorInvoice.companyCode, input.companyCode),
      eq(vendorInvoice.vendorNumber, input.vendorNumber),
      eq(vendorInvoice.reference, input.reference),
      eq(vendorInvoice.status, 'POSTED'),
    ));
    const standing = duplicates.find((d) => !d.cancellationOf);
    if (standing) {
      throw new VendorCreditMemoError(
        `Reference ${input.reference} already stands posted for this vendor as document ${standing.invoiceNumber}.`,
        'Load the standing document, or correct the reference.',
      );
    }

    // The optional original link judges, and partial credits cap at its gross.
    let original: typeof vendorInvoice.$inferSelect | null = null;
    if (input.creditOf) {
      const [found] = await tx.select().from(vendorInvoice).where(and(
        eq(vendorInvoice.client, input.client), eq(vendorInvoice.invoiceNumber, input.creditOf),
      ));
      if (!found || found.category !== 'INVOICE' || found.cancellationOf || found.status !== 'POSTED'
        || found.vendorNumber !== input.vendorNumber || found.companyCode !== input.companyCode) {
        throw new VendorCreditMemoError(
          `Original invoice ${input.creditOf} does not stand posted for this vendor and company.`,
          'Name a standing posted invoice, or leave the original blank.',
        );
      }
      original = found;
      const credited = await tx.select().from(vendorInvoice).where(and(
        eq(vendorInvoice.client, input.client),
        eq(vendorInvoice.category, 'CREDIT_MEMO'),
        eq(vendorInvoice.creditOf, input.creditOf),
        eq(vendorInvoice.status, 'POSTED'),
      ));
      const alreadyCredited = credited
        .filter((d) => !d.cancellationOf)
        .reduce((s, d) => round2(s + Number(d.grossAmount)), 0);
      if (round2(alreadyCredited + round2(input.grossAmount)) - Number(original.grossAmount) > 0.005) {
        throw new VendorCreditMemoError(
          `The credits against invoice ${original.invoiceNumber} would stand at ${(alreadyCredited + round2(input.grossAmount)).toFixed(2)} against its gross of ${Number(original.grossAmount).toFixed(2)}.`,
          'Credit no more than the original invoice stands at.',
        );
      }
    }

    const rates = new Map<string, number>();
    for (const row of await tx.select().from(taxCode).where(and(
      eq(taxCode.client, input.client), eq(taxCode.country, company.country),
    ))) rates.set(row.taxCode, Number(row.ratePercent));

    interface Prepared {
      glAccount: string; net: number; taxCode: string | null; tax: number;
      costCenter: string | null; profitCenter: string | null; lineText: string | null;
    }
    const prepared: Prepared[] = [];
    for (const line of input.lines) {
      if (!(line.netAmount > 0)) throw new VendorCreditMemoError('Every line amount must stand above zero.');
      const code = (line.taxCode ?? '').toUpperCase() || null;
      let tax = 0;
      if (code) {
        const rate = rates.get(code);
        if (rate === undefined) {
          throw new VendorCreditMemoError(
            `Tax code ${code} does not stand for country ${company.country}.`,
            'Use a standing tax code, or leave the line untaxed.',
          );
        }
        tax = round2((line.netAmount * rate) / 100);
      }
      if (line.costCenter) {
        const [cc] = await tx.select().from(costCenter).where(and(
          eq(costCenter.client, input.client), eq(costCenter.costCenter, line.costCenter),
        ));
        if (!cc) {
          throw new VendorCreditMemoError(
            `Cost centre ${line.costCenter} does not stand.`,
            'Use a standing cost centre, or leave it blank.',
          );
        }
      }
      if (line.profitCenter) {
        const [pc] = await tx.select().from(profitCenter).where(and(
          eq(profitCenter.client, input.client), eq(profitCenter.profitCenter, line.profitCenter),
        ));
        if (!pc) {
          throw new VendorCreditMemoError(
            `Profit centre ${line.profitCenter} does not stand.`,
            'Use a standing profit centre, or leave it blank.',
          );
        }
      }
      prepared.push({
        glAccount: line.glAccount, net: round2(line.netAmount), taxCode: code, tax,
        costCenter: line.costCenter || null, profitCenter: line.profitCenter || null,
        lineText: line.lineText || null,
      });
    }

    const netTotal = round2(prepared.reduce((s, p) => s + p.net, 0));
    const taxTotal = round2(prepared.reduce((s, p) => s + p.tax, 0));
    if (Math.abs(round2(netTotal + taxTotal) - round2(input.grossAmount)) > 0.005) {
      throw new VendorCreditMemoError(
        `The gross credit ${round2(input.grossAmount).toFixed(2)} does not reconcile: lines net ${netTotal.toFixed(2)} plus tax ${taxTotal.toFixed(2)} is ${round2(netTotal + taxTotal).toFixed(2)}.`,
        'Correct the gross credit or the line amounts so the document balances.',
      );
    }

    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const journalLines: Array<{
      glAccount: string; debitCredit: 'S' | 'H'; amount: string;
      businessPartner?: string; taxCode?: string; costCenter?: string; profitCenter?: string;
    }> = [{
      glAccount: vendor.reconciliationAccount, debitCredit: 'S',
      amount: round2(input.grossAmount).toFixed(2), businessPartner: input.vendorNumber,
    }];
    for (const p of prepared) {
      journalLines.push({
        glAccount: p.glAccount, debitCredit: 'H', amount: p.net.toFixed(2),
        ...(p.costCenter ? { costCenter: p.costCenter } : {}),
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

    const termsCode = input.paymentTermsCode || vendor.paymentTermsCode;
    let baseline: string | null = null;
    let due: string | null = null;
    if (termsCode) {
      const [terms] = await tx.select().from(paymentTerms).where(and(
        eq(paymentTerms.client, input.client), eq(paymentTerms.termsCode, termsCode),
      ));
      if (!terms) {
        throw new VendorCreditMemoError(
          `Payment terms ${termsCode} do not stand.`,
          'Use standing payment terms, or clear the field to take the vendor default.',
        );
      }
      baseline = terms.baselineSource === 'POSTING_DATE' ? input.postingDate : input.documentDate;
      const d = new Date(`${baseline}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + terms.netDays);
      due = d.toISOString().slice(0, 10);
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: NUMBER_OBJECT, allocatedBy: input.changedBy,
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
      transactionCode: VENDOR_CREDIT_MEMO_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new VendorCreditMemoError(error.message, error.remedy);
      throw error;
    });

    await tx.insert(vendorInvoice).values({
      client: input.client, invoiceNumber: number, fiscalYear: position.fiscalYear,
      category: 'CREDIT_MEMO', creditOf: original?.invoiceNumber ?? null,
      vendorNumber: input.vendorNumber, companyCode: input.companyCode,
      documentDate: input.documentDate, postingDate: input.postingDate,
      reference: input.reference, currency: input.currency.toUpperCase(),
      grossAmount: String(round2(input.grossAmount)), taxAmount: String(taxTotal),
      paymentTerms: termsCode ?? null, baselineDate: baseline, dueDate: due,
      headerText: input.headerText ?? null, status: 'POSTED',
      journalDocumentNumber: journal.documentNumber, requestKey: input.requestKey,
      createdBy: input.changedBy,
    });
    let lineNumber = 0;
    for (const p of prepared) {
      lineNumber += 1;
      await tx.insert(vendorInvoiceLine).values({
        client: input.client, invoiceNumber: number, lineNumber,
        glAccount: p.glAccount, netAmount: String(p.net), taxCode: p.taxCode,
        taxAmount: String(p.tax), costCenter: p.costCenter, profitCenter: p.profitCenter,
        lineText: p.lineText, createdBy: input.changedBy,
      });
    }
    await recordChange(tx, {
      client: input.client, objectClass: INVOICE_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: VENDOR_CREDIT_MEMO_CAPABILITY,
      after: {
        vendor: input.vendorNumber, gross: round2(input.grossAmount), tax: taxTotal,
        journal: journal.documentNumber, creditOf: original?.invoiceNumber ?? null,
      },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}
