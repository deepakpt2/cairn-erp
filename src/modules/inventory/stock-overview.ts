/**
 * Stock overview — SCR-128 / INV.STOCK.VIEW (MMBE).
 *
 * A tree, not a grid: plant → storage location → stock type, with every parent
 * total folded from the children it shows. The whole tree is read once and the
 * roll-ups are arithmetic on those same rows, so a parent can never disagree
 * with its own children.
 *
 * Quantitative on purpose: MMBE answers *where* stock stands. Value stays in
 * MB52, which every node can reach in one click alongside MB51 and MB5B.
 *
 * Read-only: this module issues no insert, update or delete.
 *
 * A named batch filters this tree to the stock that stands on that batch.
 * The overview does not create a batch. Stock in transit (ITEM-22: a stock transport
 * order goods issue not yet received) is its own plant-level quantity of the receiving
 * plant, outside every storage location and every on-hand figure, and counted once in
 * the plant and material totals. Refused by name: SAP's
 * one-character special stock indicator — Cairn carries special stock as a named
 * stock type, which is exactly what the third tree level shows.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';
import { IN_TRANSIT } from './stock-types';

export const STOCK_OVERVIEW_CAPABILITY = 'INV.STOCK.VIEW';
export const STOCK_OVERVIEW_ALIAS = 'MMBE';

export const UNRESTRICTED = 'UNRESTRICTED';
export const QUALITY = 'QUALITY';
export const BLOCKED = 'BLOCKED';

export const EXPANSION_LEVELS = ['PLANT', 'STORAGE_LOCATION'] as const;
export type ExpansionLevel = (typeof EXPANSION_LEVELS)[number];

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;

export interface StockOverviewSelection {
  material?: string;
  plantFrom?: string;
  plantTo?: string;
  storageLocationFrom?: string;
  storageLocationTo?: string;
  batch?: string;
  specialStockIndicator?: string;
  displayZero?: boolean;
  expansionLevel?: string;
  maxHits?: number;
}

export interface StockBatchNode {
  batch: string;
  quantity: number;
}

export interface StockTypeNode {
  stockType: string;
  isUnrestricted: boolean;
  isQualityInspection: boolean;
  isBlocked: boolean;
  quantity: number;
  batches: StockBatchNode[];
}

export interface StorageLocationNode {
  storageLocation: string;
  quantity: number;
  stockTypes: StockTypeNode[];
  movementsDrillDown: string | null;
  rollforwardDrillDown: string | null;
  warehouseDrillDown: string | null;
}

/** Stock in transit of a stock transport order: a plant-level quantity, never a storage location's, never available. */
export interface TransitNode {
  quantity: number;
  batches: StockBatchNode[];
  /** The orders it belongs to, from the transit ledger. */
  orders: Array<{ orderNumber: string; itemNumber: number; batch: string; inTransit: number; drillDown: string }>;
}

export interface PlantNode {
  plant: string;
  /** Everything counted at the plant: on-hand stock of every type PLUS transit, each once. */
  quantity: number;
  /** In transit to this plant (351 posted, 101 not yet). Not unrestricted, not available, no storage location. */
  transitQuantity: number;
  transit: TransitNode | null;
  unrestrictedQuantity: number;
  qualityInspectionQuantity: number;
  blockedQuantity: number;
  specialQuantity: number;
  storageLocations: StorageLocationNode[];
  movementsDrillDown: string | null;
  rollforwardDrillDown: string | null;
  warehouseDrillDown: string | null;
}

export interface StockOverviewResult {
  capability: string;
  selection: StockOverviewSelection;
  material: string;
  materialDescription: string;
  baseUnit: string;
  expansionLevel: ExpansionLevel;
  plants: PlantNode[];
  totalQuantity: number;
  unrestrictedQuantity: number;
  qualityInspectionQuantity: number;
  blockedQuantity: number;
  specialQuantity: number;
  /** In transit, counted once in `totalQuantity` and shown apart from every on-hand figure. */
  transitQuantity: number;
  truncated: boolean;
  maxHits: number;
  warnings: string[];
  calculatedAt: string;
}

export class StockOverviewError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'StockOverviewError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new StockOverviewError(message, remedy);
}

function bound(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

export async function stockOverview(input: {
  client: string;
  selection: StockOverviewSelection;
}): Promise<StockOverviewResult> {
  const { client } = input;
  const raw = input.selection;
  const s: StockOverviewSelection = {
    material: bound(raw.material),
    plantFrom: bound(raw.plantFrom),
    plantTo: bound(raw.plantTo),
    storageLocationFrom: bound(raw.storageLocationFrom),
    storageLocationTo: bound(raw.storageLocationTo),
    batch: bound(raw.batch),
    specialStockIndicator: bound(raw.specialStockIndicator),
    displayZero: raw.displayZero === true,
    expansionLevel: bound(raw.expansionLevel) ?? 'STORAGE_LOCATION',
    maxHits: raw.maxHits,
  };

  if (!s.material) fail('A material is required.', 'The overview is of one material — a range belongs to the warehouse stock list.');
  const level = String(s.expansionLevel).toUpperCase();
  if (!EXPANSION_LEVELS.includes(level as ExpansionLevel)) {
    fail(`The expansion level ${s.expansionLevel} does not stand.`, `Choose ${EXPANSION_LEVELS.join(' or ')}.`);
  }
  if (s.specialStockIndicator) {
    fail(
      `The special stock indicator ${s.specialStockIndicator} does not stand.`,
      'Cairn records special stock as a named stock type; the third level of the tree names it.',
    );
  }
  if (s.plantFrom && s.plantTo && s.plantTo < s.plantFrom) fail('The plant range is inverted.', 'The lower bound must not exceed the upper bound.');
  if (s.storageLocationFrom && s.storageLocationTo && s.storageLocationTo < s.storageLocationFrom) {
    fail('The storage location range is inverted.', 'The lower bound must not exceed the upper bound.');
  }

  const warnings: string[] = [];
  const requested = s.maxHits ?? DEFAULT_MAX_HITS;
  if (!Number.isInteger(requested) || requested < 1) fail('Maximum hits must be a positive number.');
  const maxHits = Math.min(requested, MAX_HITS_CAP);
  if (requested > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  const calculatedAt = new Date().toISOString();

  return withTenant(client, async (tx) => {
    const master = await tx.execute(sql`
      select material_number, description, base_unit from material
      where client = ${client} and material_number = ${s.material!}
    `) as unknown as Array<{ material_number: string; description: string; base_unit: string }>;
    if (master.length === 0) fail(`The material ${s.material} does not stand.`, 'Maintain the material before viewing its stock.');

    for (const value of [s.plantFrom, s.plantTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`select 1 as hit from plant where client = ${client} and plant = ${value} limit 1`) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The plant ${value} does not stand.`, 'Maintain the plant before selecting it.');
    }
    for (const value of [s.storageLocationFrom, s.storageLocationTo]) {
      if (!value) continue;
      const rows = await tx.execute(sql`select 1 as hit from storage_location where client = ${client} and storage_location = ${value} limit 1`) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The storage location ${value} does not stand.`, 'Maintain the storage location before selecting it.');
    }

    let batchFilter = '';
    if (s.batch) {
      const levelRows = await tx.execute(sql`
        select batch_level from batch_level_configuration where client = ${client} limit 1
      `) as unknown as Array<{ batch_level: string }>;
      const level = levelRows[0]?.batch_level?.trim();
      if (level === '0' && !s.plantFrom) {
        fail('A plant is required before a batch can be read.', 'Enter one plant, then the batch.');
      }
      if (level === '0' && s.plantTo && s.plantFrom !== s.plantTo) {
        fail('A batch at plant level is read for one plant.', 'Enter the same plant in both bounds.');
      }
      try {
        batchFilter = await resolvePostingBatch(tx, {
          client, materialNumber: s.material!, plant: s.plantFrom ?? s.plantTo ?? '', batch: s.batch,
        });
      } catch (caught) {
        if (caught instanceof BatchPostingError) {
          fail(caught.message.replace(' No stock was posted.', ''), caught.remedy);
        }
        throw caught;
      }
    }
    const filters = [
      s.plantFrom ? sql`and plant >= ${s.plantFrom}` : sql``,
      s.plantTo ? sql`and plant <= ${s.plantTo}` : sql``,
      s.storageLocationFrom ? sql`and storage_location >= ${s.storageLocationFrom}` : sql``,
      s.storageLocationTo ? sql`and storage_location <= ${s.storageLocationTo}` : sql``,
      batchFilter ? sql`and batch_number = ${batchFilter}` : sql``,
    ];
    // One read of the stock master; the tree folds these same rows, so no parent
    // can disagree with the children it displays.
    const rows = await tx.execute(sql`
      select plant, storage_location, stock_type, batch_number, quantity::text as quantity
      from stock_quantity
      where client = ${client} and material_number = ${s.material!} and stock_type <> ${IN_TRANSIT} ${sql.join(filters, sql` `)}
      order by plant, storage_location, stock_type, batch_number
      limit ${maxHits + 1}
    `) as unknown as Array<{ plant: string; storage_location: string; stock_type: string; batch_number: string; quantity: string }>;

    // Transit is its own plant-level quantity of the RECEIVING plant: no storage location exists for it, so a
    // storage-location selection (which names a place) leaves it out and says so.
    const transitRows = s.storageLocationFrom || s.storageLocationTo ? [] : await tx.execute(sql`
      select plant, batch_number, quantity::text as quantity
      from stock_quantity
      where client = ${client} and material_number = ${s.material!} and stock_type = ${IN_TRANSIT}
        ${s.plantFrom ? sql`and plant >= ${s.plantFrom}` : sql``}
        ${s.plantTo ? sql`and plant <= ${s.plantTo}` : sql``}
        ${batchFilter ? sql`and batch_number = ${batchFilter}` : sql``}
      order by plant, batch_number
    `) as unknown as Array<{ plant: string; batch_number: string; quantity: string }>;
    if (s.storageLocationFrom || s.storageLocationTo) {
      warnings.push('Stock in transit is a plant-level quantity with no storage location; it is not shown under a storage-location selection.');
    }
    const transitLedger = transitRows.length === 0 ? [] : await tx.execute(sql`
      select receiving_plant as plant, order_number, item_number, batch_number,
             (issued_quantity - reversed_quantity - received_quantity)::text as in_transit
        from sto_transit_allocation
       where client = ${client} and material_number = ${s.material!}
         and issued_quantity - reversed_quantity - received_quantity > 0
       order by receiving_plant, order_number, item_number, posting_date
    `) as unknown as Array<{ plant: string; order_number: string; item_number: number; batch_number: string; in_transit: string }>;

    const truncated = rows.length > maxHits;
    const leaves = rows.slice(0, maxHits);
    const num = (value: string) => Number(fromScaled(toScaled(value, 3), 3));

    const span = await tx.execute(sql`
      select min(posting_date)::text as first_date, max(posting_date)::text as last_date
      from material_document where client = ${client} and status = 'POSTED'
    `) as unknown as Array<{ first_date: string | null; last_date: string | null }>;
    const firstDate = span[0]?.first_date ?? null;
    const lastDate = span[0]?.last_date ?? null;
    const materialNumber = s.material!;

    const drill = (base: string, plant: string, storageLocation: string) => {
      if (!firstDate || !lastDate) return null;
      const url = `${base}?materialFrom=${encodeURIComponent(materialNumber)}&materialTo=${encodeURIComponent(materialNumber)}`
        + `&plantFrom=${encodeURIComponent(plant)}&plantTo=${encodeURIComponent(plant)}`
        + `&storageLocationFrom=${encodeURIComponent(storageLocation)}&storageLocationTo=${encodeURIComponent(storageLocation)}`
        + (base.includes('stock-on-posting-date')
          ? `&dateFrom=${firstDate}&dateTo=${lastDate}`
          : base.includes('warehouse-stocks')
            ? ''
            : `&postingDateFrom=${firstDate}&postingDateTo=${lastDate}`);
      // A filtered batch must follow the node. The other batch is not this readback.
      return batchFilter ? `${url}&batch=${encodeURIComponent(batchFilter)}` : url;
    };

    // Fold: stock type → location → plant, all from the same leaves.
    const plantMap = new Map<string, Map<string, Map<string, Map<string, number>>>>();
    for (const leaf of leaves) {
      const plant = String(leaf.plant);
      const location = String(leaf.storage_location ?? '');
      const stockType = String(leaf.stock_type);
      const batch = String(leaf.batch_number ?? '');
      const quantity = num(String(leaf.quantity));
      if (!plantMap.has(plant)) plantMap.set(plant, new Map());
      const locations = plantMap.get(plant)!;
      if (!locations.has(location)) locations.set(location, new Map());
      const types = locations.get(location)!;
      if (!types.has(stockType)) types.set(stockType, new Map());
      const batches = types.get(stockType)!;
      batches.set(batch, (batches.get(batch) ?? 0) + quantity);
    }

    const transitByPlant = new Map<string, Map<string, number>>();
    for (const row of transitRows) {
      const quantity = num(String(row.quantity));
      if (!s.displayZero && quantity === 0) continue;
      if (!transitByPlant.has(row.plant)) transitByPlant.set(row.plant, new Map());
      const batches = transitByPlant.get(row.plant)!;
      batches.set(row.batch_number ?? '', (batches.get(row.batch_number ?? '') ?? 0) + quantity);
      if (!plantMap.has(row.plant)) plantMap.set(row.plant, new Map());
    }

    const plants: PlantNode[] = [];
    for (const plant of [...plantMap.keys()].sort()) {
      const locations = plantMap.get(plant)!;
      const storageLocations: StorageLocationNode[] = [];
      let plantTotal = 0;
      let plantUnrestricted = 0;
      let plantQuality = 0;
      let plantBlocked = 0;
      let plantSpecial = 0;

      for (const location of [...locations.keys()].sort()) {
        const types = locations.get(location)!;
        const stockTypes: StockTypeNode[] = [];
        let locationTotal = 0;
        for (const stockType of [...types.keys()].sort()) {
          const batchMap = types.get(stockType)!;
          const batches = [...batchMap.keys()].sort().flatMap((batch) => {
            const quantity = Number(batchMap.get(batch)!.toFixed(3));
            if (!s.displayZero && quantity === 0) return [];
            return [{ batch, quantity }];
          });
          if (batches.length === 0) continue;
          const quantity = Number(batches.reduce((sum, batch) => sum + batch.quantity, 0).toFixed(3));
          stockTypes.push({
            stockType,
            isUnrestricted: stockType === UNRESTRICTED,
            isQualityInspection: stockType === QUALITY,
            isBlocked: stockType === BLOCKED,
            quantity,
            batches,
          });
          locationTotal += quantity;
        }
        // A location whose every stock type is zero disappears with them.
        if (stockTypes.length === 0) continue;
        locationTotal = Number(locationTotal.toFixed(3));
        const node: StorageLocationNode = {
          storageLocation: location,
          quantity: locationTotal,
          stockTypes,
          movementsDrillDown: drill('/inventory/material-document-list', plant, location),
          rollforwardDrillDown: drill('/inventory/stock-on-posting-date', plant, location),
          warehouseDrillDown: drill('/inventory/warehouse-stocks', plant, location),
        };
        storageLocations.push(node);
        plantTotal += locationTotal;
        for (const type of stockTypes) {
          if (type.isUnrestricted) plantUnrestricted += type.quantity;
          else if (type.isQualityInspection) plantQuality += type.quantity;
          else if (type.isBlocked) plantBlocked += type.quantity;
          else plantSpecial += type.quantity;
        }
      }

      const transitBatches = [...(transitByPlant.get(plant)?.entries() ?? [])]
        .filter(([, quantity]) => s.displayZero || quantity !== 0)
        .map(([batch, quantity]) => ({ batch, quantity: Number(quantity.toFixed(3)) }))
        .sort((a, b) => a.batch.localeCompare(b.batch));
      const transitQuantity = Number(transitBatches.reduce((sum, b) => sum + b.quantity, 0).toFixed(3));
      if (storageLocations.length === 0 && transitBatches.length === 0) continue;
      const transit: TransitNode | null = transitBatches.length === 0 ? null : {
        quantity: transitQuantity,
        batches: transitBatches,
        orders: transitLedger.filter((l) => l.plant === plant).map((l) => ({
          orderNumber: l.order_number, itemNumber: Number(l.item_number), batch: l.batch_number ?? '',
          inTransit: num(String(l.in_transit)),
          drillDown: `/purchasing/purchase-order-display?order=${encodeURIComponent(l.order_number)}`,
        })),
      };
      plantTotal += transitQuantity;
      plants.push({
        plant,
        quantity: Number(plantTotal.toFixed(3)),
        transitQuantity,
        transit,
        unrestrictedQuantity: Number(plantUnrestricted.toFixed(3)),
        qualityInspectionQuantity: Number(plantQuality.toFixed(3)),
        blockedQuantity: Number(plantBlocked.toFixed(3)),
        specialQuantity: Number(plantSpecial.toFixed(3)),
        storageLocations,
        movementsDrillDown: drill('/inventory/material-document-list', plant, s.storageLocationFrom ?? ''),
        rollforwardDrillDown: drill('/inventory/stock-on-posting-date', plant, s.storageLocationFrom ?? ''),
        warehouseDrillDown: drill('/inventory/warehouse-stocks', plant, s.storageLocationFrom ?? ''),
      });
    }

    if (truncated) warnings.push(`The tree is truncated at ${maxHits} stock rows; narrow the plant or location range for the complete overview.`);
    if (!firstDate || !lastDate) warnings.push('No posted movement stands, so the nodes carry no drill into movements.');
    if (leaves.length === 0) warnings.push(`No stock stands for material ${materialNumber} in the selection.`);
    if (plants.length === 0 && leaves.length > 0) warnings.push('Every stock line is zero; tick the zero-stock display to see them.');

    const totals = plants.reduce((acc, plant) => ({
      total: acc.total + plant.quantity,
      unrestricted: acc.unrestricted + plant.unrestrictedQuantity,
      quality: acc.quality + plant.qualityInspectionQuantity,
      blocked: acc.blocked + plant.blockedQuantity,
      special: acc.special + plant.specialQuantity,
      transit: acc.transit + plant.transitQuantity,
    }), { total: 0, unrestricted: 0, quality: 0, blocked: 0, special: 0, transit: 0 });

    return {
      capability: STOCK_OVERVIEW_CAPABILITY,
      selection: s,
      material: materialNumber,
      materialDescription: master[0]!.description,
      baseUnit: master[0]!.base_unit,
      expansionLevel: level as ExpansionLevel,
      plants,
      totalQuantity: Number(totals.total.toFixed(3)),
      unrestrictedQuantity: Number(totals.unrestricted.toFixed(3)),
      qualityInspectionQuantity: Number(totals.quality.toFixed(3)),
      blockedQuantity: Number(totals.blocked.toFixed(3)),
      specialQuantity: Number(totals.special.toFixed(3)),
      transitQuantity: Number(totals.transit.toFixed(3)),
      truncated,
      maxHits,
      warnings,
      calculatedAt,
    };
  });
}
