/**
 * Customer balances — SCR-069 / R-117.
 *
 * Read-only. Period balances derive at read time from the posted
 * journal — no balance table stands to drift from the ledger.
 * Opening is the signed sum of every earlier year, turnover the
 * period's debits and credits, closing opening plus movement,
 * chained period by period. A period drill lists the line items
 * behind it. This module posts nothing.
 */
import { and, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { getCompanyCode, getVariant } from '../../platform/periods';
import { customerCompany } from '../foundation/customer-company-schema';
import { journalEntry, journalEntryLine } from './schema';

export const CUSTOMER_BALANCE_CAPABILITY = 'FIN.AR.BALANCE';

export class CustomerBalanceError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerBalanceError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export interface BalancePeriodRow {
  period: number;
  special: boolean;
  opening: number;
  debitTurnover: number;
  creditTurnover: number;
  closing: number;
  itemCount: number;
}

export interface CustomerBalanceItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  documentType: string;
  debitCredit: string;
  documentAmount: string;
  documentCurrency: string;
  localAmount: string;
  clearingDocument: string | null;
  clearingDate: string | null;
}

export interface CustomerBalanceView {
  customer: string;
  companyCode: string;
  fiscalYear: number;
  currency: string;
  periods: BalancePeriodRow[];
  yearDebit: number;
  yearCredit: number;
  yearClosing: number;
  items: CustomerBalanceItem[];
  selectedPeriod: number | null;
}

export async function getCustomerBalances(client: string, input: {
  customer: string; companyCode: string; fiscalYear: number;
  displayCurrency?: string; periodFrom?: number; periodTo?: number;
  specialPeriods?: boolean; selectedPeriod?: number;
}): Promise<CustomerBalanceView> {
  return withTenant(client, async (tx) => {
    const [standing] = await tx.select().from(customerCompany).where(and(
      eq(customerCompany.client, client),
      eq(customerCompany.partnerNumber, input.customer),
      eq(customerCompany.companyCode, input.companyCode),
    ));
    if (!standing) {
      throw new CustomerBalanceError(
        `Customer ${input.customer} does not stand extended to company ${input.companyCode}.`,
        'Extend the customer to the company code, then display the balances.',
      );
    }
    const company = await getCompanyCode(tx, client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new CustomerBalanceError(`Company code ${input.companyCode} is not configured.`);
    const variant = await getVariant(tx, client, company.fiscalYearVariant);

    const regular = variant.regularPeriods;
    const lastPeriod = input.specialPeriods ? regular + variant.specialPeriods : regular;
    const from = Math.max(1, input.periodFrom ?? 1);
    const to = Math.min(lastPeriod, input.periodTo ?? lastPeriod);
    if (from > to) {
      throw new CustomerBalanceError(
        `Period range ${from}–${to} stands empty for variant ${company.fiscalYearVariant}.`,
        'Widen the period range or include the special periods.',
      );
    }

    // One pass over the customer's posted partner lines in the company.
    const rows = await tx.select({
      fiscalYear: journalEntry.fiscalYear,
      period: journalEntry.postingPeriod,
      debitCredit: journalEntryLine.debitCredit,
      amountLocal: journalEntryLine.amountLocal,
      amountDocument: journalEntryLine.amountDocument,
      currency: journalEntryLine.currency,
    }).from(journalEntryLine)
      .innerJoin(journalEntry, and(
        eq(journalEntry.client, journalEntryLine.client),
        eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
        eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
      ))
      .where(and(
        eq(journalEntryLine.client, client),
        eq(journalEntryLine.companyCode, input.companyCode),
        eq(journalEntryLine.businessPartner, input.customer),
        eq(journalEntry.status, 'POSTED'),
      ));

    // Display currency: company currency shows local amounts; a currency
    // the lines carry shows document amounts; anything else refuses.
    const carried = [...new Set(rows.map((r) => r.currency))];
    const display = (input.displayCurrency ?? '').toUpperCase();
    let useDocument = false;
    let currency = company.currency;
    if (display && display !== company.currency) {
      if (carried.includes(display) && carried.length === 1) {
        useDocument = true;
        currency = display;
      } else {
        throw new CustomerBalanceError(
          `Balances cannot display in ${display}: the items stand in ${[...new Set([company.currency, ...carried])].join(' and ')}, and no conversion is performed.`,
          'Display in the company currency or the currency the items stand in.',
        );
      }
    }
    const amount = (r: (typeof rows)[number]) => Number(useDocument ? r.amountDocument : r.amountLocal);

    let opening = 0;
    const byPeriod = new Map<number, { debit: number; credit: number; count: number }>();
    for (const r of rows) {
      const value = amount(r);
      if (r.fiscalYear < input.fiscalYear) {
        opening += r.debitCredit === 'S' ? value : -value;
      } else if (r.fiscalYear === input.fiscalYear) {
        const slot = byPeriod.get(r.period) ?? { debit: 0, credit: 0, count: 0 };
        if (r.debitCredit === 'S') slot.debit += value; else slot.credit += value;
        slot.count += 1;
        byPeriod.set(r.period, slot);
      }
    }

    const periods: BalancePeriodRow[] = [];
    let running = round4(opening);
    let yearDebit = 0;
    let yearCredit = 0;
    for (let period = 1; period <= lastPeriod; period += 1) {
      const slot = byPeriod.get(period) ?? { debit: 0, credit: 0, count: 0 };
      const periodOpening = running;
      const closing = round4(periodOpening + slot.debit - slot.credit);
      if (period <= regular || input.specialPeriods) {
        yearDebit += slot.debit;
        yearCredit += slot.credit;
      }
      if (period >= from && period <= to) {
        periods.push({
          period, special: period > regular,
          opening: periodOpening, debitTurnover: round4(slot.debit),
          creditTurnover: round4(slot.credit), closing, itemCount: slot.count,
        });
      }
      running = closing;
    }

    let items: CustomerBalanceItem[] = [];
    if (input.selectedPeriod) {
      const detail = await tx.select({
        documentNumber: journalEntryLine.documentNumber,
        fiscalYear: journalEntryLine.fiscalYear,
        lineNumber: journalEntryLine.lineNumber,
        postingDate: journalEntry.postingDate,
        documentType: journalEntry.documentType,
        debitCredit: journalEntryLine.debitCredit,
        documentAmount: journalEntryLine.amountDocument,
        documentCurrency: journalEntryLine.currency,
        localAmount: journalEntryLine.amountLocal,
        clearingDocument: journalEntryLine.clearingDocument,
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
          eq(journalEntryLine.businessPartner, input.customer),
          eq(journalEntry.status, 'POSTED'),
          eq(journalEntry.fiscalYear, input.fiscalYear),
          eq(journalEntry.postingPeriod, input.selectedPeriod),
        ))
        .orderBy(journalEntry.postingDate, journalEntryLine.documentNumber, journalEntryLine.lineNumber);
      items = detail;
    }

    return {
      customer: input.customer, companyCode: input.companyCode, fiscalYear: input.fiscalYear,
      currency, periods,
      yearDebit: round4(yearDebit), yearCredit: round4(yearCredit), yearClosing: running,
      items, selectedPeriod: input.selectedPeriod ?? null,
    };
  });
}
