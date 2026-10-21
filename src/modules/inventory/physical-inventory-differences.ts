/**
 * Physical inventory differences — SCR-148 / MI20 (INV.PHYINV.DIFF.LIST).
 *
 * A list of what was counted against what the document froze. It reads the stored difference
 * and decides nothing: no count is rewritten, no status moves, no material document, no journal.
 * Posting that difference is the next round. A label that said "ready for posting" would be a
 * decision this list is forbidden to make.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { withTenant, type Tx } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { getMaterialPeriodControlInTx } from './goods-issue';
import { materialPeriodAllows } from './material-period-control';

export const PHYSICAL_INVENTORY_DIFF_LIST_CAPABILITY = 'INV.PHYINV.DIFF.LIST';
export const PHYSICAL_INVENTORY_DIFF_LIST_ROUTE = '/inventory/physical-inventory-differences';
export const PHYSICAL_INVENTORY_DIFF_LIST_ALIASES = ['MI20'] as const;

export const DIFFERENCE_PAGE_SIZE_DEFAULT = 50;
export const DIFFERENCE_PAGE_SIZE_MAX = 200;

const SORTS = ['document', 'material', 'difference', 'monetary'] as const;
const POSTING_FILTERS = ['PENDING', 'POSTED', 'RECOUNT_REQUIRED', 'NO_DIFFERENCE', 'NOT_COUNTED'] as const;

export class PhysicalInventoryDifferenceError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PhysicalInventoryDifferenceError';
    this.remedy = remedy;
  }
}

const selectionSchema = z.object({
  plantFrom: z.string().trim().min(1).max(10),
  plantTo: z.string().trim().max(10).optional(),
  storageLocationFrom: z.string().trim().max(10).optional(),
  storageLocationTo: z.string().trim().max(10).optional(),
  documentFrom: z.string().trim().max(24).optional(),
  documentTo: z.string().trim().max(24).optional(),
  fiscalYear: z.number().int().min(2000).max(2999),
  materialFrom: z.string().trim().max(40).optional(),
  materialTo: z.string().trim().max(40).optional(),
  differenceExists: z.boolean().optional(),
  includeUncounted: z.boolean().optional(),
  countStatus: z.enum(['UNCOUNTED', 'COUNTED', 'RECOUNT_REQUIRED']).optional(),
  postingStatus: z.enum(POSTING_FILTERS).optional(),
  minimumDifferenceValue: z.number().finite().nonnegative().optional(),
  currency: z.string().trim().length(3).optional(),
  includeUnvalued: z.boolean().optional(),
  /** Accepted and not translated: the material master holds one description. */
  language: z.string().trim().max(8).optional(),
  /** Refused by name. Split valuation is not a dimension this list can price. */
  valuationType: z.string().trim().max(16).optional(),
  showPeriodNote: z.boolean().optional(),
  sort: z.enum(SORTS).optional(),
  sortDescending: z.boolean().optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(DIFFERENCE_PAGE_SIZE_MAX).optional(),
});

export interface DifferenceSelection {
  plantFrom: string;
  plantTo?: string;
  storageLocationFrom?: string;
  storageLocationTo?: string;
  documentFrom?: string;
  documentTo?: string;
  fiscalYear: number;
  materialFrom?: string;
  materialTo?: string;
  differenceExists?: boolean;
  includeUncounted?: boolean;
  countStatus?: 'UNCOUNTED' | 'COUNTED' | 'RECOUNT_REQUIRED';
  postingStatus?: (typeof POSTING_FILTERS)[number];
  minimumDifferenceValue?: number;
  currency?: string;
  includeUnvalued?: boolean;
  language?: string;
  valuationType?: string;
  showPeriodNote?: boolean;
  sort?: (typeof SORTS)[number];
  sortDescending?: boolean;
  page?: number;
  pageSize?: number;
}

export type DifferenceLabel =
  | 'NOT_COUNTED'
  | 'NO_DIFFERENCE'
  | 'PENDING'
  | 'POSTED'
  | 'RECOUNT_REQUIRED';

export type DifferenceDirection = 'SHORTAGE' | 'SURPLUS' | 'NONE';

export interface DifferenceRow {
  plant: string;
  storageLocation: string | null;
  documentNumber: string;
  fiscalYear: number;
  itemNumber: number;
  materialNumber: string;
  description: string;
  stockType: string;
  bookQuantity: string | null;
  bookUnit: string | null;
  bookBasis: string | null;
  countedQuantity: string | null;
  entryUnit: string | null;
  baseQuantity: string | null;
  baseUnit: string;
  differenceQuantity: string | null;
  direction: DifferenceDirection;
  label: DifferenceLabel;
  countDate: string | null;
  plannedCountDate: string;
  counterName: string | null;
  zeroCount: boolean;
  priceControl: string | null;
  valuationPrice: string | null;
  priceUnit: string | null;
  monetaryDifference: string | null;
  currency: string | null;
  /** The price standing now. Not the price on the count date, and not the amount a posting will take. */
  valuationBasis: 'CURRENT_PLANT_PRICE' | 'UNAVAILABLE';
  monetaryStatus: 'VALUED' | 'NO_VALUATION' | 'NO_CURRENCY_PRECISION' | 'OTHER_CURRENCY';
  monetaryReason: string | null;
  inconsistent: boolean;
  /** Informational. Absent unless the selection asked, and never a reason to hide the row. */
  periodNote: string | null;
  postingDocument: null;
}

export interface DifferenceListResult {
  rows: DifferenceRow[];
  page: number;
  pageSize: number;
  total: number;
  /** Rows the quantity filters matched that a currency threshold could not compare. */
  excludedOtherCurrency: number;
  /** Rows hidden because the selection asked to omit unvalued differences. */
  excludedUnvalued: number;
  languageRequested: string | null;
  languageBasis: 'MATERIAL_MASTER';
  readOnly: true;
}

interface RawRow {
  plant: string;
  storage_location: string | null;
  company_code: string | null;
  document_number: string;
  fiscal_year: number;
  item_number: number;
  material_number: string;
  description: string;
  base_unit: string;
  stock_type: string;
  book_quantity: string | null;
  book_unit: string | null;
  book_basis: string | null;
  counted_quantity: string | null;
  entry_unit: string | null;
  base_quantity: string | null;
  difference_quantity: string | null;
  count_status: string;
  document_status: string;
  count_date: string | null;
  planned_count_date: string;
  counter_name: string | null;
  zero_count: boolean;
  price_control: string | null;
  valuation_price: string | null;
  price_unit: string | null;
  currency: string | null;
  monetary: string | null;
  monetary_status: DifferenceRow['monetaryStatus'];
  inconsistent: boolean;
}

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireOrder(from: string | undefined, to: string | undefined, label: string) {
  if (from && to && from > to) {
    throw new PhysicalInventoryDifferenceError(
      `${label} ${from} is after ${to}.`,
      'Swap the two ends of the range.',
    );
  }
}

export function labelOf(row: {
  countStatus: string;
  documentStatus: string;
  differenceQuantity: string | null;
}): DifferenceLabel {
  if (row.documentStatus === 'POSTED') return 'POSTED';
  if (row.countStatus === 'RECOUNT_REQUIRED') return 'RECOUNT_REQUIRED';
  if (row.countStatus !== 'COUNTED' || row.differenceQuantity === null) return 'NOT_COUNTED';
  if (Number(row.differenceQuantity) === 0) return 'NO_DIFFERENCE';
  return 'PENDING';
}

export function directionOf(difference: string | null): DifferenceDirection {
  if (difference === null || Number(difference) === 0) return 'NONE';
  return Number(difference) < 0 ? 'SHORTAGE' : 'SURPLUS';
}

function monetaryReason(status: DifferenceRow['monetaryStatus'], currency: string | null): string | null {
  if (status === 'NO_VALUATION') {
    return 'No valuation record stands for this material in the plant, so no monetary difference is shown.';
  }
  if (status === 'NO_CURRENCY_PRECISION') {
    return `Currency ${currency ?? '(none)'} has no decimal-place definition, so the monetary difference is not rounded and not shown.`;
  }
  if (status === 'OTHER_CURRENCY') {
    return `The valuation is in ${currency}, which is not the comparison currency. No rate is applied.`;
  }
  return null;
}

function toRow(raw: RawRow, periodNote: string | null): DifferenceRow {
  const label = labelOf({
    countStatus: raw.count_status,
    documentStatus: raw.document_status,
    differenceQuantity: raw.difference_quantity,
  });
  const valued = raw.monetary_status === 'VALUED';
  return {
    plant: raw.plant,
    storageLocation: raw.storage_location,
    documentNumber: raw.document_number,
    fiscalYear: raw.fiscal_year,
    itemNumber: raw.item_number,
    materialNumber: raw.material_number,
    description: raw.description || raw.material_number,
    stockType: raw.stock_type,
    bookQuantity: raw.book_quantity,
    bookUnit: raw.book_unit,
    bookBasis: raw.book_basis,
    countedQuantity: raw.counted_quantity,
    entryUnit: raw.entry_unit,
    baseQuantity: raw.base_quantity,
    baseUnit: raw.base_unit,
    differenceQuantity: raw.difference_quantity,
    direction: directionOf(raw.difference_quantity),
    label,
    countDate: raw.count_date,
    plannedCountDate: raw.planned_count_date,
    counterName: raw.counter_name,
    zeroCount: raw.zero_count,
    priceControl: raw.price_control,
    valuationPrice: valued ? raw.valuation_price : null,
    priceUnit: valued ? raw.price_unit : null,
    monetaryDifference: valued ? raw.monetary : null,
    currency: raw.currency,
    valuationBasis: valued ? 'CURRENT_PLANT_PRICE' : 'UNAVAILABLE',
    monetaryStatus: raw.monetary_status,
    monetaryReason: monetaryReason(raw.monetary_status, raw.currency),
    inconsistent: raw.inconsistent,
    periodNote,
    postingDocument: null,
  };
}

async function assertStands(
  tx: Tx, client: string, table: 'plant' | 'storage_location', column: string, value: string, plant?: string,
) {
  const rows = table === 'plant'
    ? await tx.execute(sql`select 1 as hit from plant where client = ${client} and plant = ${value} limit 1`)
    : await tx.execute(sql`
        select 1 as hit from storage_location
         where client = ${client} and plant = ${plant ?? ''} and storage_location = ${value}
         limit 1
      `);
  const found = (rows as unknown as Array<{ hit: number }>).length > 0;
  if (!found) {
    throw new PhysicalInventoryDifferenceError(
      `${column === 'plant' ? 'Plant' : 'Storage location'} ${value} does not stand${plant ? ` in plant ${plant}` : ''}.`,
      'Choose a value the tenant carries.',
    );
  }
}

/**
 * The difference list. One transaction, one snapshot, no writes.
 *
 * Quantity filters run before valuation is joined into the decision, and a monetary threshold
 * never replaces them. Unvalued rows stay unless the selection hides them, and then the result
 * says how many were hidden.
 */
export async function listDifferences(
  client: string,
  raw: DifferenceSelection,
): Promise<DifferenceListResult> {
  const parsed = selectionSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new PhysicalInventoryDifferenceError(
      `The selection is not valid: ${first.path.join('.') || 'payload'} ${first.message}.`,
      'Correct the selection and run it again.',
    );
  }
  const selection = parsed.data;
  if (selection.valuationType) {
    throw new PhysicalInventoryDifferenceError(
      'Split valuation is not carried. A difference is valued at the plant, and a valuation type is refused.',
      'Leave the valuation type empty.',
    );
  }
  if (selection.minimumDifferenceValue !== undefined && !selection.currency) {
    throw new PhysicalInventoryDifferenceError(
      'A minimum difference value needs the currency it is expressed in.',
      'Name the comparison currency. No rate is assumed.',
    );
  }
  const plantFrom = selection.plantFrom.toUpperCase();
  const plantTo = blank(selection.plantTo)?.toUpperCase();
  const slocFrom = blank(selection.storageLocationFrom)?.toUpperCase();
  const slocTo = blank(selection.storageLocationTo)?.toUpperCase();
  const documentFrom = blank(selection.documentFrom)?.toUpperCase();
  const documentTo = blank(selection.documentTo)?.toUpperCase();
  const materialFrom = blank(selection.materialFrom)?.toUpperCase();
  const materialTo = blank(selection.materialTo)?.toUpperCase();
  requireOrder(plantFrom, plantTo, 'Plant');
  requireOrder(slocFrom, slocTo, 'Storage location');
  requireOrder(documentFrom, documentTo, 'Document');
  requireOrder(materialFrom, materialTo, 'Material');

  const differenceExists = selection.differenceExists !== false;
  const includeUncounted = selection.includeUncounted === true;
  const includeUnvalued = selection.includeUnvalued !== false;
  const page = selection.page ?? 1;
  const pageSize = selection.pageSize ?? DIFFERENCE_PAGE_SIZE_DEFAULT;
  const comparisonCurrency = selection.currency?.toUpperCase() ?? null;
  const threshold = selection.minimumDifferenceValue ?? null;

  return withTenant(client, async (tx) => {
    await assertStands(tx, client, 'plant', 'plant', plantFrom);
    if (plantTo) await assertStands(tx, client, 'plant', 'plant', plantTo);
    if (slocFrom) await assertStands(tx, client, 'storage_location', 'storage location', slocFrom, plantFrom);
    if (slocTo) await assertStands(tx, client, 'storage_location', 'storage location', slocTo, plantTo ?? plantFrom);

    const filters = [
      sql`d.client = ${client}`,
      sql`d.fiscal_year = ${selection.fiscalYear}`,
      sql`d.status <> 'CANCELLED'`,
      sql`d.plant >= ${plantFrom}`,
      plantTo ? sql`d.plant <= ${plantTo}` : sql`true`,
      slocFrom ? sql`d.storage_location >= ${slocFrom}` : sql`true`,
      slocTo ? sql`d.storage_location <= ${slocTo}` : sql`true`,
      documentFrom ? sql`d.inventory_document_number >= ${documentFrom}` : sql`true`,
      documentTo ? sql`d.inventory_document_number <= ${documentTo}` : sql`true`,
      materialFrom ? sql`i.material_number >= ${materialFrom}` : sql`true`,
      materialTo ? sql`i.material_number <= ${materialTo}` : sql`true`,
    ];
    if (selection.countStatus) filters.push(sql`i.count_status = ${selection.countStatus}`);
    else if (!includeUncounted) filters.push(sql`i.count_status = 'COUNTED'`);
    if (differenceExists && !selection.postingStatus) {
      filters.push(sql`i.count_status = 'COUNTED'`);
      filters.push(sql`i.difference_quantity <> 0`);
    }
    if (selection.postingStatus === 'PENDING') {
      filters.push(sql`i.count_status = 'COUNTED' and i.difference_quantity <> 0 and d.status <> 'POSTED'`);
    } else if (selection.postingStatus === 'POSTED') {
      filters.push(sql`d.status = 'POSTED'`);
    } else if (selection.postingStatus === 'RECOUNT_REQUIRED') {
      filters.push(sql`i.count_status = 'RECOUNT_REQUIRED'`);
    } else if (selection.postingStatus === 'NO_DIFFERENCE') {
      filters.push(sql`i.count_status = 'COUNTED' and i.difference_quantity = 0`);
    } else if (selection.postingStatus === 'NOT_COUNTED') {
      filters.push(sql`i.count_status = 'UNCOUNTED'`);
    }
    const where = sql.join(filters, sql` and `);

    const priced = sql`
      select d.plant, d.storage_location, p.company_code,
             d.inventory_document_number as document_number, d.fiscal_year, d.status as document_status,
             d.planned_count_date,
             i.item_number, i.material_number, coalesce(m.description, '') as description,
             coalesce(m.base_unit, '') as base_unit, i.stock_type,
             i.book_quantity_snapshot::text as book_quantity, i.book_quantity_unit as book_unit,
             i.book_quantity_basis as book_basis,
             i.counted_quantity::text as counted_quantity, i.entry_unit,
             i.counted_base_quantity::text as base_quantity,
             i.difference_quantity::text as difference_quantity,
             i.count_status, i.count_date, i.counter_name, i.zero_count_flag as zero_count,
             v.price_control,
             case when v.price_control = 'STANDARD' then v.standard_price else v.moving_average_price end::text as valuation_price,
             v.price_unit::text as price_unit, v.currency,
             case
               when v.material_number is null or c.decimal_places is null then null
               else round(
                 i.difference_quantity
                 * (case when v.price_control = 'STANDARD' then v.standard_price else v.moving_average_price end)
                 / v.price_unit
               , c.decimal_places)::text
             end as monetary,
             case
               when v.material_number is null then 'NO_VALUATION'
               when c.decimal_places is null then 'NO_CURRENCY_PRECISION'
               when ${comparisonCurrency}::text is not null and v.currency <> ${comparisonCurrency} then 'OTHER_CURRENCY'
               else 'VALUED'
             end as monetary_status,
             (
               i.counted_base_quantity is not null
               and i.book_quantity_snapshot is not null
               and i.difference_quantity is distinct from round(i.counted_base_quantity - i.book_quantity_snapshot, 3)
             ) as inconsistent
        from physical_inventory_document d
        join physical_inventory_item i
          on i.client = d.client
         and i.inventory_document_number = d.inventory_document_number
         and i.fiscal_year = d.fiscal_year
        left join plant p on p.client = d.client and p.plant = d.plant
        left join material m on m.client = i.client and m.material_number = i.material_number
        left join material_valuation v
          on v.client = i.client and v.material_number = i.material_number and v.valuation_area = d.plant
        left join currency c on c.code = v.currency
       where ${where}
    `;

    const moneyFilter = threshold === null
      ? sql`true`
      : includeUnvalued
        ? sql`(monetary_status = 'VALUED' and abs(monetary::numeric) >= ${threshold}) or monetary_status in ('NO_VALUATION', 'NO_CURRENCY_PRECISION')`
        : sql`monetary_status = 'VALUED' and abs(monetary::numeric) >= ${threshold}`;

    const sort = selection.sort ?? 'document';
    const descending = selection.sortDescending === true;
    const order = sort === 'material'
      ? (descending
        ? sql`material_number desc, document_number, item_number`
        : sql`material_number asc, document_number, item_number`)
      : sort === 'difference'
        ? (descending
          ? sql`difference_quantity desc nulls last, document_number, item_number`
          : sql`difference_quantity asc nulls last, document_number, item_number`)
        : sort === 'monetary'
          ? (descending
            ? sql`monetary desc nulls last, document_number, item_number`
            : sql`monetary asc nulls last, document_number, item_number`)
          : (descending
            ? sql`document_number desc, item_number`
            : sql`document_number asc, item_number`);

    const totals = await tx.execute(sql`
      with priced as (${priced})
      select
        count(*) filter (where ${moneyFilter})::int as total,
        count(*) filter (where monetary_status = 'OTHER_CURRENCY')::int as other_currency,
        count(*) filter (where monetary_status in ('NO_VALUATION', 'NO_CURRENCY_PRECISION'))::int as unvalued
      from priced
    `) as unknown as Array<{ total: number; other_currency: number; unvalued: number }>;

    const pageRows = await tx.execute(sql`
      with priced as (${priced})
      select * from priced
       where ${moneyFilter}
       order by ${order}
       limit ${pageSize}
       offset ${(page - 1) * pageSize}
    `) as unknown as RawRow[];

    const notes = selection.showPeriodNote
      ? await periodNotes(tx, client, pageRows)
      : new Map<string, string>();

    return {
      rows: pageRows.map((raw) => toRow(
        raw,
        raw.count_date ? notes.get(`${raw.company_code ?? ''}|${raw.count_date}`) ?? null : null,
      )),
      page,
      pageSize,
      total: Number(totals[0]?.total ?? 0),
      excludedOtherCurrency: threshold === null ? 0 : Number(totals[0]?.other_currency ?? 0),
      excludedUnvalued: threshold !== null && !includeUnvalued ? Number(totals[0]?.unvalued ?? 0) : 0,
      languageRequested: selection.language ?? null,
      languageBasis: 'MATERIAL_MASTER',
      readOnly: true,
    };
  });
}

async function periodNotes(tx: Tx, client: string, rows: RawRow[]): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  const companies = new Map<string, { variant: string | null; dates: Set<string> }>();
  for (const row of rows) {
    if (!row.company_code || !row.count_date) continue;
    const entry = companies.get(row.company_code) ?? { variant: null, dates: new Set<string>() };
    entry.dates.add(row.count_date);
    companies.set(row.company_code, entry);
  }
  for (const [companyCode, entry] of companies) {
    const company = await getCompanyCode(tx, client, companyCode);
    const control = await getMaterialPeriodControlInTx(tx, client, companyCode);
    for (const countDate of entry.dates) {
      const key = `${companyCode}|${countDate}`;
      if (!company?.fiscalYearVariant || !control) {
        notes.set(key, `No material period stands for company ${companyCode}. The row is shown; this is not a posting decision.`);
        continue;
      }
      const position = await derivePosition(tx, client, company.fiscalYearVariant, countDate);
      if (!materialPeriodAllows(control, position.fiscalYear, position.period)) {
        notes.set(
          key,
          `The material period for count date ${countDate} is closed. The row is shown; posting eligibility is not decided here.`,
        );
      }
    }
  }
  return notes;
}

export interface DifferenceDocumentView {
  documentNumber: string;
  fiscalYear: number;
  plant: string;
  storageLocation: string | null;
  plannedCountDate: string;
  status: string;
  postingBlock: boolean;
  items: DifferenceRow[];
}

/** Read-only document display. Not the create workbench, and not the count editor. */
export async function getDifferenceDocument(
  client: string,
  keys: { documentNumber: string; fiscalYear: number },
): Promise<DifferenceDocumentView | null> {
  const documentNumber = keys.documentNumber.trim().toUpperCase();
  if (!documentNumber || keys.fiscalYear < 2000 || keys.fiscalYear > 2999) {
    throw new PhysicalInventoryDifferenceError('A document number and a fiscal year are required.');
  }
  const header = await withTenant(client, async (tx) => {
    const headers = await tx.execute(sql`
      select inventory_document_number, fiscal_year, plant, storage_location, planned_count_date,
             status, posting_block
        from physical_inventory_document
       where client = ${client}
         and inventory_document_number = ${documentNumber}
         and fiscal_year = ${keys.fiscalYear}
    `) as unknown as Array<{
      inventory_document_number: string; fiscal_year: number; plant: string;
      storage_location: string | null; planned_count_date: string; status: string; posting_block: boolean;
    }>;
    return headers[0] ?? null;
  });
  if (!header) return null;
  // A second transaction, not a nested one: the test pool has a single connection.
  const listed = await listDifferences(client, {
    plantFrom: header.plant,
    fiscalYear: header.fiscal_year,
    documentFrom: header.inventory_document_number,
    documentTo: header.inventory_document_number,
    differenceExists: false,
    includeUncounted: true,
    pageSize: DIFFERENCE_PAGE_SIZE_MAX,
  });
  return {
    documentNumber: header.inventory_document_number,
    fiscalYear: header.fiscal_year,
    plant: header.plant,
    storageLocation: header.storage_location,
    plannedCountDate: header.planned_count_date,
    status: header.status,
    postingBlock: header.posting_block,
    items: listed.rows,
  };
}

/**
 * The only navigation this module answers. Display reads. Posting and recount are other
 * transactions, and naming them here is refused rather than performed.
 */
export async function openDifferenceWorkflow(
  client: string,
  input: { workflow: 'DISPLAY' | 'POST' | 'RECOUNT'; documentNumber: string; fiscalYear: number },
): Promise<DifferenceDocumentView | null> {
  if (input.workflow === 'POST') {
    throw new PhysicalInventoryDifferenceError(
      'Difference posting is not carried. A list does not post, and the posting workflow revalidates on its own round.',
      'Post the difference from the difference-posting transaction, not from this list.',
    );
  }
  if (input.workflow === 'RECOUNT') {
    throw new PhysicalInventoryDifferenceError(
      'Recount is not carried. Opening the list does not create a recount and does not change the count.',
      'Open the recount screen. That is navigation. This list still does not recount.',
    );
  }
  return getDifferenceDocument(client, input);
}
