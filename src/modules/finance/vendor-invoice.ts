/**
 * Vendor invoice posting, direct — SCR-075 / R-123.
 *
 * Expense lines carry tax-exclusive net amounts; input tax
 * calculates at the standing rate per line tax code. The gross is
 * judged: net plus tax must equal it. The journal credits the
 * vendor's reconciliation account at gross with the vendor as
 * partner — the payable open item — debits each expense line and
 * the tax account. Cancellation is a linked mirror by journal
 * reversal. A posted invoice is never edited or deleted.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { MoneyError, moneyFor, refusing } from '../../platform/posting/money';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { fromScaled } from '../../platform/posting/decimal';
import { accountDetermination, costCenter, profitCenter, taxCode } from '../foundation/schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { vendorInvoice, vendorInvoiceLine } from './schema';
import { requireExchangeRate } from './exchange-rate-lookup';
import { localUnitsOf } from './fx-settlement';

export const VENDOR_INVOICE_CAPABILITY = 'FIN.AP.INVOICE.POST';
const JOURNAL_DOCUMENT_TYPE = 'KR';
const INVOICE_CLASS = 'vendor_invoice';
const NUMBER_OBJECT = 'VENDINV';

export class VendorInvoiceError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'VendorInvoiceError';
    this.remedy = remedy;
  }
}

export interface VendorInvoiceView {
  invoiceNumber: string;
  fiscalYear: number;
  category: string;
  creditOf: string | null;
  vendorNumber: string;
  companyCode: string;
  documentDate: string;
  postingDate: string;
  reference: string;
  currency: string;
  exchangeRate: string;
  grossAmount: string;
  localGrossAmount: string;
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
    taxCode: string | null; taxAmount: string;
    costCenter: string | null; profitCenter: string | null; lineText: string | null;
  }>;
}

function toView(
  header: typeof vendorInvoice.$inferSelect,
  lines: Array<typeof vendorInvoiceLine.$inferSelect>,
): VendorInvoiceView {
  return {
    invoiceNumber: header.invoiceNumber, fiscalYear: header.fiscalYear,
    category: header.category, creditOf: header.creditOf,
    vendorNumber: header.vendorNumber, companyCode: header.companyCode,
    documentDate: header.documentDate, postingDate: header.postingDate,
    reference: header.reference, currency: header.currency,
    exchangeRate: header.exchangeRate,
    grossAmount: header.grossAmount, localGrossAmount: header.localGrossAmount,
    taxAmount: header.taxAmount,
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

async function loadView(tx: Tx, client: string, number: string): Promise<VendorInvoiceView | null> {
  const [header] = await tx.select().from(vendorInvoice).where(and(
    eq(vendorInvoice.client, client), eq(vendorInvoice.invoiceNumber, number),
  ));
  if (!header) return null;
  const lines = await tx.select().from(vendorInvoiceLine).where(and(
    eq(vendorInvoiceLine.client, client), eq(vendorInvoiceLine.invoiceNumber, number),
  )).orderBy(vendorInvoiceLine.lineNumber);
  return toView(header, lines);
}

export async function getVendorInvoice(client: string, number: string): Promise<VendorInvoiceView | null> {
  return withTenant(client, (tx) => loadView(tx, client, number));
}

async function byRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(vendorInvoice).where(and(
    eq(vendorInvoice.client, client), eq(vendorInvoice.requestKey, requestKey),
  ));
  return header ? loadView(tx, client, header.invoiceNumber) : null;
}

export interface TaxCodeChoice { code: string; ratePercent: string; name: string }

export async function listVendorInvoiceTaxCodes(client: string, companyCode: string): Promise<TaxCodeChoice[]> {
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
    throw new VendorInvoiceError(
      `Account determination for TAX does not stand in chart ${chart}.`,
      'Maintain the account determination for the tax event, then post again.',
    );
  }
  return row.glAccount;
}

export interface PostVendorInvoiceInput {
  client: string; changedBy: string;
  vendorNumber: string; companyCode: string;
  documentDate: string; postingDate: string;
  reference: string; currency: string;
  paymentTermsCode?: string;
  grossAmount: number;
  headerText?: string;
  requestKey: string;
  lines: Array<{
    glAccount: string; netAmount: number; taxCode?: string;
    costCenter?: string; profitCenter?: string; lineText?: string;
  }>;
}

export async function postVendorInvoice(input: PostVendorInvoiceInput): Promise<VendorInvoiceView> {
  if (input.lines.length === 0) {
    throw new VendorInvoiceError('Enter at least one expense line.', 'Add a G/L line with its net amount.');
  }
  if (!input.reference?.trim()) {
    throw new VendorInvoiceError('The vendor reference stands required.', 'Enter the reference printed on the vendor invoice.');
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
      throw new VendorInvoiceError(
        `Vendor ${input.vendorNumber} does not stand extended to company ${input.companyCode}.`,
        'Extend the vendor to the company code, then post.',
      );
    }
    if (vendor.isBlocked) throw new VendorInvoiceError(`Vendor ${input.vendorNumber} is blocked for company ${input.companyCode}.`);
    if (!vendor.reconciliationAccount) {
      throw new VendorInvoiceError(
        `Vendor ${input.vendorNumber} carries no reconciliation account in company ${input.companyCode}.`,
        'Maintain the vendor company data, then post.',
      );
    }
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant || !company.country) {
      throw new VendorInvoiceError(`Company code ${input.companyCode} is not configured.`);
    }
    const chart = vendor.chartOfAccounts;
    // The document currency's decimals decide every amount below; an unknown currency is refused here.
    const money = refusing(await moneyFor(tx, input.currency).catch((error: unknown) => {
      if (error instanceof MoneyError) throw new VendorInvoiceError(error.message, error.remedy);
      throw error;
    }), (e) => new VendorInvoiceError(e.message, e.remedy));
    const entered = (value: number, label: string): number => {
      try { return Number(money.fromUnits(money.entered(value, label))); } catch (error) {
        if (error instanceof MoneyError) throw new VendorInvoiceError(error.message, error.remedy);
        throw error;
      }
    };
    const rate = await requireExchangeRate(
      tx, input.client, input.currency, company.currency, input.postingDate,
    ).catch((error: unknown) => {
      if (error instanceof Error && 'remedy' in error) {
        throw new VendorInvoiceError(error.message, (error as { remedy?: string }).remedy);
      }
      throw error;
    });
    const localScale = company.currency.toUpperCase() === input.currency.toUpperCase()
      ? money.scale
      : (await moneyFor(tx, company.currency)).scale;

    const duplicates = await tx.select().from(vendorInvoice).where(and(
      eq(vendorInvoice.client, input.client),
      eq(vendorInvoice.companyCode, input.companyCode),
      eq(vendorInvoice.vendorNumber, input.vendorNumber),
      eq(vendorInvoice.reference, input.reference),
      eq(vendorInvoice.status, 'POSTED'),
    ));
    const standing = duplicates.find((d) => !d.cancellationOf);
    if (standing) {
      throw new VendorInvoiceError(
        `Reference ${input.reference} already stands posted for this vendor as invoice ${standing.invoiceNumber}.`,
        'Load the standing invoice, or correct the reference.',
      );
    }

    // Tax per line at the standing rate for the company country.
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
      if (!(line.netAmount > 0)) throw new VendorInvoiceError('Every line amount must stand above zero.');
      const code = (line.taxCode ?? '').toUpperCase() || null;
      let tax = 0;
      if (code) {
        const rate = rates.get(code);
        if (rate === undefined) {
          throw new VendorInvoiceError(
            `Tax code ${code} does not stand for country ${company.country}.`,
            'Use a standing tax code, or leave the line untaxed.',
          );
        }
        tax = Number(money.fromUnits(money.percentOf(entered(line.netAmount, 'The line amount'), rate)));
      }
      if (line.costCenter) {
        const [cc] = await tx.select().from(costCenter).where(and(
          eq(costCenter.client, input.client), eq(costCenter.costCenter, line.costCenter),
        ));
        if (!cc) {
          throw new VendorInvoiceError(
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
          throw new VendorInvoiceError(
            `Profit centre ${line.profitCenter} does not stand.`,
            'Use a standing profit centre, or leave it blank.',
          );
        }
      }
      prepared.push({
        glAccount: line.glAccount, net: entered(line.netAmount, 'The line amount'), taxCode: code, tax,
        costCenter: line.costCenter || null, profitCenter: line.profitCenter || null,
        lineText: line.lineText || null,
      });
    }

    const netUnits = prepared.reduce((t, p) => t + money.units(p.net), 0n);
    const taxUnits = prepared.reduce((t, p) => t + money.units(p.tax), 0n);
    const grossUnits = money.entered(input.grossAmount, 'The gross amount');
    if (netUnits + taxUnits !== grossUnits) {
      throw new VendorInvoiceError(
        `The gross amount ${money.fromUnits(grossUnits)} does not reconcile: lines net ${money.fromUnits(netUnits)} plus tax ${money.fromUnits(taxUnits)} is ${money.fromUnits(netUnits + taxUnits)}.`,
        'Correct the gross amount or the line amounts so the document balances.',
      );
    }

    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const journalLines: Array<{
      glAccount: string; debitCredit: 'S' | 'H'; amount: string;
      businessPartner?: string; taxCode?: string; costCenter?: string; profitCenter?: string;
    }> = [];
    for (const p of prepared) {
      journalLines.push({
        glAccount: p.glAccount, debitCredit: 'S', amount: money.text(p.net),
        ...(p.costCenter ? { costCenter: p.costCenter } : {}),
        ...(p.profitCenter ? { profitCenter: p.profitCenter } : {}),
      });
    }
    const taxByCode = new Map<string, number>();
    for (const p of prepared) {
      if (p.tax > 0 && p.taxCode) taxByCode.set(p.taxCode, Number(money.fromUnits(money.units(taxByCode.get(p.taxCode) ?? 0) + money.units(p.tax))));
    }
    if (taxByCode.size > 0) {
      const account = await taxAccount(tx, input.client, chart);
      for (const [code, amount] of taxByCode) {
        journalLines.push({ glAccount: account, debitCredit: 'S', amount: money.text(amount), taxCode: code });
      }
    }
    journalLines.push({
      glAccount: vendor.reconciliationAccount, debitCredit: 'H',
      amount: money.fromUnits(grossUnits), businessPartner: input.vendorNumber,
    });

    // Payment terms and the due date they compute.
    const termsCode = input.paymentTermsCode || vendor.paymentTermsCode;
    let baseline: string | null = null;
    let due: string | null = null;
    if (termsCode) {
      const [terms] = await tx.select().from(paymentTerms).where(and(
        eq(paymentTerms.client, input.client), eq(paymentTerms.termsCode, termsCode),
      ));
      if (!terms) {
        throw new VendorInvoiceError(
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
      rate,
      reference: input.reference,
      headerText: input.headerText,
      lines: journalLines,
      origin: { documentClass: INVOICE_CLASS, documentKey: number },
      postedBy: input.changedBy,
      transactionCode: VENDOR_INVOICE_CAPABILITY,
      precision: 'CURRENCY',
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new VendorInvoiceError(error.message, error.remedy);
      throw error;
    });

    await tx.insert(vendorInvoice).values({
      client: input.client, invoiceNumber: number, fiscalYear: position.fiscalYear,
      category: 'INVOICE', creditOf: null,
      vendorNumber: input.vendorNumber, companyCode: input.companyCode,
      documentDate: input.documentDate, postingDate: input.postingDate,
      reference: input.reference, currency: input.currency.toUpperCase(),
      exchangeRate: rate.effectiveRate,
      grossAmount: money.fromUnits(grossUnits),
      localGrossAmount: fromScaled(localUnitsOf(grossUnits, money.scale, localScale, rate)),
      taxAmount: money.fromUnits(taxUnits),
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
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: VENDOR_INVOICE_CAPABILITY,
      after: { vendor: input.vendorNumber, gross: money.fromUnits(grossUnits), tax: money.fromUnits(taxUnits), journal: journal.documentNumber },
    });
    return (await byRequestKey(tx, input.client, input.requestKey))!;
  });
}

export async function cancelVendorInvoice(input: {
  client: string; changedBy: string; invoiceNumber: string; postingDate: string; requestKey: string;
}): Promise<VendorInvoiceView> {
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    const original = await loadView(tx, input.client, input.invoiceNumber);
    if (!original) throw new VendorInvoiceError(`Invoice ${input.invoiceNumber} does not exist.`);
    if (original.status === 'CANCELLED') {
      throw new VendorInvoiceError(`Invoice ${input.invoiceNumber} has already been cancelled by ${original.cancelledBy}.`);
    }
    if (original.cancellationOf) {
      throw new VendorInvoiceError('A cancellation document cannot itself be cancelled.', 'Cancel the original invoice instead.');
    }
    if (!original.journalDocumentNumber) throw new VendorInvoiceError('The invoice carries no journal to mirror.');

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: NUMBER_OBJECT, allocatedBy: input.changedBy,
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
      transactionCode: VENDOR_INVOICE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new VendorInvoiceError(error.message, error.remedy);
      throw error;
    });

    const company = await getCompanyCode(tx, input.client, original.companyCode);
    const position = company?.fiscalYearVariant
      ? await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate)
      : { fiscalYear: Number(input.postingDate.slice(0, 4)), period: Number(input.postingDate.slice(5, 7)) };

    await tx.insert(vendorInvoice).values({
      client: input.client, invoiceNumber: number, fiscalYear: position.fiscalYear,
      category: original.category, creditOf: original.creditOf,
      vendorNumber: original.vendorNumber, companyCode: original.companyCode,
      documentDate: original.documentDate, postingDate: input.postingDate,
      reference: original.reference, currency: original.currency,
      exchangeRate: original.exchangeRate, grossAmount: original.grossAmount,
      localGrossAmount: original.localGrossAmount, taxAmount: original.taxAmount,
      paymentTerms: original.paymentTerms, baselineDate: original.baselineDate,
      dueDate: original.dueDate, headerText: `Cancellation of ${original.invoiceNumber}`,
      status: 'POSTED', journalDocumentNumber: reversal.documentNumber,
      cancellationOf: original.invoiceNumber, requestKey: input.requestKey,
      createdBy: input.changedBy,
    });
    let lineNumber = 0;
    for (const line of original.lines) {
      lineNumber += 1;
      await tx.insert(vendorInvoiceLine).values({
        client: input.client, invoiceNumber: number, lineNumber,
        glAccount: line.glAccount, netAmount: line.netAmount, taxCode: line.taxCode,
        taxAmount: line.taxAmount, costCenter: line.costCenter, profitCenter: line.profitCenter,
        lineText: line.lineText, createdBy: input.changedBy,
      });
    }
    await tx.update(vendorInvoice).set({
      status: 'CANCELLED', cancelledBy: number, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(vendorInvoice.client, input.client), eq(vendorInvoice.invoiceNumber, original.invoiceNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: INVOICE_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: VENDOR_INVOICE_CAPABILITY,
      after: { cancellationOf: original.invoiceNumber, journal: reversal.documentNumber },
    });
    return (await loadView(tx, input.client, number))!;
  });
}
