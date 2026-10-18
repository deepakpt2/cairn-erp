/**
 * Vendor open-item clearing — SCR-064 / R-112.
 *
 * A supplier's open items — invoices, credit memos and payments
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
import { supplierCompany } from '../foundation/supplier-company-schema';
import { journalEntry, journalEntryLine } from './schema';

export const VENDOR_CLEARING_CAPABILITY = 'FIN.AP.CLEAR';
const JOURNAL_DOCUMENT_TYPE = 'KZ';
const CLEARING_CLASS = 'vendor_clearing';

export class VendorClearingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'VendorClearingError';
    this.remedy = remedy;
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export interface VendorItem {
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

export interface VendorClearingView {
  supplier: string;
  companyCode: string;
  openItems: VendorItem[];
  clearedItems: VendorItem[];
  openBalance: number;
}

async function judgeSupplier(tx: Tx, client: string, supplier: string, companyCode: string) {
  const [standing] = await tx.select().from(supplierCompany).where(and(
    eq(supplierCompany.client, client),
    eq(supplierCompany.partnerNumber, supplier),
    eq(supplierCompany.companyCode, companyCode),
  ));
  if (!standing) {
    throw new VendorClearingError(
      `Supplier ${supplier} does not stand extended to company ${companyCode}.`,
      'Extend the supplier to the company code, then load the open items.',
    );
  }
  return standing;
}

async function loadItems(
  tx: Tx, client: string, supplier: string, companyCode: string, cleared: boolean,
): Promise<VendorItem[]> {
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
      eq(journalEntryLine.businessPartner, supplier),
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

export async function getVendorClearing(
  client: string, supplier: string, companyCode: string,
): Promise<VendorClearingView> {
  return withTenant(client, async (tx) => {
    await judgeSupplier(tx, client, supplier, companyCode);
    const openItems = await loadItems(tx, client, supplier, companyCode, false);
    const clearedItems = await loadItems(tx, client, supplier, companyCode, true);
    return {
      supplier, companyCode, openItems, clearedItems,
      openBalance: round4(openItems.reduce((s, i) => s + i.signed, 0)),
    };
  });
}

export interface ClearingItemRef {
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
}

export async function clearVendorItems(input: {
  client: string; changedBy: string;
  supplier: string; companyCode: string;
  clearingDate: string; postingDate: string; documentDate: string;
  items: ClearingItemRef[];
}): Promise<VendorClearingView & { clearingDocumentNumber: string }> {
  if (input.items.length === 0) {
    throw new VendorClearingError('Select at least one open item to clear.', 'Tick the items that settle each other.');
  }
  for (const [label, value] of [['Clearing date', input.clearingDate], ['Posting date', input.postingDate], ['Document date', input.documentDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new VendorClearingError(`${label} ${value} is not a calendar date.`);
  }
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/vendorclear/${input.companyCode}/${input.supplier}`}, 0))`);
    await judgeSupplier(tx, input.client, input.supplier, input.companyCode);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new VendorClearingError(`Company code ${input.companyCode} is not configured.`);

    interface Held { ref: ClearingItemRef; glAccount: string; currency: string; amount: string; signed: number }
    const held: Held[] = [];
    for (const ref of input.items) {
      const [line] = await tx.select().from(journalEntryLine).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, ref.documentNumber),
        eq(journalEntryLine.fiscalYear, ref.fiscalYear),
        eq(journalEntryLine.lineNumber, ref.lineNumber),
      ));
      if (!line || line.businessPartner !== input.supplier || line.companyCode !== input.companyCode) {
        throw new VendorClearingError(
          `Document ${ref.documentNumber} line ${ref.lineNumber} is not an open item of supplier ${input.supplier} in company ${input.companyCode}.`,
          'Reload the open items, then clear.',
        );
      }
      if (line.clearingDocument) {
        throw new VendorClearingError(
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
        throw new VendorClearingError(`Document ${ref.documentNumber} does not stand posted.`, 'Reload the open items, then clear.');
      }
      held.push({
        ref, glAccount: line.glAccount, currency: line.currency, amount: line.amountLocal,
        signed: line.debitCredit === 'S' ? Number(line.amountLocal) : -Number(line.amountLocal),
      });
    }

    const currencies = [...new Set(held.map((h) => h.currency))];
    if (currencies.length > 1) {
      throw new VendorClearingError(
        `The selected items stand in ${currencies.join(' and ')}; one clearing settles one currency.`,
        'Select items in a single currency.',
      );
    }
    const difference = round4(held.reduce((s, h) => s + h.signed, 0));
    if (difference !== 0) {
      throw new VendorClearingError(
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
      reference: input.supplier,
      headerText: `Vendor clearing ${input.supplier}`,
      lines: held.map((h) => ({
        glAccount: h.glAccount,
        debitCredit: h.signed > 0 ? 'H' as const : 'S' as const,
        amount: Number(h.amount).toFixed(2),
        businessPartner: input.supplier,
      })),
      origin: { documentClass: CLEARING_CLASS, documentKey: `${input.companyCode}/${input.supplier}` },
      postedBy: input.changedBy,
      transactionCode: VENDOR_CLEARING_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new VendorClearingError(error.message, error.remedy);
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
      objectKey: `${input.companyCode}/${input.supplier}/${journal.documentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: VENDOR_CLEARING_CAPABILITY,
      after: { clearingDocument: journal.documentNumber, items: held.length, clearingDate: input.clearingDate },
    });

    const view = await getVendorClearingInTx(tx, input.client, input.supplier, input.companyCode);
    return { ...view, clearingDocumentNumber: journal.documentNumber };
  });
}

async function getVendorClearingInTx(
  tx: Tx, client: string, supplier: string, companyCode: string,
): Promise<VendorClearingView> {
  const openItems = await loadItems(tx, client, supplier, companyCode, false);
  const clearedItems = await loadItems(tx, client, supplier, companyCode, true);
  return {
    supplier, companyCode, openItems, clearedItems,
    openBalance: round4(openItems.reduce((s, i) => s + i.signed, 0)),
  };
}
