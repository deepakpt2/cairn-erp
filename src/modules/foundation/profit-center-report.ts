/**
 * Profit centre: actual line items (SCR-113 /
 * FIN.RPT.PROFITCENTER; KE5Z search alias).
 *
 * The journal is the universal-journal equivalent (§14.1):
 * actuals are the POSTED journal lines carrying a profit
 * centre, exactly as recorded at posting — never re-derived
 * from current master data. No classic PCA tables stand and
 * none are added; no report-specific posting tables.
 *
 * Selection per the owner package: controlling area,
 * profit centre single/range/group (groups resolve through
 * ranged leaves), fiscal year, period range, G/L account
 * range, ledger (canon carries the one leading ledger `0L`;
 * any other ledger is refused by name), optional document
 * number range, and a server-side maximum-hits limit whose
 * truncation is always indicated. Totals stand by profit
 * centre, G/L account and currency, document-currency and
 * local totals kept separate. Read-only; closed periods
 * never suppress history.
 *
 * Deferred by name: partner profit centre (not recorded on
 * canon lines), G/L account groups (ranges only), KE5Y plan
 * line items, interactive sorting/filtering, and direct
 * operational-document navigation beyond the journal
 * display's origin reference.
 *
 * Stage 1 carries the vocabulary only; the index check
 * lands in stage 2 and the line-item service in stage 3.
 */
export const PROFIT_CENTER_REPORT_CAPABILITY = 'FIN.RPT.PROFITCENTER';
export const LEADING_LEDGER = '0L';
export const DEFAULT_MAX_HITS = 5000;
export const MAX_HITS_CAP = 50000;

export interface ProfitCenterReportSelection {
  controllingArea: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  ledger: string;
  profitCenterFrom?: string;
  profitCenterTo?: string;
  profitCenterGroup?: string;
  glAccountFrom?: string;
  glAccountTo?: string;
  documentFrom?: string;
  documentTo?: string;
  maxHits: number;
}

export interface ProfitCenterLine {
  companyCode: string;
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  lineNumber: number;
  postingDate: string;
  documentDate: string;
  documentType: string;
  ledger: string;
  profitCenter: string;
  profitCenterName: string;
  glAccount: string;
  debitCredit: string;
  documentCurrency: string;
  /** Signed by the debit/credit indicator (debit positive). */
  amountDocument: number;
  localCurrency: string;
  amountLocal: number;
  assignment: string;
  reference: string;
  lineText: string;
  costCenter: string;
  internalOrder: string;
  productionOrder: string;
  businessPartner: string;
  material: string;
  plant: string;
  originClass: string;
  originKey: string;
}

export interface ProfitCenterTotal {
  profitCenter: string;
  glAccount: string;
  documentCurrency: string;
  amountDocument: number;
  localCurrency: string;
  amountLocal: number;
}

export interface ProfitCenterReportResult {
  controllingArea: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  ledger: string;
  lines: ProfitCenterLine[];
  totals: ProfitCenterTotal[];
  /** True when the hit limit cut the result; never silent. */
  truncated: boolean;
  maxHits: number;
  /** Centres excluded because no validity stands in the area or year. */
  excludedCenters: string[];
  warnings: string[];
  calculatedAt: string;
}

import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { fromScaled, toScaled } from '@/platform/posting/decimal';

export class ProfitCenterReportError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ProfitCenterReportError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new ProfitCenterReportError(message, remedy);
}

export async function listProfitCenterLines(input: {
  client: string; selection: ProfitCenterReportSelection;
}): Promise<ProfitCenterReportResult> {
  const { client } = input;
  const s = { ...input.selection, ledger: (input.selection.ledger || LEADING_LEDGER).toUpperCase() };
  if (s.ledger !== LEADING_LEDGER) {
    fail(`Ledger ${s.ledger} is not configured.`, `Only the leading ledger ${LEADING_LEDGER} stands in this canon; other ledgers are not carried.`);
  }
  if (!Number.isInteger(s.fiscalYear) || s.fiscalYear < 1900 || s.fiscalYear > 2199) fail('A valid fiscal year is required.');
  if (s.periodFrom < 1 || s.periodTo > 16 || s.periodFrom > s.periodTo) {
    fail('The period range is invalid.', 'Period from must not exceed period to; periods run 1–16.');
  }
  if (!Number.isInteger(s.maxHits) || s.maxHits < 1) fail('Maximum hits must be a positive number.');
  const warnings: string[] = [];
  const maxHits = Math.min(s.maxHits, MAX_HITS_CAP);
  if (s.maxHits > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  if (s.profitCenterFrom && s.profitCenterTo && s.profitCenterFrom > s.profitCenterTo) fail('The profit center range is inverted.');
  if (s.glAccountFrom && s.glAccountTo && s.glAccountFrom > s.glAccountTo) fail('The G/L account range is inverted.');
  if (s.documentFrom && s.documentTo && s.documentFrom > s.documentTo) fail('The document number range is inverted.');
  const calculatedAt = new Date().toISOString();
  const yearStart = `${s.fiscalYear}-01-01`;
  const yearEnd = `${s.fiscalYear}-12-31`;

  return withTenant(client, async (tx) => {
    const areaRows = await tx.execute(sql`
      select controlling_area from controlling_area
      where client = ${client} and controlling_area = ${s.controllingArea}
    `) as unknown as Array<{ controlling_area: string }>;
    if (areaRows.length === 0) fail(`Controlling area ${s.controllingArea} does not stand.`);

    const companyRows = await tx.execute(sql`
      select company_code from controlling_area_company
      where client = ${client} and controlling_area = ${s.controllingArea} order by company_code
    `) as unknown as Array<{ company_code: string }>;
    const companies = companyRows.map((r) => r.company_code);
    if (companies.length === 0) fail(`Controlling area ${s.controllingArea} has no company codes assigned.`);

    const centerRows = await tx.execute(sql`
      select profit_center, name, valid_from::text as valid_from, valid_to::text as valid_to
      from profit_center where client = ${client} and controlling_area = ${s.controllingArea}
      order by profit_center, valid_from
    `) as unknown as Array<{ profit_center: string; name: string; valid_from: string; valid_to: string }>;
    const standing = new Set(centerRows.map((r) => r.profit_center));
    for (const bound of [s.profitCenterFrom, s.profitCenterTo]) {
      if (bound && !standing.has(bound)) {
        fail(`Profit center ${bound} does not stand in controlling area ${s.controllingArea}.`);
      }
    }
    const nameOf = new Map<string, string>();
    const validCenters = new Set<string>();
    for (const row of centerRows) {
      nameOf.set(row.profit_center, row.name);
      if (row.valid_from <= yearEnd && row.valid_to >= yearStart) validCenters.add(row.profit_center);
    }
    const inRange = (c: string) =>
      (!s.profitCenterFrom || c >= s.profitCenterFrom) && (!s.profitCenterTo || c <= s.profitCenterTo);
    let selected = [...validCenters].filter(inRange);
    const excludedCenters = [...standing].filter((c) => !validCenters.has(c) && inRange(c)).sort();
    if (s.profitCenterGroup) {
      const groupRows = await tx.execute(sql`
        select group_name from profit_center_group
        where client = ${client} and controlling_area = ${s.controllingArea} and group_name = ${s.profitCenterGroup}
      `) as unknown as Array<{ group_name: string }>;
      if (groupRows.length === 0) fail(`Profit center group ${s.profitCenterGroup} does not stand in controlling area ${s.controllingArea}.`);
      const leafRows = await tx.execute(sql`
        select val_sign, val_from, val_to from profit_center_group_leaf
        where client = ${client} and controlling_area = ${s.controllingArea} and group_name = ${s.profitCenterGroup}
        order by display_order, val_from
      `) as unknown as Array<{ val_sign: string; val_from: string; val_to: string }>;
      // Leaves resolve in display order: I includes, E excludes (SCR-042 canon).
      const inGroup = (c: string) => leafRows.reduce((member, l) => {
        const matches = l.val_to ? c >= l.val_from && c <= l.val_to : c === l.val_from;
        return matches ? l.val_sign !== 'E' : member;
      }, false);
      selected = selected.filter(inGroup);
    }
    if (selected.length === 0) fail('No profit centers match the selection in the reported fiscal year.', 'Widen the profit center selection.');
    if (excludedCenters.length > 0) {
      warnings.push(`Profit centers without validity in ${s.fiscalYear} are excluded: ${excludedCenters.join(', ')}.`);
    }

    const accountFilter = s.glAccountFrom
      ? sql`and l.gl_account between ${s.glAccountFrom} and ${s.glAccountTo || s.glAccountFrom}` : sql``;
    const documentFilter = s.documentFrom || s.documentTo
      ? sql`and coalesce(nullif(e.display_number, ''), l.document_number) >= ${s.documentFrom || ''}
            and coalesce(nullif(e.display_number, ''), l.document_number) <= ${s.documentTo || '￿'}` : sql``;
    const centerList = sql.join(selected.map((c) => sql`${c}`), sql`, `);
    const companyList = sql.join(companies.map((c) => sql`${c}`), sql`, `);

    const lineRows = await tx.execute(sql`
      select e.company_code, l.document_number, e.display_number, l.fiscal_year, l.line_number,
        e.posting_date::text as posting_date, e.document_date::text as document_date, e.document_type,
        l.profit_center, l.gl_account, l.debit_credit,
        l.currency as document_currency,
        (case when l.debit_credit = 'S' then l.amount_document else -l.amount_document end)::text as amount_document,
        e.local_currency,
        (case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end)::text as amount_local,
        coalesce(l.assignment, '') as assignment, coalesce(e.reference, '') as reference,
        coalesce(l.line_text, '') as line_text,
        coalesce(l.cost_center, '') as cost_center, coalesce(l.internal_order, '') as internal_order,
        coalesce(l.production_order, '') as production_order, coalesce(l.business_partner, '') as business_partner,
        coalesce(l.material, '') as material, coalesce(l.plant, '') as plant,
        coalesce(e.origin_class, '') as origin_class, coalesce(e.origin_key, '') as origin_key
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and l.profit_center in (${centerList})
        and l.fiscal_year = ${s.fiscalYear}
        and e.company_code in (${companyList})
        and e.posting_period between ${s.periodFrom} and ${s.periodTo}
        and e.status = 'POSTED'
        ${accountFilter} ${documentFilter}
      order by l.profit_center, l.gl_account, e.posting_date, l.document_number, l.line_number
      limit ${maxHits + 1}
    `) as unknown as Array<Record<string, string | number>>;

    const totalRows = await tx.execute(sql`
      select l.profit_center, l.gl_account, l.currency as document_currency,
        sum(case when l.debit_credit = 'S' then l.amount_document else -l.amount_document end)::text as amount_document,
        e.local_currency,
        sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end)::text as amount_local
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and l.profit_center in (${centerList})
        and l.fiscal_year = ${s.fiscalYear}
        and e.company_code in (${companyList})
        and e.posting_period between ${s.periodFrom} and ${s.periodTo}
        and e.status = 'POSTED'
        ${accountFilter} ${documentFilter}
      group by l.profit_center, l.gl_account, l.currency, e.local_currency
      order by l.profit_center, l.gl_account, l.currency, e.local_currency
    `) as unknown as Array<Record<string, string>>;

    const truncated = lineRows.length > maxHits;
    const lines: ProfitCenterLine[] = lineRows.slice(0, maxHits).map((r) => ({
      companyCode: String(r.company_code), documentNumber: String(r.document_number),
      displayNumber: String(r.display_number ?? ''), fiscalYear: Number(r.fiscal_year),
      lineNumber: Number(r.line_number), postingDate: String(r.posting_date),
      documentDate: String(r.document_date), documentType: String(r.document_type),
      ledger: LEADING_LEDGER, profitCenter: String(r.profit_center),
      profitCenterName: nameOf.get(String(r.profit_center)) ?? '',
      glAccount: String(r.gl_account), debitCredit: String(r.debit_credit),
      documentCurrency: String(r.document_currency),
      amountDocument: Number(fromScaled(toScaled(String(r.amount_document)))),
      localCurrency: String(r.local_currency),
      amountLocal: Number(fromScaled(toScaled(String(r.amount_local)))),
      assignment: String(r.assignment), reference: String(r.reference), lineText: String(r.line_text),
      costCenter: String(r.cost_center), internalOrder: String(r.internal_order),
      productionOrder: String(r.production_order), businessPartner: String(r.business_partner),
      material: String(r.material), plant: String(r.plant),
      originClass: String(r.origin_class), originKey: String(r.origin_key),
    }));
    const totals: ProfitCenterTotal[] = totalRows.map((r) => ({
      profitCenter: r.profit_center!, glAccount: r.gl_account!,
      documentCurrency: r.document_currency!,
      amountDocument: Number(fromScaled(toScaled(r.amount_document!))),
      localCurrency: r.local_currency!,
      amountLocal: Number(fromScaled(toScaled(r.amount_local!))),
    }));

    return {
      controllingArea: s.controllingArea, fiscalYear: s.fiscalYear,
      periodFrom: s.periodFrom, periodTo: s.periodTo, ledger: LEADING_LEDGER,
      lines, totals, truncated, maxHits,
      excludedCenters, warnings, calculatedAt,
    };
  });
}

/**
 * CSV of one executed selection (SCR-113 export): exactly the line
 * window the screen shows for that selection, in the screen's fixed
 * order. A truncated window opens with a `# TRUNCATED` comment so a
 * partial file is never mistaken for the complete selection.
 */
export function profitCenterLinesCsv(result: ProfitCenterReportResult): string {
  const esc = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'Company Code,Document Number,Display Number,Fiscal Year,Line,Posting Date,Document Date,Document Type,Ledger,Profit Center,Profit Center Name,G/L Account,Debit/Credit,Document Currency,Amount (Document),Local Currency,Amount (Local),Assignment,Reference,Line Text,Cost Center,Internal Order,Production Order,Business Partner,Material,Plant,Origin Class,Origin Key';
  const lines = result.lines.map((l) => [
    l.companyCode, l.documentNumber, l.displayNumber, l.fiscalYear, l.lineNumber,
    l.postingDate, l.documentDate, l.documentType, l.ledger, l.profitCenter,
    l.profitCenterName, l.glAccount, l.debitCredit, l.documentCurrency,
    l.amountDocument.toFixed(4), l.localCurrency, l.amountLocal.toFixed(4),
    l.assignment, l.reference, l.lineText, l.costCenter, l.internalOrder,
    l.productionOrder, l.businessPartner, l.material, l.plant,
    l.originClass, l.originKey,
  ].map(esc).join(','));
  const marker = result.truncated
    ? [`# TRUNCATED at ${result.maxHits} hits - narrow the selection for the complete list`]
    : [];
  return [...marker, header, ...lines].join('\n') + '\n';
}
