/**
 * G/L line item report — SCR-088 / R-136.
 *
 * A strictly read-only inquiry over the canonical journal: the
 * tenant comes from the session, never from the client; amounts
 * display as stored in document and local currency; subtotals
 * never combine unlike currencies; the hit cap stands enforced
 * server-side with an explicit truncation signal. Open/cleared is
 * judged from the line's clearing document, and only for accounts
 * standing open-item-managed — other lines carry no status.
 * Closed periods remain displayable: period locks govern posting,
 * not inquiry. Reading mutates nothing.
 *
 * Stage 1 carries the vocabulary only; the query lands in stage 3.
 */
export const JOURNAL_ITEMS_CAPABILITY = 'FIN.JOURNAL.LIST';

export class JournalItemsError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'JournalItemsError';
    this.remedy = remedy;
  }
}

export type LineItemStatusFilter = 'ALL' | 'OPEN' | 'CLEARED';

export interface JournalItemFilters {
  accountFrom: string;
  accountTo?: string;
  companyCodes: string[];
  fiscalYear?: number;
  postingDateFrom?: string;
  postingDateTo?: string;
  documentDateFrom?: string;
  documentDateTo?: string;
  documentNumber?: string;
  documentType?: string;
  status: LineItemStatusFilter;
  profitCenter?: string;
  costCenter?: string;
  reference?: string;
  maxHits?: number;
}

export interface JournalItemRow {
  companyCode: string;
  documentNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  documentDate: string;
  documentType: string;
  documentStatus: string;
  glAccount: string;
  debitCredit: 'S' | 'H';
  amountDocument: number;
  currency: string;
  amountLocal: number;
  localCurrency: string;
  costCenter: string | null;
  profitCenter: string | null;
  taxCode: string | null;
  lineText: string | null;
  businessPartner: string | null;
  reference: string | null;
  clearingDocument: string | null;
  clearingDate: string | null;
  /** OPEN | CLEARED on open-item-managed accounts; null otherwise. */
  itemStatus: 'OPEN' | 'CLEARED' | null;
}

export interface JournalItemSubtotal {
  companyCode: string;
  glAccount: string;
  currency: string;
  localCurrency: string;
  debitDocument: number;
  creditDocument: number;
  debitLocal: number;
  creditLocal: number;
}

export interface JournalItemsResult {
  rows: JournalItemRow[];
  subtotals: JournalItemSubtotal[];
  truncated: boolean;
  cap: number;
}

import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { getCompanyCode } from '../../platform/periods';

export const JOURNAL_ITEMS_CAP = 5000;

const round2 = (n: number) => Math.round(n * 100) / 100;

interface RawRow {
  company_code: string;
  document_number: string;
  fiscal_year: number;
  line_number: number;
  posting_date: string;
  document_date: string;
  document_type: string;
  document_status: string;
  gl_account: string;
  debit_credit: string;
  amount_document: string;
  currency: string;
  amount_local: string;
  local_currency: string;
  cost_center: string | null;
  profit_center: string | null;
  tax_code: string | null;
  line_text: string | null;
  business_partner: string | null;
  reference: string | null;
  clearing_document: string | null;
  clearing_date: string | null;
  is_open_item_managed: boolean;
}

export async function getJournalItems(
  client: string, filters: JournalItemFilters,
): Promise<JournalItemsResult> {
  const accountFrom = (filters.accountFrom ?? '').trim();
  const accountTo = (filters.accountTo ?? '').trim() || accountFrom;
  if (!accountFrom) throw new JournalItemsError('Enter the G/L account to start from.');
  if (filters.companyCodes.length === 0) {
    throw new JournalItemsError('Enter at least one company code.', 'Name the company codes whose lines to read.');
  }
  for (const [label, from, to] of [
    ['Posting date', filters.postingDateFrom, filters.postingDateTo],
    ['Document date', filters.documentDateFrom, filters.documentDateTo],
  ] as const) {
    if (from && to && from > to) {
      throw new JournalItemsError(`${label} to ${to} precedes ${label.toLowerCase()} from ${from}.`, 'Correct the date interval.');
    }
  }
  const cap = Math.max(1, Math.min(filters.maxHits ?? JOURNAL_ITEMS_CAP, JOURNAL_ITEMS_CAP));

  return withTenant(client, async (tx) => {
    for (const companyCode of filters.companyCodes) {
      const company = await getCompanyCode(tx, client, companyCode);
      if (!company) {
        throw new JournalItemsError(
          `Company code ${companyCode} is not configured in this tenant.`, 'Correct the company selection.',
        );
      }
    }
    const accounts = await tx.execute(sql`
      select account_number from gl_account
      where client = ${client} and account_number in (${accountFrom}, ${accountTo})
    `);
    const standing = new Set((accounts as unknown as { account_number: string }[]).map((r) => r.account_number));
    if (!standing.has(accountFrom)) {
      throw new JournalItemsError(`G/L account ${accountFrom} does not stand in this tenant.`, 'Correct the account selection.');
    }
    if (filters.accountTo && !standing.has(accountTo)) {
      throw new JournalItemsError(`G/L account ${accountTo} does not stand in this tenant.`, 'Correct the account selection.');
    }

    const statusClause = filters.status === 'OPEN'
      ? sql`and g.is_open_item_managed and l.clearing_document is null`
      : filters.status === 'CLEARED'
        ? sql`and g.is_open_item_managed and l.clearing_document is not null`
        : sql``;
    const rows = await tx.execute(sql`
      select
        l.company_code, l.document_number, l.fiscal_year, l.line_number,
        h.posting_date::text as posting_date, h.document_date::text as document_date,
        h.document_type, h.status as document_status,
        l.gl_account, l.debit_credit,
        l.amount_document::text as amount_document, l.currency,
        l.amount_local::text as amount_local, h.local_currency,
        l.cost_center, l.profit_center, l.tax_code, l.line_text,
        l.business_partner, h.reference,
        l.clearing_document, l.clearing_date::text as clearing_date,
        coalesce(g.is_open_item_managed, false) as is_open_item_managed
      from journal_entry_line l
      join journal_entry h
        on h.client = l.client and h.document_number = l.document_number and h.fiscal_year = l.fiscal_year
      left join gl_account g
        on g.client = l.client and g.account_number = l.gl_account
      where l.client = ${client}
        and l.gl_account between ${accountFrom} and ${accountTo}
        and l.company_code in (${sql.join(filters.companyCodes.map((c) => sql`${c}`), sql`, `)})
        ${filters.fiscalYear ? sql`and l.fiscal_year = ${filters.fiscalYear}` : sql``}
        ${filters.postingDateFrom ? sql`and h.posting_date >= ${filters.postingDateFrom}` : sql``}
        ${filters.postingDateTo ? sql`and h.posting_date <= ${filters.postingDateTo}` : sql``}
        ${filters.documentDateFrom ? sql`and h.document_date >= ${filters.documentDateFrom}` : sql``}
        ${filters.documentDateTo ? sql`and h.document_date <= ${filters.documentDateTo}` : sql``}
        ${filters.documentNumber ? sql`and l.document_number = ${filters.documentNumber}` : sql``}
        ${filters.documentType ? sql`and h.document_type = ${filters.documentType}` : sql``}
        ${filters.costCenter ? sql`and l.cost_center = ${filters.costCenter}` : sql``}
        ${filters.profitCenter ? sql`and l.profit_center = ${filters.profitCenter}` : sql``}
        ${filters.reference ? sql`and h.reference ilike ${`%${filters.reference}%`}` : sql``}
        ${statusClause}
      order by h.posting_date, l.document_number, l.line_number
      limit ${cap + 1}
    `) as unknown as RawRow[];

    const truncated = rows.length > cap;
    const kept = truncated ? rows.slice(0, cap) : rows;
    const view: JournalItemRow[] = kept.map((r) => ({
      companyCode: r.company_code, documentNumber: r.document_number,
      fiscalYear: Number(r.fiscal_year), lineNumber: Number(r.line_number),
      postingDate: r.posting_date, documentDate: r.document_date,
      documentType: r.document_type, documentStatus: r.document_status,
      glAccount: r.gl_account, debitCredit: r.debit_credit as 'S' | 'H',
      amountDocument: Number(r.amount_document), currency: r.currency,
      amountLocal: Number(r.amount_local), localCurrency: r.local_currency,
      costCenter: r.cost_center, profitCenter: r.profit_center,
      taxCode: r.tax_code, lineText: r.line_text,
      businessPartner: r.business_partner, reference: r.reference,
      clearingDocument: r.clearing_document, clearingDate: r.clearing_date,
      itemStatus: !r.is_open_item_managed ? null : r.clearing_document ? 'CLEARED' : 'OPEN',
    }));

    const groups = new Map<string, JournalItemSubtotal>();
    for (const row of view) {
      const key = `${row.companyCode}|${row.glAccount}|${row.currency}|${row.localCurrency}`;
      const group = groups.get(key) ?? {
        companyCode: row.companyCode, glAccount: row.glAccount,
        currency: row.currency, localCurrency: row.localCurrency,
        debitDocument: 0, creditDocument: 0, debitLocal: 0, creditLocal: 0,
      };
      if (row.debitCredit === 'S') {
        group.debitDocument = round2(group.debitDocument + row.amountDocument);
        group.debitLocal = round2(group.debitLocal + row.amountLocal);
      } else {
        group.creditDocument = round2(group.creditDocument + row.amountDocument);
        group.creditLocal = round2(group.creditLocal + row.amountLocal);
      }
      groups.set(key, group);
    }
    return { rows: view, subtotals: [...groups.values()], truncated, cap };
  });
}
