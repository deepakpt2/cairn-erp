/**
 * Shared ageing derivation (SCR-120 / R-169).
 *
 * One derivation serves vendor ageing (FIN.AP.AGEING) and, as the
 * same-defect mirror repair, customer ageing (FIN.AR.AGEING):
 *
 *  - an item is a POSTED journal line in the company, on an account
 *    of the company's chart carrying the side's reconciliation type
 *    (VENDORS / CUSTOMERS), with a business partner — customer lines,
 *    expense lines and every other partner line never age here;
 *  - special G/L lines stand on the alternative reconciliation
 *    accounts of the side's special G/L indicators and join only
 *    when selected, carrying their indicator;
 *  - standing is historical: posted on or before the key date and
 *    not cleared on or before it, judged by the clearing stamp, so
 *    an item cleared after the key date stands at full line amount;
 *  - the due date comes from the canonical payment-term service:
 *    the origin invoice's baseline date plus its payment terms,
 *    recomputed; the invoice's stored due date when its terms no
 *    longer stand; the posting date for items with no invoice.
 *
 * Read-only. Vendor/customer balances are never written here.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { getCompanyCode } from '../../platform/periods';
import { businessPartner } from '../foundation/business-partner-schema';
import { calculatePaymentSchedule, type PaymentTermRule } from '../foundation/payment-term-dates';
import { paymentTerms as paymentTermsTable } from '../foundation/payment-terms-schema';
import { specialGlConfig } from '../foundation/schema';
import { customerInvoice, supplierInvoice } from '../purchasing/schema';
import { glAccount, journalEntry, journalEntryLine, vendorInvoice } from './schema';

export type AgeingSide = 'AP' | 'AR';
export type AgeingSort =
  | 'VENDOR' | 'DOCUMENT_DATE' | 'POSTING_DATE' | 'BASELINE_DATE' | 'DUE_DATE' | 'OVERDUE_DAYS';

export class AgeingDerivationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AgeingDerivationError';
    this.remedy = remedy;
  }
}

export interface DerivedAgeingItem {
  partner: string;
  partnerName: string;
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  documentType: string;
  postingDate: string;
  documentDate: string;
  baselineDate: string | null;
  dueDate: string;
  daysOverdue: number;
  bucket: number; // 0 = not yet due, 1..4 = overdue buckets
  currency: string;
  amount: string;
  documentAmount: string;
  signed: number;
  specialGlIndicator: string | null;
  paymentTerms: string | null;
  clearingDocument: string | null;
  clearingDate: string | null;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const dayMs = 24 * 60 * 60 * 1000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);

export function validateAgeingSelection(input: {
  keyDate: string; thresholds: [number, number, number];
}): void {
  const { thresholds } = input;
  if (!(thresholds.every((n) => Number.isInteger(n) && n > 0)
    && thresholds[1] > thresholds[0] && thresholds[2] > thresholds[1])) {
    throw new AgeingDerivationError(
      `Ageing thresholds ${thresholds.join(', ')} do not increase.`,
      'Give three thresholds, each a positive whole number of days greater than the last.',
    );
  }
  if (!/^\d{4}-\d{2}-(\d{2})$/.test(input.keyDate)) {
    throw new AgeingDerivationError(`Key date ${input.keyDate} is not a calendar date.`);
  }
  const parsed = new Date(`${input.keyDate}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.keyDate) {
    throw new AgeingDerivationError(`Key date ${input.keyDate} is not a calendar date.`);
  }
}

interface InvoiceDueSource {
  baselineDate: string | null;
  paymentTerms: string | null;
  dueDate: string | null;
}

export async function deriveAgeingItems(
  tx: Tx,
  client: string,
  input: {
    side: AgeingSide;
    companyCode: string;
    keyDate: string;
    partnerFrom?: string;
    partnerTo?: string;
    thresholds: [number, number, number];
    includeSpecialGl?: boolean;
    sort?: AgeingSort;
  },
): Promise<{ currency: string; items: DerivedAgeingItem[] }> {
  const company = await getCompanyCode(tx, client, input.companyCode);
  if (!company) {
    throw new AgeingDerivationError(`Company code ${input.companyCode} does not stand configured.`);
  }
  const chart = company.chartOfAccounts ?? '';
  const reconciliationType = input.side === 'AP' ? 'VENDORS' : 'CUSTOMERS';

  // Eligible accounts: the side's reconciliation accounts, plus —
  // when selected — the alternative accounts of its special G/L
  // indicators, each remembering the indicator it stands for.
  const eligible = new Map<string, string | null>();
  const reconRows = await tx.select({ accountNumber: glAccount.accountNumber })
    .from(glAccount)
    .where(and(
      eq(glAccount.client, client),
      eq(glAccount.chartOfAccounts, chart),
      eq(glAccount.reconciliationType, reconciliationType),
    ));
  for (const row of reconRows) eligible.set(row.accountNumber, null);

  // Special G/L lines stand on the alternative accounts. Journal
  // lines carry no indicator flag, so the account is the attribution:
  // with the toggle off those accounts leave the derivation entirely
  // (even when the account also reconciles normally); with it on,
  // their lines join under their indicator.
  const configs = await tx.select().from(specialGlConfig).where(and(
    eq(specialGlConfig.client, client),
    eq(specialGlConfig.accountType, input.side),
  ));
  const chosen = new Map<string, { indicator: string; companyCode: string }>();
  for (const config of [...configs].sort((a, b) => a.indicator.localeCompare(b.indicator))) {
    const account = config.alternativeReconciliationAccount;
    const standing = chosen.get(account);
    // A company-specific row wins over the tenant-wide default.
    if (!standing || (standing.companyCode === '' && config.companyCode === input.companyCode)) {
      chosen.set(account, { indicator: config.indicator, companyCode: config.companyCode });
    }
  }
  for (const [account, config] of chosen) {
    if (config.companyCode !== '' && config.companyCode !== input.companyCode) continue;
    if (input.includeSpecialGl) eligible.set(account, config.indicator);
    else eligible.delete(account);
  }
  if (eligible.size === 0) return { currency: company.currency, items: [] };

  const rows = await tx.select({
    documentNumber: journalEntryLine.documentNumber,
    fiscalYear: journalEntryLine.fiscalYear,
    lineNumber: journalEntryLine.lineNumber,
    glAccount: journalEntryLine.glAccount,
    partner: journalEntryLine.businessPartner,
    debitCredit: journalEntryLine.debitCredit,
    amount: journalEntryLine.amountLocal,
    documentAmount: journalEntryLine.amountDocument,
    currency: journalEntryLine.currency,
    postingDate: journalEntry.postingDate,
    documentDate: journalEntry.documentDate,
    documentType: journalEntry.documentType,
    originClass: journalEntry.originClass,
    originKey: journalEntry.originKey,
    clearingDocument: journalEntryLine.clearingDocument,
    clearingDate: journalEntryLine.clearingDate,
    lineTerms: journalEntryLine.paymentTerms,
    lineBaseline: journalEntryLine.baselineDate,
  }).from(journalEntryLine)
    .innerJoin(journalEntry, and(
      eq(journalEntry.client, journalEntryLine.client),
      eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
      eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
    ))
    .where(and(
      eq(journalEntryLine.client, client),
      eq(journalEntryLine.companyCode, input.companyCode),
      eq(journalEntry.companyCode, input.companyCode),
      eq(journalEntry.status, 'POSTED'),
      inArray(journalEntryLine.glAccount, [...eligible.keys()]),
      sql`${journalEntryLine.businessPartner} is not null`,
      ...(input.partnerFrom ? [sql`${journalEntryLine.businessPartner} >= ${input.partnerFrom}`] : []),
      ...(input.partnerTo ? [sql`${journalEntryLine.businessPartner} <= ${input.partnerTo}`] : []),
      sql`${journalEntry.postingDate} <= ${input.keyDate}`,
      sql`(${journalEntryLine.clearingDate} is null or ${journalEntryLine.clearingDate} > ${input.keyDate})`,
    ))
    .orderBy(journalEntryLine.businessPartner, journalEntry.postingDate, journalEntryLine.documentNumber, journalEntryLine.lineNumber);

  // Due-date sources: the origin invoices of both posting paths,
  // and the tenant's payment terms for the canonical recomputation.
  const invoiceSources = new Map<string, InvoiceDueSource>();
  const wanted: Record<string, Set<string>> = { supplier_invoice: new Set(), vendor_invoice: new Set(), customer_invoice: new Set() };
  for (const r of rows) {
    if (r.originClass && r.originKey && wanted[r.originClass]) wanted[r.originClass].add(r.originKey);
  }
  if (wanted.supplier_invoice.size > 0) {
    const found = await tx.select().from(supplierInvoice).where(eq(supplierInvoice.client, client));
    for (const inv of found) {
      if (wanted.supplier_invoice.has(inv.invoiceNumber)) {
        invoiceSources.set(`supplier_invoice|${inv.invoiceNumber}`, inv);
      }
    }
  }
  if (wanted.vendor_invoice.size > 0) {
    const found = await tx.select().from(vendorInvoice).where(eq(vendorInvoice.client, client));
    for (const inv of found) {
      if (wanted.vendor_invoice.has(inv.invoiceNumber)) {
        invoiceSources.set(`vendor_invoice|${inv.invoiceNumber}`, inv);
      }
    }
  }
  if (wanted.customer_invoice.size > 0) {
    const found = await tx.select().from(customerInvoice).where(eq(customerInvoice.client, client));
    for (const inv of found) {
      if (wanted.customer_invoice.has(inv.invoiceNumber)) {
        invoiceSources.set(`customer_invoice|${inv.invoiceNumber}`, inv);
      }
    }
  }
  const termsByCode = new Map<string, PaymentTermRule & { isActive: boolean }>();
  if (invoiceSources.size > 0 || rows.some((r) => r.lineTerms)) {
    for (const row of await tx.select().from(paymentTermsTable).where(eq(paymentTermsTable.client, client))) {
      termsByCode.set(row.termsCode, {
        termsCode: row.termsCode,
        version: row.version,
        baselineSource: row.baselineSource as PaymentTermRule['baselineSource'],
        netDays: row.netDays,
        discount1Days: row.discount1Days,
        discount1Percent: String(row.discount1Percent),
        discount2Days: row.discount2Days,
        discount2Percent: String(row.discount2Percent),
        isActive: row.isActive,
      });
    }
  }

  const names = new Map<string, string>();
  const partners = [...new Set(rows.map((r) => r.partner!))];
  if (partners.length > 0) {
    const found = await tx.select({
      partnerNumber: businessPartner.partnerNumber, name: businessPartner.name,
    }).from(businessPartner).where(and(
      eq(businessPartner.client, client),
      inArray(businessPartner.partnerNumber, partners),
    ));
    for (const row of found) names.set(row.partnerNumber, row.name);
  }

  const items: DerivedAgeingItem[] = rows.map((r) => {
    const invoice = r.originClass && r.originKey
      ? invoiceSources.get(`${r.originClass}|${r.originKey}`)
      : undefined;
    let dueDate = r.postingDate;
    let baselineDate: string | null = null;
    let paymentTermsCode: string | null = null;
    if (r.lineTerms) {
      // A line carrying its own terms — a residual item, SCR-114 follow-up —
      // judges its own due date; origin resolution never overrides it.
      paymentTermsCode = r.lineTerms;
      baselineDate = r.lineBaseline;
      const rule = termsByCode.get(r.lineTerms);
      if (baselineDate && rule?.isActive) {
        try {
          dueDate = calculatePaymentSchedule(rule, {
            [rule.baselineSource]: baselineDate,
          }).netDueDate;
        } catch {
          dueDate = r.postingDate;
        }
      } else {
        dueDate = r.postingDate;
      }
    } else if (invoice) {
      baselineDate = invoice.baselineDate;
      paymentTermsCode = invoice.paymentTerms;
      const rule = invoice.paymentTerms ? termsByCode.get(invoice.paymentTerms) : undefined;
      if (invoice.baselineDate && rule?.isActive) {
        try {
          dueDate = calculatePaymentSchedule(rule, {
            [rule.baselineSource]: invoice.baselineDate,
          }).netDueDate;
        } catch {
          dueDate = invoice.dueDate ?? r.postingDate;
        }
      } else {
        dueDate = invoice.dueDate ?? r.postingDate;
      }
    }
    const overdue = daysBetween(dueDate, input.keyDate);
    const [a, b, c] = input.thresholds;
    const bucket = overdue <= 0 ? 0 : overdue <= a ? 1 : overdue <= b ? 2 : overdue <= c ? 3 : 4;
    const signed = r.debitCredit === 'S' ? Number(r.amount) : -Number(r.amount);
    return {
      partner: r.partner!,
      partnerName: names.get(r.partner!) ?? '',
      documentNumber: r.documentNumber,
      fiscalYear: r.fiscalYear,
      lineNumber: r.lineNumber,
      documentType: r.documentType,
      postingDate: r.postingDate,
      documentDate: r.documentDate,
      baselineDate,
      dueDate,
      daysOverdue: Math.max(0, overdue),
      bucket,
      currency: r.currency,
      amount: r.amount,
      documentAmount: r.documentAmount,
      signed: round4(signed),
      specialGlIndicator: eligible.get(r.glAccount) ?? null,
      paymentTerms: paymentTermsCode,
      clearingDocument: r.clearingDocument,
      clearingDate: r.clearingDate,
    };
  });

  const byPartnerDue = (x: DerivedAgeingItem, y: DerivedAgeingItem) =>
    x.partner.localeCompare(y.partner) || x.dueDate.localeCompare(y.dueDate);
  switch (input.sort ?? 'VENDOR') {
    case 'DOCUMENT_DATE':
      items.sort((x, y) => x.documentDate.localeCompare(y.documentDate) || byPartnerDue(x, y));
      break;
    case 'POSTING_DATE':
      items.sort((x, y) => x.postingDate.localeCompare(y.postingDate) || byPartnerDue(x, y));
      break;
    case 'BASELINE_DATE':
      items.sort((x, y) => (x.baselineDate ?? x.dueDate).localeCompare(y.baselineDate ?? y.dueDate) || byPartnerDue(x, y));
      break;
    case 'DUE_DATE':
      items.sort((x, y) => x.dueDate.localeCompare(y.dueDate) || byPartnerDue(x, y));
      break;
    case 'OVERDUE_DAYS':
      items.sort((x, y) => y.daysOverdue - x.daysOverdue || byPartnerDue(x, y));
      break;
    default:
      items.sort(byPartnerDue);
  }

  return { currency: company.currency, items };
}

export interface DerivedAgeingPartnerRow {
  partner: string;
  partnerName: string;
  itemCount: number;
  buckets: [number, number, number, number, number];
  total: number;
}

export function aggregateAgeingPartners(items: DerivedAgeingItem[]): {
  partners: DerivedAgeingPartnerRow[];
  totals: [number, number, number, number, number];
  grandTotal: number;
} {
  const byPartner = new Map<string, DerivedAgeingPartnerRow>();
  const totals: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const item of items) {
    const row = byPartner.get(item.partner) ?? {
      partner: item.partner, partnerName: item.partnerName, itemCount: 0,
      buckets: [0, 0, 0, 0, 0] as [number, number, number, number, number], total: 0,
    };
    row.itemCount += 1;
    row.buckets[item.bucket] = round4(row.buckets[item.bucket] + item.signed);
    row.total = round4(row.total + item.signed);
    totals[item.bucket] = round4(totals[item.bucket] + item.signed);
    byPartner.set(item.partner, row);
  }
  const partners = [...byPartner.values()].sort((x, y) => x.partner.localeCompare(y.partner));
  return { partners, totals, grandTotal: round4(totals.reduce((s, v) => s + v, 0)) };
}
