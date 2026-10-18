/**
 * Customer open-item clearing — SCR-073 / R-121.
 *
 * A customer's open items — invoices, credit memos and payments
 * standing as uncleared partner lines — clear against each other
 * when their signed sum stands at zero. One clearing journal
 * carries the audit trail; the cleared lines are stamped in place
 * with the clearing document and the clearing date, three dates
 * (clearing, posting, document) kept distinct. A posted clearing
 * is history.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { changeDocument, changeDocumentItem } from '../../platform/tables/audit-trail';
import { customerCompany } from '../foundation/customer-company-schema';
import { journalEntry, journalEntryLine } from './schema';

export const CUSTOMER_CLEARING_CAPABILITY = 'FIN.AR.CLEAR';
const JOURNAL_DOCUMENT_TYPE = 'DZ';
const CLEARING_CLASS = 'customer_clearing';

export class CustomerClearingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CustomerClearingError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export interface CustomerItem {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  documentType: string;
  glAccount: string;
  currency: string;
  amount: string;
  signed: number;
  clearingDocument: string | null;
  clearingDate: string | null;
}

export interface CustomerClearingView {
  customer: string;
  companyCode: string;
  openItems: CustomerItem[];
  clearedItems: CustomerItem[];
  openBalance: number;
}

async function judgeCustomer(tx: Tx, client: string, customer: string, companyCode: string) {
  const [standing] = await tx.select().from(customerCompany).where(and(
    eq(customerCompany.client, client),
    eq(customerCompany.partnerNumber, customer),
    eq(customerCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new CustomerClearingError(
      `Customer ${customer} does not stand extended to company ${companyCode}.`,
      'Extend the customer to the company code, then load the open items.',
    );
  }
  return standing;
}

async function loadItems(
  tx: Tx, client: string, customer: string, companyCode: string, cleared: boolean,
): Promise<CustomerItem[]> {
  const rows = await tx.select({
    documentNumber: journalEntryLine.documentNumber,
    fiscalYear: journalEntryLine.fiscalYear,
    lineNumber: journalEntryLine.lineNumber,
    postingDate: journalEntry.postingDate,
    documentType: journalEntry.documentType,
    glAccount: journalEntryLine.glAccount,
    currency: journalEntryLine.currency,
    amount: journalEntryLine.amountLocal,
    debitCredit: journalEntryLine.debitCredit,
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
      eq(journalEntryLine.companyCode, companyCode),
      eq(journalEntryLine.businessPartner, customer),
      eq(journalEntry.status, 'POSTED'),
      cleared
        ? sql`${journalEntryLine.clearingDocument} is not null`
        : sql`${journalEntryLine.clearingDocument} is null`,
    ))
    .orderBy(journalEntry.postingDate, journalEntryLine.documentNumber, journalEntryLine.lineNumber);
  return rows.map((r) => ({
    documentNumber: r.documentNumber, fiscalYear: r.fiscalYear, lineNumber: r.lineNumber,
    postingDate: r.postingDate, documentType: r.documentType, glAccount: r.glAccount,
    currency: r.currency, amount: r.amount,
    signed: r.debitCredit === 'S' ? Number(r.amount) : -Number(r.amount),
    clearingDocument: r.clearingDocument, clearingDate: r.clearingDate,
  }));
}

async function loadView(
  tx: Tx, client: string, customer: string, companyCode: string,
): Promise<CustomerClearingView> {
  const openItems = await loadItems(tx, client, customer, companyCode, false);
  const clearedItems = await loadItems(tx, client, customer, companyCode, true);
  return {
    customer, companyCode, openItems, clearedItems,
    openBalance: round4(openItems.reduce((s, i) => s + i.signed, 0)),
  };
}

export async function getCustomerClearing(
  client: string, customer: string, companyCode: string,
): Promise<CustomerClearingView> {
  return withTenant(client, async (tx) => {
    await judgeCustomer(tx, client, customer, companyCode);
    return loadView(tx, client, customer, companyCode);
  });
}

export interface ClearingItemRef {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
}

/** A retried submission returns the standing clearing instead of clearing twice. */
async function standingClearingForRequestKey(
  tx: Tx, client: string, requestKey: string,
): Promise<string | null> {
  const [row] = await tx.select({ id: changeDocument.id })
    .from(changeDocument)
    .innerJoin(changeDocumentItem, and(
      eq(changeDocumentItem.client, changeDocument.client),
      eq(changeDocumentItem.changeDocumentId, changeDocument.id),
    ))
    .where(and(
      eq(changeDocument.client, client),
      eq(changeDocument.objectClass, CLEARING_CLASS),
      eq(changeDocumentItem.fieldName, 'requestKey'),
      eq(changeDocumentItem.newValue, requestKey),
    ));
  if (!row) return null;
  const [doc] = await tx.select({ newValue: changeDocumentItem.newValue })
    .from(changeDocumentItem)
    .where(and(
      eq(changeDocumentItem.client, client),
      eq(changeDocumentItem.changeDocumentId, row.id),
      eq(changeDocumentItem.fieldName, 'clearingDocument'),
    ));
  return doc?.newValue ?? null;
}

export async function clearCustomerItems(input: {
  client: string; changedBy: string;
  customer: string; companyCode: string;
  clearingDate: string; postingDate: string; documentDate: string;
  confirmed: boolean; requestKey: string;
  items: ClearingItemRef[];
}): Promise<CustomerClearingView & { clearingDocumentNumber: string }> {
  if (!input.confirmed) {
    throw new CustomerClearingError('The clearing stands unconfirmed.', 'Tick the confirmation, then post the clearing.');
  }
  if (input.items.length === 0) {
    throw new CustomerClearingError('Select at least one open item to clear.', 'Tick the items that settle each other.');
  }
  for (const [label, value] of [['Clearing date', input.clearingDate], ['Posting date', input.postingDate], ['Document date', input.documentDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CustomerClearingError(`${label} ${value} is not a calendar date.`);
  }
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/customerclear/${input.companyCode}/${input.customer}`}, 0))`);
    const replay = input.requestKey
      ? await standingClearingForRequestKey(tx, input.client, input.requestKey)
      : null;
    if (replay) {
      await judgeCustomer(tx, input.client, input.customer, input.companyCode);
      const view = await loadView(tx, input.client, input.customer, input.companyCode);
      return { ...view, clearingDocumentNumber: replay };
    }
    await judgeCustomer(tx, input.client, input.customer, input.companyCode);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new CustomerClearingError(`Company code ${input.companyCode} is not configured.`);

    interface Held { ref: ClearingItemRef; glAccount: string; currency: string; amount: string; signed: number }
    const held: Held[] = [];
    for (const ref of input.items) {
      const [line] = await tx.select().from(journalEntryLine).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, ref.documentNumber),
        eq(journalEntryLine.fiscalYear, ref.fiscalYear),
        eq(journalEntryLine.lineNumber, ref.lineNumber),
      ));
      if (!line || line.businessPartner !== input.customer || line.companyCode !== input.companyCode) {
        throw new CustomerClearingError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} is not an open item of customer ${input.customer} in company ${input.companyCode}.`,
          'Reload the open items, then clear.',
        );
      }
      if (line.clearingDocument) {
        throw new CustomerClearingError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} already stands cleared by ${line.clearingDocument}.`,
          'Reload the open items, then clear.',
        );
      }
      const [journal] = await tx.select().from(journalEntry).where(and(
        eq(journalEntry.client, input.client),
        eq(journalEntry.documentNumber, ref.documentNumber),
        eq(journalEntry.fiscalYear, ref.fiscalYear),
      ));
      if (!journal || journal.status !== 'POSTED') {
        throw new CustomerClearingError(`Document ${ref.documentNumber} does not stand posted.`, 'Reload the open items, then clear.');
      }
      held.push({
        ref, glAccount: line.glAccount, currency: line.currency, amount: line.amountLocal,
        signed: line.debitCredit === 'S' ? Number(line.amountLocal) : -Number(line.amountLocal),
      });
    }

    const currencies = [...new Set(held.map((h) => h.currency))];
    if (currencies.length > 1) {
      throw new CustomerClearingError(
        `The selected items stand in ${currencies.join(' and ')}; one clearing settles one currency.`,
        'Select items in a single currency.',
      );
    }
    const difference = round4(held.reduce((s, h) => s + h.signed, 0));
    if (difference !== 0) {
      throw new CustomerClearingError(
        `The selected items do not balance: the difference stands at ${Math.abs(difference).toFixed(2)} ${currencies[0]}.`,
        'Select items whose signed sum stands at zero; partial and residual clearing stand deferred.',
      );
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
      reference: input.customer,
      headerText: `Customer clearing ${input.customer}`,
      lines: held.map((h) => ({
        glAccount: h.glAccount,
        debitCredit: h.signed > 0 ? 'H' as const : 'S' as const,
        amount: Number(h.amount).toFixed(2),
        businessPartner: input.customer,
      })),
      origin: { documentClass: CLEARING_CLASS, documentKey: `${input.companyCode}/${input.customer}` },
      postedBy: input.changedBy,
      transactionCode: CUSTOMER_CLEARING_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new CustomerClearingError(error.message, error.remedy);
      throw error;
    });

    for (const h of held) {
      await tx.update(journalEntryLine).set({
        clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
      }).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, h.ref.documentNumber),
        eq(journalEntryLine.fiscalYear, h.ref.fiscalYear),
        eq(journalEntryLine.lineNumber, h.ref.lineNumber),
      ));
    }
    // The clearing lines stand cleared against their own document.
    await tx.update(journalEntryLine).set({
      clearingDocument: journal.documentNumber, clearingDate: input.clearingDate,
    }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, journal.documentNumber),
      eq(journalEntryLine.fiscalYear, journal.fiscalYear),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: CLEARING_CLASS,
      objectKey: `${input.companyCode}/${input.customer}/${journal.documentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: CUSTOMER_CLEARING_CAPABILITY,
      after: {
        clearingDocument: journal.documentNumber, items: held.length,
        clearingDate: input.clearingDate, requestKey: input.requestKey,
      },
    });

    const view = await loadView(tx, input.client, input.customer, input.companyCode);
    return { ...view, clearingDocumentNumber: journal.documentNumber };
  });
}
