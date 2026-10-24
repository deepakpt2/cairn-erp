/**
 * Change production order — CO02.
 *
 * The standing production order is the record. There is no second order table.
 * The number, material, plant, unit, and status stay fixed. A save can change
 * the quantity, the dates, and the component snapshot while no goods movement
 * cites the order.
 *
 * A header quantity change does not rescale components. Operations are not
 * stored, so dates are not rescheduled. This save does not release, technically
 * complete, close, or post.
 *
 * Created and released are the only statuses. A released order with no goods
 * movement can still be changed. A goods movement freezes the snapshot.
 */
import { and, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { toScaled } from '../../platform/posting/decimal';
import { unitOfMeasure } from '../../platform/tables/reference';
import { material, materialPlant, productionOrder, productionOrderComponent } from '../inventory/schema';
import { resolveStorageLocation, StorageLocationError } from '../inventory/storage-location';
import {
  getProductionOrderDisplay,
  type ProductionOrderDisplay,
} from './production-order-display';

export const PRODUCTION_ORDER_CHANGE_CAPABILITY = 'PROD.ORDER.CHANGE';
export const PRODUCTION_ORDER_CHANGE_ROUTE = '/production/production-order-change';
export const PRODUCTION_ORDER_CHANGE_ALIAS = 'CO02';
export const PRODUCTION_ORDER_LOCK = 'PRODUCTION_ORDER';

const REFUSED: Record<string, string> = {
  orderType: 'An order type is not stored. The status stays as it was stored.',
  controllingArea: 'A controlling area is not a key of the order.',
  scrap: 'A scrap quantity is not stored. It was not applied.',
  productionVersion: 'A production version is not stored on the order. Master data was not re-read.',
  schedulingType: 'A scheduling type is not stored. The dates are stored as entered.',
  priority: 'A priority is not stored.',
  operation: 'Operations are not stored. None were added, changed, or deleted.',
  sequence: 'Sequences are not stored.',
  reschedule: 'Lead-time scheduling is not carried. The dates were not recalculated.',
  availability: 'Component availability is not checked on this change.',
  reread: 'Re-reading the bill of material is not this save. The component snapshot was not replaced.',
  bom: 'The bill of material is not stored on the order. This save does not explode one.',
  routing: 'A routing is not stored on the order.',
  release: 'Change does not release the order. Release is a separate act.',
  teco: 'Technical completion is not a status and is not done here.',
  closed: 'A closed status is not stored. Change does not close the order.',
  delete: 'Change does not delete the production order.',
  confirmation: 'A posted confirmation is not changed here. Cancellation is not this screen.',
  cost: 'Cost is not carried. No cost was posted.',
  reservation: 'A reservation is not created or changed here.',
  post: 'A production-order change posts nothing.',
  status: 'Status is not changed by this save. Created and released stay as they stand.',
};

export class ProductionOrderChangeError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'ProductionOrderChangeError';
  }
}

export interface ProductionOrderComponentChange {
  itemNumber?: number | null;
  materialNumber: string;
  requiredQuantity: string;
  unit?: string | null;
  storageLocation?: string | null;
  remove?: boolean;
}

export interface ProductionOrderChangeInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  expectedVersion: number;
  quantity?: string | null;
  unit?: string | null;
  startDate?: string | null;
  finishDate?: string | null;
  materialNumber?: string | null;
  plant?: string | null;
  components?: ProductionOrderComponentChange[] | null;
  named?: Record<string, string | null | undefined>;
}

export interface ProductionOrderChangeResult {
  order: ProductionOrderDisplay;
  changed: boolean;
  warnings: string[];
}

function fail(message: string, remedy?: string): never {
  throw new ProductionOrderChangeError(message, remedy);
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function productionOrderChangeRefusal(fields: Record<string, string | null | undefined> | undefined): string | null {
  if (!fields) return null;
  for (const [name, value] of Object.entries(fields)) {
    if (!clean(value)) continue;
    return REFUSED[name] ?? `${name} is not a field of this change.`;
  }
  return null;
}

export function holdsProductionOrderChangeAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], PRODUCTION_ORDER_CHANGE_CAPABILITY);
}

function dateOf(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} is not a date.`, 'Use a calendar date. A factory calendar is not carried.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    fail(`${label} is not a valid date.`);
  }
  return value;
}

function quantityOf(value: string, decimals: number, label: string): string {
  if (!/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/.test(value)) fail(`${label} is not a number. It was not rounded.`);
  const fraction = (value.split('.')[1] ?? '').replace(/0+$/, '');
  if (fraction.length > Math.min(3, decimals)) fail(`${label} has more decimal places than the unit allows. It was not rounded.`);
  if (Number(value) <= 0) fail(`${label} must be positive.`);
  return value;
}

function sameQuantity(left: string, right: string): boolean {
  return toScaled(left, 3) === toScaled(right, 3);
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return await tx.execute(query) as unknown as Array<Record<string, unknown>>;
}

interface StandingComponent {
  itemNumber: number;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  requiredQuantity: string;
  unit: string;
}

export async function changeProductionOrder(input: ProductionOrderChangeInput): Promise<ProductionOrderChangeResult> {
  const refusal = productionOrderChangeRefusal(input.named);
  if (refusal) fail(refusal);
  const orderNumber = clean(input.orderNumber);
  if (!orderNumber) fail('A production order number is required.');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    fail('Open the order again. The record version is required.', 'Display the order, then change it.');
  }
  const actor = clean(input.changedBy);
  if (!actor || actor.length > 60) fail('The user who changed the order is required.');

  const warnings = [
    'Component quantities were not rescaled from the header quantity.',
    'Operations are not stored, so the dates were not rescheduled.',
    'No goods movement, reservation, journal, or confirmation was posted.',
    'The order was not released by this save.',
  ];

  await withTenant(input.client, async (tx) => {
    const found = await rows(tx, sql`
      select order_number, material_number, plant, order_quantity::text as quantity, unit_of_measure,
             scheduled_start, scheduled_finish, status, version
        from production_order
       where client = ${input.client} and order_number = ${orderNumber}
       for update
    `);
    const header = found[0];
    if (!header) fail(`Production order ${orderNumber} does not stand.`, 'Choose an order that stands in this tenant.');
    if (Number(header.version) !== input.expectedVersion) {
      fail('The production order was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    const status = String(header.status);
    if (status !== 'CREATED' && status !== 'RELEASED') {
      fail(`Status ${status} is not a production-order status. Nothing was saved.`);
    }
    const materialNumber = clean(input.materialNumber).toUpperCase();
    const plant = clean(input.plant).toUpperCase();
    if (materialNumber && materialNumber !== String(header.material_number)) {
      fail('The material is fixed.', 'Create another production order for a different material.');
    }
    if (plant && plant !== String(header.plant)) {
      fail('The plant is fixed.', 'The plant on the order is the production plant.');
    }
    const storedUnit = String(header.unit_of_measure);
    const unit = clean(input.unit).toUpperCase() || storedUnit;
    if (unit !== storedUnit) {
      fail(`The unit is stored as ${storedUnit}. A different unit was not substituted.`);
    }
    const [unitRow] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces }).from(unitOfMeasure).where(eq(unitOfMeasure.code, storedUnit));
    if (!unitRow) fail(`Unit ${storedUnit} does not exist.`);
    const quantity = clean(input.quantity) ? quantityOf(clean(input.quantity), unitRow.decimalPlaces, 'The order quantity') : String(header.quantity);
    const start = clean(input.startDate) ? dateOf(clean(input.startDate), 'The scheduled start') : String(header.scheduled_start);
    const finish = clean(input.finishDate) ? dateOf(clean(input.finishDate), 'The scheduled finish') : String(header.scheduled_finish);
    if (finish < start) fail(`The scheduled finish ${finish} stands before the scheduled start ${start}.`, 'Enter a finish on or after the start.');

    const standing = await tx.select().from(productionOrderComponent).where(and(
      eq(productionOrderComponent.client, input.client),
      eq(productionOrderComponent.orderNumber, orderNumber),
    ));
    const components = new Map<number, StandingComponent>(standing.map((row) => [row.itemNumber, {
      itemNumber: row.itemNumber,
      materialNumber: row.materialNumber,
      plant: row.plant,
      storageLocation: row.storageLocation,
      requiredQuantity: String(row.requiredQuantity),
      unit: row.unitOfMeasure,
    }]));
    const beforeComponents = [...components.values()].map((row) => `${row.itemNumber}:${row.materialNumber}:${row.requiredQuantity}:${row.storageLocation ?? ''}`).join('|');
    let nextItem = standing.reduce((max, row) => Math.max(max, row.itemNumber), 0);
    const removed: number[] = [];
    for (const edit of input.components ?? []) {
      const itemNumber = edit.itemNumber == null ? null : Number(edit.itemNumber);
      if (edit.remove) {
        if (itemNumber == null || !components.has(itemNumber)) fail(`Component item ${itemNumber ?? ''} does not stand.`, 'Remove an item the order carries.');
        removed.push(itemNumber);
        components.delete(itemNumber);
        continue;
      }
      const componentMaterial = clean(edit.materialNumber).toUpperCase();
      if (!componentMaterial) fail('A component material is required.');
      if (itemNumber == null) {
        const [master] = await tx.select().from(material).where(and(eq(material.client, input.client), eq(material.materialNumber, componentMaterial)));
        if (!master) fail(`Material ${componentMaterial} does not exist.`);
        if (master.markedForDeletion) fail(`Material ${componentMaterial} is flagged for deletion.`);
        const [extended] = await tx.select().from(materialPlant).where(and(
          eq(materialPlant.client, input.client),
          eq(materialPlant.materialNumber, componentMaterial),
          eq(materialPlant.plant, String(header.plant)),
        ));
        if (!extended) fail(`Material ${componentMaterial} is not extended to plant ${String(header.plant)}.`);
        const componentUnit = clean(edit.unit).toUpperCase() || master.baseUnit || '';
        if (componentUnit !== master.baseUnit) {
          fail(`Component ${componentMaterial} is stored in ${master.baseUnit}. ${componentUnit || 'A different unit'} was not substituted.`);
        }
        const [componentUnitRow] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces }).from(unitOfMeasure).where(eq(unitOfMeasure.code, componentUnit));
        if (!componentUnitRow) fail(`Unit ${componentUnit} does not exist.`);
        const required = quantityOf(clean(edit.requiredQuantity), componentUnitRow.decimalPlaces, `Component ${componentMaterial}`);
        let location: string | null = null;
        if (clean(edit.storageLocation)) {
          try {
            const resolved = await resolveStorageLocation(tx, {
              client: input.client,
              plant: String(header.plant),
              typed: edit.storageLocation,
              required: false,
              applyPlantDefault: false,
              verb: 'Issue from',
            });
            location = resolved.storageLocation || null;
          } catch (caught) {
            if (caught instanceof StorageLocationError) fail(caught.message, caught.remedy);
            throw caught;
          }
        }
        nextItem += 10;
        components.set(nextItem, {
          itemNumber: nextItem,
          materialNumber: componentMaterial,
          plant: String(header.plant),
          storageLocation: location,
          requiredQuantity: required,
          unit: componentUnit,
        });
        continue;
      }
      const current = components.get(itemNumber);
      if (!current) fail(`Component item ${itemNumber} does not stand.`, 'Change an item the order carries. A typed item number was not created.');
      if (componentMaterial !== current.materialNumber) {
        fail(`Component item ${itemNumber} is ${current.materialNumber}. The material was not replaced.`, 'Remove the item and add another. The posted issue, if any, keeps the item number.');
      }
      const componentUnit = clean(edit.unit).toUpperCase() || current.unit;
      if (componentUnit !== current.unit) fail(`Component item ${itemNumber} is stored in ${current.unit}. A different unit was not substituted.`);
      const [componentUnitRow] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces }).from(unitOfMeasure).where(eq(unitOfMeasure.code, current.unit));
      const required = quantityOf(clean(edit.requiredQuantity) || current.requiredQuantity, componentUnitRow?.decimalPlaces ?? 3, `Component item ${itemNumber}`);
      let location = current.storageLocation;
      if (edit.storageLocation !== undefined) {
        if (!clean(edit.storageLocation)) location = null;
        else {
          try {
            const resolved = await resolveStorageLocation(tx, {
              client: input.client,
              plant: current.plant,
              typed: edit.storageLocation,
              required: false,
              applyPlantDefault: false,
              verb: 'Issue from',
            });
            location = resolved.storageLocation || null;
          } catch (caught) {
            if (caught instanceof StorageLocationError) fail(caught.message, caught.remedy);
            throw caught;
          }
        }
      }
      components.set(itemNumber, { ...current, requiredQuantity: required, storageLocation: location });
    }
    if (components.size === 0) fail('An order needs at least one component.', 'Leave one component, or cancel the change.');
    const afterComponents = [...components.values()].map((row) => `${row.itemNumber}:${row.materialNumber}:${row.requiredQuantity}:${row.storageLocation ?? ''}`).join('|');
    const headerSame = sameQuantity(quantity, String(header.quantity)) && start === String(header.scheduled_start) && finish === String(header.scheduled_finish);
    const componentsSame = beforeComponents === afterComponents;
    if (headerSame && componentsSame) return;

    const movements = await rows(tx, sql`
      select 1 from material_document_line
       where client = ${input.client} and production_order_number = ${orderNumber}
       limit 1
    `);
    if (movements.length > 0) {
      fail(
        `Production order ${orderNumber} has a goods movement. The snapshot was not changed.`,
        'Correct the movement in inventory. This save does not rewrite a material document.',
      );
    }
    const confirmations = await rows(tx, sql`
      select 1 from production_confirmation
       where client = ${input.client} and order_number = ${orderNumber}
       limit 1
    `);
    if (confirmations.length > 0) {
      fail(
        `Production order ${orderNumber} has a confirmation. The snapshot was not changed.`,
        'A posted confirmation is not corrected here. Cancellation is not this screen.',
      );
    }

    await tx.update(productionOrder).set({
      orderQuantity: quantity,
      scheduledStart: start,
      scheduledFinish: finish,
      version: Number(header.version) + 1,
      changedBy: actor,
      changedAt: new Date(),
    }).where(and(eq(productionOrder.client, input.client), eq(productionOrder.orderNumber, orderNumber), eq(productionOrder.version, Number(header.version))));

    for (const itemNumber of removed) {
      await tx.delete(productionOrderComponent).where(and(
        eq(productionOrderComponent.client, input.client),
        eq(productionOrderComponent.orderNumber, orderNumber),
        eq(productionOrderComponent.itemNumber, itemNumber),
      ));
    }
    for (const component of components.values()) {
      const existing = standing.find((row) => row.itemNumber === component.itemNumber);
      if (!existing) {
        await tx.insert(productionOrderComponent).values({
          client: input.client,
          orderNumber,
          itemNumber: component.itemNumber,
          materialNumber: component.materialNumber,
          plant: component.plant,
          storageLocation: component.storageLocation,
          requiredQuantity: component.requiredQuantity,
          unitOfMeasure: component.unit,
          createdBy: actor,
        });
      } else if (
        !sameQuantity(String(existing.requiredQuantity), component.requiredQuantity)
        || (existing.storageLocation ?? '') !== (component.storageLocation ?? '')
      ) {
        await tx.update(productionOrderComponent).set({
          requiredQuantity: component.requiredQuantity,
          storageLocation: component.storageLocation,
          changedBy: actor,
          changedAt: new Date(),
        }).where(and(
          eq(productionOrderComponent.client, input.client),
          eq(productionOrderComponent.orderNumber, orderNumber),
          eq(productionOrderComponent.itemNumber, component.itemNumber),
        ));
      }
    }

    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order',
      objectKey: orderNumber,
      changeType: 'CHANGE',
      changedBy: actor,
      transactionCode: PRODUCTION_ORDER_CHANGE_ALIAS,
      reason: `Production order ${orderNumber} changed`,
      before: {
        quantity: String(header.quantity),
        scheduledStart: String(header.scheduled_start),
        scheduledFinish: String(header.scheduled_finish),
        status,
        components: beforeComponents,
      },
      after: { quantity, scheduledStart: start, scheduledFinish: finish, status, components: afterComponents },
      fieldLabels: {
        quantity: 'Order quantity',
        scheduledStart: 'Scheduled start',
        scheduledFinish: 'Scheduled finish',
        components: 'Components',
      },
    });
  });

  const order = await getProductionOrderDisplay(input.client, orderNumber);
  if (!order) fail(`Production order ${orderNumber} does not stand after the save.`);
  return { order, changed: order.version !== input.expectedVersion, warnings };
}
