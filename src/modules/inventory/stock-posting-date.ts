/**
 * Stocks on posting date — SCR-126 / INV.STOCK.POSTINGDATE (MB5B).
 *
 * A rollforward of opening, receipts, issues and closing across a date window.
 * The figures are read from the immutable ledger, not derived by unwinding the
 * current snapshot: this canon keeps every movement, so the exact answer comes
 * straight from it. Where the window reaches the latest posting date, the
 * closing quantity is compared with `stock_quantity` and any difference stands
 * as a warning naming both figures — a control, never a silent adjustment.
 *
 * Required material and plant ranges keep every query bounded; the stock type
 * defaults to unrestricted, and zero-stock lines are suppressed unless asked for.
 *
 * Deferred by name (contract §26.849): batch and valuation type (neither stands
 * on the ledger line), Scope-of-List variants, stock ageing and exporting.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';

export const STOCK_POSTINGDATE_CAPABILITY = 'INV.STOCK.POSTINGDATE';
export const STOCK_POSTINGDATE_ALIAS = 'MB5B';
export const DEFAULT_STOCK_TYPE = 'UNRESTRICTED';

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;

export interface StockPostingDateSelection {
  materialFrom?: string;
  materialTo?: string;
  plantFrom?: string;
  plantTo?: string;
  storageLocationFrom?: string;
  storageLocationTo?: string;
  dateFrom?: string;
  dateTo?: string;
  stockType?: string;
  displayZero?: boolean;
  maxHits?: number;
}

export interface StockPostingDateRow {
  materialNumber: string;
  materialDescription: string;
  plant: string;
  storageLocation: string;
  stockType: string;
  baseUnit: string;
  openingQuantity: number;
  openingValue: number;
  receiptQuantity: number;
  receiptValue: number;
  issueQuantity: number;
  issueValue: number;
  closingQuantity: number;
  closingValue: number;
  /** MB51 filtered to this row and the same posting window. */
  drillDown: string;
}

export interface StockPostingDateResult {
  capability: string;
  selection: StockPostingDateSelection;
  rows: StockPostingDateRow[];
  rowCount: number;
  truncated: boolean;
  maxHits: number;
  warnings: string[];
  calculatedAt: string;
}

export class StockPostingDateError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'StockPostingDateError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new StockPostingDateError(message, remedy);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, label: string): string {
  const parsed = ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} ${value} is not a valid date.`, 'Use the format YYYY-MM-DD.');
  }
  return value;
}

function bound(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

export async function stockOnPostingDate(input: {
  client: string;
  selection: StockPostingDateSelection;
}): Promise<StockPostingDateResult> {
  const { client } = input;
  const raw = input.selection;
  const s: StockPostingDateSelection = {
    materialFrom: bound(raw.materialFrom),
    materialTo: bound(raw.materialTo),
    plantFrom: bound(raw.plantFrom),
    plantTo: bound(raw.plantTo),
    storageLocationFrom: bound(raw.storageLocationFrom),
    storageLocationTo: bound(raw.storageLocationTo),
    dateFrom: bound(raw.dateFrom),
    dateTo: bound(raw.dateTo),
    stockType: bound(raw.stockType) ?? DEFAULT_STOCK_TYPE,
    displayZero: raw.displayZero === true,
    maxHits: raw.maxHits,
  };

  if (!s.materialFrom) fail('A material range is required.', 'Enter the material from — the rollforward is never run over every material.');
  if (!s.plantFrom) fail('A plant range is required.', 'Enter the plant from — the rollforward is never run over every plant.');
  if (!s.dateFrom || !s.dateTo) {
    fail('A reporting date range is required.', 'Enter the reporting date from and to.');
  }
  checkDate(s.dateFrom, 'Reporting date from');
  checkDate(s.dateTo, 'Reporting date to');
  if (s.dateFrom > s.dateTo) fail('The reporting date range is inverted.', 'The start date must not exceed the end date.');

  // An open upper bound is the single key, never the whole table.
  const materialTo = s.materialTo ?? s.materialFrom;
  const plantTo = s.plantTo ?? s.plantFrom;
  if (materialTo < s.materialFrom) fail('The material range is inverted.', 'The lower bound must not exceed the upper bound.');
  if (plantTo < s.plantFrom) fail('The plant range is inverted.', 'The lower bound must not exceed the upper bound.');
  if (s.storageLocationFrom && s.storageLocationTo && s.storageLocationFrom > s.storageLocationTo) {
    fail('The storage location range is inverted.', 'The lower bound must not exceed the upper bound.');
  }

  const warnings: string[] = [];
  const requested = s.maxHits ?? DEFAULT_MAX_HITS;
  if (!Number.isInteger(requested) || requested < 1) fail('Maximum hits must be a positive number.');
  const maxHits = Math.min(requested, MAX_HITS_CAP);
  if (requested > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  const calculatedAt = new Date().toISOString();

  return withTenant(client, async (tx) => {
    for (const [table, column, value, label] of [
      ['material', 'material_number', s.materialFrom, 'material'],
      ['material', 'material_number', materialTo, 'material'],
      ['plant', 'plant', s.plantFrom, 'plant'],
      ['plant', 'plant', plantTo, 'plant'],
    ] as const) {
      const rows = await tx.execute(sql`
        select ${sql.raw(column)} as key from ${sql.raw(table)}
        where client = ${client} and ${sql.raw(column)} = ${value}
      `) as unknown as Array<{ key: string }>;
      if (rows.length === 0) fail(`The ${label} ${value} does not stand.`, `Maintain the ${label} before selecting it.`);
    }
    for (const value of [s.storageLocationFrom, s.storageLocationTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`
        select storage_location as key from storage_location where client = ${client} and storage_location = ${value}
      `) as unknown as Array<{ key: string }>;
      if (rows.length === 0) fail(`The storage location ${value} does not stand.`, 'Maintain the storage location before selecting it.');
    }
    {
      const rows = await tx.execute(sql`
        select 1 as hit from stock_quantity where client = ${client} and stock_type = ${s.stockType ?? DEFAULT_STOCK_TYPE}
        union all
        select 1 as hit from material_document_line where client = ${client} and stock_type = ${s.stockType ?? DEFAULT_STOCK_TYPE}
        limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) {
        fail(
          `The stock type ${s.stockType} does not stand.`,
          'Project and sales-order special stocks are not carried; select a stock type the ledger records.',
        );
      }
    }

    const storageFilter = s.storageLocationFrom || s.storageLocationTo
      ? sql`and l.storage_location between ${s.storageLocationFrom ?? ''} and ${s.storageLocationTo ?? '￿'}`
      : sql``;
    const having = s.displayZero
      ? sql``
      : sql`having sum(case when m.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end) <> 0
             or sum(case when m.direction = 'REVERSAL' then -l.value else l.value end) <> 0`;

    const rows = await tx.execute(sql`
      select l.material_number, coalesce(mat.description, '') as material_description,
             l.plant, l.storage_location, l.stock_type, l.base_unit,
             sum(case when d.posting_date < ${s.dateFrom}
                      then (case when m.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end)
                      else 0 end) as opening_qty,
             sum(case when d.posting_date < ${s.dateFrom}
                      then (case when m.direction = 'REVERSAL' then -l.value else l.value end)
                      else 0 end) as opening_val,
             sum(case when d.posting_date >= ${s.dateFrom} and m.direction <> 'REVERSAL' then l.base_quantity else 0 end) as receipt_qty,
             sum(case when d.posting_date >= ${s.dateFrom} and m.direction <> 'REVERSAL' then l.value else 0 end) as receipt_val,
             sum(case when d.posting_date >= ${s.dateFrom} and m.direction = 'REVERSAL' then l.base_quantity else 0 end) as issue_qty,
             sum(case when d.posting_date >= ${s.dateFrom} and m.direction = 'REVERSAL' then l.value else 0 end) as issue_val
      from material_document_line l
      join material_document d
        on d.client = l.client and d.material_document_number = l.material_document_number
      join movement_type m on m.client = l.client and m.movement_type = l.movement_type
      left join material mat on mat.client = l.client and mat.material_number = l.material_number
      where l.client = ${client} and d.status = 'POSTED'
        and l.material_number between ${s.materialFrom} and ${materialTo}
        and l.plant between ${s.plantFrom} and ${plantTo}
        and l.stock_type = ${s.stockType ?? DEFAULT_STOCK_TYPE}
        and d.posting_date <= ${s.dateTo}
        ${storageFilter}
      group by l.material_number, mat.description, l.plant, l.storage_location, l.stock_type, l.base_unit
      ${having}
      order by l.material_number, l.plant, l.storage_location, l.stock_type
      limit ${maxHits + 1}
    `) as unknown as Array<Record<string, unknown>>;

    const truncated = rows.length > maxHits;
    const window = rows.slice(0, maxHits);
    const num = (value: unknown, scale = 3) => Number(fromScaled(toScaled(String(value), scale), scale));
    const out: StockPostingDateRow[] = window.map((r) => {
      const openingQuantity = num(r.opening_qty);
      const receiptQuantity = num(r.receipt_qty);
      const issueQuantity = num(r.issue_qty);
      return {
        materialNumber: String(r.material_number),
        materialDescription: String(r.material_description ?? ''),
        plant: String(r.plant ?? ''),
        storageLocation: String(r.storage_location ?? ''),
        stockType: String(r.stock_type ?? ''),
        baseUnit: String(r.base_unit ?? ''),
        openingQuantity,
        openingValue: num(r.opening_val, 2),
        receiptQuantity,
        receiptValue: num(r.receipt_val, 2),
        issueQuantity,
        issueValue: num(r.issue_val, 2),
        closingQuantity: Number((openingQuantity + receiptQuantity - issueQuantity).toFixed(3)),
        closingValue: Number((num(r.opening_val, 2) + num(r.receipt_val, 2) - num(r.issue_val, 2)).toFixed(2)),
        drillDown: `/inventory/material-document-list?materialFrom=${encodeURIComponent(String(r.material_number))}`
          + `&materialTo=${encodeURIComponent(String(r.material_number))}`
          + `&plantFrom=${encodeURIComponent(String(r.plant))}&plantTo=${encodeURIComponent(String(r.plant))}`
          + `&storageLocationFrom=${encodeURIComponent(String(r.storage_location ?? ''))}`
          + `&storageLocationTo=${encodeURIComponent(String(r.storage_location ?? ''))}`
          + `&stockType=${encodeURIComponent(String(r.stock_type ?? ''))}`
          + `&postingDateFrom=${s.dateFrom}&postingDateTo=${s.dateTo}`,
      };
    });

    // The snapshot is a control: when the window reaches the latest posting date
    // in the tenant, the closing quantity must agree with the stock master.
    const latest = await tx.execute(sql`
      select max(posting_date)::text as latest from material_document
      where client = ${client} and status = 'POSTED'
    `) as unknown as Array<{ latest: string | null }>;
    const latestPosting = latest[0]?.latest ?? null;
    if (latestPosting && s.dateTo! >= latestPosting && out.length > 0) {
      const differences: string[] = [];
      for (const row of out) {
        const snapshot = await tx.execute(sql`
          select quantity::text as quantity from stock_quantity
          where client = ${client} and material_number = ${row.materialNumber} and plant = ${row.plant}
            and storage_location = ${row.storageLocation} and stock_type = ${row.stockType}
        `) as unknown as Array<{ quantity: string }>;
        const onHand = snapshot[0] ? Number(fromScaled(toScaled(snapshot[0].quantity, 3), 3)) : 0;
        if (Math.abs(onHand - row.closingQuantity) > 0.0005) {
          differences.push(
            `${row.materialNumber} / ${row.plant} / ${row.storageLocation || '(none)'} / ${row.stockType}: `
            + `closing ${row.closingQuantity.toFixed(3)} against stock on hand ${onHand.toFixed(3)}`,
          );
        }
      }
      if (differences.length > 0) {
        warnings.push(
          `The closing position differs from the stock master for ${differences.length} row(s): ${differences.slice(0, 5).join('; ')}`
          + (differences.length > 5 ? '; …' : '') + '. The ledger figures stand as computed; nothing is adjusted.',
        );
      }
    }
    if (truncated) warnings.push(`The list is truncated at ${maxHits} hits; narrow the selection for the complete list.`);

    return {
      capability: STOCK_POSTINGDATE_CAPABILITY,
      selection: s,
      rows: out,
      rowCount: out.length,
      truncated,
      maxHits,
      warnings,
      calculatedAt,
    };
  });
}
