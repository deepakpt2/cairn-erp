/**
 * List of warehouse stocks on hand — SCR-127 / INV.STOCK.WAREHOUSE (MB52).
 *
 * The snapshot, not the ledger: every stock record is read as it stands, pivoted
 * on stock type into unrestricted, quality inspection, blocked and a fourth
 * "special / other" column, and valued at the plant's valuation price. Total
 * quantity covers every stock type shown, so the columns always add up.
 *
 * A material with no valuation record shows an unknown value and is named in a
 * warning — never zero, which would assert worthlessness. A valuation currency
 * that differs from the client currency is carried as is, with the currency on
 * the line, and the run says no translation was applied.
 *
 * Read-only: this module issues no insert, update or delete.
 *
 * A named batch splits the row and filters this list. The list does not create
 * a batch. Valuation type is deferred by name (no valuation type on the stock
 * record). Refused by name: SAP's one-character special stock indicator, which
 * Cairn replaces with a named stock type.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';

export const WAREHOUSE_STOCK_CAPABILITY = 'INV.STOCK.WAREHOUSE';
export const WAREHOUSE_STOCK_ALIAS = 'MB52';

export const UNRESTRICTED = 'UNRESTRICTED';
// The stock type column is varchar(16): the canonical value is QUALITY, displayed as quality inspection.
export const QUALITY_INSPECTION = 'QUALITY';
export const BLOCKED = 'BLOCKED';

export const SCOPE_OF_LIST_OPTIONS = ['ALV', 'STANDARD'] as const;
export type ScopeOfList = (typeof SCOPE_OF_LIST_OPTIONS)[number];

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;

export interface WarehouseStockSelection {
  scopeOfList?: string;
  materialFrom?: string;
  materialTo?: string;
  plantFrom?: string;
  plantTo?: string;
  storageLocationFrom?: string;
  storageLocationTo?: string;
  stockType?: string;
  specialStockIndicator?: string;
  valuationType?: string;
  batch?: string;
  displayZero?: boolean;
  valuationPriceDisplay?: boolean;
  maxHits?: number;
}

export interface WarehouseStockRow {
  materialNumber: string;
  materialDescription: string;
  plant: string;
  storageLocation: string;
  batch: string;
  baseUnit: string;
  unrestrictedQuantity: number;
  qualityInspectionQuantity: number;
  blockedQuantity: number;
  specialQuantity: number;
  totalQuantity: number;
  /** null where no valuation record stands — unknown, never zero. */
  price: number | null;
  priceUnit: number;
  priceControl: string | null;
  currency: string | null;
  /** null where the valuation is unknown. */
  value: number | null;
  movementsDrillDown: string | null;
  rollforwardDrillDown: string | null;
}

export interface WarehouseStockResult {
  capability: string;
  selection: WarehouseStockSelection;
  scopeOfList: ScopeOfList;
  valuationPriceDisplay: boolean;
  rows: WarehouseStockRow[];
  rowCount: number;
  truncated: boolean;
  maxHits: number;
  totals: {
    unrestrictedQuantity: number;
    qualityInspectionQuantity: number;
    blockedQuantity: number;
    specialQuantity: number;
    totalQuantity: number;
    value: number | null;
  };
  warnings: string[];
  calculatedAt: string;
}

export class WarehouseStockError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'WarehouseStockError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new WarehouseStockError(message, remedy);
}

function bound(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

export async function listWarehouseStocks(input: {
  client: string;
  localCurrency: string;
  selection: WarehouseStockSelection;
}): Promise<WarehouseStockResult> {
  const { client, localCurrency } = input;
  const raw = input.selection;
  const s: WarehouseStockSelection = {
    scopeOfList: bound(raw.scopeOfList) ?? 'ALV',
    materialFrom: bound(raw.materialFrom),
    materialTo: bound(raw.materialTo),
    plantFrom: bound(raw.plantFrom),
    plantTo: bound(raw.plantTo),
    storageLocationFrom: bound(raw.storageLocationFrom),
    storageLocationTo: bound(raw.storageLocationTo),
    stockType: bound(raw.stockType),
    specialStockIndicator: bound(raw.specialStockIndicator),
    valuationType: bound(raw.valuationType),
    batch: bound(raw.batch),
    displayZero: raw.displayZero === true,
    valuationPriceDisplay: raw.valuationPriceDisplay !== false,
    maxHits: raw.maxHits,
  };

  const scope = String(s.scopeOfList).toUpperCase();
  if (!SCOPE_OF_LIST_OPTIONS.includes(scope as ScopeOfList)) {
    fail(
      `The scope of list ${s.scopeOfList} does not stand.`,
      `Choose ${SCOPE_OF_LIST_OPTIONS.join(' or ')}.`,
    );
  }
  if (s.specialStockIndicator) {
    fail(
      `The special stock indicator ${s.specialStockIndicator} does not stand.`,
      'Cairn records special stock as a named stock type, not a one-character indicator — filter on the stock type instead.',
    );
  }
  if (s.valuationType) {
    fail(
      `Valuation type ${s.valuationType} is not maintained.`,
      'Valuation type is deferred: this canon carries no valuation type on the stock record.',
    );
  }

  if (s.materialFrom && s.materialTo && s.materialTo < s.materialFrom) fail('The material range is inverted.', 'The lower bound must not exceed the upper bound.');
  if (s.plantFrom && s.plantTo && s.plantTo < s.plantFrom) fail('The plant range is inverted.', 'The lower bound must not exceed the upper bound.');
  if (s.storageLocationFrom && s.storageLocationTo && s.storageLocationTo < s.storageLocationFrom) {
    fail('The storage location range is inverted.', 'The lower bound must not exceed the upper bound.');
  }

  const warnings: string[] = [];
  const requested = s.maxHits ?? DEFAULT_MAX_HITS;
  if (!Number.isInteger(requested) || requested < 1) fail('Maximum hits must be a positive number.');
  const maxHits = Math.min(requested, MAX_HITS_CAP);
  if (requested > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  if (scope === 'STANDARD') {
    warnings.push('The scope of list STANDARD is presented as a flat list; totals are shown in the grid footer.');
  }
  const calculatedAt = new Date().toISOString();

  return withTenant(client, async (tx) => {
    for (const value of [s.materialFrom, s.materialTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`
        select 1 as hit from material where client = ${client} and material_number = ${value} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The material ${value} does not stand.`, 'Maintain the material before selecting it.');
    }
    for (const value of [s.plantFrom, s.plantTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`
        select 1 as hit from plant where client = ${client} and plant = ${value} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The plant ${value} does not stand.`, 'Maintain the plant before selecting it.');
    }
    for (const value of [s.storageLocationFrom, s.storageLocationTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`
        select 1 as hit from storage_location where client = ${client} and storage_location = ${value} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The storage location ${value} does not stand.`, 'Maintain the storage location before selecting it.');
    }
    if (s.stockType) {
      const rows = await tx.execute(sql`
        select 1 as hit from stock_quantity where client = ${client} and stock_type = ${s.stockType!} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The stock type ${s.stockType} does not stand.`, 'Choose a stock type the stock master carries.');
    }
    if (s.batch) {
      const typed = s.batch.trim().toUpperCase();
      s.batch = typed;
      const singleMaterial = Boolean(s.materialFrom) && (!s.materialTo || s.materialTo === s.materialFrom);
      const singlePlant = Boolean(s.plantFrom) && (!s.plantTo || s.plantTo === s.plantFrom);
      if (singleMaterial && singlePlant) {
        try {
          s.batch = await resolvePostingBatch(tx, {
            client, materialNumber: s.materialFrom!, plant: s.plantFrom!, batch: typed,
          });
        } catch (caught) {
          if (caught instanceof BatchPostingError) fail(caught.message.replace(' No stock was posted.', ''), caught.remedy);
          throw caught;
        }
      } else {
        const standing = await tx.execute(sql`
          select 1 as hit from batch where client = ${client} and batch_number = ${typed} limit 1
        `) as unknown as Array<{ hit: number }>;
        if (standing.length === 0) {
          fail(`Batch ${typed} does not stand.`, 'Create the batch in MSC1N first. This list does not create a batch.');
        }
      }
    }

    const filters = [
      s.materialFrom ? sql`and s.material_number >= ${s.materialFrom}` : sql``,
      s.materialTo ? sql`and s.material_number <= ${s.materialTo}` : sql``,
      s.plantFrom ? sql`and s.plant >= ${s.plantFrom}` : sql``,
      s.plantTo ? sql`and s.plant <= ${s.plantTo}` : sql``,
      s.storageLocationFrom ? sql`and s.storage_location >= ${s.storageLocationFrom}` : sql``,
      s.storageLocationTo ? sql`and s.storage_location <= ${s.storageLocationTo}` : sql``,
      s.stockType ? sql`and s.stock_type = ${s.stockType}` : sql``,
      s.batch ? sql`and s.batch_number = ${s.batch}` : sql``,
    ];
    const where = sql.join(filters, sql` `);
    const having = s.displayZero ? sql`` : sql`having sum(s.quantity) <> 0`;

    const rows = await tx.execute(sql`
      select s.material_number, coalesce(mat.description, '') as material_description,
             s.plant, s.storage_location, s.batch_number, coalesce(mat.base_unit, '') as base_unit,
             sum(case when s.stock_type = ${UNRESTRICTED} then s.quantity else 0 end) as unrestricted_qty,
             sum(case when s.stock_type = ${QUALITY_INSPECTION} then s.quantity else 0 end) as quality_qty,
             sum(case when s.stock_type = ${BLOCKED} then s.quantity else 0 end) as blocked_qty,
             sum(case when s.stock_type not in (${UNRESTRICTED}, ${QUALITY_INSPECTION}, ${BLOCKED}) then s.quantity else 0 end) as special_qty,
             sum(s.quantity) as total_qty,
             max(v.price_control) as price_control,
             max(case when v.price_control = 'STANDARD' then v.standard_price else v.moving_average_price end) as price,
             max(v.price_unit) as price_unit,
             max(v.currency) as currency
      from stock_quantity s
      left join material mat on mat.client = s.client and mat.material_number = s.material_number
      left join material_valuation v
        on v.client = s.client and v.material_number = s.material_number and v.valuation_area = s.plant
      where s.client = ${client} ${where}
      group by s.material_number, mat.description, s.plant, s.storage_location, s.batch_number, mat.base_unit
      ${having}
      order by s.material_number, s.plant, s.storage_location, s.batch_number
      limit ${maxHits + 1}
    `) as unknown as Array<Record<string, unknown>>;

    const truncated = rows.length > maxHits;
    const window = rows.slice(0, maxHits);
    const num = (value: unknown, scale = 3) => (value === null || value === undefined
      ? 0
      : Number(fromScaled(toScaled(String(value), scale), scale)));

    // The drill window is the client's whole recorded ledger: earliest to latest posting.
    const span = await tx.execute(sql`
      select min(posting_date)::text as first_date, max(posting_date)::text as last_date
      from material_document where client = ${client} and status = 'POSTED'
    `) as unknown as Array<{ first_date: string | null; last_date: string | null }>;
    const firstDate = span[0]?.first_date ?? null;
    const lastDate = span[0]?.last_date ?? null;

    const unknownValuation: string[] = [];
    const foreignCurrency = new Map<string, number>();
    let valueTotal = 0;
    let valuationKnown = true;

    const out: WarehouseStockRow[] = window.map((r) => {
      const materialNumber = String(r.material_number);
      const plant = String(r.plant ?? '');
      const storageLocation = String(r.storage_location ?? '');
      const batch = String(r.batch_number ?? '');
      const totalQuantity = num(r.total_qty);
      const priceControl = r.price_control === null || r.price_control === undefined ? null : String(r.price_control);
      const priceUnit = r.price_unit === null || r.price_unit === undefined ? 1 : num(r.price_unit);
      const currency = r.currency === null || r.currency === undefined ? null : String(r.currency);
      let price: number | null = null;
      let value: number | null = null;

      if (priceControl === null) {
        valuationKnown = false;
        if (!unknownValuation.includes(materialNumber)) unknownValuation.push(materialNumber);
      } else {
        price = num(r.price, 4);
        value = Number(((totalQuantity * price) / priceUnit).toFixed(2));
        valueTotal += value;
        if (currency && currency !== localCurrency) {
          foreignCurrency.set(currency, (foreignCurrency.get(currency) ?? 0) + 1);
        }
      }

      // Both drills take the same material, plant and storage location; the ledger
      // list wants posting dates, the rollforward wants a reporting window.
      const drill = (base: string) => (firstDate && lastDate
        ? `${base}?materialFrom=${encodeURIComponent(materialNumber)}&materialTo=${encodeURIComponent(materialNumber)}`
          + `&plantFrom=${encodeURIComponent(plant)}&plantTo=${encodeURIComponent(plant)}`
          + `&storageLocationFrom=${encodeURIComponent(storageLocation)}&storageLocationTo=${encodeURIComponent(storageLocation)}`
          + (base.includes('stock-on-posting-date')
            ? `&dateFrom=${firstDate}&dateTo=${lastDate}`
            : `&postingDateFrom=${firstDate}&postingDateTo=${lastDate}`)
          + (batch ? `&batch=${encodeURIComponent(batch)}` : '')
        : null);

      return {
        materialNumber,
        materialDescription: String(r.material_description ?? ''),
        plant,
        storageLocation,
        batch,
        baseUnit: String(r.base_unit ?? ''),
        unrestrictedQuantity: num(r.unrestricted_qty),
        qualityInspectionQuantity: num(r.quality_qty),
        blockedQuantity: num(r.blocked_qty),
        specialQuantity: num(r.special_qty),
        totalQuantity,
        price,
        priceUnit,
        priceControl,
        currency: s.valuationPriceDisplay ? currency : null,
        value: s.valuationPriceDisplay ? value : null,
        movementsDrillDown: drill('/inventory/material-document-list'),
        rollforwardDrillDown: drill('/inventory/stock-on-posting-date'),
      };
    });

    if (unknownValuation.length > 0) {
      warnings.push(
        `No valuation stands for ${unknownValuation.length} material(s): ${unknownValuation.slice(0, 8).join(', ')}`
        + (unknownValuation.length > 8 ? ', …' : '')
        + '. Their value is unknown, not zero; the footer total covers valued lines only.',
      );
    }
    if (foreignCurrency.size > 0) {
      warnings.push(
        `Some lines are valued in ${[...foreignCurrency.keys()].sort().join(', ')} rather than ${localCurrency}; `
        + 'no translation was applied at report time (entries appear as carried).',
      );
    }
    if (truncated) warnings.push(`The list is truncated at ${maxHits} hits; narrow the selection for the complete list.`);
    if (!firstDate || !lastDate) {
      warnings.push('No posted movement stands, so the rows carry no drill into movements.');
    }

    const totals = {
      unrestrictedQuantity: out.reduce((sum, r) => sum + r.unrestrictedQuantity, 0),
      qualityInspectionQuantity: out.reduce((sum, r) => sum + r.qualityInspectionQuantity, 0),
      blockedQuantity: out.reduce((sum, r) => sum + r.blockedQuantity, 0),
      specialQuantity: out.reduce((sum, r) => sum + r.specialQuantity, 0),
      totalQuantity: out.reduce((sum, r) => sum + r.totalQuantity, 0),
      value: valuationKnown || out.some((r) => r.value !== null) ? Number(valueTotal.toFixed(2)) : null,
    };

    return {
      capability: WAREHOUSE_STOCK_CAPABILITY,
      selection: s,
      scopeOfList: scope as ScopeOfList,
      valuationPriceDisplay: s.valuationPriceDisplay === true,
      rows: s.valuationPriceDisplay ? out : out.map((r) => ({ ...r, price: null, value: null })),
      rowCount: out.length,
      truncated,
      maxHits,
      totals,
      warnings,
      calculatedAt,
    };
  });
}
