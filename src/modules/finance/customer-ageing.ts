/**
 * Customer ageing analysis — SCR-070 / R-118.
 *
 * Read-only. Standing reconstructs as of the key date: an item
 * stands when its journal posted on or before the key date and it
 * was not cleared on or before it. Ageing runs on the due date —
 * the verified invoice's computed due date where the item came
 * from invoice verification, the journal's posting date otherwise.
 * Amounts aggregate in company-code currency. Nothing posts here.
 */
import { and, eq, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { getCompanyCode } from '../../platform/periods';
import { customerInvoice } from '../purchasing/schema';
import { journalEntry, journalEntryLine } from './schema';

export const CUSTOMER_AGEING_CAPABILITY = 'FIN.AR.AGEING';

export class CustomerAgeingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerAgeingError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export interface AgeingItem {
  customer: string;
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  dueDate: string;
  daysOverdue: number;
  bucket: number; // 0 = not yet due, 1..4 = overdue buckets
  currency: string;
  amount: string;
  signed: number;
}

export interface AgeingCustomerRow {
  customer: string;
  buckets: [number, number, number, number, number];
  total: number;
}

export interface CustomerAgeingView {
  companyCode: string;
  keyDate: string;
  currency: string;
  thresholds: [number, number, number];
  customers: AgeingCustomerRow[];
  totals: [number, number, number, number, number];
  grandTotal: number;
  items: AgeingItem[];
}

const dayMs = 24 * 60 * 60 * 1000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);

export async function getCustomerAgeing(client: string, input: {
  companyCode: string; keyDate: string;
  customerFrom?: string; customerTo?: string;
  thresholds?: [number, number, number];
}): Promise<CustomerAgeingView> {
  const thresholds = input.thresholds ?? [30, 60, 90];
  if (!(thresholds[0] > 0 && thresholds[1] > thresholds[0] && thresholds[2] > thresholds[1])) {
    throw new CustomerAgeingError(
      `Ageing thresholds ${thresholds.join(', ')} do not increase.`,
      'Give three thresholds, each greater than the last.',
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.keyDate)) {
    throw new CustomerAgeingError(`Key date ${input.keyDate} is not a calendar date.`);
  }
  return withTenant(client, async (tx) => {
    const company = await getCompanyCode(tx, client, input.companyCode);
    if (!company) throw new CustomerAgeingError(`Company code ${input.companyCode} does not stand configured.`);

    const invoices = new Map<string, string | null>();
    for (const inv of await tx.select().from(customerInvoice).where(eq(customerInvoice.client, client))) {
      invoices.set(inv.invoiceNumber, inv.dueDate);
    }

    const rows = await tx.select({
      documentNumber: journalEntryLine.documentNumber,
      fiscalYear: journalEntryLine.fiscalYear,
      lineNumber: journalEntryLine.lineNumber,
      customer: journalEntryLine.businessPartner,
      debitCredit: journalEntryLine.debitCredit,
      amount: journalEntryLine.amountLocal,
      currency: journalEntryLine.currency,
      postingDate: journalEntry.postingDate,
      originClass: journalEntry.originClass,
      originKey: journalEntry.originKey,
      clearingDate: journalEntryLine.clearingDate,
    }).from(journalEntryLine)
      .innerJoin(journalEntry, and(
        eq(journalEntry.client, journalEntryLine.client),
        eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
        eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
      ))
      .where(and(
        eq(journalEntryLine.client, client),
        eq(journalEntryLine.companyCode, input.companyCode),
        eq(journalEntry.status, 'POSTED'),
        sql`${journalEntryLine.businessPartner} is not null`,
      ))
      .orderBy(journalEntryLine.businessPartner, journalEntry.postingDate, journalEntryLine.documentNumber);

    const items: AgeingItem[] = [];
    for (const r of rows) {
      const customer = r.customer!;
      if (input.customerFrom && customer < input.customerFrom) continue;
      if (input.customerTo && customer > input.customerTo) continue;
      // Standing as of the key date: posted by then, not cleared by then.
      if (r.postingDate > input.keyDate) continue;
      if (r.clearingDate && r.clearingDate <= input.keyDate) continue;
      const dueDate = r.originClass === 'customer_invoice' && r.originKey
        ? (invoices.get(r.originKey) ?? r.postingDate)
        : r.postingDate;
      const overdue = daysBetween(dueDate, input.keyDate);
      const bucket = overdue <= 0 ? 0
        : overdue <= thresholds[0] ? 1
        : overdue <= thresholds[1] ? 2
        : overdue <= thresholds[2] ? 3 : 4;
      const signed = r.debitCredit === 'S' ? Number(r.amount) : -Number(r.amount);
      items.push({
        customer, documentNumber: r.documentNumber, fiscalYear: r.fiscalYear,
        lineNumber: r.lineNumber, postingDate: r.postingDate, dueDate,
        daysOverdue: Math.max(0, overdue), bucket, currency: r.currency,
        amount: r.amount, signed: round4(signed),
      });
    }
    items.sort((a, b) => a.customer.localeCompare(b.customer) || a.dueDate.localeCompare(b.dueDate));

    const byCustomer = new Map<string, AgeingCustomerRow>();
    const totals: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    for (const item of items) {
      const row = byCustomer.get(item.customer) ?? {
        customer: item.customer, buckets: [0, 0, 0, 0, 0] as [number, number, number, number, number], total: 0,
      };
      row.buckets[item.bucket] = round4(row.buckets[item.bucket] + item.signed);
      row.total = round4(row.total + item.signed);
      totals[item.bucket] = round4(totals[item.bucket] + item.signed);
      byCustomer.set(item.customer, row);
    }

    return {
      companyCode: input.companyCode, keyDate: input.keyDate, currency: company.currency,
      thresholds, customers: [...byCustomer.values()],
      totals, grandTotal: round4(totals.reduce((s, v) => s + v, 0)), items,
    };
  });
}
