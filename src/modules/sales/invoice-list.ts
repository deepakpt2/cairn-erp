/**
 * The invoice list — VF21 to create, VF24 to display and release (CAIRN.md §11.2, §14.7, §20; §4.6, gap G2).
 *
 * An invoice list is not a second billing of the same goods. A customer who is billed by list receives
 * one document a period that records the several billing documents raised inside it: the invoices stand
 * for what was delivered, and the list stands for what is owed. SAP keeps the list in `VBRK` as a billing
 * document of its own whose items are already-released billing documents, which is what this file does —
 * the list is a `billing_document` of type `LR`, and its items are rows of `sales_invoice_list_item`
 * naming the documents it groups.
 *
 * **The one rule that makes it worth having.** A document that is relevant for a list posts **no**
 * receivable when it is billed: it stands OPEN and DUE, released to the customer but not to accounting.
 * The receivable is the list's, raised once when the list is released, for the group. Were the member
 * documents to post as well, the customer would owe the money twice, and the list would be a reprint.
 * This is why relevance is decided at the moment of billing and never revised — SAP stamps `FKART_RL`
 * and `FKDAT_RL` at creation and will not change them online — and why the list stores what each member
 * was worth on the day it was listed rather than reading it back later.
 *
 * Relevance needs **both** halves: an invoice-list type on the billing type (SAP assigns it in `OVV7`)
 * **and** an invoicing-list schedule on the **payer's** sales-area master. Either alone leaves the
 * document posting on its own, which is what every document raised before this increment does, and what
 * every document raised for a payer with no schedule still does.
 *
 * Creating a list (VF21) and releasing it (VF24) are two acts, not one, and carry two capabilities: the
 * list is a document a clerk assembles and checks before it becomes a receivable anybody has to pay.
 * A listed document cannot be posted or cancelled on its own, because the receivable is no longer its to
 * post; cancelling the list returns its members to due, to be listed again or released one by one.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { postCustomerInvoice, type CustomerInvoiceView } from '../finance/customer-invoice';
import { companyCode as companyCodeTable, taxCode as taxCodeTable } from '../foundation/schema';
import { customerSalesArea } from '../foundation/customer-sales-area-schema';
import { materialSales } from '../inventory/schema';

import {
  billingDocument, billingDocumentLine, salesDocumentPartner, salesInvoiceListItem,
} from './schema';
import {
  DOCUMENT_TYPE_REMEDY, STANDARD_INVOICE_LIST_TYPE, salesDocumentTypeFor,
} from './document-type';
import { type DocumentPartners, writeDocumentPartners } from './partners';
import { determineLineAccounts } from './account-determination';
import { type StoredCondition, documentConditionsOf } from './pricing-procedure';
import { BILLING_OBJECT_CLASS, revenueAccountFor } from './billing';

/** What the change log calls one of these: an invoice list is its own object, not a billing document. */
export const INVOICE_LIST_OBJECT_CLASS = 'sales_invoice_list';
/**
 * The type an invoice list is raised as. Defined with the rest of the catalogue in `document-type`,
 * where the reason it is not SAP's own `LR` is recorded: this package spends that code on the returns
 * delivery, and a document type is unique by code within a tenant.
 */
export const INVOICE_LIST_TYPE = STANDARD_INVOICE_LIST_TYPE;
export const INVOICE_LIST_CREATE_CAPABILITY = 'SALES.INVOICE_LIST.CREATE';
export const INVOICE_LIST_RELEASE_CAPABILITY = 'SALES.INVOICE_LIST.RELEASE';
/** Where the two acts live: one screen, because the list and what is waiting for one are one view. */
export const INVOICE_LIST_ROUTE = '/sales/invoice-lists';

const ITEM_STEP = 10;

export class InvoiceListError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'InvoiceListError';
    this.remedy = remedy;
  }
}

/* ------------------------------------------------------------------ *
 * What the screen shows
 * ------------------------------------------------------------------ */

/** A billing document waiting to be listed, as VF21 shows it. */
export interface InvoiceListDueRow {
  billingNumber: string;
  documentType: string;
  billingDate: string;
  invoiceListType: string;
  invoiceListDate: string;
  payer: string;
  soldTo: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  companyCode: string;
  currency: string;
  netValue: number;
  taxValue: number;
  grossValue: number;
}

export interface InvoiceListDueSelection {
  /** Narrow to a list type — `LR` for a customer invoice list. */
  invoiceListType?: string;
  /** Narrow to the payer whose list it is. */
  payer?: string;
  salesOrg?: string;
  companyCode?: string;
  currency?: string;
  /** Narrow to one list date: the period whose documents are being grouped. */
  invoiceListDate?: string;
}

/**
 * The documents a list could still be made of (VF21). A document is due while it stands OPEN, carries a
 * list type and date, and has not been listed — which in practice is exactly the set that has been
 * released to the customer and not yet to accounting.
 */
export async function invoiceListDueDocuments(
  client: string,
  selection: InvoiceListDueSelection = {},
): Promise<InvoiceListDueRow[]> {
  return withTenant(client, (tx) => dueRows(tx, client, selection));
}

async function dueRows(
  tx: Tx,
  client: string,
  selection: InvoiceListDueSelection = {},
): Promise<InvoiceListDueRow[]> {
  {
    const partners = await tx.select({
      billingNumber: salesDocumentPartner.documentNumber,
      payer: salesDocumentPartner.partnerNumber,
    }).from(salesDocumentPartner).where(and(
      eq(salesDocumentPartner.client, client),
      eq(salesDocumentPartner.documentCategory, 'BILLING'),
      eq(salesDocumentPartner.functionCode, 'PY'),
    ));
    const payerOf = new Map(partners.map((row) => [row.billingNumber, row.payer]));

    const rows = await tx.select({
      billingNumber: billingDocument.billingNumber,
      documentType: billingDocument.documentType,
      billingDate: billingDocument.billingDate,
      invoiceListType: billingDocument.invoiceListType,
      invoiceListDate: billingDocument.invoiceListDate,
      soldTo: billingDocument.customerNumber,
      salesOrg: billingDocument.salesOrg,
      distributionChannel: billingDocument.distributionChannel,
      division: billingDocument.division,
      companyCode: billingDocument.companyCode,
      currency: billingDocument.currency,
      netValue: billingDocument.netValue,
      taxValue: billingDocument.taxValue,
      grossValue: billingDocument.grossValue,
    }).from(billingDocument).where(and(
      eq(billingDocument.client, client),
      eq(billingDocument.status, 'OPEN'),
      eq(billingDocument.invoiceListStatus, 'DUE'),
      isNull(billingDocument.invoiceListNumber),
      selection.invoiceListType ? eq(billingDocument.invoiceListType, selection.invoiceListType) : undefined,
      selection.invoiceListDate ? eq(billingDocument.invoiceListDate, selection.invoiceListDate) : undefined,
      selection.salesOrg ? eq(billingDocument.salesOrg, selection.salesOrg) : undefined,
      selection.companyCode ? eq(billingDocument.companyCode, selection.companyCode) : undefined,
      selection.currency ? eq(billingDocument.currency, selection.currency) : undefined,
    )).orderBy(asc(billingDocument.invoiceListDate), asc(billingDocument.billingNumber));

    return rows
      .map((row) => ({
        ...row,
        payer: payerOf.get(row.billingNumber) ?? row.soldTo,
        // A document is only due while both halves stand, so the pair is never null here. The fallback
        // is what keeps the type honest rather than a claim about the data.
        invoiceListType: row.invoiceListType ?? '',
        invoiceListDate: row.invoiceListDate ?? row.billingDate,
        netValue: Number(row.netValue),
        taxValue: Number(row.taxValue),
        grossValue: Number(row.grossValue),
      }))
      .filter((row) => !selection.payer || row.payer === selection.payer);
  }
}

/** One member of a list, as it was written down when it was listed. */
export interface InvoiceListItemView {
  itemNumber: number;
  billingNumber: string;
  documentType: string;
  billingDate: string;
  netValue: number;
  taxValue: number;
  grossValue: number;
}

export interface InvoiceListHeaderView {
  billingNumber: string;
  documentType: string;
  billingDate: string;
  /** The period the list covers: the date every member was stamped with. */
  invoiceListDate: string;
  payer: string;
  soldTo: string;
  salesOrg: string;
  companyCode: string;
  currency: string;
  status: string;
  netValue: number;
  taxValue: number;
  grossValue: number;
  postingDate: string | null;
  customerInvoiceNumber: string | null;
  journalDocumentNumber: string | null;
  referenceDocumentText: string | null;
  version: number;
}

export interface InvoiceListView {
  header: InvoiceListHeaderView;
  items: InvoiceListItemView[];
}

export async function getInvoiceList(client: string, billingNumber: string): Promise<InvoiceListView | null> {
  return withTenant(client, async (tx) => loadInvoiceList(tx, client, billingNumber.trim().toUpperCase()));
}

async function loadInvoiceList(tx: Tx, client: string, number: string): Promise<InvoiceListView | null> {
  const [header] = await tx.select().from(billingDocument).where(and(
    eq(billingDocument.client, client), eq(billingDocument.billingNumber, number),
  )).limit(1);
  if (!header) return null;

  const members = await tx.select({
    itemNumber: salesInvoiceListItem.itemNumber,
    billingNumber: salesInvoiceListItem.billingNumber,
    netValue: salesInvoiceListItem.netValue,
    taxValue: salesInvoiceListItem.taxValue,
    grossValue: salesInvoiceListItem.grossValue,
    documentType: billingDocument.documentType,
    billingDate: billingDocument.billingDate,
  }).from(salesInvoiceListItem)
    .innerJoin(billingDocument, and(
      eq(billingDocument.client, salesInvoiceListItem.client),
      eq(billingDocument.billingNumber, salesInvoiceListItem.billingNumber),
    ))
    .where(and(
      eq(salesInvoiceListItem.client, client),
      eq(salesInvoiceListItem.invoiceListNumber, number),
    ))
    .orderBy(asc(salesInvoiceListItem.itemNumber));

  const [payer] = await tx.select({ partnerNumber: salesDocumentPartner.partnerNumber })
    .from(salesDocumentPartner).where(and(
      eq(salesDocumentPartner.client, client),
      eq(salesDocumentPartner.documentCategory, 'BILLING'),
      eq(salesDocumentPartner.documentNumber, number),
      eq(salesDocumentPartner.functionCode, 'PY'),
    )).limit(1);

  return {
    header: {
      billingNumber: header.billingNumber,
      documentType: header.documentType,
      billingDate: header.billingDate,
      invoiceListDate: header.billingDate,
      payer: payer?.partnerNumber ?? header.customerNumber,
      soldTo: header.customerNumber,
      salesOrg: header.salesOrg,
      companyCode: header.companyCode,
      currency: header.currency,
      status: header.status,
      netValue: Number(header.netValue),
      taxValue: Number(header.taxValue),
      grossValue: Number(header.grossValue),
      postingDate: header.postingDate,
      customerInvoiceNumber: header.customerInvoiceNumber,
      journalDocumentNumber: header.journalDocumentNumber,
      referenceDocumentText: header.referenceDocumentText,
      version: header.version,
    },
    items: members.map((row) => ({
      itemNumber: row.itemNumber,
      billingNumber: row.billingNumber,
      documentType: row.documentType,
      billingDate: row.billingDate,
      netValue: Number(row.netValue),
      taxValue: Number(row.taxValue),
      grossValue: Number(row.grossValue),
    })),
  };
}

/** A standing list, as VF24 shows it. */
export interface InvoiceListRow {
  billingNumber: string;
  billingDate: string;
  documentType: string;
  payer: string;
  companyCode: string;
  currency: string;
  status: string;
  netValue: number;
  taxValue: number;
  grossValue: number;
  itemCount: number;
  customerInvoiceNumber: string | null;
}

export async function listInvoiceLists(
  client: string,
  selection: { status?: string; payer?: string; companyCode?: string } = {},
): Promise<InvoiceListRow[]> {
  return withTenant(client, async (tx) => {
    const counts = await tx.select({
      invoiceListNumber: salesInvoiceListItem.invoiceListNumber,
      itemCount: sql<number>`count(*)::int`,
    }).from(salesInvoiceListItem)
      .where(eq(salesInvoiceListItem.client, client))
      .groupBy(salesInvoiceListItem.invoiceListNumber);
    const size = new Map(counts.map((row) => [row.invoiceListNumber, row.itemCount]));

    const payers = await tx.select({
      documentNumber: salesDocumentPartner.documentNumber,
      partnerNumber: salesDocumentPartner.partnerNumber,
    }).from(salesDocumentPartner).where(and(
      eq(salesDocumentPartner.client, client),
      eq(salesDocumentPartner.documentCategory, 'BILLING'),
      eq(salesDocumentPartner.functionCode, 'PY'),
    ));
    const payerOf = new Map(payers.map((row) => [row.documentNumber, row.partnerNumber]));

    const rows = await tx.select().from(billingDocument).where(and(
      eq(billingDocument.client, client),
      eq(billingDocument.invoiceListStatus, 'NOT_RELEVANT'),
      isNull(billingDocument.invoiceListType),
      inArray(billingDocument.billingNumber, [...size.keys()]),
      selection.status ? eq(billingDocument.status, selection.status) : undefined,
      selection.companyCode ? eq(billingDocument.companyCode, selection.companyCode) : undefined,
    )).orderBy(desc(billingDocument.billingDate), desc(billingDocument.billingNumber));

    return rows
      .map((row) => ({
        billingNumber: row.billingNumber,
        billingDate: row.billingDate,
        documentType: row.documentType,
        payer: payerOf.get(row.billingNumber) ?? row.customerNumber,
        companyCode: row.companyCode,
        currency: row.currency,
        status: row.status,
        netValue: Number(row.netValue),
        taxValue: Number(row.taxValue),
        grossValue: Number(row.grossValue),
        itemCount: size.get(row.billingNumber) ?? 0,
        customerInvoiceNumber: row.customerInvoiceNumber,
      }))
      .filter((row) => !selection.payer || row.payer === selection.payer);
  });
}

/* ------------------------------------------------------------------ *
 * Creating a list — VF21
 * ------------------------------------------------------------------ */

export interface InvoiceListCreateInput {
  client: string;
  changedBy: string;
  /** Which documents to list. Omitted, every due document matching the selection is taken. */
  billingNumbers?: string[];
  selection?: InvoiceListDueSelection;
  /** Defaults to the list type the members were stamped with. */
  documentType?: string;
  /** Defaults to the members' list date: the period whose documents these are. */
  billingDate?: string;
  referenceDocumentText?: string;
  requestKey?: string;
  transactionCode?: string;
}

export interface InvoiceListCreateResult {
  list: InvoiceListView;
  /** The documents the list took, in the order they stand on it. */
  listed: string[];
}

export const createInvoiceListInputSchema = z.object({
    client: z.string().trim().min(1),
    changedBy: z.string().trim().min(1),
    billingNumbers: z.array(z.string().trim().min(1)).optional(),
    selection: z.object({
      invoiceListType: z.string().trim().optional(),
      payer: z.string().trim().optional(),
      salesOrg: z.string().trim().optional(),
      companyCode: z.string().trim().optional(),
      currency: z.string().trim().optional(),
      invoiceListDate: z.string().trim().optional(),
    }).optional(),
    documentType: z.string().trim().min(1).max(4).optional(),
    billingDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    referenceDocumentText: z.string().trim().max(100).optional(),
    requestKey: z.string().trim().max(64).optional(),
  transactionCode: z.string().trim().max(20).optional(),
});

export async function createInvoiceList(input: InvoiceListCreateInput): Promise<InvoiceListCreateResult> {
  const parsed = createInvoiceListInputSchema.parse(input);
  return withTenant(parsed.client, async (tx) => {
    const client = parsed.client;
    const changedBy = parsed.changedBy;

    // Idempotency: SAP's VF21 will not raise the same list twice, and neither will this. A submitted key
    // that has already produced a list returns that list rather than a second one for the same documents.
    if (parsed.requestKey) {
      const [standing] = await tx.select({ billingNumber: billingDocument.billingNumber })
        .from(billingDocument).where(and(
          eq(billingDocument.client, client),
          eq(billingDocument.requestKey, parsed.requestKey),
        )).limit(1);
      if (standing) {
        const view = await loadInvoiceList(tx, client, standing.billingNumber);
        if (view) return { list: view, listed: view.items.map((item) => item.billingNumber) };
      }
    }

    const due = parsed.billingNumbers?.length
      ? await dueByNumber(tx, client, parsed.billingNumbers)
      : await dueRows(tx, client, parsed.selection ?? {});
    if (due.length === 0) {
      throw new InvoiceListError(
        'No billing document is waiting for an invoice list.',
        'A document has to be billed, and to carry a list type and a list date, before it can be listed.',
      );
    }

    // One list is one receivable owed by one partner in one currency, and covers one period. Anything
    // else would be a document nobody can pay from, so the group is checked before it is numbered.
    const groups = new Map<string, InvoiceListDueRow[]>();
    for (const row of due) {
      const key = [row.payer, row.companyCode, row.currency, row.invoiceListType, row.invoiceListDate].join('|');
      const bucket = groups.get(key);
      if (bucket) bucket.push(row); else groups.set(key, [row]);
    }
    if (groups.size > 1) {
      const what = [...groups.values()].map((rows) =>
        `${rows[0].payer}/${rows[0].companyCode}/${rows[0].currency} at ${rows[0].invoiceListDate}`).join(', ');
      throw new InvoiceListError(
        `The ${due.length} documents chosen fall into ${groups.size} groups (${what}).`,
        'One list is raised for one payer, company code, currency and list date: narrow the selection.',
      );
    }

    const members = [...(groups.values().next().value as InvoiceListDueRow[])];
    const documentType = parsed.documentType ?? members[0].invoiceListType;
    const billingDate = parsed.billingDate ?? members[0].invoiceListDate;

    const type = await salesDocumentTypeFor(tx, client, documentType);
    if (!type) {
      throw new InvoiceListError(
        `Billing type ${documentType} does not stand, or is not a billing type.`,
        DOCUMENT_TYPE_REMEDY,
      );
    }

    // The list is dated the day the period closes, because that is the day the members were stamped
    // with: a list that closes the month is dated the last day of the month, not the day it was drawn.
    // The list draws its number from the interval its own type names, which is the billing interval:
    // a list is a billing document, and SAP numbers it out of the same range as the invoices it groups.
    const allocated = await allocateNumber(tx, {
      client, objectCode: type.numberRangeObject, subObject: type.numberRangeSubObject,
      allocatedBy: changedBy,
    });
    if (!type.numberRangeObject) {
      throw new InvoiceListError(
        `Billing type ${documentType} names no number range.`,
        DOCUMENT_TYPE_REMEDY,
      );
    }
    const number = allocated.display;

    await tx.insert(billingDocument).values({
      client,
      billingNumber: number,
      documentType,
      salesOrg: members[0].salesOrg,
      distributionChannel: members[0].distributionChannel,
      division: members[0].division,
      customerNumber: members[0].soldTo,
      companyCode: members[0].companyCode,
      currency: members[0].currency,
      billingDate,
      status: 'OPEN',
      netValue: round2(sum(members, (row) => row.netValue)).toFixed(4),
      taxValue: round2(sum(members, (row) => row.taxValue)).toFixed(4),
      grossValue: round2(sum(members, (row) => row.grossValue)).toFixed(4),
      referenceDocumentText:
        (parsed.referenceDocumentText ?? `Invoice list for ${members[0].invoiceListDate}`).slice(0, 100),
      requestKey: parsed.requestKey || null,
      // The list is not itself listed: it is the document the list is made of.
      invoiceListStatus: 'NOT_RELEVANT',
      version: 1,
      createdBy: changedBy,
    });

    await writeDocumentPartners(tx, {
      client, documentCategory: 'BILLING', documentNumber: number,
      partners: { soldTo: members[0].soldTo, shipTo: members[0].soldTo, billTo: members[0].soldTo, payer: members[0].payer } satisfies DocumentPartners,
      changedBy,
    });

    // What each member contributes, written down now and not read back later: the list has to be able
    // to say what it was worth on the day it was raised, which is not what the members read tomorrow.
    await tx.insert(salesInvoiceListItem).values(members.map((row, index) => ({
      client,
      invoiceListNumber: number,
      itemNumber: (index + 1) * ITEM_STEP,
      billingNumber: row.billingNumber,
      netValue: row.netValue.toFixed(4),
      taxValue: row.taxValue.toFixed(4),
      grossValue: row.grossValue.toFixed(4),
      createdBy: changedBy,
    })));

    const listed: string[] = [];
    for (const row of members) {
      const applied = await tx.update(billingDocument).set({
        invoiceListStatus: 'LISTED',
        invoiceListNumber: number,
        changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(billingDocument.client, client),
        eq(billingDocument.billingNumber, row.billingNumber),
        eq(billingDocument.status, 'OPEN'),
        eq(billingDocument.invoiceListStatus, 'DUE'),
        isNull(billingDocument.invoiceListNumber),
      )).returning({ billingNumber: billingDocument.billingNumber });
      if (!applied.length) {
        throw new InvoiceListError(
          `Billing document ${row.billingNumber} was listed or cancelled while the list was being raised.`,
          'Read the due list again: no document is listed twice.',
        );
      }
      listed.push(row.billingNumber);
    }

    await recordChange(tx, {
      client, objectClass: INVOICE_LIST_OBJECT_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy,
      transactionCode: parsed.transactionCode ?? INVOICE_LIST_CREATE_CAPABILITY,
      after: {
        documentType, billingDate, payer: members[0].payer, companyCode: members[0].companyCode,
        currency: members[0].currency, itemCount: listed.length,
        netValue: round2(sum(members, (row) => row.netValue)),
        grossValue: round2(sum(members, (row) => row.grossValue)),
      },
      fieldLabels: {
        documentType: 'List type', billingDate: 'List date', payer: 'Payer',
        companyCode: 'Company code', currency: 'Currency', itemCount: 'Documents',
        netValue: 'Net value', grossValue: 'Gross value',
      },
    });
    for (const billingNumber of listed) {
      await recordChange(tx, {
        client, objectClass: BILLING_OBJECT_CLASS, objectKey: billingNumber,
        changeType: 'CHANGE', changedBy,
        transactionCode: parsed.transactionCode ?? INVOICE_LIST_CREATE_CAPABILITY,
        before: { invoiceListStatus: 'DUE', invoiceListNumber: '' },
        after: { invoiceListStatus: 'LISTED', invoiceListNumber: number },
        fieldLabels: {
          invoiceListStatus: 'Invoice list status', invoiceListNumber: 'Invoice list',
        },
      });
    }

    const view = await loadInvoiceList(tx, client, number);
    if (!view) throw new InvoiceListError(`Invoice list ${number} could not be read back.`);
    return { list: view, listed };
  });
}

async function dueByNumber(tx: Tx, client: string, numbers: string[]): Promise<InvoiceListDueRow[]> {
  const wanted = numbers.map((value) => value.trim().toUpperCase());
  const rows = await tx.select().from(billingDocument).where(and(
    eq(billingDocument.client, client),
    inArray(billingDocument.billingNumber, wanted),
  ));
  const payers = await tx.select({
    documentNumber: salesDocumentPartner.documentNumber,
    partnerNumber: salesDocumentPartner.partnerNumber,
  }).from(salesDocumentPartner).where(and(
    eq(salesDocumentPartner.client, client),
    eq(salesDocumentPartner.documentCategory, 'BILLING'),
    eq(salesDocumentPartner.functionCode, 'PY'),
    inArray(salesDocumentPartner.documentNumber, wanted),
  ));
  const payerOf = new Map(payers.map((row) => [row.documentNumber, row.partnerNumber]));

  const out: InvoiceListDueRow[] = [];
  for (const billingNumber of wanted) {
    const row = rows.find((candidate) => candidate.billingNumber === billingNumber);
    if (!row) throw new InvoiceListError(`Billing document ${billingNumber} does not exist.`);
    if (row.status !== 'OPEN') {
      throw new InvoiceListError(
        `Billing document ${billingNumber} stands ${row.status} and cannot be listed.`,
        'Only an open document can be listed.',
      );
    }
    // Listed already, and not listed twice: a document on two lists would be sent to the customer
    // twice and released to accounting twice, which is the one failure an invoice list must not have.
    if (row.invoiceListStatus === 'LISTED' || row.invoiceListNumber) {
      throw new InvoiceListError(
        `Billing document ${billingNumber} is already on invoice list ${row.invoiceListNumber ?? 'another list'}.`,
        'Cancel that list, or list the document again once it has been returned to due.',
      );
    }
    if (row.invoiceListStatus !== 'DUE') {
      throw new InvoiceListError(
        `Billing document ${billingNumber} is not relevant for an invoice list.`,
        'The document needs both a list type on its billing type and a list schedule on its payer.',
      );
    }
    out.push({
      billingNumber: row.billingNumber,
      documentType: row.documentType,
      billingDate: row.billingDate,
      invoiceListType: row.invoiceListType ?? '',
      invoiceListDate: row.invoiceListDate ?? row.billingDate,
      payer: payerOf.get(row.billingNumber) ?? row.customerNumber,
      soldTo: row.customerNumber,
      salesOrg: row.salesOrg,
      distributionChannel: row.distributionChannel,
      division: row.division,
      companyCode: row.companyCode,
      currency: row.currency,
      netValue: Number(row.netValue),
      taxValue: Number(row.taxValue),
      grossValue: Number(row.grossValue),
    });
  }
  if (out.length !== new Set(wanted).size) {
    throw new InvoiceListError('A billing document was named twice.', 'Name each document once.');
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Releasing a list — VF24
 * ------------------------------------------------------------------ */

export interface InvoiceListReleaseInput {
  client: string;
  changedBy: string;
  invoiceListNumber: string;
  postingDate?: string;
  /** The version the screen read. A list that changed underneath is not released on a stale view. */
  expectedVersion?: number;
  requestKey?: string;
  transactionCode?: string;
}

export interface InvoiceListReleaseResult {
  list: InvoiceListView;
  invoice: CustomerInvoiceView | null;
  posted: boolean;
  /** True when the list already stood released: the receivable is posted once and read back after. */
  replayed: boolean;
}

export async function releaseInvoiceList(input: InvoiceListReleaseInput): Promise<InvoiceListReleaseResult> {
  const client = input.client;
  const number = input.invoiceListNumber.trim().toUpperCase();
  const changedBy = input.changedBy;
  // Deterministic, so a retry after a half-finished release resolves to the same receivable: the
  // accounting-invoice service replays its own key, and the list cannot raise a second one.
  const requestKey = `sd-il-${client}-${number}`;

  // Phase one: read the list, work out what it posts, and commit nothing but that reading. The
  // receivable is posted outside this transaction because the accounting-invoice service opens its
  // own — the same two-phase shape billing uses, and for the same reason: a refused posting leaves a
  // document that can be released again rather than a half-posted one.
  const plan = await withTenant(client, async (tx) => {
    const view = await loadInvoiceList(tx, client, number);
    if (!view) throw new InvoiceListError(`Invoice list ${number} does not exist.`);
    // Cancelled before the documents are counted: a cancelled list has had its members deleted and
    // given back, so the first thing a reader needs told is that there is nothing left to post.
    if (view.header.status === 'CANCELLED') {
      throw new InvoiceListError(`Invoice list ${number} has been cancelled.`, 'Cancelled lists are not released.');
    }
    if (view.items.length === 0) {
      throw new InvoiceListError(
        `Invoice list ${number} names no documents.`,
        'Add the documents to the list, or cancel it.',
      );
    }
    if (input.expectedVersion !== undefined && view.header.version !== input.expectedVersion) {
      throw new InvoiceListError(
        `Invoice list ${number} changed while it was being released (read version ${input.expectedVersion}, standing ${view.header.version}).`,
        'Read the list again, then release it.',
      );
    }
    if (view.header.status === 'POSTED') {
      return { view, posted: true, lines: null as InvoiceListPostingLine[] | null, postingDate: '' };
    }
    return {
      view, posted: false, lines: await postingLines(tx, client, view),
      // The list is posted on the day it is dated, which is the day the period closed — the same day
      // SAP's `VF24` uses. A release that took today's date instead would post a receivable dated
      // before the document it belongs to, which the billing document refuses.
      postingDate: input.postingDate ?? view.header.billingDate,
    };
  });

  if (plan.posted) {
    return { list: plan.view, invoice: null, posted: true, replayed: true };
  }
  const lines = plan.lines as InvoiceListPostingLine[];
  const postingDate = plan.postingDate;

  const invoice = await postCustomerInvoice({
    client, changedBy,
    customerNumber: plan.view.header.payer,
    companyCode: plan.view.header.companyCode,
    documentDate: plan.view.header.billingDate,
    postingDate,
    // The list number is what the customer will quote back, and what the duplicate check stands on.
    reference: plan.view.header.billingNumber,
    currency: plan.view.header.currency,
    grossAmount: round2(lines.reduce((total, line) => total + line.netAmount + line.tax, 0)),
    category: 'INVOICE',
    headerText: `Invoice list ${number} — ${lines.length} document${lines.length === 1 ? '' : 's'}`,
    requestKey,
    lines: lines.map((line) => ({
      components: line.components,
      netAmount: line.netAmount,
      taxCode: line.taxCode ?? undefined,
      taxAccount: line.taxAccount ?? undefined,
      lineText: line.lineText,
    })),
  }).catch((error: unknown) => {
    throw new InvoiceListError(
      error instanceof Error ? error.message : String(error),
      'The list stands open: correct what was refused and release it again.',
    );
  });

  // Phase two: the receivable exists, so the list records it. Members stay LISTED — they have no
  // receivable of their own and never did, which is the whole point of listing them.
  const view = await withTenant(client, async (tx) => {
    const updated = await tx.update(billingDocument).set({
      status: 'POSTED',
      postingDate: invoice.postingDate,
      customerInvoiceNumber: invoice.invoiceNumber,
      journalDocumentNumber: invoice.journalDocumentNumber,
      netValue: round2(lines.reduce((total, line) => total + line.netAmount, 0)).toFixed(4),
      taxValue: round2(lines.reduce((total, line) => total + line.tax, 0)).toFixed(4),
      grossValue: invoice.grossAmount,
      version: sql`${billingDocument.version} + 1`,
      changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(billingDocument.client, client),
      eq(billingDocument.billingNumber, number),
      eq(billingDocument.status, 'OPEN'),
    )).returning({ billingNumber: billingDocument.billingNumber });

    await recordChange(tx, {
      client, objectClass: INVOICE_LIST_OBJECT_CLASS, objectKey: number,
      changeType: 'RELEASE', changedBy,
      transactionCode: input.transactionCode ?? INVOICE_LIST_RELEASE_CAPABILITY,
      before: { status: 'OPEN' },
      after: {
        status: 'POSTED', invoice: invoice.invoiceNumber,
        journal: invoice.journalDocumentNumber ?? '', dueDate: invoice.dueDate ?? '',
      },
      fieldLabels: {
        status: 'Status', invoice: 'Customer invoice', journal: 'Accounting document', dueDate: 'Due date',
      },
    });

    if (!updated.length) {
      throw new InvoiceListError(
        `Invoice list ${number} changed while the receivable was being posted.`,
        'The receivable stands as ' + invoice.invoiceNumber + ': read the list again.',
      );
    }
    const after = await loadInvoiceList(tx, client, number);
    if (!after) throw new InvoiceListError(`Invoice list ${number} could not be read back.`);
    return after;
  });

  return { list: view, invoice, posted: true, replayed: false };
}

interface InvoiceListPostingLine {
  components: Array<{ glAccount: string; amount: number }>;
  netAmount: number;
  taxCode: string | null;
  taxAccount: string | null;
  tax: number;
  lineText: string;
}

/**
 * What the list posts: one line per member document, each carrying the accounts that document's lines
 * were priced into and the tax it was raised with.
 *
 * One line per member, and not one line per billing line, because the list's job is to say what is owed
 * for the period — and because a line whose net is nothing at all cannot be posted: a credit note is not
 * netted into a list, it is issued on its own.
 *
 * The accounts are re-determined here rather than read off the members, because a billing document in
 * this package does not store them: revenue is determined by the condition on the line and the account
 * key it carries, and what the document keeps is the condition. That is the same determination the
 * billing service made when it raised the document, read from the same rows, so it answers the same
 * accounts — and where a line predates the conditions, it falls back to the revenue account the chart
 * stands on today, which is what the billing service did for it then.
 */
async function postingLines(tx: Tx, client: string, view: InvoiceListView): Promise<InvoiceListPostingLine[]> {
  const numbers = view.items.map((item) => item.billingNumber);
  const memberLines = await tx.select({
    billingNumber: billingDocumentLine.billingNumber,
    lineNumber: billingDocumentLine.lineNumber,
    materialNumber: billingDocumentLine.materialNumber,
    netAmount: billingDocumentLine.netAmount,
    taxCode: billingDocumentLine.taxCode,
    taxAmount: billingDocumentLine.taxAmount,
  }).from(billingDocumentLine).where(and(
    eq(billingDocumentLine.client, client),
    inArray(billingDocumentLine.billingNumber, numbers),
  )).orderBy(asc(billingDocumentLine.billingNumber), asc(billingDocumentLine.lineNumber));

  const [company] = await tx.select({
    country: companyCodeTable.country, chartOfAccounts: companyCodeTable.chartOfAccounts,
  }).from(companyCodeTable).where(and(
    eq(companyCodeTable.client, client),
    eq(companyCodeTable.companyCode, view.header.companyCode),
  )).limit(1);

  const rates = new Map<string, number>();
  if (company?.country) {
    for (const row of await tx.select().from(taxCodeTable).where(and(
      eq(taxCodeTable.client, client), eq(taxCodeTable.country, company.country),
    ))) rates.set(row.taxCode, Number(row.ratePercent));
  }
  const chart = company?.chartOfAccounts ?? '';

  // The two halves of revenue determination that are not on the document: the customer's account
  // assignment group, and the material's. Both are read from the masters they were read from when the
  // document was billed, which is what makes the answer the same answer.
  const [area] = await tx.select({ group: customerSalesArea.accountAssignmentGroup })
    .from(customerSalesArea).where(and(
      eq(customerSalesArea.client, client),
      eq(customerSalesArea.partnerNumber, view.header.soldTo),
      eq(customerSalesArea.salesOrg, view.header.salesOrg),
    )).limit(1);
  const materials = await tx.select({
    materialNumber: materialSales.materialNumber,
    group: materialSales.materialAccountAssignmentGroup,
  }).from(materialSales).where(and(
    eq(materialSales.client, client),
    inArray(materialSales.materialNumber, [...new Set(memberLines.map((row) => row.materialNumber))]),
  ));
  const materialGroup = new Map(materials.map((row) => [row.materialNumber, row.group]));

  // The conditions each member was priced by, read once for all of them.
  const conditionsByDocument = new Map<string, StoredCondition[]>();
  for (const billingNumber of numbers) {
    conditionsByDocument.set(billingNumber, await documentConditionsOf(tx, client, 'BILLING', billingNumber));
  }
  // Read once and only where a line predates the conditions, as the billing service does.
  let fallbackAccount: string | null = null;

  const lines: InvoiceListPostingLine[] = [];
  for (const item of view.items) {
    if (!(item.netValue > 0)) {
      throw new InvoiceListError(
        `Billing document ${item.billingNumber} carries no net value and cannot be listed.`,
        'A credit belongs on a credit memo, not netted into an invoice list.',
      );
    }
    const own = memberLines.filter((row) => row.billingNumber === item.billingNumber);
    const conditions = conditionsByDocument.get(item.billingNumber) ?? [];

    const byAccount = new Map<string, number>();
    const byCode = new Map<string, { net: number; account: string | null }>();
    for (const row of own) {
      const net = Number(row.netAmount);
      const lineConditions = conditions.filter((condition) => condition.lineNumber === row.lineNumber);
      const determined = chart && lineConditions.length > 0
        ? await determineLineAccounts(tx, client, {
          chartOfAccounts: chart,
          salesOrg: view.header.salesOrg,
          customerAccountAssignmentGroup: area?.group,
          materialAccountAssignmentGroup: materialGroup.get(row.materialNumber),
          conditions: lineConditions.map((condition) => ({
            accountKey: condition.accountKey,
            amount: condition.amount,
            isStatistical: condition.isStatistical,
            conditionClass: condition.conditionClass,
            conditionType: condition.conditionType,
          })),
        })
        : undefined;

      if (determined?.components.length) {
        for (const part of determined.components) {
          byAccount.set(part.glAccount, round2((byAccount.get(part.glAccount) ?? 0) + Number(part.amount)));
        }
      } else {
        const account = fallbackAccount
          ?? (fallbackAccount = await revenueAccountFor(tx, client, view.header.companyCode));
        byAccount.set(account, round2((byAccount.get(account) ?? 0) + net));
      }
      if (determined?.taxAccount) {
        const held = byCode.get('tax') ?? { net: 0, account: null };
        held.account = determined.taxAccount;
        byCode.set('tax', held);
      }

      const code = (row.taxCode ?? '').toUpperCase() || '';
      const current = byCode.get(code) ?? { net: 0, account: null };
      current.net = round2(current.net + net);
      byCode.set(code, current);
    }

    const components = [...byAccount].map(([glAccount, amount]) => ({ glAccount, amount }));
    const componentTotal = round2(components.reduce((total, part) => total + part.amount, 0));
    if (Math.abs(componentTotal - round2(item.netValue)) > 0.005) {
      throw new InvoiceListError(
        `The lines of ${item.billingNumber} post ${componentTotal.toFixed(2)} between them, which is not the ${round2(item.netValue).toFixed(2)} the document is worth.`,
        'The document or its accounts moved since it was listed: cancel the list and raise it again.',
      );
    }

    // The tax code the document was raised with, and the account its tax posts to. One code per member:
    // the accounting-invoice service taxes a line at one rate, and a member is one line on the list.
    const byTaxCode = [...byCode].filter(([code]) => code !== 'tax');
    const dominant = byTaxCode.sort((a, b) => Math.abs(b[1].net) - Math.abs(a[1].net))[0];
    const taxCode = dominant?.[0] || null;
    const taxAccount = byCode.get('tax')?.account ?? null;
    const rate = taxCode ? rates.get(taxCode) : undefined;
    if (taxCode && rate === undefined) {
      throw new InvoiceListError(
        `Tax code ${taxCode} does not stand for country ${company?.country ?? ''}.`,
        'Use a standing tax code, then release the list.',
      );
    }
    const expectedTax = round2((item.netValue * (rate ?? 0)) / 100);
    // Recomputed rather than copied, because the accounting-invoice service will recompute it too: if
    // the two disagree, the list would post a receivable that does not match the documents behind it.
    if (Math.abs(expectedTax - round2(item.taxValue)) > 0.005) {
      throw new InvoiceListError(
        `Billing document ${item.billingNumber} carries ${round2(item.taxValue).toFixed(2)} of tax, which is not ${expectedTax.toFixed(2)} at the standing rate.`,
        'The tax code or the rate changed since the document was billed: cancel the list and raise it again.',
      );
    }
    if (round2(item.taxValue) !== 0 && !taxCode) {
      throw new InvoiceListError(
        `Billing document ${item.billingNumber} carries tax but names no tax code.`,
        'Maintain the tax code on the document, or release it without a list.',
      );
    }

    lines.push({
      components,
      netAmount: round2(item.netValue),
      taxCode,
      taxAccount,
      tax: round2(item.taxValue),
      lineText: `${item.documentType} ${item.billingNumber}`.slice(0, 50),
    });
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * Cancelling a list — the members go back to being due
 * ------------------------------------------------------------------ */

export interface InvoiceListCancelInput {
  client: string;
  changedBy: string;
  invoiceListNumber: string;
  reason?: string;
  expectedVersion?: number;
  transactionCode?: string;
}

export async function cancelInvoiceList(input: InvoiceListCancelInput): Promise<InvoiceListView> {
  return withTenant(input.client, async (tx) => {
    const client = input.client;
    const number = input.invoiceListNumber.trim().toUpperCase();
    const view = await loadInvoiceList(tx, client, number);
    if (!view) throw new InvoiceListError(`Invoice list ${number} does not exist.`);
    if (view.header.status === 'CANCELLED') {
      throw new InvoiceListError(`Invoice list ${number} has already been cancelled.`, 'Cancellation stands once.');
    }
    if (view.header.status === 'POSTED') {
      throw new InvoiceListError(
        `Invoice list ${number} is released to accounting as ${view.header.customerInvoiceNumber}.`,
        'Cancel the accounting invoice first: a released list is a receivable, and a receivable is not undone here.',
      );
    }
    if (input.expectedVersion !== undefined && view.header.version !== input.expectedVersion) {
      throw new InvoiceListError(
        `Invoice list ${number} changed while it was being cancelled (read version ${input.expectedVersion}, standing ${view.header.version}).`,
        'Read the list again, then cancel it.',
      );
    }

    // The members go back to being due, which is what makes the cancellation reversible rather than a
    // dead end: they were never released to accounting, so releasing them again is a fresh act and not
    // a second posting.
    for (const item of view.items) {
      await tx.update(billingDocument).set({
        invoiceListStatus: 'DUE',
        invoiceListNumber: null,
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(billingDocument.client, client),
        eq(billingDocument.billingNumber, item.billingNumber),
        eq(billingDocument.invoiceListStatus, 'LISTED'),
        eq(billingDocument.invoiceListNumber, number),
      ));
      await recordChange(tx, {
        client, objectClass: BILLING_OBJECT_CLASS, objectKey: item.billingNumber,
        changeType: 'CHANGE', changedBy: input.changedBy,
        transactionCode: input.transactionCode ?? INVOICE_LIST_CREATE_CAPABILITY,
        before: { invoiceListStatus: 'LISTED', invoiceListNumber: number },
        after: { invoiceListStatus: 'DUE', invoiceListNumber: '' },
        reason: input.reason,
        fieldLabels: { invoiceListStatus: 'Invoice list status', invoiceListNumber: 'Invoice list' },
      });
    }
    await tx.delete(salesInvoiceListItem).where(and(
      eq(salesInvoiceListItem.client, client),
      eq(salesInvoiceListItem.invoiceListNumber, number),
    ));

    await tx.update(billingDocument).set({
      status: 'CANCELLED',
      version: sql`${billingDocument.version} + 1`,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(billingDocument.client, client),
      eq(billingDocument.billingNumber, number),
    ));

    await recordChange(tx, {
      client, objectClass: INVOICE_LIST_OBJECT_CLASS, objectKey: number,
      changeType: 'DELETE', changedBy: input.changedBy,
      transactionCode: input.transactionCode ?? INVOICE_LIST_CREATE_CAPABILITY,
      before: { status: view.header.status, itemCount: view.items.length },
      after: { status: 'CANCELLED' },
      reason: input.reason,
      fieldLabels: { status: 'Status', itemCount: 'Documents' },
    });

    const after = await loadInvoiceList(tx, client, number);
    if (!after) throw new InvoiceListError(`Invoice list ${number} could not be read back.`);
    return after;
  });
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}
