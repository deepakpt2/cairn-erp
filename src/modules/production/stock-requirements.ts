/**
 * Stock/requirements list — SCR-130 / PROD.MRP.STOCKREQ (MD04).
 *
 * A live projection, never a stored one: stock on hand, the open purchase
 * requisitions and the open purchase orders are read as they stand and folded
 * into one chronological list with a running projected balance. Nothing is
 * written — the contract declines the package's pegging table (§26.861) because
 * a stored projection is wrong the moment anything posts.
 *
 * MRP availability covers unrestricted-use and quality-inspection stock only.
 * Blocked stock is excluded, as SAP excludes it, and a warning names what was
 * left out.
 *
 * Reservations (SCR-133) are a requirement element: an open item is stock the
 * plant has already promised away, dated at its required date. SCR-130 deferred
 * them because no table existed; the deferral is closed.
 *
 * Deferred by name: planned orders, production orders and sales orders (no such
 * tables); excess-stock alerts (no stock ceiling exists).
 * Refused by name: MRP area, the one-character special stock indicator, a
 * simulation version, and PR-to-PO conversion (a posting action, not a report).
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';

export const STOCK_REQUIREMENTS_CAPABILITY = 'PROD.MRP.STOCKREQ';
export const STOCK_REQUIREMENTS_ALIAS = 'MD04';

/** The stock types MRP counts. Blocked stock is held for a reason and never planned. */
export const MRP_AVAILABLE_STOCK_TYPES = ['UNRESTRICTED', 'QUALITY'] as const;

export const PERIOD_SPLITS = ['DAILY', 'WEEKLY'] as const;
export type PeriodSplit = (typeof PERIOD_SPLITS)[number];

export type ElementType =
  | 'STOCK' | 'PURCHASE_REQUISITION' | 'PURCHASE_ORDER' | 'SAFETY_STOCK' | 'RESERVATION';
export type ElementDirection = 'RECEIPT' | 'REQUIREMENT';
export type ExceptionCode = 'SHORTAGE' | 'SAFETY_BREACH' | 'PAST_DUE';

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;

export interface StockRequirementsSelection {
  material?: string;
  plant?: string;
  mrpArea?: string;
  specialStockIndicator?: string;
  displayPastDue?: boolean;
  periodSplit?: string;
  simulationVersion?: string;
  horizonEnd?: string;
  maxHits?: number;
}

export interface StockRequirementRow {
  date: string;
  periodEnd: string;
  elementType: ElementType;
  elementLabel: string;
  direction: ElementDirection;
  documentNumber: string;
  documentItem: string;
  quantity: number;
  projectedBalance: number;
  exceptions: ExceptionCode[];
  drillDown: string | null;
}

export interface StockRequirementsResult {
  capability: string;
  selection: StockRequirementsSelection;
  material: string;
  materialDescription: string;
  baseUnit: string;
  plant: string;
  mrpType: string | null;
  safetyStock: number;
  reorderPoint: number;
  periodSplit: PeriodSplit;
  openingStock: number;
  totalReceipts: number;
  totalRequirements: number;
  closingBalance: number;
  rows: StockRequirementRow[];
  rowCount: number;
  exceptionCounts: Record<ExceptionCode, number>;
  truncated: boolean;
  maxHits: number;
  warnings: string[];
  calculatedAt: string;
}

export class StockRequirementsError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'StockRequirementsError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new StockRequirementsError(message, remedy);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, label: string): string {
  const parsed = ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} ${value} is not a valid date.`, 'Use the format YYYY-MM-DD.');
  }
  return value;
}

/** Monday of the week a date falls in — the bucket boundary for a weekly split. */
function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  day.setUTCDate(day.getUTCDate() - weekday);
  return day.toISOString().slice(0, 10);
}

function weekEnd(date: string): string {
  const day = new Date(`${weekStart(date)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 6);
  return day.toISOString().slice(0, 10);
}

function bound(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

interface Element {
  date: string;
  elementType: ElementType;
  elementLabel: string;
  direction: ElementDirection;
  documentNumber: string;
  documentItem: string;
  quantity: number;
  drillDown: string | null;
}

export async function stockRequirementsList(input: {
  client: string;
  today: string;
  selection: StockRequirementsSelection;
}): Promise<StockRequirementsResult> {
  const { client, today } = input;
  const raw = input.selection;
  const s: StockRequirementsSelection = {
    material: bound(raw.material),
    plant: bound(raw.plant),
    mrpArea: bound(raw.mrpArea),
    specialStockIndicator: bound(raw.specialStockIndicator),
    displayPastDue: raw.displayPastDue !== false,
    periodSplit: bound(raw.periodSplit)?.toUpperCase() ?? 'DAILY',
    simulationVersion: bound(raw.simulationVersion),
    horizonEnd: bound(raw.horizonEnd),
    maxHits: raw.maxHits,
  };

  if (!s.material) fail('A material is required.', 'The stock/requirements list is of one material.');
  if (!s.plant) fail('A plant is required.', 'The list is of one material in one plant.');
  if (s.mrpArea) fail(`The MRP area ${s.mrpArea} does not stand.`, 'Decentralised planning is not carried; the plant is the planning scope.');
  if (s.specialStockIndicator) {
    fail(
      `The special stock indicator ${s.specialStockIndicator} does not stand.`,
      'Cairn records special stock as a named stock type; MRP counts unrestricted-use and quality-inspection stock.',
    );
  }
  if (s.simulationVersion) {
    fail(`The simulation version ${s.simulationVersion} does not stand.`, 'No planning runs exist to version.');
  }
  const periodSplit = String(s.periodSplit).toUpperCase();
  if (!PERIOD_SPLITS.includes(periodSplit as PeriodSplit)) {
    fail(`The period split ${s.periodSplit} does not stand.`, `Choose ${PERIOD_SPLITS.join(' or ')}.`);
  }
  if (s.horizonEnd) checkDate(s.horizonEnd, 'Planning horizon end');
  if (s.horizonEnd && s.horizonEnd < today) fail('The planning horizon ends in the past.', 'Set the horizon end on or after today.');

  const warnings: string[] = [];
  const requested = s.maxHits ?? DEFAULT_MAX_HITS;
  if (!Number.isInteger(requested) || requested < 1) fail('Maximum hits must be a positive number.');
  const maxHits = Math.min(requested, MAX_HITS_CAP);
  if (requested > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  const calculatedAt = new Date().toISOString();

  return withTenant(client, async (tx) => {
    const master = await tx.execute(sql`
      select m.material_number, m.description, m.base_unit,
             mp.mrp_type, mp.safety_stock::text as safety_stock, mp.reorder_point::text as reorder_point
      from material m
      left join material_plant mp on mp.client = m.client and mp.material_number = m.material_number and mp.plant = ${s.plant!}
      where m.client = ${client} and m.material_number = ${s.material!}
    `) as unknown as Array<Record<string, unknown>>;
    if (master.length === 0) fail(`The material ${s.material} does not stand.`, 'Maintain the material before planning it.');
    const plant = await tx.execute(sql`select 1 as hit from plant where client = ${client} and plant = ${s.plant!} limit 1`) as unknown as Array<{ hit: number }>;
    if (plant.length === 0) fail(`The plant ${s.plant} does not stand.`, 'Maintain the plant before planning in it.');

    const num = (value: unknown, scale = 3) => (value === null || value === undefined
      ? 0
      : Number(fromScaled(toScaled(String(value), scale), scale)));

    const mrpType = master[0]!.mrp_type === null || master[0]!.mrp_type === undefined ? null : String(master[0]!.mrp_type);
    const safetyStock = num(master[0]!.safety_stock);
    const reorderPoint = num(master[0]!.reorder_point);
    if (mrpType === null || mrpType === 'NONE') {
      warnings.push(`The material is not planned in plant ${s.plant} (MRP type ${mrpType ?? 'not maintained'}); the list shows stock and open documents only.`);
    }

    // ── Stock on hand: MRP-available types only ─────────────────────────────
    const stockRows = await tx.execute(sql`
      select stock_type, sum(quantity)::text as quantity
      from stock_quantity
      where client = ${client} and material_number = ${s.material!} and plant = ${s.plant!}
      group by stock_type
    `) as unknown as Array<{ stock_type: string; quantity: string }>;
    let openingStock = 0;
    let excludedStock = 0;
    const excludedTypes: string[] = [];
    for (const row of stockRows) {
      const quantity = num(row.quantity);
      if ((MRP_AVAILABLE_STOCK_TYPES as readonly string[]).includes(row.stock_type)) {
        openingStock += quantity;
      } else {
        excludedStock += quantity;
        if (quantity !== 0) excludedTypes.push(`${row.stock_type} ${quantity.toFixed(3)}`);
      }
    }
    if (excludedStock !== 0) {
      warnings.push(
        `Blocked and other non-planned stock is excluded from MRP availability: ${excludedTypes.join(', ')} `
        + '(MRP counts unrestricted-use and quality-inspection stock only).',
      );
    }

    // ── Open purchase requisitions: quantity less what orders already cover ──
    const prRows = await tx.execute(sql`
      select r.requisition_number, r.item_number, r.quantity::text as quantity, r.delivery_date::text as delivery_date,
             coalesce(conv.converted, 0)::text as converted
      from purchase_requisition_item r
      left join (
        select i.requisition_number, i.requisition_item, sum(i.quantity) as converted
        from purchase_order_item i
        where i.client = ${client} and i.requisition_number is not null and not i.marked_for_deletion
        group by i.requisition_number, i.requisition_item
      ) conv on conv.requisition_number = r.requisition_number and conv.requisition_item = r.item_number
      where r.client = ${client} and r.material_number = ${s.material!} and r.plant = ${s.plant!}
        and not r.marked_for_deletion
      order by r.delivery_date, r.requisition_number, r.item_number
    `) as unknown as Array<Record<string, string>>;

    // ── Open purchase orders: quantity less what has been delivered ─────────
    const poRows = await tx.execute(sql`
      with gr as (
        select l.purchase_order_number, l.purchase_order_item,
               sum(case when m.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end) as delivered
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number and d.status = 'POSTED'
        join movement_type m on m.client = l.client and m.movement_type = l.movement_type
        where l.client = ${client} and l.purchase_order_number is not null
        group by l.purchase_order_number, l.purchase_order_item
      ), schedule as (
        select order_number, item_number, min(delivery_date)::text as delivery_date
        from purchase_order_schedule_line where client = ${client}
        group by order_number, item_number
      )
      select i.order_number, i.item_number, i.quantity::text as quantity, po.document_date::text as document_date,
             coalesce(gr.delivered, 0)::text as delivered, coalesce(sc.delivery_date, '') as delivery_date,
             i.marked_for_deletion
      from purchase_order_item i
      join purchase_order po on po.client = i.client and po.order_number = i.order_number
      left join gr on gr.purchase_order_number = i.order_number and gr.purchase_order_item = i.item_number
      left join schedule sc on sc.order_number = i.order_number and sc.item_number = i.item_number
      where i.client = ${client} and i.material_number = ${s.material!} and i.plant = ${s.plant!}
        and not i.marked_for_deletion
      order by po.document_date, i.order_number, i.item_number
    `) as unknown as Array<Record<string, unknown>>;

    const reservationRows = await tx.execute(sql`
      select i.reservation_number, i.item_number, i.required_quantity::text as required_quantity,
             i.withdrawn_quantity::text as withdrawn_quantity, h.base_date
      from reservation_item i
      join reservation_header h
        on h.client = i.client and h.reservation_number = i.reservation_number
      where i.client = ${client} and i.plant = ${s.plant!} and i.material_number = ${s.material!}
        and not i.is_completed
      order by h.base_date, i.reservation_number, i.item_number
    `) as unknown as Array<Record<string, unknown>>;

    const elements: Element[] = [];
    // The opening element is always drawn, even at zero: the list starts from a position.
    {
      elements.push({
        date: today,
        elementType: 'STOCK',
        elementLabel: 'Stock on hand',
        direction: 'RECEIPT',
        documentNumber: '',
        documentItem: '',
        quantity: Number(openingStock.toFixed(3)),
        drillDown: `/inventory/stock-overview?material=${encodeURIComponent(s.material!)}`,
      });
    }
    if (safetyStock > 0) {
      elements.push({
        date: today,
        elementType: 'SAFETY_STOCK',
        elementLabel: 'Safety stock',
        direction: 'REQUIREMENT',
        documentNumber: '',
        documentItem: '',
        quantity: safetyStock,
        drillDown: null,
      });
    }
    for (const row of prRows) {
      const open = Number((num(row.quantity) - num(row.converted)).toFixed(3));
      if (open === 0) continue;
      elements.push({
        date: String(row.delivery_date),
        elementType: 'PURCHASE_REQUISITION',
        elementLabel: 'Purchase requisition',
        direction: 'RECEIPT',
        documentNumber: String(row.requisition_number),
        documentItem: String(row.item_number),
        quantity: open,
        drillDown: `/purchasing/requisition-list?requisitionNumber=${encodeURIComponent(String(row.requisition_number))}`,
      });
    }
    for (const row of poRows) {
      const open = Number((num(row.quantity) - num(row.delivered)).toFixed(3));
      if (open === 0) continue;
      elements.push({
        date: String(row.delivery_date) || String(row.document_date),
        elementType: 'PURCHASE_ORDER',
        elementLabel: 'Purchase order',
        direction: 'RECEIPT',
        documentNumber: String(row.order_number),
        documentItem: String(row.item_number),
        quantity: open,
        drillDown: `/purchasing/orders?order=${encodeURIComponent(String(row.order_number))}`,
      });
    }
    for (const row of reservationRows) {
      const open = Number((num(row.required_quantity) - num(row.withdrawn_quantity)).toFixed(3));
      if (open <= 0) continue;
      elements.push({
        date: String(row.base_date),
        elementType: 'RESERVATION',
        elementLabel: 'Reservation',
        direction: 'REQUIREMENT',
        documentNumber: String(row.reservation_number),
        documentItem: String(row.item_number),
        quantity: open,
        drillDown: `/inventory/reservations?reservation=${encodeURIComponent(String(row.reservation_number))}`,
      });
    }

    // Chronological: receipts before requirements on the same date, so a receipt
    // landing that day is available to meet the demand of that day.
    elements.sort((a, b) => (a.date === b.date
      ? (a.direction === b.direction ? 0 : a.direction === 'RECEIPT' ? -1 : 1)
      : a.date < b.date ? -1 : 1));

    const withinHorizon = elements.filter((e) => !s.horizonEnd || e.date <= s.horizonEnd);

    // Running balance, then exceptions.
    let balance = 0;
    const computed = withinHorizon.map((element) => {
      balance = Number((balance + (element.direction === 'RECEIPT' ? element.quantity : -element.quantity)).toFixed(3));
      return { ...element, projectedBalance: balance };
    });

    const exceptionOf = (balanceNow: number, date: string): ExceptionCode[] => {
      const codes: ExceptionCode[] = [];
      if (balanceNow < 0) codes.push('SHORTAGE');
      else if (safetyStock > 0 && balanceNow < safetyStock) codes.push('SAFETY_BREACH');
      if (date < today) codes.push('PAST_DUE');
      return codes;
    };

    let rows: StockRequirementRow[];
    if (periodSplit === 'WEEKLY') {
      const buckets = new Map<string, { receipts: number; requirements: number; balance: number; date: string }>();
      for (const row of computed) {
        const key = weekStart(row.date);
        const bucket = buckets.get(key) ?? { receipts: 0, requirements: 0, balance: 0, date: key };
        if (row.direction === 'RECEIPT') bucket.receipts += row.quantity;
        else bucket.requirements += row.quantity;
        bucket.balance = row.projectedBalance; // the week ends on its last element
        buckets.set(key, bucket);
      }
      rows = [...buckets.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, bucket]) => {
          const net = Number((bucket.receipts - bucket.requirements).toFixed(3));
          return {
            date: key,
            periodEnd: weekEnd(key),
            elementType: bucket.receipts >= bucket.requirements ? 'STOCK' : 'SAFETY_STOCK',
            elementLabel: `Week ${key}`,
            direction: net >= 0 ? 'RECEIPT' : 'REQUIREMENT',
            documentNumber: '',
            documentItem: '',
            quantity: Math.abs(net),
            projectedBalance: Number(bucket.balance.toFixed(3)),
            exceptions: exceptionOf(Number(bucket.balance.toFixed(3)), key),
            drillDown: null,
          };
        });
    } else {
      rows = computed.map((row) => ({
        date: row.date,
        periodEnd: row.date,
        elementType: row.elementType,
        elementLabel: row.elementLabel,
        direction: row.direction,
        documentNumber: row.documentNumber,
        documentItem: row.documentItem,
        quantity: row.quantity,
        projectedBalance: row.projectedBalance,
        exceptions: exceptionOf(row.projectedBalance, row.date),
        drillDown: row.drillDown,
      }));
    }

    // Past due: hidden rows leave the list but never leave the balance. The first
    // visible row therefore carries the position the hidden rows produced.
    if (s.displayPastDue === false) {
      rows = rows.filter((row) => row.date >= today);
    }

    const truncated = rows.length > maxHits;
    const shown = rows.slice(0, maxHits);
    if (truncated) warnings.push(`The list is truncated at ${maxHits} rows; narrow the horizon for the complete list.`);

    const exceptionCounts: Record<ExceptionCode, number> = { SHORTAGE: 0, SAFETY_BREACH: 0, PAST_DUE: 0 };
    for (const row of shown) for (const code of row.exceptions) exceptionCounts[code] += 1;

    const totalReceipts = Number(shown.filter((r) => r.direction === 'RECEIPT').reduce((sum, r) => sum + r.quantity, 0).toFixed(3));
    const totalRequirements = Number(shown.filter((r) => r.direction === 'REQUIREMENT').reduce((sum, r) => sum + r.quantity, 0).toFixed(3));
    const closingBalance = shown.length > 0 ? shown[shown.length - 1]!.projectedBalance : balance;

    if (shown.length === 0) warnings.push('The list is empty: no stock, requisition or order stands in the selection.');

    return {
      capability: STOCK_REQUIREMENTS_CAPABILITY,
      selection: s,
      material: String(master[0]!.material_number),
      materialDescription: String(master[0]!.description ?? ''),
      baseUnit: String(master[0]!.base_unit ?? ''),
      plant: s.plant!,
      mrpType,
      safetyStock,
      reorderPoint,
      periodSplit: periodSplit as PeriodSplit,
      openingStock: Number(openingStock.toFixed(3)),
      totalReceipts,
      totalRequirements,
      closingBalance: Number(closingBalance.toFixed(3)),
      rows: shown,
      rowCount: shown.length,
      exceptionCounts,
      truncated,
      maxHits,
      warnings,
      calculatedAt,
    };
  });
}
