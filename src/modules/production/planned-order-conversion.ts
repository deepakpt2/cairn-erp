/**
 * Convert a planned order into a production order — CO40 and CO41.
 *
 * One service. CO41 calls it once per order, each in its own transaction.
 * The production order is created by the existing order service. The BOM
 * quantity uses the shared component-quantity function. The production
 * version is chosen by the shared selector. This file does not insert a
 * production order itself and does not explode through MRP.
 *
 * Full conversion is one-to-one. The planned order is not deleted and its
 * quantity is not reduced. A second conversion returns the existing order.
 * External procurement is refused. Partial quantity is refused.
 *
 * Not carried, because the production order does not store them: operations,
 * a reservation, a goods movement, a journal, a confirmation, costing, and
 * settlement. Availability is not checked. Dates are copied, not rescheduled.
 * An order type is stored only when the caller names one. No scheduling
 * profile, material, or first standing type is used. Checking control is not read.
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
import { materialBom, materialBomItem } from './schema';
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
  constructor(code: string, message: string, remedy = '') {
    super(message);
    this.name = 'PlannedOrderConversionError';
    this.code = code;
    this.remedy = remedy;
  }
}

export interface ConversionComponentPreview {
  itemNumber: string;
  materialNumber: string;
  bomQuantity: string;
  bomUnit: string;
  requiredQuantity: string;
  unit: string;
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

export interface PlannedOrderConversionResult {
  status: 'CONVERTED' | 'ALREADY_CONVERTED' | 'FAILED';
  plannedOrderNumber: string;
  productionOrderNumber: string | null;
  productionOrderStatus: ProductionOrderStatus | null;
  code: string | null;
  message: string;
  remedy: string | null;
  warnings: string[];
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
  throw new PlannedOrderConversionError(code, message, remedy);
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

function sameQuantity(left: string, right: string): boolean {
  return Number(left).toFixed(3) === Number(right).toFixed(3);
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

async function assess(tx: Tx, client: string, order: StandingOrder): Promise<Omit<ConversionPreview, 'productionOrderNumber' | 'productionOrderStatus'>> {
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
      selected = await selectProductionVersion(client, {
        materialNumber: order.materialNumber,
        plant: order.plant,
        keyDate: order.finishDate,
        quantity: order.quantity,
        unit: order.unit,
        context: 'ORDER',
      }, tx);
    } catch (caught) {
      if (caught instanceof ProductionVersionError) blocked = caught.message;
      else throw caught;
    }
  }

  if (selected) {
    warnings.push(`Routing ${selected.taskListType} ${selected.routingGroup} ${selected.groupCounter} is named by production version ${selected.productionVersion}. The production order does not store operations, so none were copied.`);
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
    return previewOf(await assess(tx, client, order), link);
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

function outcomeOf(created: CreateProductionOrderResult, warnings: string[], status: 'CONVERTED' | 'ALREADY_CONVERTED', message: string): PlannedOrderConversionResult {
  return {
    status,
    plannedOrderNumber: created.plannedOrderNumber ?? '',
    productionOrderNumber: created.orderNumber,
    productionOrderStatus: created.status,
    code: null,
    message,
    remedy: null,
    warnings,
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
        message: `Planned order ${orderNumber} was already converted to production order ${link.orderNumber}. No second order was created.`,
        remedy: 'Open the production order. The planned order was not deleted.',
        warnings: ['Partial conversion was not performed.'],
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
    const assessed = await assess(tx, input.client, order);
    if (!assessed.eligible) {
      fail('INELIGIBLE', assessed.blockedReason ?? 'The planned order cannot be converted.', 'Correct the master data, then convert again. Nothing was saved.');
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
        components: assessed.components.map((component) => ({
          materialNumber: component.materialNumber,
          plant: order.plant,
          requiredQuantity: Number(component.requiredQuantity),
        })),
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
    return outcomeOf(
      created,
      assessed.warnings,
      'CONVERTED',
      `Planned order ${order.orderNumber} was converted to production order ${created.orderNumber}. The planned order was not deleted.`,
    );
  });
}

export async function convertPlannedOrders(input: {
  client: string;
  changedBy: string;
  orderNumbers: string[];
  correlationId: string;
  /** One explicit type for every selected order. Required. Not inferred. */
  orderType: string;
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
        correlationId: input.correlationId,
        transactionCode: PLANNED_ORDER_CONVERT_COLLECTIVE_ALIAS,
      }));
    } catch (caught) {
      const error = caught instanceof PlannedOrderConversionError
        ? caught
        : new PlannedOrderConversionError('FAILED', caught instanceof Error ? caught.message : 'The order could not be converted.');
      results.push({
        status: 'FAILED',
        plannedOrderNumber: orderNumber,
        productionOrderNumber: null,
        productionOrderStatus: null,
        code: error.code,
        message: error.message,
        remedy: error.remedy || null,
        warnings: [],
      });
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
