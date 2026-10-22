/**
 * Invoice overview — SCR-161 / PROC.INV.OVERVIEW.
 *
 * One read over the logistics invoices that already stand. A parked invoice
 * is a parked row. A posted invoice is a supplier invoice. A cancelled invoice
 * stays cancelled, and the cancellation document stays a posted document that
 * names it. There is no draft, no payment block, and no second invoice table.
 *
 * The fiscal year is the year stored on the document. It is not derived from
 * the posting date, and a closed period is not read. A company-currency amount
 * is the journal line's stored amount, or it is absent. Viewing writes nothing.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';

export const INVOICE_OVERVIEW_CAPABILITY = 'PROC.INV.OVERVIEW';
export const INVOICE_OVERVIEW_ROUTE = '/purchasing/invoice-overview';
export const INVOICE_OVERVIEW_ALIASES = ['MIR6'] as const;

export const DEFAULT_MAX_HITS = 100;
export const MAX_HITS_CAP = 500;
export const MAX_DATE_SPAN_DAYS = 366;

export const LIFECYCLES = ['PARKED', 'POSTED', 'CANCELLED'] as const;
export const CATEGORIES = ['INVOICE', 'CREDIT_MEMO', 'SUBSEQUENT_DEBIT', 'SUBSEQUENT_CREDIT'] as const;
export const SORTS = ['postingDate', 'documentNumber', 'supplier', 'documentDate', 'grossAmount'] as const;

export type InvoiceLifecycle = (typeof LIFECYCLES)[number];
export type InvoiceCategory = (typeof CATEGORIES)[number];
export type InvoiceOverviewSort = (typeof SORTS)[number];
export type PaymentState = 'OPEN' | 'CLEARED' | 'PARTIALLY_CLEARED' | 'NOT_APPLICABLE';

export class InvoiceOverviewError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'InvoiceOverviewError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new InvoiceOverviewError(message, remedy);
}

export interface InvoiceOverviewSelection {
  companyFrom?: string;
  companyTo?: string;
  fiscalYear?: string;
  vendorFrom?: string;
  vendorTo?: string;
  orderFrom?: string;
  orderTo?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  documentFrom?: string;
  documentTo?: string;
  reference?: string;
  lifecycle?: string;
  category?: string;
  purchasingOrg?: string;
  sort?: string;
  direction?: string;
  maxHits?: number;
  draft?: string;
  paymentBlock?: string;
  reversed?: string;
  layout?: string;
  export?: string;
  withoutOrder?: string;
  companyAuthorization?: string;
  purchasingAuthorization?: string;
  exchangeRate?: string;
  post?: string;
  release?: string;
  clear?: string;
}

export interface InvoiceOverviewRow {
  documentNumber: string;
  fiscalYear: number;
  lifecycle: InvoiceLifecycle;
  category: string | null;
  companyCode: string;
  supplierNumber: string;
  supplierName: string;
  reference: string;
  purchaseOrderNumber: string;
  purchasingOrg: string | null;
  documentDate: string;
  postingDate: string | null;
  proposedPostingDate: string | null;
  grossAmount: string;
  currency: string;
  companyCurrencyAmount: string | null;
  companyCurrency: string | null;
  journalDocumentNumber: string | null;
  journalHref: string | null;
  paymentState: PaymentState;
  clearingDocument: string | null;
  cancellationOf: string | null;
  cancelledBy: string | null;
  createdBy: string;
  createdAt: string;
  changedAt: string | null;
}

export interface InvoiceOverviewTotal {
  currency: string;
  lifecycle: InvoiceLifecycle;
  count: number;
  grossAmount: string;
}

export interface InvoiceOverviewResult {
  rows: InvoiceOverviewRow[];
  totals: InvoiceOverviewTotal[];
  counts: { parked: number; posted: number; cancelled: number };
  truncated: boolean;
  maxHits: number;
  warnings: string[];
  wrote: false;
}

export interface InvoiceOverviewLine {
  lineNumber: number;
  purchaseOrderItem: number;
  quantity: string;
  netAmount: string;
  taxAmount: string;
}

export interface InvoiceOverviewDocument {
  row: InvoiceOverviewRow;
  lines: InvoiceOverviewLine[];
  wrote: false;
}

interface Normalized {
  companyFrom: string;
  companyTo: string;
  fiscalYear: number;
  vendorFrom: string | null;
  vendorTo: string | null;
  orderFrom: string | null;
  orderTo: string | null;
  postingDateFrom: string | null;
  postingDateTo: string | null;
  documentFrom: string | null;
  documentTo: string | null;
  reference: string | null;
  lifecycles: InvoiceLifecycle[];
  categories: InvoiceCategory[];
  purchasingOrg: string | null;
  sort: InvoiceOverviewSort;
  direction: 'asc' | 'desc';
  maxHits: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z0-9-]{1,20}$/;
const YEAR = /^\d{4}$/;

function named(value: string | undefined): string {
  return (value ?? '').trim();
}

function checkDate(value: string, label: string): string {
  const parsed = ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} ${value} is not a valid date.`, 'Use the format YYYY-MM-DD.');
  }
  return value;
}

function spanDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function boundCode(value: string | undefined, label: string): string | null {
  const text = named(value).toUpperCase();
  if (!text) return null;
  if (!CODE.test(text)) fail(`${label} ${text} is not a document number.`, 'Use letters, digits, and hyphens, at most 20.');
  return text;
}

function refuseAbsent(raw: InvoiceOverviewSelection) {
  if (named(raw.draft)) {
    fail('A draft is not an invoice on this list.', 'Park the invoice, or post it. This list does not keep a draft.');
  }
  if (named(raw.paymentBlock)) {
    fail('A payment block is not on this list.', 'This list does not read a payment block, and it does not release one.');
  }
  if (named(raw.reversed)) {
    fail(
      'A reversal is not a status on this list.',
      'A cancelled invoice stands as cancelled. A cancellation document stands posted and names the invoice it cancels. A credit memo is a category, not a reversal.',
    );
  }
  if (named(raw.layout)) fail('A display layout is not saved on this list.');
  if (named(raw.export)) fail('This list does not export.');
  if (named(raw.withoutOrder)) {
    fail(
      'An invoice without a purchase order is not this list.',
      'Every logistics invoice names an order. A vendor invoice without an order is a different document.',
    );
  }
  if (named(raw.companyAuthorization)) {
    fail('There is no company-code authorization object.', 'The company must stand in this tenant. This list does not grant a company.');
  }
  if (named(raw.purchasingAuthorization)) {
    fail('There is no purchasing-organisation authorization object.', 'The purchasing organisation is the order\'s. This list does not grant one.');
  }
  if (named(raw.exchangeRate)) {
    fail('This list does not convert an amount.', 'A company-currency amount is shown only where the journal line already stores it.');
  }
  if (named(raw.post) || named(raw.release) || named(raw.clear)) {
    fail('This list does not post, release, or clear.');
  }
}

function parseLifecycle(value: string | undefined): InvoiceLifecycle[] {
  const text = named(value);
  if (!text) return [...LIFECYCLES];
  const asked = text.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean);
  const unknown = asked.filter((part) => !LIFECYCLES.includes(part as InvoiceLifecycle));
  if (unknown.length > 0) {
    fail(
      `Lifecycle ${unknown.join(', ')} is not on this list.`,
      'The lifecycles are parked, posted, and cancelled.',
    );
  }
  return [...new Set(asked)] as InvoiceLifecycle[];
}

function parseCategory(value: string | undefined): InvoiceCategory[] {
  const text = named(value);
  if (!text) return [];
  const asked = text.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean);
  const unknown = asked.filter((part) => !CATEGORIES.includes(part as InvoiceCategory));
  if (unknown.length > 0) {
    fail(
      `Category ${unknown.join(', ')} is not a logistics invoice category.`,
      'The categories are invoice, credit memo, subsequent debit, and subsequent credit. A parked invoice has no category.',
    );
  }
  return [...new Set(asked)] as InvoiceCategory[];
}

async function normalize(client: string, raw: InvoiceOverviewSelection): Promise<{ selection: Normalized; warnings: string[] }> {
  refuseAbsent(raw);
  const warnings: string[] = [];
  const companyFrom = named(raw.companyFrom).toUpperCase();
  if (!companyFrom) fail('A company code is required.', 'Name the company the invoices stand in.');
  const companyTo = named(raw.companyTo).toUpperCase() || companyFrom;
  if (companyTo < companyFrom) {
    fail(`Company code ${companyTo} is before ${companyFrom}.`, 'The upper company must be the same or later.');
  }
  const yearText = named(raw.fiscalYear);
  if (!YEAR.test(yearText)) {
    fail('A fiscal year is required.', 'Name the four-digit fiscal year stored on the invoice. It is not taken from the calendar date.');
  }
  const fiscalYear = Number(yearText);
  if (fiscalYear < 1000 || fiscalYear > 9999) fail(`Fiscal year ${yearText} is not a fiscal year.`);

  const vendorFrom = boundCode(raw.vendorFrom, 'Vendor');
  const vendorTo = boundCode(raw.vendorTo, 'Vendor') ?? vendorFrom;
  if (vendorFrom && vendorTo && vendorTo < vendorFrom) {
    fail(`Vendor ${vendorTo} is before ${vendorFrom}.`, 'The upper vendor must be the same or later.');
  }
  const orderFrom = boundCode(raw.orderFrom, 'Purchase order');
  const orderTo = boundCode(raw.orderTo, 'Purchase order') ?? orderFrom;
  if (orderFrom && orderTo && orderTo < orderFrom) {
    fail(`Purchase order ${orderTo} is before ${orderFrom}.`, 'The upper order must be the same or later.');
  }
  const documentFrom = boundCode(raw.documentFrom, 'Invoice document');
  const documentTo = boundCode(raw.documentTo, 'Invoice document') ?? documentFrom;
  if (documentFrom && documentTo && documentTo < documentFrom) {
    fail(`Invoice document ${documentTo} is before ${documentFrom}.`, 'The upper document must be the same or later.');
  }
  const reference = named(raw.reference);
  if (reference.length > 16) fail('The supplier reference is longer than 16 characters.');

  let postingDateFrom = named(raw.postingDateFrom) ? checkDate(named(raw.postingDateFrom), 'Posting date') : null;
  let postingDateTo = named(raw.postingDateTo) ? checkDate(named(raw.postingDateTo), 'Posting date') : null;
  if (postingDateFrom && postingDateTo && postingDateTo < postingDateFrom) {
    fail(`Posting date ${postingDateTo} is before ${postingDateFrom}.`, 'The upper date must be the same day or later.');
  }
  if (postingDateFrom && postingDateTo && spanDays(postingDateFrom, postingDateTo) > MAX_DATE_SPAN_DAYS) {
    fail(
      `The posting-date range is longer than ${MAX_DATE_SPAN_DAYS} days.`,
      'Narrow the dates. The fiscal year still bounds the invoices.',
    );
  }

  const purchasingOrg = named(raw.purchasingOrg).toUpperCase() || null;
  const sortText = named(raw.sort) || 'postingDate';
  if (!SORTS.includes(sortText as InvoiceOverviewSort)) {
    fail(`Sort ${sortText} is not allowed.`, 'Sort by posting date, document, supplier, document date, or gross amount.');
  }
  const directionText = named(raw.direction).toLowerCase() || 'desc';
  if (directionText !== 'asc' && directionText !== 'desc') fail(`Sort direction ${directionText} is not allowed.`);

  const requested = raw.maxHits ?? DEFAULT_MAX_HITS;
  const numericHits = Number(requested);
  if (!Number.isInteger(numericHits) || numericHits < 1) fail('The result limit must be a positive whole number.');
  const maxHits = Math.min(numericHits, MAX_HITS_CAP);
  if (numericHits > MAX_HITS_CAP) warnings.push(`The result limit is capped at ${MAX_HITS_CAP}.`);

  const lifecycles = parseLifecycle(raw.lifecycle);
  const categories = parseCategory(raw.category);
  if ((postingDateFrom || postingDateTo) && lifecycles.includes('PARKED')) {
    warnings.push('A parked invoice has no recorded posting date, so a posting-date filter leaves it out.');
  }

  await withTenant(client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code
        from company_code
       where client = ${client} and is_active
         and company_code in (${companyFrom}, ${companyTo})
    `) as unknown as Array<{ company_code: string }>;
    const standing = new Set(companies.map((row) => row.company_code));
    if (!standing.has(companyFrom)) fail(`Company code ${companyFrom} does not stand.`);
    if (!standing.has(companyTo)) fail(`Company code ${companyTo} does not stand.`);
    for (const vendor of [vendorFrom, vendorTo]) {
      if (!vendor) continue;
      const [row] = await tx.execute(sql`
        select partner_number
          from bp_role
         where client = ${client} and partner_number = ${vendor} and role_code = 'SUPPLIER' and is_active
      `) as unknown as Array<{ partner_number: string }>;
      if (!row) fail(`Vendor ${vendor} does not stand.`);
    }
    if (purchasingOrg) {
      const [row] = await tx.execute(sql`
        select purchasing_org
          from purchasing_org
         where client = ${client} and purchasing_org = ${purchasingOrg}
      `) as unknown as Array<{ purchasing_org: string }>;
      if (!row) fail(`Purchasing organisation ${purchasingOrg} does not stand.`);
    }
  });

  return {
    warnings,
    selection: {
      companyFrom,
      companyTo,
      fiscalYear,
      vendorFrom,
      vendorTo: vendorFrom ? vendorTo : null,
      orderFrom,
      orderTo: orderFrom ? orderTo : null,
      postingDateFrom,
      postingDateTo,
      documentFrom,
      documentTo: documentFrom ? documentTo : null,
      reference: reference || null,
      lifecycles,
      categories,
      purchasingOrg,
      sort: sortText as InvoiceOverviewSort,
      direction: directionText,
      maxHits,
    },
  };
}

function journalHref(documentNumber: string | null, companyCode: string): string | null {
  if (!documentNumber) return null;
  const year = Number(documentNumber.split('/')[1]);
  if (!Number.isInteger(year)) return null;
  return `/finance/journal/document?document=${encodeURIComponent(documentNumber)}&company=${encodeURIComponent(companyCode)}&year=${year}`;
}

function orderClause(sort: InvoiceOverviewSort, direction: 'asc' | 'desc') {
  const dir = direction === 'asc' ? 'asc' : 'desc';
  switch (sort) {
    case 'documentNumber':
      return sql.raw(`document_number ${dir}, fiscal_year asc`);
    case 'supplier':
      return sql.raw(`supplier_number ${dir}, document_number asc, fiscal_year asc`);
    case 'documentDate':
      return sql.raw(`document_date ${dir}, document_number asc, fiscal_year asc`);
    case 'grossAmount':
      return sql.raw(`gross_amount ${dir}, document_number asc, fiscal_year asc`);
    default:
      return sql.raw(`posting_date ${dir} nulls last, document_number asc, fiscal_year asc`);
  }
}

function documentSource(client: string) {
  return sql`
    select i.invoice_number as document_number,
           i.fiscal_year,
           i.status as lifecycle,
           i.category,
           i.company_code,
           i.supplier_number,
           coalesce(bp.name, '') as supplier_name,
           i.supplier_reference as reference,
           i.purchase_order_number,
           po.purchasing_org,
           i.invoice_date as document_date,
           i.posting_date,
           null::date as proposed_posting_date,
           i.gross_amount,
           i.currency,
           case when partner.lines = 1 then partner.amount_local::text else null end as company_currency_amount,
           case when partner.lines = 1 then co.currency else null end as company_currency,
           i.journal_document_number,
           case
             when partner.lines = 0 or partner.lines is null then 'NOT_APPLICABLE'
             when partner.cleared = 0 then 'OPEN'
             when partner.open_lines = 0 then 'CLEARED'
             else 'PARTIALLY_CLEARED'
           end as payment_state,
           case when partner.cleared = 1 and partner.lines = 1 then partner.clearing_document else null end as clearing_document,
           i.cancellation_of,
           i.cancelled_by,
           i.created_by,
           to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
           to_char(i.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as changed_at
      from supplier_invoice i
      left join business_partner bp
        on bp.client = i.client and bp.partner_number = i.supplier_number
      left join purchase_order po
        on po.client = i.client and po.order_number = i.purchase_order_number
      left join company_code co
        on co.client = i.client and co.company_code = i.company_code
      left join lateral (
        select count(*)::int as lines,
               count(*) filter (where l.clearing_document is null)::int as open_lines,
               count(l.clearing_document)::int as cleared,
               min(l.amount_local) as amount_local,
               min(l.clearing_document) as clearing_document
          from journal_entry_line l
         where l.client = i.client
           and l.document_number = i.journal_document_number
           and l.business_partner = i.supplier_number
      ) partner on true
     where i.client = ${client}
    union all
    select p.parked_number,
           p.fiscal_year,
           'PARKED',
           null::varchar,
           p.company_code,
           p.supplier_number,
           coalesce(bp.name, ''),
           p.supplier_reference,
           p.purchase_order_number,
           po.purchasing_org,
           p.invoice_date,
           null::date,
           p.posting_date,
           p.gross_amount,
           p.currency,
           null::text,
           null::char(3),
           null::varchar,
           'NOT_APPLICABLE',
           null::varchar,
           null::varchar,
           null::varchar,
           p.created_by,
           to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
           to_char(p.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as changed_at
      from parked_supplier_invoice p
      left join business_partner bp
        on bp.client = p.client and bp.partner_number = p.supplier_number
      left join purchase_order po
        on po.client = p.client and po.order_number = p.purchase_order_number
     where p.client = ${client}
  `;
}

function whereClause(s: Normalized) {
  return sql`
    company_code >= ${s.companyFrom}
    and company_code <= ${s.companyTo}
    and fiscal_year = ${s.fiscalYear}
    and lifecycle in (${sql.join(s.lifecycles.map((value) => sql`${value}`), sql`, `)})
    and (${s.categories.length === 0} or category in (${sql.join((s.categories.length ? s.categories : ['INVOICE']).map((value) => sql`${value}`), sql`, `)}))
    and (${s.vendorFrom}::text is null or supplier_number >= ${s.vendorFrom})
    and (${s.vendorTo}::text is null or supplier_number <= ${s.vendorTo})
    and (${s.orderFrom}::text is null or purchase_order_number >= ${s.orderFrom})
    and (${s.orderTo}::text is null or purchase_order_number <= ${s.orderTo})
    and (${s.documentFrom}::text is null or document_number >= ${s.documentFrom})
    and (${s.documentTo}::text is null or document_number <= ${s.documentTo})
    and (${s.reference}::text is null or reference = ${s.reference})
    and (${s.purchasingOrg}::text is null or purchasing_org = ${s.purchasingOrg})
    and (
      (${s.postingDateFrom}::date is null and ${s.postingDateTo}::date is null)
      or (
        posting_date is not null
        and (${s.postingDateFrom}::date is null or posting_date >= ${s.postingDateFrom}::date)
        and (${s.postingDateTo}::date is null or posting_date <= ${s.postingDateTo}::date)
      )
    )
  `;
}

interface RawRow {
  document_number: string;
  fiscal_year: number;
  lifecycle: InvoiceLifecycle;
  category: string | null;
  company_code: string;
  supplier_number: string;
  supplier_name: string;
  reference: string;
  purchase_order_number: string;
  purchasing_org: string | null;
  document_date: string;
  posting_date: string | null;
  proposed_posting_date: string | null;
  gross_amount: string;
  currency: string;
  company_currency_amount: string | null;
  company_currency: string | null;
  journal_document_number: string | null;
  payment_state: PaymentState;
  clearing_document: string | null;
  cancellation_of: string | null;
  cancelled_by: string | null;
  created_by: string;
  created_at: string;
  changed_at: string | null;
}

function mapRow(row: RawRow): InvoiceOverviewRow {
  return {
    documentNumber: row.document_number,
    fiscalYear: Number(row.fiscal_year),
    lifecycle: row.lifecycle,
    category: row.category,
    companyCode: row.company_code,
    supplierNumber: row.supplier_number,
    supplierName: row.supplier_name,
    reference: row.reference,
    purchaseOrderNumber: row.purchase_order_number,
    purchasingOrg: row.purchasing_org,
    documentDate: row.document_date,
    postingDate: row.posting_date,
    proposedPostingDate: row.proposed_posting_date,
    grossAmount: row.gross_amount,
    currency: row.currency.trim(),
    companyCurrencyAmount: row.company_currency_amount,
    companyCurrency: row.company_currency?.trim() ?? null,
    journalDocumentNumber: row.journal_document_number,
    journalHref: journalHref(row.journal_document_number, row.company_code),
    paymentState: row.payment_state,
    clearingDocument: row.clearing_document,
    cancellationOf: row.cancellation_of,
    cancelledBy: row.cancelled_by,
    createdBy: row.created_by,
    createdAt: row.created_at,
    changedAt: row.changed_at,
  };
}

export async function listInvoiceOverview(input: {
  client: string;
  selection: InvoiceOverviewSelection;
}): Promise<InvoiceOverviewResult> {
  const { warnings, selection } = await normalize(input.client, input.selection);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', '5000', true)`);
    const source = documentSource(input.client);
    const where = whereClause(selection);
    const rows = await tx.execute(sql`
      select *
        from (${source}) documents
       where ${where}
       order by ${orderClause(selection.sort, selection.direction)}
       limit ${selection.maxHits + 1}
    `) as unknown as RawRow[];
    const totals = await tx.execute(sql`
      select currency, lifecycle, count(*)::int as count, sum(gross_amount)::text as gross_amount
        from (${source}) documents
       where ${where}
       group by currency, lifecycle
       order by lifecycle, currency
    `) as unknown as Array<{ currency: string; lifecycle: InvoiceLifecycle; count: number; gross_amount: string }>;
    const truncated = rows.length > selection.maxHits;
    if (truncated) warnings.push(`The list is truncated at ${selection.maxHits} invoices. Narrow the selection for the rest.`);
    const counts = { parked: 0, posted: 0, cancelled: 0 };
    for (const total of totals) {
      if (total.lifecycle === 'PARKED') counts.parked += Number(total.count);
      else if (total.lifecycle === 'POSTED') counts.posted += Number(total.count);
      else if (total.lifecycle === 'CANCELLED') counts.cancelled += Number(total.count);
    }
    return {
      rows: rows.slice(0, selection.maxHits).map(mapRow),
      totals: totals.map((total) => ({
        currency: total.currency.trim(),
        lifecycle: total.lifecycle,
        count: Number(total.count),
        grossAmount: total.gross_amount,
      })),
      counts,
      truncated,
      maxHits: selection.maxHits,
      warnings,
      wrote: false,
    };
  });
}

export async function readInvoiceOverviewDocument(
  client: string,
  documentNumber: string,
): Promise<InvoiceOverviewDocument | null> {
  const number = named(documentNumber).toUpperCase();
  if (!number) return null;
  if (!CODE.test(number)) fail(`Invoice document ${number} is not a document number.`);
  return withTenant(client, async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', '5000', true)`);
    const rows = await tx.execute(sql`
      select * from (${documentSource(client)}) documents where document_number = ${number}
    `) as unknown as RawRow[];
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      fail(
        `Document ${number} stands as ${rows.map((row) => row.lifecycle).join(' and ')}.`,
        'Name the document that stands. This list does not merge them.',
      );
    }
    const row = mapRow(rows[0]);
    const [company] = await tx.execute(sql`
      select company_code from company_code
       where client = ${client} and company_code = ${row.companyCode} and is_active
    `) as unknown as Array<{ company_code: string }>;
    if (!company) fail(`Company code ${row.companyCode} does not stand.`);
    const lines = row.lifecycle === 'PARKED'
      ? await tx.execute(sql`
          select line_number, purchase_order_item, quantity::text, net_amount::text, tax_amount::text
            from parked_supplier_invoice_item
           where client = ${client} and parked_number = ${number}
           order by line_number
        `) as unknown as Array<{ line_number: number; purchase_order_item: number; quantity: string; net_amount: string; tax_amount: string }>
      : await tx.execute(sql`
          select line_number, purchase_order_item, quantity::text, net_amount::text, tax_amount::text
            from supplier_invoice_item
           where client = ${client} and invoice_number = ${number}
           order by line_number
        `) as unknown as Array<{ line_number: number; purchase_order_item: number; quantity: string; net_amount: string; tax_amount: string }>;
    return {
      row,
      lines: lines.map((line) => ({
        lineNumber: Number(line.line_number),
        purchaseOrderItem: Number(line.purchase_order_item),
        quantity: line.quantity,
        netAmount: line.net_amount,
        taxAmount: line.tax_amount,
      })),
      wrote: false,
    };
  });
}
