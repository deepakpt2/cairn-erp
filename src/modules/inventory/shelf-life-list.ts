/**
 * Shelf life list — INV.SLED.LIST (MB5M), program RM07MMHD.
 *
 * Read-only. The quantity is unrestricted stock as it stands. It is not the
 * sum of material documents. Quality inspection and blocked stock are not
 * the list quantity: the standard view column is LABST.
 *
 * Total remaining life is the stored expiration date less the key date.
 * Warehouse remaining life is that date less the storage percentage of the
 * minimum remaining shelf life. The report does not invent a missing date
 * and does not write a batch, a stock row, or a material document.
 *
 * A blank remaining-shelf-life field lists batches already expired. A number
 * of days lists batches whose remaining life is at most that many days.
 * The key date is the business date. It is not an expiration-date range.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';

export const SLED_LIST_CAPABILITY = 'INV.SLED.LIST';
export const SLED_LIST_ALIAS = 'MB5M';
export const SLED_LIST_ROUTE = '/inventory/shelf-life-list';

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;

export type ShelfLifeScope = 'TOTAL' | 'WAREHOUSE';
export type ShelfLifeDisplay = 'DAYS' | 'PERIOD';
export type ShelfLifeLayout = 'ALV' | 'LIST';

export interface ShelfLifeSelection {
  materialFrom?: string;
  materialTo?: string;
  plantFrom?: string;
  plantTo?: string;
  storageLocationFrom?: string;
  storageLocationTo?: string;
  batchFrom?: string;
  batchTo?: string;
  /** Blank lists expired batches only. A number lists remaining life of at most that many days. */
  remainingShelfLifeDays?: number | null;
  scope?: string;
  includeZeroStock?: boolean;
  display?: string;
  layout?: string;
  layoutVariant?: string;
  keyDate?: string;
  maxHits?: number;
  salesOrder?: string;
  delivery?: string;
  billingDocument?: string;
  schedulingAgreement?: string;
  specialStockIndicator?: string;
}

export interface ShelfLifeRow {
  materialNumber: string;
  materialDescription: string;
  plant: string;
  storageLocation: string;
  batch: string;
  manufactureDate: string | null;
  expirationDate: string | null;
  comparedExpiration: string;
  remainingDays: number;
  displayRemaining: string;
  classification: 'EXPIRED' | 'EXPIRES_ON_KEY_DATE' | 'NOT_YET_EXPIRING';
  unrestrictedQuantity: string;
  baseUnit: string;
  periodIndicator: string | null;
  storagePercentage: number | null;
  minimumRemainingShelfLife: number | null;
  totalShelfLife: number | null;
  latestDocument: string | null;
  materialHref: string;
  batchHref: string;
  stockHref: string;
  documentHref: string | null;
  pickupHref: string;
}

export interface ShelfLifeUndetermined {
  materialNumber: string;
  plant: string;
  storageLocation: string;
  batch: string;
  unrestrictedQuantity: string;
  reason: string;
}

export interface ShelfLifeResult {
  capability: string;
  readOnly: true;
  scope: ShelfLifeScope;
  display: ShelfLifeDisplay;
  layout: ShelfLifeLayout;
  keyDate: string;
  remainingShelfLifeDays: number | null;
  includeZeroStock: boolean;
  rows: ShelfLifeRow[];
  undetermined: ShelfLifeUndetermined[];
  truncated: boolean;
  undeterminedTruncated: boolean;
  maxHits: number;
  warnings: string[];
}

export class ShelfLifeListError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'ShelfLifeListError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy: string): never {
  throw new ShelfLifeListError(message, remedy);
}

function bound(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim().toUpperCase();
  return trimmed === '' ? undefined : trimmed;
}

export function businessDate(timeZone = 'Asia/Kuwait', now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: 'numeric',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) fail('The business date could not be read.', 'Run the list again.');
  return `${year}-${month}-${day}`;
}

function parseDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail(`${label} ${value || '(empty)'} is not a date.`, 'Use YYYY-MM-DD.');
  }
  return value;
}

function dayDiff(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function addMonths(iso: string, months: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const clamped = Math.min(day, last);
  const result = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), clamped));
  return result.toISOString().slice(0, 10);
}

function periodText(remainingDays: number, indicator: string | null, from: string, to: string): string {
  const code = indicator === '1' || indicator === '2' || indicator === '3' ? indicator : ' ';
  if (code === ' ') return `${remainingDays} days`;
  if (code === '1') {
    const weeks = Math.trunc(remainingDays / 7);
    const leftover = remainingDays - weeks * 7;
    return leftover === 0 ? `${weeks} weeks` : `${weeks} weeks ${leftover} days`;
  }
  const earlier = remainingDays >= 0 ? from : to;
  const later = remainingDays >= 0 ? to : from;
  const sign = remainingDays >= 0 ? 1 : -1;
  let periods = 0;
  if (code === '3') {
    while (addMonths(earlier, (periods + 1) * 12) <= later) periods += 1;
    const base = addMonths(earlier, periods * 12);
    const leftover = dayDiff(base, later);
    const years = sign * periods;
    return leftover === 0 ? `${years} years` : `${years} years ${sign * leftover} days`;
  }
  while (addMonths(earlier, periods + 1) <= later) periods += 1;
  const base = addMonths(earlier, periods);
  const leftover = dayDiff(base, later);
  const months = sign * periods;
  return leftover === 0 ? `${months} months` : `${months} months ${sign * leftover} days`;
}

interface RawRow {
  material_number: string;
  material_description: string;
  plant: string;
  storage_location: string;
  batch_number: string;
  manufacture_date: string | null;
  expiration_date: string | null;
  compared_expiration: string | null;
  remaining_days: number | null;
  unrestricted_qty: string;
  base_unit: string;
  period_indicator: string | null;
  storage_percentage: number | null;
  min_remaining_shelf_life: number | null;
  total_shelf_life: number | null;
  latest_document: string | null;
  undetermined_reason: string | null;
}

export async function listShelfLife(input: {
  client: string;
  selection?: ShelfLifeSelection;
  timeZone?: string;
}): Promise<ShelfLifeResult> {
  const raw = input.selection ?? {};
  if (bound(raw.salesOrder)) fail('A sales order is not on this list.', 'Select a material, a plant, or a batch.');
  if (bound(raw.delivery)) fail('A delivery is not on this list.', 'Select a material, a plant, or a batch.');
  if (bound(raw.billingDocument)) fail('A billing document is not on this list.', 'Select a material, a plant, or a batch.');
  if (bound(raw.schedulingAgreement)) fail('A scheduling agreement is not on this list.', 'Select a material, a plant, or a batch.');
  if (bound(raw.specialStockIndicator)) {
    fail('A special stock indicator is not on this list.', 'The quantity is unrestricted stock. Quality and blocked stock are not this column.');
  }
  if (raw.layoutVariant?.trim()) {
    fail('A saved layout is not stored.', 'Leave the layout variant empty. This list does not keep an ALV variant.');
  }
  const scope = (raw.scope ?? 'TOTAL').trim().toUpperCase();
  if (scope !== 'TOTAL' && scope !== 'WAREHOUSE') {
    fail(`Shelf-life scope ${raw.scope} does not stand.`, 'Choose total remaining shelf life or warehouse remaining shelf life.');
  }
  const display = (raw.display ?? 'DAYS').trim().toUpperCase();
  if (display !== 'DAYS' && display !== 'PERIOD') {
    fail(`Remaining-shelf-life display ${raw.display} does not stand.`, 'Choose days or period.');
  }
  const layout = (raw.layout ?? 'ALV').trim().toUpperCase();
  if (layout !== 'ALV' && layout !== 'LIST') {
    fail(`Layout ${raw.layout} does not stand.`, 'Choose ALV or list. A saved variant is not stored.');
  }
  let remaining: number | null = null;
  if (raw.remainingShelfLifeDays !== null && raw.remainingShelfLifeDays !== undefined && String(raw.remainingShelfLifeDays) !== '') {
    remaining = Number(raw.remainingShelfLifeDays);
    if (!Number.isInteger(remaining) || remaining < 0 || remaining > 9999) {
      fail('Remaining shelf life must be a whole number of days from 0 to 9999.', 'Leave it empty to list expired batches only.');
    }
  }
  const keyDate = parseDate(raw.keyDate?.trim() || businessDate(input.timeZone), 'Key date');
  const materialFrom = bound(raw.materialFrom);
  const materialTo = bound(raw.materialTo);
  const plantFrom = bound(raw.plantFrom);
  const plantTo = bound(raw.plantTo);
  const locationFrom = bound(raw.storageLocationFrom);
  const locationTo = bound(raw.storageLocationTo);
  const batchFrom = bound(raw.batchFrom);
  const batchTo = bound(raw.batchTo);
  if (materialFrom && materialTo && materialTo < materialFrom) fail('The material range is inverted.', 'The lower bound must not exceed the upper bound.');
  if (plantFrom && plantTo && plantTo < plantFrom) fail('The plant range is inverted.', 'The lower bound must not exceed the upper bound.');
  if (locationFrom && locationTo && locationTo < locationFrom) fail('The storage location range is inverted.', 'The lower bound must not exceed the upper bound.');
  if (batchFrom && batchTo && batchTo < batchFrom) fail('The batch range is inverted.', 'The lower bound must not exceed the upper bound.');
  const requested = raw.maxHits ?? DEFAULT_MAX_HITS;
  if (!Number.isInteger(requested) || requested < 1) fail('Maximum hits must be a positive number.', 'Use a hit count from 1 to 5000.');
  const maxHits = Math.min(requested, MAX_HITS_CAP);
  const warnings: string[] = [];
  if (requested > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  if (layout === 'LIST') warnings.push('The list layout shows the same rows as the grid. A saved variant is not stored.');
  if (scope === 'WAREHOUSE') {
    warnings.push('Warehouse remaining life is the expiration date less the storage percentage of the minimum remaining shelf life. It is not total remaining life.');
  }
  warnings.push('Quality inspection and blocked stock are not the list quantity. The column is unrestricted stock.');
  warnings.push('A goods movement does not calculate this date. The stored batch date is read as it stands.');

  return withTenant(input.client, async (tx) => {
    for (const value of [materialFrom, materialTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`select 1 as hit from material where client = ${input.client} and material_number = ${value} limit 1`) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The material ${value} does not stand.`, 'Maintain the material before selecting it.');
    }
    for (const value of [plantFrom, plantTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`select 1 as hit from plant where client = ${input.client} and plant = ${value} limit 1`) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The plant ${value} does not stand.`, 'Maintain the plant before selecting it.');
    }
    for (const value of [locationFrom, locationTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`select 1 as hit from storage_location where client = ${input.client} and storage_location = ${value} limit 1`) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The storage location ${value} does not stand.`, 'Maintain the storage location before selecting it.');
    }
    if (batchFrom && (!batchTo || batchTo === batchFrom)) {
      const rows = await tx.execute(sql`select 1 as hit from batch where client = ${input.client} and batch_number = ${batchFrom} limit 1`) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`Batch ${batchFrom} does not stand.`, 'Create the batch in MSC1N first. This list does not create a batch.');
    }

    const filters = [
      materialFrom ? sql`and s.material_number >= ${materialFrom}` : sql``,
      materialTo ? sql`and s.material_number <= ${materialTo}` : sql``,
      plantFrom ? sql`and s.plant >= ${plantFrom}` : sql``,
      plantTo ? sql`and s.plant <= ${plantTo}` : sql``,
      locationFrom ? sql`and s.storage_location >= ${locationFrom}` : sql``,
      locationTo ? sql`and s.storage_location <= ${locationTo}` : sql``,
      batchFrom ? sql`and s.batch_number >= ${batchFrom}` : sql``,
      batchTo ? sql`and s.batch_number <= ${batchTo}` : sql``,
    ];
    const where = sql.join(filters, sql` `);
    const zeroStock = raw.includeZeroStock === true ? sql`` : sql`and s.unrestricted_qty <> 0`;
    const zeroJoined = raw.includeZeroStock === true ? sql`` : sql`and q.unrestricted_qty::numeric <> 0`;
    const threshold = remaining === null
      ? sql`q.compared_expiration::date < ${keyDate}::date`
      : sql`q.compared_expiration::date <= (${keyDate}::date + ${remaining}::int)`;
    const warehouseDate = sql`
      case
        when m.storage_percentage is null or m.min_remaining_shelf_life is null or b.shelf_life_expiration_date is null then null
        when coalesce(m.sled_period_indicator, ' ') = '1'
          then b.shelf_life_expiration_date - (((m.min_remaining_shelf_life * m.storage_percentage) / 100) * 7)
        when m.sled_period_indicator = '2'
          then (b.shelf_life_expiration_date - make_interval(months => ((m.min_remaining_shelf_life * m.storage_percentage) / 100)))::date
        when m.sled_period_indicator = '3'
          then (b.shelf_life_expiration_date - make_interval(years => ((m.min_remaining_shelf_life * m.storage_percentage) / 100)))::date
        else b.shelf_life_expiration_date - ((m.min_remaining_shelf_life * m.storage_percentage) / 100)
      end
    `;
    const compared = scope === 'WAREHOUSE' ? warehouseDate : sql`b.shelf_life_expiration_date`;
    const reason = scope === 'WAREHOUSE'
      ? sql`case
          when b.shelf_life_expiration_date is null then 'The shelf-life expiration date is not stored. No date was invented.'
          when m.storage_percentage is null then 'A storage percentage is not stored. Warehouse remaining life was not calculated.'
          when m.min_remaining_shelf_life is null then 'Minimum remaining shelf life is not stored. Warehouse remaining life was not calculated.'
          else 'Warehouse remaining life could not be calculated.'
        end`
      : sql`'The shelf-life expiration date is not stored. No date was invented.'`;

    const listed = await tx.execute(sql`
      with stock as (
        select material_number, plant, storage_location, batch_number, sum(quantity) as unrestricted_qty
          from stock_quantity
         where client = ${input.client}
           and stock_type = 'UNRESTRICTED'
           and batch_number <> ''
         group by material_number, plant, storage_location, batch_number
      ),
      joined as (
        select s.material_number,
               coalesce(m.description, '') as material_description,
               s.plant,
               s.storage_location,
               s.batch_number,
               b.manufacture_date::text as manufacture_date,
               b.shelf_life_expiration_date::text as expiration_date,
               (${compared})::text as compared_expiration,
               s.unrestricted_qty::text as unrestricted_qty,
               coalesce(m.base_unit, '') as base_unit,
               m.sled_period_indicator as period_indicator,
               m.storage_percentage,
               m.min_remaining_shelf_life,
               m.total_shelf_life,
               (
                 select l.material_document_number
                   from material_document_line l
                  where l.client = ${input.client}
                    and l.material_number = s.material_number
                    and l.plant = s.plant
                    and l.batch_number = s.batch_number
                  order by l.material_document_number desc
                  limit 1
               ) as latest_document
          from stock s
          left join material m
            on m.client = ${input.client} and m.material_number = s.material_number
          left join lateral (
            select manufacture_date, shelf_life_expiration_date
              from batch b
             where b.client = ${input.client}
               and b.material_number = s.material_number
               and b.batch_number = s.batch_number
               and (
                 (b.batch_level_at_creation = '0' and b.plant = s.plant)
                 or (b.batch_level_at_creation <> '0' and b.plant is null)
               )
             order by case when b.plant = s.plant then 0 else 1 end
             limit 1
          ) b on true
         where true ${where}
      )
      select q.*, (q.compared_expiration::date - ${keyDate}::date) as remaining_days, null::text as undetermined_reason
        from joined q
       where q.compared_expiration is not null
         and ${threshold}
         ${zeroJoined}
       order by q.material_number, q.plant, q.storage_location, q.batch_number
       limit ${maxHits + 1}
    `) as unknown as RawRow[];

    const missing = await tx.execute(sql`
      with stock as (
        select material_number, plant, storage_location, batch_number, sum(quantity) as unrestricted_qty
          from stock_quantity
         where client = ${input.client}
           and stock_type = 'UNRESTRICTED'
           and batch_number <> ''
         group by material_number, plant, storage_location, batch_number
      )
      select s.material_number, '' as material_description, s.plant, s.storage_location, s.batch_number,
             null::text as manufacture_date, b.shelf_life_expiration_date::text as expiration_date,
             null::text as compared_expiration, null::int as remaining_days,
             s.unrestricted_qty::text as unrestricted_qty, '' as base_unit,
             null::text as period_indicator, m.storage_percentage, m.min_remaining_shelf_life, m.total_shelf_life,
             null::text as latest_document,
             ${reason} as undetermined_reason
        from stock s
        left join material m on m.client = ${input.client} and m.material_number = s.material_number
        left join lateral (
          select shelf_life_expiration_date
            from batch b
           where b.client = ${input.client}
             and b.material_number = s.material_number
             and b.batch_number = s.batch_number
             and (
               (b.batch_level_at_creation = '0' and b.plant = s.plant)
               or (b.batch_level_at_creation <> '0' and b.plant is null)
             )
           order by case when b.plant = s.plant then 0 else 1 end
           limit 1
        ) b on true
       where true ${where}
         ${zeroStock}
         and (${compared}) is null
       order by s.material_number, s.plant, s.storage_location, s.batch_number
       limit ${maxHits + 1}
    `) as unknown as RawRow[];

    const truncated = listed.length > maxHits;
    const undeterminedTruncated = missing.length > maxHits;
    const rows = listed.slice(0, maxHits).map((row): ShelfLifeRow => {
      const remainingDays = Number(row.remaining_days);
      const classification = remainingDays < 0
        ? 'EXPIRED'
        : remainingDays === 0
          ? 'EXPIRES_ON_KEY_DATE'
          : 'NOT_YET_EXPIRING';
      const plantQuery = row.plant ? `&plant=${encodeURIComponent(row.plant)}` : '';
      return {
        materialNumber: row.material_number,
        materialDescription: row.material_description,
        plant: row.plant,
        storageLocation: row.storage_location,
        batch: row.batch_number,
        manufactureDate: row.manufacture_date,
        expirationDate: row.expiration_date,
        comparedExpiration: row.compared_expiration ?? '',
        remainingDays,
        displayRemaining: display === 'DAYS'
          ? `${remainingDays} days`
          : periodText(remainingDays, row.period_indicator, keyDate, row.compared_expiration ?? keyDate),
        classification,
        unrestrictedQuantity: row.unrestricted_qty,
        baseUnit: row.base_unit,
        periodIndicator: row.period_indicator,
        storagePercentage: row.storage_percentage,
        minimumRemainingShelfLife: row.min_remaining_shelf_life,
        totalShelfLife: row.total_shelf_life,
        latestDocument: row.latest_document,
        materialHref: `/inventory/materials?material=${encodeURIComponent(row.material_number)}`,
        batchHref: `/inventory/batches/display?material=${encodeURIComponent(row.material_number)}&batch=${encodeURIComponent(row.batch_number)}${plantQuery}`,
        stockHref: `/inventory/stock-overview?material=${encodeURIComponent(row.material_number)}`,
        documentHref: row.latest_document
          ? `/inventory/material-documents?document=${encodeURIComponent(row.latest_document)}`
          : null,
        pickupHref: `/inventory/batch-pickup?material=${encodeURIComponent(row.material_number)}&plant=${encodeURIComponent(row.plant)}&batch=${encodeURIComponent(row.batch_number)}`,
      };
    });
    return {
      capability: SLED_LIST_CAPABILITY,
      readOnly: true,
      scope,
      display,
      layout,
      keyDate,
      remainingShelfLifeDays: remaining,
      includeZeroStock: raw.includeZeroStock === true,
      rows,
      undetermined: missing.slice(0, maxHits).map((row) => ({
        materialNumber: row.material_number,
        plant: row.plant,
        storageLocation: row.storage_location,
        batch: row.batch_number,
        unrestrictedQuantity: row.unrestricted_qty,
        reason: row.undetermined_reason ?? 'The date could not be determined.',
      })),
      truncated,
      undeterminedTruncated,
      maxHits,
      warnings,
    };
  });
}
