/**
 * Convert a planned order into a production order — CO40 and CO41.
 *
 * One service. CO41 calls it once per order, each in its own transaction.
 * The production order is created by the existing order service. The BOM
 * quantity uses the shared component-quantity function. Conversion reads
 * the order type's production version selection, then calls the shared
 * selector. The saved order is derived again by the order service from that
 * version, so the version and bill of material are stored with the snapshot.
 * An independent component list is not given that version. The convertible
 * list has no order type, so it does not read the setting and does not invent
 * one. This file does not insert a production order itself and does not
 * explode through MRP. A component requirement date is copied only from an
 * open dependent requirement that matches the tenant, planned order, source
 * material, BOM item, component, plant, unit, and quantity. The order start,
 * order finish, bill of material date, and today are not used. That dependent
 * requirement is closed only after the date is stored, in this transaction.
 * A line that cannot be matched stays undated, and its dependent requirement
 * stays open. A reservation is not created in its place.
 *
 * Full conversion is one-to-one. The planned order is not deleted and its
 * quantity is not reduced. A second conversion returns the existing order
 * and does not reconcile again. External procurement is refused. Partial
 * quantity is refused.
 *
 * A created order is not the same as complete demand reconciliation. The
 * result says COMPLETE only when every open dependent requirement was closed
 * after its date was stored, PARTIAL when one stayed open, and NONE when none
 * stood open. A failure throws inside the conversion transaction, so the
 * order and the planning rows are unchanged. That result is ROLLED_BACK, not
 * a partial reconciliation. An already-converted order is NOT_RERUN: reconciliation
 * is not repeated and the prior result is not revalidated. A request that never
 * reaches conversion is NOT_ATTEMPTED. A mismatch reason is reported only from
 * the stored rows. A date is not invented to make a row match.
 *
 * The selected routing's operations are copied by the order service in this
 * same transaction. A later routing edit does not rewrite them. Not carried:
 * a reservation, a goods movement, a journal, a confirmation, costing, and
 * settlement. Availability is not checked. Dates are copied, not rescheduled.
 * An order type is required. It is not inferred. Checking control is not read.
 * Release happens only when the scheduling profile snapshotted by order
 * creation already says so.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import {
  createProductionOrder,
  ProductionOrderError,
  type CreateProductionOrderResult,
} from '../inventory/production-orders';
import { material, materialPlant } from '../inventory/schema';
import { parseProductionOrderStatus, type ProductionOrderStatus } from './production-order-status';
import { readMaterialSchedulingProfile, SchedulingProfileError } from '../inventory/scheduling-profile';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import { componentRequirementQuantity } from './mrp-explosion';
import { materialBom, materialBomItem, productionOrderType } from './schema';
import {
  OrderTypeParameterError,
  productionVersionForSelection,
  readProductionVersionSelection,
} from './order-type-parameters';
import { OrderOperationSnapshotError, resolveOrderOperationSnapshot } from './order-operation-snapshot';
import {
  conversionOutcomeText,
  pairedConversion,
  type ConversionStatus,
  type DemandReconciliation,
} from './conversion-outcome';
import { ProductionVersionError, selectProductionVersion, type ProductionVersionView } from './production-version';

export const PLANNED_ORDER_CONVERT_CAPABILITY = 'PROD.PLANNEDORDER.CONVERT';
export const PLANNED_ORDER_CONVERT_ROUTE = '/production/planned-order-conversion';
export const PLANNED_ORDER_CONVERT_ALIAS = 'CO40';
export const PLANNED_ORDER_CONVERT_COLLECTIVE_CAPABILITY = 'PROD.PLANNEDORDER.CONVERT.COLLECTIVE';
export const PLANNED_ORDER_CONVERT_COLLECTIVE_ROUTE = '/production/planned-order-conversion-collective';
export const PLANNED_ORDER_CONVERT_COLLECTIVE_ALIAS = 'CO41';
export const CONVERSION_LIMIT = 25;

const REFUSED: Record<string, string> = {
  mrpArea: 'An MRP area is not stored. The plant is the selection boundary. The filter was not applied.',
  openingDate: 'An opening date is not stored. It was not used as a filter.',
  productionVersion: 'A production version is not stored on the planned order. It was not used as a filter. The version is selected at conversion, and the first match is not taken.',
  salesOrder: 'A sales order is not stored on the planned order. It was not used as a filter.',
  wbs: 'A WBS element is not stored on the planned order. It was not used as a filter.',
  availability: 'Component availability is not checked. It was not used as a filter.',
  orderType: 'An order type is not a search filter. Enter it when converting. The list was not filtered.',
  bomExplosionNumber: 'A BOM explosion number is not stored. It was not used as a filter.',
  partialQuantity: 'Partial conversion is not supported. The quantity was not reduced.',
};

export class PlannedOrderConversionError extends Error {
  readonly code: string;
  readonly remedy: string;
  /** A thrown error is never a created order. ROLLED_BACK refused a conversion. NOT_ATTEMPTED stopped before one. */
  readonly reconciliation: 'ROLLED_BACK' | 'NOT_ATTEMPTED';
  constructor(code: string, message: string, remedy = '', reconciliation: 'ROLLED_BACK' | 'NOT_ATTEMPTED' = 'ROLLED_BACK') {
    super(message);
    this.name = 'PlannedOrderConversionError';
    this.code = code;
    this.remedy = remedy;
    this.reconciliation = reconciliation;
  }
}

export interface ConversionComponentPreview {
  itemNumber: string;
  materialNumber: string;
  bomQuantity: string;
  bomUnit: string;
  requiredQuantity: string;
  unit: string;
  /** BOM item the line was copied from. Null only when a line was not derived. */
  bomItem: string | null;
  /** Material whose bill of material supplied the line. */
  sourceMaterial: string | null;
}

export interface ConversionSuppliedComponent {
  materialNumber: string;
  plant?: string | null;
  requiredQuantity: number;
  bomItem?: string | null;
  sourceMaterial?: string | null;
}

export interface ConversionPreview {
  orderNumber: string;
  materialNumber: string;
  plant: string;
  quantity: string;
  unit: string;
  startDate: string;
  finishDate: string;
  firmingStatus: string;
  origin: string;
  version: number;
  procurementType: string | null;
  eligible: boolean;
  blockedReason: string | null;
  productionVersion: string | null;
  bomUsage: string | null;
  bomAlternative: string | null;
  routingGroup: string | null;
  groupCounter: string | null;
  /** Operations that will be copied. Zero when the routing could not be copied. */
  operationCount: number;
  productionOrderNumber: string | null;
  productionOrderStatus: string | null;
  components: ConversionComponentPreview[];
  warnings: string[];
}

export interface ConversionSearch {
  plant: string;
  materialNumber?: string | null;
  orderNumber?: string | null;
  orderFrom?: string | null;
  orderTo?: string | null;
  mrpController?: string | null;
  firmingStatus?: string | null;
  converted?: string | null;
  offset?: number | null;
  named?: Record<string, string | null | undefined>;
}

export interface ConversionList {
  rows: ConversionPreview[];
  total: number;
  truncated: boolean;
}

export type { ConversionStatus, DemandReconciliation } from './conversion-outcome';

export interface PlannedOrderConversionResult {
  status: ConversionStatus;
  plannedOrderNumber: string;
  productionOrderNumber: string | null;
  productionOrderStatus: ProductionOrderStatus | null;
  code: string | null;
  message: string;
  remedy: string | null;
  warnings: string[];
  reconciliation: DemandReconciliation;
}

export interface ConversionLogEntry {
  changedAt: string;
  objectClass: string;
  objectKey: string;
  changeType: string;
  transactionCode: string | null;
  changedBy: string;
  correlationId: string | null;
  reason: string | null;
}

interface StandingOrder {
  orderNumber: string;
  materialNumber: string;
  plant: string;
  quantity: string;
  unit: string;
  startDate: string;
  finishDate: string;
  firmingStatus: string;
  origin: string;
  version: number;
}

function fail(code: string, message: string, remedy = ''): never {
  const beforeConversion = code === 'EMPTY' || code === 'TOO_MANY' || code === 'UNSUPPORTED' || code === 'UNSUPPORTED_FILTER';
  throw new PlannedOrderConversionError(code, message, remedy, beforeConversion ? 'NOT_ATTEMPTED' : 'ROLLED_BACK');
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function requiredConversionOrderType(raw: string | null | undefined): string {
  if (raw == null || raw.trim() === '') {
    fail(
      'ORDER_TYPE',
      'A production order type is required. Nothing was converted.',
      'Enter a standing category 10 production order type. A scheduling profile does not propose one.',
    );
  }
  return raw;
}

export function plannedOrderConversionRefusal(fields: Record<string, string | null | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!clean(value)) continue;
    return REFUSED[name] ?? `${name} is not a field of this conversion. It was not applied.`;
  }
  return null;
}

export function holdsPlannedOrderConvertAuthority(held: readonly string[]): boolean {
  return held.includes(PLANNED_ORDER_CONVERT_CAPABILITY);
}

export function holdsPlannedOrderCollectiveAuthority(held: readonly string[]): boolean {
  return held.includes(PLANNED_ORDER_CONVERT_COLLECTIVE_CAPABILITY);
}

function orderNumberOf(value: string): string {
  const number = clean(value);
  if (!number) fail('NOT_FOUND', 'A planned order number is required.', 'Enter the order number, or choose one from the list.');
  if (number.length > 12) fail('NOT_FOUND', 'The planned order number is too long.', 'Use the number as it stands.');
  return number;
}

function sameQuantity(left: string | number, right: string | number): boolean {
  return Number(left).toFixed(3) === Number(right).toFixed(3);
}

function textOf(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/** A stored calendar date. An empty or impossible value is not a requirement date. */
function calendarDate(value: unknown): string | null {
  const text = textOf(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return null;
  return text;
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

async function loadOrder(tx: Tx, client: string, orderNumber: string, lock: boolean): Promise<StandingOrder | null> {
  const found = lock
    ? await rows(tx, sql`
        select order_number, material_number, plant, quantity::text as quantity, unit,
               start_date::text as start_date, finish_date::text as finish_date,
               firming_status, origin, version
          from planned_order
         where client = ${client} and order_number = ${orderNumber}
         for update
      `)
    : await rows(tx, sql`
        select order_number, material_number, plant, quantity::text as quantity, unit,
               start_date::text as start_date, finish_date::text as finish_date,
               firming_status, origin, version
          from planned_order
         where client = ${client} and order_number = ${orderNumber}
      `);
  const row = found[0];
  if (!row) return null;
  return {
    orderNumber: String(row.order_number),
    materialNumber: String(row.material_number),
    plant: String(row.plant),
    quantity: String(row.quantity),
    unit: String(row.unit),
    startDate: String(row.start_date),
    finishDate: String(row.finish_date),
    firmingStatus: String(row.firming_status),
    origin: String(row.origin),
    version: Number(row.version),
  };
}

async function linkedOrder(tx: Tx, client: string, orderNumber: string): Promise<{ orderNumber: string; status: string } | null> {
  const found = await rows(tx, sql`
    select order_number, status
      from production_order
     where client = ${client} and planned_order_number = ${orderNumber}
  `);
  if (!found[0]) return null;
  return { orderNumber: String(found[0].order_number), status: String(found[0].status) };
}

async function assess(
  tx: Tx,
  client: string,
  order: StandingOrder,
  selection?: { orderType: string; productionVersion?: string | null },
): Promise<Omit<ConversionPreview, 'productionOrderNumber' | 'productionOrderStatus'>> {
  const warnings = [
    'Component availability is not checked.',
    'Dates are copied. They are not rescheduled.',
    'Partial conversion is not supported.',
    'The planned order is not deleted.',
    'No reservation, goods movement, journal, confirmation, or settlement is posted.',
  ];
  let blocked: string | null = null;
  let selected: ProductionVersionView | null = null;
  let procurementType: string | null = null;
  let operationCount = 0;
  const components: ConversionComponentPreview[] = [];

  const [plantView] = await tx.select({
    procurementType: materialPlant.procurementType,
  }).from(materialPlant).where(and(
    eq(materialPlant.client, client),
    eq(materialPlant.materialNumber, order.materialNumber),
    eq(materialPlant.plant, order.plant),
  ));
  procurementType = plantView?.procurementType ?? null;
  if (!plantView) blocked = `Material ${order.materialNumber} is not extended to plant ${order.plant}.`;
  else if (procurementType === 'BUY') blocked = `Material ${order.materialNumber} is externally procured. It was not converted to a production order.`;
  else if (procurementType !== 'MAKE' && procurementType !== 'BOTH') blocked = `Material ${order.materialNumber} has no in-house procurement type.`;

  const [produced] = await tx.select({ baseUnit: material.baseUnit }).from(material).where(and(
    eq(material.client, client), eq(material.materialNumber, order.materialNumber),
  ));
  if (!blocked && produced?.baseUnit && order.unit !== produced.baseUnit) {
    blocked = `The planned order unit is ${order.unit}. The production order stores the material base unit ${produced.baseUnit}. The quantity was not converted.`;
  }

  if (!blocked) {
    try {
      const profile = await readMaterialSchedulingProfile(tx, client, order.materialNumber, order.plant);
      warnings.push(profile?.releaseOnCreate === 'X'
        ? 'The scheduling profile releases the order when it is created. Conversion does not add a second release.'
        : 'The order is created and not released. No scheduling profile asks for release at creation.');
    } catch (caught) {
      if (caught instanceof SchedulingProfileError) blocked = caught.message;
      else throw caught;
    }
  }

  if (!blocked) {
    try {
      // Search has no order type. It keeps the existing automatic selector and does not guess a type.
      let requested: string | undefined;
      if (selection) {
        const mode = await readProductionVersionSelection(tx, client, order.plant, selection.orderType);
        requested = productionVersionForSelection(mode, selection.productionVersion, order.plant, selection.orderType);
      }
      selected = await selectProductionVersion(client, {
        materialNumber: order.materialNumber,
        plant: order.plant,
        keyDate: order.finishDate,
        quantity: order.quantity,
        unit: order.unit,
        productionVersion: requested,
        context: 'ORDER',
      }, tx);
    } catch (caught) {
      if (caught instanceof ProductionVersionError || caught instanceof OrderTypeParameterError) blocked = caught.message;
      else throw caught;
    }
  }

  if (selected && !blocked) {
    try {
      const copied = await resolveOrderOperationSnapshot(tx, {
        client,
        plant: order.plant,
        finishDate: order.finishDate,
        taskListType: selected.taskListType,
        routingGroup: selected.routingGroup,
        groupCounter: selected.groupCounter,
        productionVersion: selected.productionVersion,
      });
      operationCount = copied.operations.length;
      warnings.push(...copied.warnings);
    } catch (caught) {
      if (caught instanceof OrderOperationSnapshotError) blocked = caught.message;
      else throw caught;
    }
  }

  if (selected) {
    const [header] = await tx.select().from(materialBom).where(and(
      eq(materialBom.client, client),
      eq(materialBom.materialNumber, order.materialNumber),
      eq(materialBom.plant, order.plant),
      eq(materialBom.usage, selected.bomUsage),
      eq(materialBom.alternative, selected.bomAlternative),
    ));
    if (!header || header.deletionFlag === 'X') {
      blocked = `Bill of material ${selected.bomUsage}/${selected.bomAlternative} does not stand. No order was created.`;
    } else {
      const items = await tx.select().from(materialBomItem).where(and(
        eq(materialBomItem.client, client),
        eq(materialBomItem.materialNumber, order.materialNumber),
        eq(materialBomItem.plant, order.plant),
        eq(materialBomItem.usage, selected.bomUsage),
        eq(materialBomItem.alternative, selected.bomAlternative),
      )).orderBy(asc(materialBomItem.itemNumber));
      const inEffect = items.filter((item) => item.deletionFlag !== 'X' && item.validFrom <= order.finishDate && item.validTo >= order.finishDate);
      if (inEffect.length < items.filter((item) => item.deletionFlag !== 'X').length) {
        warnings.push('Bill of material items outside the finish date were not copied.');
      }
      if (inEffect.length === 0) {
        blocked = 'The selected bill of material has no component in effect on the finish date. No order was created.';
      }
      for (const item of inEffect) {
        if (blocked) break;
        if (item.phantom === 'X') {
          blocked = `Component ${item.itemNumber} is a phantom. Conversion does not explode through a phantom, and the item was not dropped.`;
        } else if (item.bulkMaterial === 'X') {
          blocked = `Component ${item.itemNumber} is a bulk material. It was not silently omitted.`;
        } else if (item.coproduct === 'X') {
          blocked = `Component ${item.itemNumber} is a co-product. It was not copied.`;
        } else if (item.specialProcurement?.trim()) {
          blocked = `Component ${item.itemNumber} has special procurement ${item.specialProcurement}. It was not copied.`;
        } else if (item.issuingPlant && item.issuingPlant !== order.plant) {
          blocked = `Component ${item.itemNumber} is issued from plant ${item.issuingPlant}. The production order component does not store a different issuing plant.`;
        } else if (item.followUpMaterial?.trim()) {
          blocked = `Component ${item.itemNumber} names follow-up material ${item.followUpMaterial}. It was not substituted.`;
        } else if (!item.componentMaterial || item.quantity == null || !item.unit) {
          blocked = `Component ${item.itemNumber} has no material, quantity, or unit. It was not dropped.`;
        } else {
          const raw = componentRequirementQuantity({
            parentQuantity: toScaled(order.quantity, 3),
            itemQuantity: toScaled(String(item.quantity), 3),
            baseQuantity: toScaled(String(header.baseQuantity), 3),
            scrapPercent: item.scrapPercent,
            fixed: item.fixedQuantity === 'X',
          });
          if (raw == null) {
            blocked = `Component ${item.itemNumber} has no positive requirement quantity.`;
          } else {
            try {
              const base = await toBaseQuantity(tx, client, {
                materialNumber: item.componentMaterial,
                quantity: Number(fromScaled(raw, 3)),
                entryUnit: item.unit,
              });
              components.push({
                itemNumber: item.itemNumber,
                materialNumber: item.componentMaterial,
                bomQuantity: fromScaled(raw, 3),
                bomUnit: item.unit,
                requiredQuantity: Number(base.baseQuantity).toFixed(3),
                unit: base.baseUnit,
                bomItem: item.itemNumber,
                sourceMaterial: order.materialNumber,
              });
            } catch (caught) {
              blocked = caught instanceof UnitConversionError
                ? caught.message
                : `Component ${item.itemNumber} could not be converted to its base unit.`;
            }
          }
        }
      }
    }
  }

  return {
    orderNumber: order.orderNumber,
    materialNumber: order.materialNumber,
    plant: order.plant,
    quantity: order.quantity,
    unit: order.unit,
    startDate: order.startDate,
    finishDate: order.finishDate,
    firmingStatus: order.firmingStatus,
    origin: order.origin,
    version: order.version,
    procurementType,
    eligible: blocked == null && components.length > 0,
    blockedReason: blocked ?? (components.length === 0 ? 'No component could be snapshotted.' : null),
    productionVersion: selected?.productionVersion ?? null,
    bomUsage: selected?.bomUsage ?? null,
    bomAlternative: selected?.bomAlternative ?? null,
    routingGroup: selected?.routingGroup ?? null,
    groupCounter: selected?.groupCounter ?? null,
    operationCount: blocked ? 0 : operationCount,
    components: blocked ? [] : components,
    warnings,
  };
}

function productionOrderStatusOf(status: string, orderNumber: string): ProductionOrderStatus {
  const parsed = parseProductionOrderStatus(status);
  if (!parsed) {
    throw new PlannedOrderConversionError(
      `Status ${status} on production order ${orderNumber} is not a production-order status.`,
      'The stored status is unsupported. It was not treated as created.',
    );
  }
  return parsed;
}

function previewOf(
  assessed: Omit<ConversionPreview, 'productionOrderNumber' | 'productionOrderStatus'>,
  link: { orderNumber: string; status: string } | null,
): ConversionPreview {
  if (!link) return { ...assessed, productionOrderNumber: null, productionOrderStatus: null };
  return {
    ...assessed,
    eligible: false,
    blockedReason: `Already converted to production order ${link.orderNumber}.`,
    productionOrderNumber: link.orderNumber,
    productionOrderStatus: link.status,
    components: assessed.components,
  };
}

export async function previewPlannedOrderConversion(client: string, orderNumber: string): Promise<ConversionPreview | null> {
  const number = orderNumberOf(orderNumber);
  return withTenant(client, async (tx) => {
    const order = await loadOrder(tx, client, number, false);
    if (!order) return null;
    const link = await linkedOrder(tx, client, number);
    const assessed = await assess(tx, client, order);
    const standing = await rows(tx, sql`
      select count(*)::int as open_count
        from mrp_dependent_requirement
       where client = ${client} and parent_order_number = ${number} and status = 'OPEN'
    `);
    const openCount = Number(standing[0]?.open_count ?? 0);
    if (openCount > 0) {
      assessed.warnings.push(`${openCount} open dependent requirement(s) stand. Conversion closes a row only when the source material, bill of material item, component, plant, unit, quantity, and a calendar date match one component. A row that does not match stays open.`);
    }
    return previewOf(assessed, link);
  });
}

function refuseSearch(input: ConversionSearch): void {
  const named = plannedOrderConversionRefusal(input.named);
  if (named) fail('UNSUPPORTED_FILTER', named, 'Remove the filter. Search writes nothing.');
  const material = clean(input.materialNumber).toUpperCase();
  if (material.includes('*') || material.includes('%')) {
    fail('UNSUPPORTED_FILTER', 'A material wildcard is not supported. The material was not searched as a partial name.', 'Enter the full material number.');
  }
  const firming = clean(input.firmingStatus).toUpperCase();
  if (firming && firming !== 'OPEN' && firming !== 'FIRMED') {
    fail('UNSUPPORTED_FILTER', `Status ${firming} is not a planned-order state.`, 'Use open, firmed, or converted.');
  }
  const converted = clean(input.converted).toUpperCase();
  if (converted && converted !== 'YES' && converted !== 'NO') {
    fail('UNSUPPORTED_FILTER', `Converted ${converted} is not a stored choice.`, 'Use yes or no, or leave it blank.');
  }
}

export async function listConvertiblePlannedOrders(client: string, input: ConversionSearch): Promise<ConversionList> {
  refuseSearch(input);
  const plant = clean(input.plant).toUpperCase();
  if (!plant) fail('NOT_FOUND', 'A plant is required.', 'The plant is the selection boundary. The first order was not opened.');
  if (plant.length > 10) fail('NOT_FOUND', 'The plant is too long.');
  const materialNumber = clean(input.materialNumber).toUpperCase();
  const orderNumber = clean(input.orderNumber);
  const orderFrom = clean(input.orderFrom);
  const orderTo = clean(input.orderTo);
  const controller = clean(input.mrpController).toUpperCase();
  const firming = clean(input.firmingStatus).toUpperCase();
  const converted = clean(input.converted).toUpperCase();
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) fail('NOT_FOUND', 'The list offset is not valid.');

  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      select o.order_number
        from planned_order o
        left join material_plant mp
          on mp.client = o.client and mp.material_number = o.material_number and mp.plant = o.plant
        left join production_order conv
          on conv.client = o.client and conv.planned_order_number = o.order_number
       where o.client = ${client} and o.plant = ${plant}
         and (${materialNumber} = '' or o.material_number = ${materialNumber})
         and (${orderNumber} = '' or o.order_number = ${orderNumber})
         and (${orderFrom} = '' or o.order_number >= ${orderFrom})
         and (${orderTo} = '' or o.order_number <= ${orderTo})
         and (${controller} = '' or mp.mrp_controller = ${controller})
         and (${firming} = '' or o.firming_status = ${firming})
         and (${converted} <> 'YES' or conv.order_number is not null)
         and (${converted} <> 'NO' or conv.order_number is null)
       order by o.order_number
       limit ${CONVERSION_LIMIT + 1}
       offset ${offset}
    `);
    const truncated = found.length > CONVERSION_LIMIT;
    const numbers = found.slice(0, CONVERSION_LIMIT).map((row) => String(row.order_number));
    const listed: ConversionPreview[] = [];
    for (const number of numbers) {
      const order = await loadOrder(tx, client, number, false);
      if (!order) continue;
      const link = await linkedOrder(tx, client, number);
      listed.push(previewOf(await assess(tx, client, order), link));
    }
    const totalRows = await rows(tx, sql`
      select count(*)::int as total
        from planned_order o
        left join material_plant mp
          on mp.client = o.client and mp.material_number = o.material_number and mp.plant = o.plant
        left join production_order conv
          on conv.client = o.client and conv.planned_order_number = o.order_number
       where o.client = ${client} and o.plant = ${plant}
         and (${materialNumber} = '' or o.material_number = ${materialNumber})
         and (${orderNumber} = '' or o.order_number = ${orderNumber})
         and (${orderFrom} = '' or o.order_number >= ${orderFrom})
         and (${orderTo} = '' or o.order_number <= ${orderTo})
         and (${controller} = '' or mp.mrp_controller = ${controller})
         and (${firming} = '' or o.firming_status = ${firming})
         and (${converted} <> 'YES' or conv.order_number is not null)
         and (${converted} <> 'NO' or conv.order_number is null)
    `);
    return { rows: listed, total: Number(totalRows[0]?.total ?? listed.length), truncated };
  });
}

function suppliedSnapshotMatches(
  supplied: ConversionSuppliedComponent[],
  derived: ConversionComponentPreview[],
  plant: string,
): boolean {
  if (supplied.length !== derived.length) return false;
  const used = new Set<number>();
  for (const line of supplied) {
    const materialNumber = line.materialNumber.trim();
    const linePlant = (line.plant ?? plant).trim();
    const index = derived.findIndex((row, position) => !used.has(position)
      && row.materialNumber === materialNumber
      && linePlant === plant
      && sameQuantity(line.requiredQuantity, row.requiredQuantity)
      && (line.bomItem == null || line.bomItem.trim() === '' || line.bomItem.trim() === row.bomItem)
      && (line.sourceMaterial == null || line.sourceMaterial.trim() === '' || line.sourceMaterial.trim() === row.sourceMaterial));
    if (index < 0) return false;
    used.add(index);
  }
  return true;
}

function dependentKey(row: Record<string, unknown>): string {
  return `${textOf(row.source_material)}/${textOf(row.item_number)}`;
}

/** Established differences only. An empty list means the open row is a safe match. */
function mismatchOf(component: Record<string, unknown>, dependent: Record<string, unknown>): string[] {
  const found: string[] = [];
  if (!calendarDate(dependent.requirement_date)) found.push('no authoritative requirement date');
  if (textOf(dependent.material_number) !== textOf(component.material_number)) {
    found.push(`material ${textOf(dependent.material_number)} is not ${textOf(component.material_number)}`);
  }
  if (textOf(dependent.plant) !== textOf(component.plant)) {
    found.push(`plant ${textOf(dependent.plant)} is not ${textOf(component.plant)}`);
  }
  if (textOf(dependent.unit) !== textOf(component.unit_of_measure)) {
    found.push(`unit ${textOf(dependent.unit)} is not ${textOf(component.unit_of_measure)}`);
  }
  if (!sameQuantity(textOf(dependent.quantity), textOf(component.required_quantity))) {
    found.push(`quantity ${textOf(dependent.quantity)} is not ${textOf(component.required_quantity)}`);
  }
  return found;
}

/**
 * Copy a component requirement date from a matching dependent requirement, then
 * close only that row. The order start, finish, bill of material date, and
 * today are not read. A line that does not match is left undated and its
 * dependent requirement stays open. A write that does not land rolls the
 * conversion back, so a dependent requirement is never closed without its
 * replacement. A reason is reported only when the stored rows establish it.
 */
async function replaceMatchedDependentDemand(
  tx: Tx,
  client: string,
  plannedOrderNumber: string,
  productionOrderNumber: string,
  actor: string,
): Promise<{ warnings: string[]; reconciliation: 'COMPLETE' | 'PARTIAL' | 'NONE' }> {
  const components = await rows(tx, sql`
    select item_number, material_number, plant, required_quantity::text as required_quantity,
           unit_of_measure, bom_item, source_material
      from production_order_component
     where client = ${client} and order_number = ${productionOrderNumber}
     for update
  `);
  const dependents = await rows(tx, sql`
    select source_material, item_number, material_number, plant, quantity::text as quantity,
           unit, requirement_date::text as requirement_date, status
      from mrp_dependent_requirement
     where client = ${client} and parent_order_number = ${plannedOrderNumber}
     for update
  `);
  const open = dependents.filter((row) => textOf(row.status) === 'OPEN');
  const closed = dependents.filter((row) => textOf(row.status) === 'CLOSED');
  const warnings: string[] = [];
  const explained = new Set<string>();
  if (open.length === 0 && closed.length === 0) {
    warnings.push('No open dependent requirement stood for this planned order. No component requirement date was invented.');
    return { warnings, reconciliation: 'NONE' };
  }
  const claims = new Map<string, number>();
  for (const component of components) {
    const source = textOf(component.source_material);
    const bomItem = textOf(component.bom_item);
    if (!source || !bomItem) continue;
    const key = `${source}/${bomItem}`;
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }
  const matched: Array<{ component: Record<string, unknown>; dependent: Record<string, unknown>; date: string }> = [];
  const skipped: string[] = [];
  for (const component of components) {
    const label = `Item ${textOf(component.item_number)}`;
    const source = textOf(component.source_material);
    const bomItem = textOf(component.bom_item);
    if (!source || !bomItem) {
      skipped.push(`${label} has no bill-of-material identity. No requirement date was invented.`);
      continue;
    }
    const key = `${source}/${bomItem}`;
    if ((claims.get(key) ?? 0) !== 1) {
      skipped.push(`${label} is not the only line for ${key}. No requirement date was copied.`);
      explained.add(key);
      continue;
    }
    const candidates = open.filter((row) => textOf(row.source_material) === source && textOf(row.item_number) === bomItem);
    if (candidates.length > 1) {
      skipped.push(`${label} has more than one open dependent requirement for ${key}. None was closed.`);
      explained.add(key);
      continue;
    }
    if (candidates.length === 0) {
      const prior = closed.filter((row) => textOf(row.source_material) === source && textOf(row.item_number) === bomItem);
      if (prior.length === 1) {
        skipped.push(`Dependent requirement ${textOf(prior[0]!.item_number)} is already closed. It was not reopened, and ${label} was not dated from it.`);
        explained.add(key);
      } else {
        skipped.push(`No dependent requirement stands for ${key}. ${label} was not dated. The order start, finish, bill of material date, and today were not used.`);
      }
      continue;
    }
    const dependent = candidates[0]!;
    const diffs = mismatchOf(component, dependent);
    if (diffs.length > 0) {
      skipped.push(`${label} does not match dependent requirement ${textOf(dependent.item_number)}: ${diffs.join('; ')}. It stayed open.`);
      explained.add(key);
      continue;
    }
    const date = calendarDate(dependent.requirement_date);
    if (!date) {
      skipped.push(`${label} has no authoritative requirement date. It stayed open.`);
      explained.add(key);
      continue;
    }
    matched.push({ component, dependent, date });
  }
  for (const match of matched) {
    const dated = await rows(tx, sql`
      update production_order_component
         set requirement_date = ${match.date}::date,
             changed_by = ${actor},
             changed_at = now()
       where client = ${client}
         and order_number = ${productionOrderNumber}
         and item_number = ${Number(match.component.item_number)}
         and requirement_date is null
         and bom_item = ${String(match.component.bom_item)}
         and source_material = ${String(match.component.source_material)}
         and material_number = ${String(match.component.material_number)}
         and plant = ${String(match.component.plant)}
         and unit_of_measure = ${String(match.component.unit_of_measure)}
         and required_quantity = ${String(match.component.required_quantity)}::numeric
      returning item_number
    `);
    if (dated.length !== 1) {
      fail(
        'DEMAND',
        `The requirement date for component item ${textOf(match.component.item_number)} was not stored. Nothing was converted.`,
        'The dependent requirement was not closed.',
      );
    }
    const closed = await rows(tx, sql`
      update mrp_dependent_requirement
         set status = 'CLOSED', version = version + 1, changed_by = ${actor}, changed_at = now()
       where client = ${client}
         and parent_order_number = ${plannedOrderNumber}
         and source_material = ${String(match.dependent.source_material)}
         and item_number = ${String(match.dependent.item_number)}
         and material_number = ${String(match.dependent.material_number)}
         and plant = ${String(match.dependent.plant)}
         and unit = ${String(match.dependent.unit)}
         and quantity = ${String(match.dependent.quantity)}::numeric
         and requirement_date = ${match.date}::date
         and status = 'OPEN'
      returning item_number
    `);
    if (closed.length !== 1) {
      fail(
        'DEMAND',
        `Dependent requirement ${textOf(match.dependent.item_number)} could not be closed after its replacement date was stored. Nothing was converted.`,
        'No dependent requirement of another planned order was closed.',
      );
    }
  }
  if (matched.length > 0) {
    warnings.push(`${matched.length} dependent requirement(s) were closed after the same requirement date and quantity were stored on the production order. They are not counted twice.`);
  }
  const matchedKeys = new Set(matched.map((match) => dependentKey(match.dependent)));
  const untouched = open.filter((row) => !matchedKeys.has(dependentKey(row)));
  for (const row of untouched) {
    const key = dependentKey(row);
    if (explained.has(key)) continue;
    warnings.push(`Dependent requirement ${textOf(row.item_number)} has no production-order component for ${key}. It stayed open.`);
  }
  for (const row of closed) {
    const key = dependentKey(row);
    if (explained.has(key)) continue;
    warnings.push(`Dependent requirement ${textOf(row.item_number)} for ${key} is already closed. It was not reopened.`);
  }
  if (untouched.length > 0) {
    warnings.push(`${untouched.length} dependent requirement(s) stayed open. No replacement date was established for them. The order start, finish, bill of material date, and today were not used.`);
  }
  if (open.length === 0) {
    warnings.push('No open dependent requirement stood for this planned order. No component requirement date was invented.');
  }
  if (skipped.length > 0) {
    warnings.push(`These component lines were not dated: ${skipped.join(' ')}`);
  }
  const reconciliation: 'COMPLETE' | 'PARTIAL' | 'NONE' = open.length === 0
    ? 'NONE'
    : untouched.length === 0
      ? 'COMPLETE'
      : 'PARTIAL';
  return { warnings, reconciliation };
}

function outcomeOf(
  created: CreateProductionOrderResult,
  warnings: string[],
  status: 'CONVERTED',
  message: string,
  reconciliation: 'COMPLETE' | 'PARTIAL' | 'NONE',
): PlannedOrderConversionResult {
  if (!pairedConversion(status, reconciliation)) {
    fail('OUTCOME', 'The conversion outcome is not a known pair. Nothing was reported as a successful reconciliation.');
  }
  return {
    status,
    plannedOrderNumber: created.plannedOrderNumber ?? '',
    productionOrderNumber: created.orderNumber,
    productionOrderStatus: created.status,
    code: null,
    message,
    remedy: null,
    warnings,
    reconciliation,
  };
}

export async function convertPlannedOrder(input: {
  client: string;
  changedBy: string;
  orderNumber: string;
  expectedVersion?: number | null;
  quantity?: string | null;
  unit?: string | null;
  startDate?: string | null;
  finishDate?: string | null;
  correlationId?: string | null;
  transactionCode?: string | null;
  /**
   * Explicit production order type. Required. A scheduling profile, a material,
   * and the first standing type are not used.
   */
  orderType: string;
  /**
   * Named production version. Required when this plant and order type use manual selection.
   * Not a search filter. Automatic selection does not require it.
   */
  productionVersion?: string | null;
  /**
   * An independent component snapshot. It is not stored as the order snapshot.
   * It is accepted only when it matches the selected version's bill of material.
   * A mismatch fails and does not attach the version to the supplied lines.
   */
  components?: ConversionSuppliedComponent[] | null;
  named?: Record<string, string | null | undefined>;
}): Promise<PlannedOrderConversionResult> {
  const named = plannedOrderConversionRefusal(input.named);
  if (named) fail('UNSUPPORTED', named);
  const orderType = requiredConversionOrderType(input.orderType);
  const actor = clean(input.changedBy);
  if (!actor || actor.length > 60) fail('NOT_FOUND', 'The user who converted the order is required.');
  const orderNumber = orderNumberOf(input.orderNumber);
  const requestedQuantity = clean(input.quantity);
  const requestedUnit = clean(input.unit).toUpperCase();
  const requestedStart = clean(input.startDate);
  const requestedFinish = clean(input.finishDate);

  return withTenant(input.client, async (tx) => {
    const order = await loadOrder(tx, input.client, orderNumber, true);
    if (!order) fail('NOT_FOUND', `Planned order ${orderNumber} does not stand.`, 'Choose an order that stands in this tenant.');
    const link = await linkedOrder(tx, input.client, orderNumber);
    if (link) {
      return {
        status: 'ALREADY_CONVERTED' as const,
        plannedOrderNumber: orderNumber,
        productionOrderNumber: link.orderNumber,
        productionOrderStatus: productionOrderStatusOf(link.status, link.orderNumber),
        code: 'ALREADY_CONVERTED',
        message: `Planned order ${orderNumber} was already converted to production order ${link.orderNumber}. No second order was created. ${conversionOutcomeText('ALREADY_CONVERTED', 'NOT_RERUN')}`,
        remedy: 'Open the production order. The planned order was not deleted.',
        warnings: [
          'The quantity was not reduced. Partial conversion was not performed.',
          'Dependent requirements were not reconciled again. The prior reconciliation was not revalidated. The existing production order was returned.',
        ],
        reconciliation: 'NOT_RERUN',
      };
    }
    if (input.expectedVersion != null && order.version !== input.expectedVersion) {
      fail('CONCURRENT', 'The planned order was changed by someone else. Nothing was converted.', 'Open it again, then convert.');
    }
    if (requestedQuantity && !sameQuantity(requestedQuantity, order.quantity)) {
      fail('PARTIAL', `Partial conversion is not supported. The planned quantity is ${order.quantity}. It was not reduced or split.`, 'Convert the whole order, or change it on MD12 before conversion.');
    }
    if (requestedUnit && requestedUnit !== order.unit) {
      fail('UNIT', `The unit is stored as ${order.unit}. A different unit was not substituted.`);
    }
    if ((requestedStart && requestedStart !== order.startDate) || (requestedFinish && requestedFinish !== order.finishDate)) {
      fail('DATE', 'The dates were not changed during conversion.', 'Change the dates on MD12, then convert. Conversion copies the stored dates.');
    }
    const [type] = await tx.select().from(productionOrderType).where(and(
      eq(productionOrderType.client, input.client),
      eq(productionOrderType.orderType, orderType),
    ));
    if (!type) {
      fail(
        'ORDER_TYPE',
        `Order type ${orderType} does not stand in this tenant. Nothing was converted.`,
        'Define the production order type first. An order-type parameter is not proof that the type stands.',
      );
    }
    if (type.orderCategory !== '10') {
      fail(
        'ORDER_TYPE',
        `Order type ${orderType} is not a production order type. Nothing was converted.`,
        'Use a category 10 type. Process orders and networks are not assigned here.',
      );
    }
    const assessed = await assess(tx, input.client, order, {
      orderType,
      productionVersion: input.productionVersion,
    });
    if (!assessed.eligible) {
      fail('INELIGIBLE', assessed.blockedReason ?? 'The planned order cannot be converted.', 'Correct the master data, then convert again. Nothing was saved.');
    }
    if (!assessed.productionVersion || !assessed.bomUsage || !assessed.bomAlternative) {
      fail(
        'VERSION',
        'Conversion did not select a production version. Nothing was converted.',
        'The first version was not chosen. Correct the order type parameters or name a version.',
      );
    }
    if (input.components != null && !suppliedSnapshotMatches(input.components, assessed.components, order.plant)) {
      fail(
        'SNAPSHOT',
        `The supplied component snapshot does not match production version ${assessed.productionVersion}. Nothing was converted.`,
        'Remove the supplied snapshot, or supply the lines from that version. The version was not attached to the supplied lines.',
      );
    }
    let created: CreateProductionOrderResult;
    try {
      created = await createProductionOrder({
        client: input.client,
        createdBy: actor,
        requestKey: `convert/${order.orderNumber}`,
        materialNumber: order.materialNumber,
        plant: order.plant,
        orderQuantity: Number(order.quantity),
        scheduledStart: order.startDate,
        scheduledFinish: order.finishDate,
        orderType,
        productionVersion: assessed.productionVersion,
      }, { tx, plannedOrderNumber: order.orderNumber });
    } catch (caught) {
      if (caught instanceof ProductionOrderError) fail('ORDER', caught.message, caught.remedy);
      throw caught;
    }
    if (created.plannedOrderNumber !== order.orderNumber) {
      fail('ORDER', 'The production order was not linked to this planned order. Nothing was kept.', 'Convert again. A second order was not left behind.');
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'planned_order',
      objectKey: order.orderNumber,
      changeType: 'CHANGE',
      changedBy: actor,
      transactionCode: input.transactionCode?.trim() || PLANNED_ORDER_CONVERT_ALIAS,
      correlationId: input.correlationId ?? undefined,
      reason: `Converted to production order ${created.orderNumber}`,
      before: { productionOrderNumber: null },
      after: { productionOrderNumber: created.orderNumber },
      fieldLabels: { productionOrderNumber: 'Production order' },
    });
    const demand = await replaceMatchedDependentDemand(
      tx,
      input.client,
      order.orderNumber,
      created.orderNumber,
      actor,
    );
    const converted = `Planned order ${order.orderNumber} was converted to production order ${created.orderNumber}. The planned order was not deleted.`;
    const outcome = conversionOutcomeText('CONVERTED', demand.reconciliation);
    const message = demand.reconciliation === 'PARTIAL'
      ? `${converted} Conversion succeeded. ${outcome}`
      : demand.reconciliation === 'NONE'
        ? `${converted} No open dependent requirement was reconciled. ${outcome}`
        : `${converted} ${outcome}`;
    return outcomeOf(created, [...assessed.warnings, ...demand.warnings], 'CONVERTED', message, demand.reconciliation);
  });
}

export function notAttemptedConversion(input: {
  message: string;
  remedy?: string;
  plannedOrderNumber?: string;
}): PlannedOrderConversionResult {
  return {
    status: 'NOT_ATTEMPTED',
    plannedOrderNumber: input.plannedOrderNumber ?? '',
    productionOrderNumber: null,
    productionOrderStatus: null,
    code: 'NOT_ATTEMPTED',
    message: input.message,
    remedy: input.remedy ?? 'Nothing was converted.',
    warnings: [conversionOutcomeText('NOT_ATTEMPTED', 'NOT_ATTEMPTED')],
    reconciliation: 'NOT_ATTEMPTED',
  };
}

export function rolledBackConversion(input: {
  plannedOrderNumber: string;
  code: string;
  message: string;
  remedy?: string;
}): PlannedOrderConversionResult {
  return {
    status: 'FAILED',
    plannedOrderNumber: input.plannedOrderNumber,
    productionOrderNumber: null,
    productionOrderStatus: null,
    code: input.code,
    message: input.message,
    remedy: input.remedy || null,
    warnings: [`${conversionOutcomeText('FAILED', 'ROLLED_BACK')} Dependent requirements were not closed.`],
    reconciliation: 'ROLLED_BACK',
  };
}

export async function convertPlannedOrders(input: {
  client: string;
  changedBy: string;
  orderNumbers: string[];
  correlationId: string;
  /** One explicit type for every selected order. Required. Not inferred. */
  orderType: string;
  /** One named version for every selected order. Required when selection is manual. */
  productionVersion?: string | null;
  /** One supplied snapshot, checked against each selected order. It is not stored unless it matches. */
  components?: ConversionSuppliedComponent[] | null;
  named?: Record<string, string | null | undefined>;
}): Promise<{ correlationId: string; results: PlannedOrderConversionResult[] }> {
  const named = plannedOrderConversionRefusal(input.named);
  if (named) fail('UNSUPPORTED', named);
  const orderType = requiredConversionOrderType(input.orderType);
  const numbers = input.orderNumbers.map((value) => clean(value)).filter(Boolean);
  if (numbers.length === 0) fail('EMPTY', 'No planned order was selected.', 'Select at least one order. Search writes nothing.');
  if (numbers.length > CONVERSION_LIMIT) {
    fail('TOO_MANY', `Select at most ${CONVERSION_LIMIT} planned orders.`, 'Convert the rest in another confirmation. Nothing in this batch was saved.');
  }
  const results: PlannedOrderConversionResult[] = [];
  for (const orderNumber of numbers) {
    try {
      results.push(await convertPlannedOrder({
        client: input.client,
        changedBy: input.changedBy,
        orderNumber,
        orderType,
        productionVersion: input.productionVersion,
        components: input.components,
        correlationId: input.correlationId,
        transactionCode: PLANNED_ORDER_CONVERT_COLLECTIVE_ALIAS,
      }));
    } catch (caught) {
      const error = caught instanceof PlannedOrderConversionError
        ? caught
        : new PlannedOrderConversionError('FAILED', caught instanceof Error ? caught.message : 'The order could not be converted.');
      results.push(rolledBackConversion({
        plannedOrderNumber: orderNumber,
        code: error.code,
        message: error.message,
        remedy: error.remedy,
      }));
    }
  }
  return { correlationId: input.correlationId, results };
}

export async function listConversionLog(client: string, orderNumber: string): Promise<ConversionLogEntry[]> {
  const number = orderNumberOf(orderNumber);
  return withTenant(client, async (tx) => {
    const link = await linkedOrder(tx, client, number);
    const productionKey = link?.orderNumber ?? '';
    const documents = await rows(tx, sql`
      select changed_at, object_class, object_key, change_type, transaction_code, changed_by, correlation_id, reason
        from change_document
       where client = ${client}
         and (
           (object_class = 'planned_order' and object_key = ${number})
           or (${productionKey} <> '' and object_class = 'production_order' and object_key = ${productionKey})
         )
       order by changed_at
    `);
    return documents.map((row) => ({
      changedAt: row.changed_at instanceof Date ? row.changed_at.toISOString() : String(row.changed_at),
      objectClass: String(row.object_class),
      objectKey: String(row.object_key),
      changeType: String(row.change_type),
      transactionCode: row.transaction_code == null ? null : String(row.transaction_code),
      changedBy: String(row.changed_by),
      correlationId: row.correlation_id == null ? null : String(row.correlation_id),
      reason: row.reason == null ? null : String(row.reason),
    }));
  });
}
