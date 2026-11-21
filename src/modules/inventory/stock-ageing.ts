/**
 * Stock ageing and slow-moving analysis — INV.STOCK.AGEING.DISPLAY (MC46 / MC50).
 *
 * How old is what we hold, and what has stopped moving. The layers are rebuilt on every run from
 * the material ledger (FIFO, at material / plant / stock type), never stored: a layer table would
 * be a second source of truth for stock that already has one. The valuation rule is MB52's
 * (unknown, never zero; carried currency, never translated; returns stock counted, not valuated),
 * and the reversal filter and the inbound / outbound expressions are MB5B's.
 *
 * Read-only: this module issues no insert, update or delete.
 */
import { sql, type SQL } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { purchasingActor, reachablePlantsInTx, plantReachFilter } from '../../platform/auth/scope-actor';
import type { ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { RETURNS } from './stock-types';

export const STOCK_AGEING_CAPABILITY = 'INV.STOCK.AGEING.DISPLAY';
export const STOCK_AGEING_ALIASES = ['MC46', 'MC50'] as const;

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;
export const DEFAULT_STOCK_TYPE = 'UNRESTRICTED';
export const DEFAULT_AGE_BUCKETS = [30, 60, 90, 180, 365] as const;
export const MAX_AGE_BUCKETS = 6;
export const DEFAULT_SLOW_MOVING_DAYS = 90;
export const DEFAULT_NON_MOVING_DAYS = 180;
export const DRIFT_TOLERANCE = 0.0005;

export type MovementClass = 'ACTIVE' | 'SLOW_MOVING' | 'NON_MOVING';

export interface StockAgeingSelection {
  materialFrom?: string;
  materialTo?: string;
  plantFrom?: string;
  plantTo?: string;
  stockType?: string;
  /** The day the report is struck. Defaults to today (UTC). */
  asOf?: string;
  /** Upper bounds in days, ascending. Default DEFAULT_AGE_BUCKETS; the last bucket is "over". */
  ageBuckets?: number[];
  slowMovingDays?: number;
  nonMovingDays?: number;
  displayZero?: boolean;
  valuationPriceDisplay?: boolean;
  maxHits?: number;
}

export interface StockAgeingRow {
  materialNumber: string;
  materialDescription: string;
  materialType: string;
  materialGroup: string | null;
  plant: string;
  stockType: string;
  baseUnit: string;
  quantityOnHand: number;
  /** Quantity per bucket, same order as the buckets; the last is "older than the last bound". */
  bucketQuantities: number[];
  /** null when no layer survives — a row with stock but no documents behind it. */
  oldestLayerDate: string | null;
  weightedAverageAgeDays: number | null;
  lastReceiptDate: string | null;
  lastIssueDate: string | null;
  /** null when the material has never been issued in this plant — not zero. */
  daysSinceLastIssue: number | null;
  movementClass: MovementClass;
  price: number | null;
  priceUnit: number;
  priceControl: string | null;
  currency: string | null;
  value: number | null;
  /** Ledger layers minus the stock record, when they differ by more than DRIFT_TOLERANCE. */
  drift: number | null;
  movementsDrillDown: string;
  stockDrillDown: string;
}

export interface StockAgeingResult {
  capability: string;
  selection: StockAgeingSelection & { asOf: string };
  buckets: Array<{ upToDays: number | null; label: string }>;
  slowMovingDays: number;
  nonMovingDays: number;
  rows: StockAgeingRow[];
  rowCount: number;
  truncated: boolean;
  maxHits: number;
  totals: {
    quantityOnHand: number;
    bucketQuantities: number[];
    value: number | null;
    byClass: Record<MovementClass, number>;
  };
  warnings: string[];
  calculatedAt: string;
}

export class StockAgeingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'StockAgeingError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new StockAgeingError(message, remedy);
}

function bound(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

const num = (value: unknown, scale = 3) => (value === null || value === undefined
  ? 0
  : Number(fromScaled(toScaled(String(value), scale), scale)));

const isPositiveInteger = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function bucketLabels(bounds: readonly number[]): Array<{ upToDays: number | null; label: string }> {
  const out: Array<{ upToDays: number | null; label: string }> = [];
  let previous = 0;
  bounds.forEach((upTo, i) => {
    out.push({ upToDays: upTo, label: i === 0 ? `0–${upTo} days` : `${previous + 1}–${upTo} days` });
    previous = upTo;
  });
  out.push({ upToDays: null, label: `over ${previous} days` });
  return out;
}

// MB5B's expressions, restated here only as shared fragments of the one statement below.
const signedQty = sql`case when l.line_direction = 'ISSUE' or m.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end`;
const inbound = sql`l.line_direction <> 'ISSUE' and m.direction <> 'REVERSAL'`;
const outbound = sql`l.line_direction = 'ISSUE' or m.direction = 'REVERSAL'`;

/**
 * The ledger lines the report reads, as the `lines` CTE both queries share. The four reversal
 * clauses are MB5B's (stock-posting-date.ts), copied. One addition, and why: a transfer that moves
 * stock inside one material / plant / stock type (a storage-location or batch transfer) writes an
 * ISSUE and a RECEIPT there. Read as a FIFO issue plus a fresh receipt it would date thirty-year-old
 * stock from the transfer, so such a pair is left out — it nets to zero, so the net position, and
 * so the drift check, are unaffected. A plant-to-plant or stock-type transfer has no counterpart
 * line in the same partition and is read as the receipt it is for the receiving side.
 */
function linesCte(client: string, stockType: string, asOf: string, filters: SQL): SQL {
  return sql`
    lines as (
      select l.material_number, l.plant, l.stock_type, d.posting_date::date as posting_date,
             d.material_document_number, l.line_number,
             ${signedQty} as qty,
             (${inbound}) as is_inbound
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number
        join movement_type m on m.client = l.client and m.movement_type = l.movement_type
       where l.client = ${client} and (d.status = 'POSTED' or d.status = 'PARTIALLY_REVERSED')
         and l.reversal_of_line is null
         and not exists (
           select 1 from material_document original
           where original.client = d.client
             and original.material_document_number = d.reversal_of
             and original.status = 'REVERSED'
         )
         and not exists (
           select 1 from material_document_line reversed_line
           where reversed_line.client = l.client
             and reversed_line.reversal_of_document = l.material_document_number
             and reversed_line.reversal_of_line = l.line_number
         )
         and not (m.direction = 'TRANSFER' and exists (
           select 1 from material_document_line pair
           where pair.client = l.client
             and pair.material_document_number = l.material_document_number
             and pair.material_number = l.material_number
             and pair.plant = l.plant
             and pair.stock_type = l.stock_type
             and pair.line_direction <> l.line_direction
         ))
         and l.stock_type = ${stockType}
         and d.posting_date::date <= ${asOf}::date
         ${filters}
    )`;
}

type AgeingInput = { client: string; localCurrency: string; selection: StockAgeingSelection };

/** Session, `INV.STOCK.AGEING.DISPLAY` and company scope: only stock of plants the caller reaches is read. */
export async function stockAgeing(input: AgeingInput & { authorization: ServiceAuthorityContext | undefined }): Promise<StockAgeingResult> {
  return stockAgeingWith(input, { authorization: input.authorization });
}

/** Seeding, demo, tests and scripts only; never imported from `src/app`. */
export async function stockAgeingForProvisioning(input: AgeingInput): Promise<StockAgeingResult> {
  return stockAgeingWith(input, 'unscoped');
}

async function stockAgeingWith(
  input: AgeingInput, scope: 'unscoped' | { authorization: ServiceAuthorityContext | undefined },
): Promise<StockAgeingResult> {
  const { client, localCurrency } = input;
  const raw = input.selection;

  const materialFrom = bound(raw.materialFrom)?.toUpperCase();
  const materialTo = bound(raw.materialTo)?.toUpperCase();
  const plantFrom = bound(raw.plantFrom)?.toUpperCase();
  const plantTo = bound(raw.plantTo)?.toUpperCase();
  const namedStockType = bound(raw.stockType)?.toUpperCase();
  const stockType = namedStockType ?? DEFAULT_STOCK_TYPE;

  if (materialFrom && materialTo && materialTo < materialFrom) fail('The material range is inverted.', 'The lower bound must not exceed the upper bound.');
  if (plantFrom && plantTo && plantTo < plantFrom) fail('The plant range is inverted.', 'The lower bound must not exceed the upper bound.');

  const asOf = bound(raw.asOf) ?? new Date().toISOString().slice(0, 10);
  if (!validDate(asOf)) fail(`The date ${asOf} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');

  const ageBuckets = raw.ageBuckets && raw.ageBuckets.length > 0 ? [...raw.ageBuckets] : [...DEFAULT_AGE_BUCKETS];
  if (raw.ageBuckets && raw.ageBuckets.length === 0) fail('At least one age bucket bound is required.', `Leave the field as ${DEFAULT_AGE_BUCKETS.join(',')} for the default.`);
  if (ageBuckets.length > MAX_AGE_BUCKETS) fail(`At most ${MAX_AGE_BUCKETS} age bucket bounds are allowed.`, 'Remove bounds until the list fits.');
  if (!ageBuckets.every(isPositiveInteger)) fail('Age bucket bounds must be positive whole numbers of days.', 'Enter them as 30,60,90.');
  if (!ageBuckets.every((b, i) => i === 0 || b > ageBuckets[i - 1]!)) fail('Age bucket bounds must be strictly ascending.', 'Enter them as 30,60,90.');

  const slowMovingDays = raw.slowMovingDays ?? DEFAULT_SLOW_MOVING_DAYS;
  const nonMovingDays = raw.nonMovingDays ?? DEFAULT_NON_MOVING_DAYS;
  if (!isPositiveInteger(slowMovingDays)) fail('The slow-moving threshold must be a positive whole number of days.');
  if (!isPositiveInteger(nonMovingDays)) fail('The non-moving threshold must be a positive whole number of days.');
  if (nonMovingDays <= slowMovingDays) {
    fail(
      'The non-moving threshold must exceed the slow-moving threshold.',
      'Otherwise the two classes overlap and the classification means nothing.',
    );
  }

  const warnings: string[] = [];
  const requested = raw.maxHits ?? DEFAULT_MAX_HITS;
  if (!Number.isInteger(requested) || requested < 1) fail('Maximum hits must be a positive number.');
  const maxHits = Math.min(requested, MAX_HITS_CAP);
  if (requested > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  const valuationPriceDisplay = raw.valuationPriceDisplay !== false;
  const displayZero = raw.displayZero === true;
  const calculatedAt = new Date().toISOString();
  const buckets = bucketLabels(ageBuckets);

  return withTenant(client, async (tx) => {
    const reachable = scope === 'unscoped' ? null : await reachablePlantsInTx(
      tx, client, await purchasingActor(tx, client, scope.authorization, [STOCK_AGEING_CAPABILITY], (m, r) => new StockAgeingError(m, r)),
    );
    for (const value of [materialFrom, materialTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`
        select 1 as hit from material where client = ${client} and material_number = ${value} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The material ${value} does not stand.`, 'Maintain the material before selecting it.');
    }
    for (const value of [plantFrom, plantTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`
        select 1 as hit from plant where client = ${client} and plant = ${value} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0 || (reachable && !reachable.includes(value))) fail(`The plant ${value} does not stand.`, 'Maintain the plant before selecting it.');
    }
    if (namedStockType) {
      const rows = await tx.execute(sql`
        select 1 as hit from stock_quantity where client = ${client} and stock_type = ${namedStockType} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The stock type ${namedStockType} does not stand.`, 'Choose a stock type the stock master carries.');
    }

    const range = (alias: string) => sql.join([
      materialFrom ? sql`and ${sql.raw(alias)}.material_number >= ${materialFrom}` : sql``,
      materialTo ? sql`and ${sql.raw(alias)}.material_number <= ${materialTo}` : sql``,
      plantFrom ? sql`and ${sql.raw(alias)}.plant >= ${plantFrom}` : sql``,
      plantTo ? sql`and ${sql.raw(alias)}.plant <= ${plantTo}` : sql``,
      reachable ? plantReachFilter(`${alias}.plant`, reachable) : sql``,
    ], sql` `);

    // 1. The population: what the stock record says is on hand, with master data and the MB52 valuation.
    const having = displayZero ? sql`` : sql`having sum(s.quantity) <> 0`;
    const stockRows = await tx.execute(sql`
      select s.material_number, s.plant, s.stock_type,
             coalesce(mat.description, '') as material_description,
             coalesce(mat.material_type, '') as material_type, mat.material_group,
             coalesce(mat.base_unit, '') as base_unit,
             sum(s.quantity) as quantity_on_hand,
             max(v.price_control) as price_control,
             max(case when v.price_control = 'STANDARD' then v.standard_price else v.moving_average_price end) as price,
             max(v.price_unit) as price_unit,
             max(v.currency) as currency
        from stock_quantity s
        left join material mat on mat.client = s.client and mat.material_number = s.material_number
        left join material_valuation v
          on v.client = s.client and v.material_number = s.material_number and v.valuation_area = s.plant
       where s.client = ${client} and s.stock_type = ${stockType} ${range('s')}
       group by s.material_number, s.plant, s.stock_type, mat.description, mat.material_type, mat.material_group, mat.base_unit
       ${having}
       order by s.material_number, s.plant
       limit ${maxHits + 1}
    `) as unknown as Array<Record<string, unknown>>;
    const truncated = stockRows.length > maxHits;
    const window = stockRows.slice(0, maxHits);

    // 2. The layers. A receipt is consumed oldest first; what survives of the receipt spanning
    // (r_before, r_after] of the cumulative receipts is the part above the total ever taken out.
    const bucketColumns = sql.join(buckets.map((bucket, i) => {
      const upper = bucket.upToDays;
      const when = i === 0
        ? sql`age <= ${upper}`
        : upper === null ? sql`age > ${ageBuckets[i - 1]!}` : sql`age > ${ageBuckets[i - 1]!} and age <= ${upper}`;
      return sql`sum(case when ${when} then qty else 0 end) as ${sql.raw(`b${i}`)}`;
    }), sql`, `);

    const layerRows = await tx.execute(sql`
      with ${linesCte(client, stockType, asOf, range('l'))},
      running as (
        select material_number, plant, stock_type, posting_date, qty,
               sum(greatest(qty, 0)) over (partition by material_number, plant, stock_type
                 order by posting_date, material_document_number, line_number
                 rows between unbounded preceding and current row) as r_after,
               sum(greatest(-qty, 0)) over (partition by material_number, plant, stock_type) as taken
          from lines
      ),
      surviving as (
        select material_number, plant, stock_type, posting_date,
               greatest(0, r_after - greatest(r_after - qty, taken)) as qty,
               (${asOf}::date - posting_date) as age
          from running
         where qty > 0
      )
      select material_number, plant, stock_type,
             sum(qty) as layered_qty,
             (min(posting_date) filter (where qty > 0))::text as oldest_layer_date,
             sum(qty * age) as age_days_qty,
             ${bucketColumns}
        from surviving
       group by material_number, plant, stock_type
    `) as unknown as Array<Record<string, unknown>>;
    const layers = new Map<string, Record<string, unknown>>();
    for (const r of layerRows) layers.set(`${r.material_number}|${r.plant}`, r);

    // 3. The movement dates, over the same `lines` CTE — one filter, not two.
    const dateRows = await tx.execute(sql`
      with ${linesCte(client, stockType, asOf, range('l'))}
      select material_number, plant,
             (max(posting_date) filter (where is_inbound))::text as last_receipt,
             (max(posting_date) filter (where not is_inbound))::text as last_issue
        from lines
       group by material_number, plant
    `) as unknown as Array<Record<string, unknown>>;
    const dates = new Map<string, { receipt: string | null; issue: string | null }>();
    for (const r of dateRows) {
      dates.set(`${r.material_number}|${r.plant}`, {
        receipt: r.last_receipt === null ? null : String(r.last_receipt),
        issue: r.last_issue === null ? null : String(r.last_issue),
      });
    }

    const span = await tx.execute(sql`
      select min(posting_date)::text as first_date from material_document
       where client = ${client} and status in ('POSTED', 'PARTIALLY_REVERSED')
    `) as unknown as Array<{ first_date: string | null }>;
    const firstDate = span[0]?.first_date ?? null;

    const unknownValuation: string[] = [];
    const foreignCurrency = new Set<string>();
    let valueTotal = 0;
    let driftCount = 0;
    const standing = new Set<string>();

    const rows: StockAgeingRow[] = window.map((r) => {
      const materialNumber = String(r.material_number);
      const plant = String(r.plant);
      const key = `${materialNumber}|${plant}`;
      standing.add(key);
      const quantityOnHand = num(r.quantity_on_hand);
      const layer = layers.get(key);
      const layeredQty = layer ? num(layer.layered_qty) : 0;
      const bucketQuantities = buckets.map((_, i) => (layer ? num(layer[`b${i}`]) : 0));
      const moved = dates.get(key);
      const lastReceiptDate = moved?.receipt ?? null;
      const lastIssueDate = moved?.issue ?? null;
      const daysSinceLastIssue = lastIssueDate ? daysBetween(lastIssueDate, asOf) : null;

      // Never issued: the clock runs from the last receipt, so old unsold stock is not "active".
      const sinceMovement = daysSinceLastIssue
        ?? (lastReceiptDate ? daysBetween(lastReceiptDate, asOf) : null);
      const movementClass: MovementClass = sinceMovement !== null && sinceMovement >= nonMovingDays
        ? 'NON_MOVING'
        : sinceMovement !== null && sinceMovement >= slowMovingDays ? 'SLOW_MOVING' : 'ACTIVE';

      const priceControl = r.price_control === null || r.price_control === undefined ? null : String(r.price_control);
      const priceUnit = r.price_unit === null || r.price_unit === undefined ? 1 : num(r.price_unit);
      const currency = r.currency === null || r.currency === undefined ? null : String(r.currency);
      let price: number | null = null;
      let value: number | null = null;
      if (priceControl === null) {
        if (!unknownValuation.includes(materialNumber)) unknownValuation.push(materialNumber);
      } else {
        price = num(r.price, 4);
        // Returns stock is counted, not valuated: movement 651 wrote no accounting document for it.
        const valuatedQty = stockType === RETURNS ? 0 : quantityOnHand;
        value = Number(((valuatedQty * price) / priceUnit).toFixed(2));
        valueTotal += value;
        if (currency && currency !== localCurrency) foreignCurrency.add(currency);
      }

      const difference = layeredQty - quantityOnHand;
      const drift = Math.abs(difference) > DRIFT_TOLERANCE ? Number(difference.toFixed(3)) : null;
      if (drift !== null) driftCount += 1;

      const pair = `materialFrom=${encodeURIComponent(materialNumber)}&materialTo=${encodeURIComponent(materialNumber)}`
        + `&plantFrom=${encodeURIComponent(plant)}&plantTo=${encodeURIComponent(plant)}`;
      return {
        materialNumber,
        materialDescription: String(r.material_description ?? ''),
        materialType: String(r.material_type ?? ''),
        materialGroup: r.material_group === null || r.material_group === undefined ? null : String(r.material_group),
        plant,
        stockType,
        baseUnit: String(r.base_unit ?? ''),
        quantityOnHand,
        bucketQuantities,
        oldestLayerDate: layer && layer.oldest_layer_date !== null ? String(layer.oldest_layer_date) : null,
        weightedAverageAgeDays: layeredQty > 0 ? Math.round(num(layer!.age_days_qty) / layeredQty) : null,
        lastReceiptDate,
        lastIssueDate,
        daysSinceLastIssue,
        movementClass,
        price: valuationPriceDisplay ? price : null,
        priceUnit,
        priceControl,
        currency: valuationPriceDisplay ? currency : null,
        value: valuationPriceDisplay ? value : null,
        drift,
        movementsDrillDown: `/inventory/material-document-list?${pair}&stockType=${encodeURIComponent(stockType)}`
          + (firstDate ? `&postingDateFrom=${firstDate}` : '') + `&postingDateTo=${asOf}`,
        stockDrillDown: `/inventory/stock-overview?material=${encodeURIComponent(materialNumber)}`
          + `&plantFrom=${encodeURIComponent(plant)}&plantTo=${encodeURIComponent(plant)}`,
      };
    });

    // Layers that survive where the stock record shows nothing (or sits outside the listed window).
    let layersWithoutStock = 0;
    if (!truncated) {
      for (const [key, layer] of layers) {
        if (!standing.has(key) && num(layer.layered_qty) > DRIFT_TOLERANCE) layersWithoutStock += 1;
      }
    }

    if (unknownValuation.length > 0) {
      warnings.push(
        `No valuation stands for ${unknownValuation.length} material(s): ${unknownValuation.slice(0, 8).join(', ')}`
        + (unknownValuation.length > 8 ? ', …' : '')
        + '. Their value is unknown, not zero; the footer total covers valued lines only.',
      );
    }
    if (foreignCurrency.size > 0) {
      warnings.push(
        `Some lines are valued in ${[...foreignCurrency].sort().join(', ')} rather than ${localCurrency}; `
        + 'no translation was applied at report time (entries appear as carried).',
      );
    }
    if (stockType === RETURNS) warnings.push('Returns stock is counted but not valuated; its value reads zero by rule, not by price.');
    if (truncated) warnings.push(`The list is truncated at ${maxHits} hits; narrow the selection for the complete list.`);
    if (driftCount > 0) {
      warnings.push(
        `The ledger and the stock record disagree for ${driftCount} material/plant combinations; `
        + 'run MB5L at /inventory/stock-reconcile before acting on their ages.',
      );
    }
    if (layersWithoutStock > 0) {
      warnings.push(
        `${layersWithoutStock} combinations carry ledger layers but no stock on hand; `
        + 'their ages were struck from documents the stock record no longer shows.',
      );
    }

    const byClass: Record<MovementClass, number> = { ACTIVE: 0, SLOW_MOVING: 0, NON_MOVING: 0 };
    for (const row of rows) byClass[row.movementClass] += 1;
    const valued = rows.filter((r) => r.priceControl !== null);
    const mixedCurrency = valued.some((r) => r.currency !== null && r.currency !== localCurrency)
      || foreignCurrency.size > 0;
    const totals = {
      quantityOnHand: Number(rows.reduce((sum, r) => sum + r.quantityOnHand, 0).toFixed(3)),
      bucketQuantities: buckets.map((_, i) => Number(rows.reduce((sum, r) => sum + r.bucketQuantities[i]!, 0).toFixed(3))),
      value: !valuationPriceDisplay || valued.length === 0 || mixedCurrency ? null : Number(valueTotal.toFixed(2)),
      byClass,
    };

    return {
      capability: STOCK_AGEING_CAPABILITY,
      selection: {
        materialFrom, materialTo, plantFrom, plantTo, stockType, asOf, ageBuckets,
        slowMovingDays, nonMovingDays, displayZero, valuationPriceDisplay, maxHits,
      },
      buckets,
      slowMovingDays,
      nonMovingDays,
      rows,
      rowCount: rows.length,
      truncated,
      maxHits,
      totals,
      warnings,
      calculatedAt,
    };
  });
}
