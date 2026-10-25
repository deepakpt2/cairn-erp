/**
 * Change production order — CO02.
 *
 * The standing production order is the record. There is no second order table.
 * The number, material, plant, unit, and status stay fixed. A save can change
 * the quantity, the dates, and the component snapshot while no goods movement
 * cites the order.
 *
 * A header quantity change does not rescale components. Stored operations are
 * not added, changed, or deleted, and dates are not rescheduled. This save
 * does not release, technically complete, close, or post.
 *
 * A component requirement date stays only when the line's material, plant,
 * unit, BOM item, and source material stay. A quantity or storage-location
 * change does not invalidate it, and the order start, finish, bill of material
 * date, and today are not written onto it. A new line has no requirement date.
 * A removed line is no longer demand. This save does not close, reopen, or
 * rewrite a dependent requirement.
 *
 * scheduled_start and scheduled_finish are the order's basic dates. Creation
 * and conversion set them. This save is the only path that changes them.
 * MD01 and MD04 use the finish as the receipt date. A stored component
 * requirement date is the date copied from a matching dependent requirement.
 * It is not derived from these header dates, and it can already differ from
 * both. Lead-time scheduling, operation offsets, and a factory calendar are
 * not carried, so a header date change does not recalculate it. The copied
 * date stays. The receipt date and the component demand date remain separate.
 *
 * Technical completion and its revocation are separate functions of this
 * screen. They are not fields of the quantity save. A technically completed
 * order cannot be edited until that completion is revoked.
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
import { parseProductionOrderStatus, priorStatusFromRelease } from './production-order-status';

export const PRODUCTION_ORDER_CHANGE_CAPABILITY = 'PROD.ORDER.CHANGE';
export const PRODUCTION_ORDER_CHANGE_ROUTE = '/production/production-order-change';
export const PRODUCTION_ORDER_CHANGE_ALIAS = 'CO02';
export const PRODUCTION_ORDER_LOCK = 'PRODUCTION_ORDER';

const REFUSED: Record<string, string> = {
  orderType: 'An order type is stored. This change does not replace it.',
  controllingArea: 'A controlling area is not a key of the order.',
  scrap: 'A scrap quantity is not stored. It was not applied.',
  productionVersion: 'The stored production version is not replaced by this change. Master data was not re-read.',
  schedulingType: 'A scheduling type is not stored. The dates are stored as entered.',
  priority: 'A priority is not stored.',
  operation: 'Stored operations are not changed here. None were added, changed, or deleted.',
  sequence: 'The copied sequence is not replaced here. An alternative sequence was not stored.',
  reschedule: 'Lead-time scheduling is not carried. The dates were not recalculated.',
  availability: 'Component availability is not checked on this change.',
  reread: 'Re-reading the bill of material is not this save. The component snapshot was not replaced.',
  bom: 'The bill of material is not stored on the order. This save does not explode one.',
  routing: 'The stored routing snapshot is not replaced by this change. Master data was not re-read.',
  release: 'Change does not release the order. Release is a separate act.',
  teco: 'Technical completion is not a status field of this save. Use the technical completion action.',
  closed: 'A closed status is not stored. Change does not close the order.',
  delete: 'Change does not delete the production order.',
  confirmation: 'A posted confirmation is not changed here. Cancellation is not this screen.',
  cost: 'Cost is not carried. No cost was posted.',
  reservation: 'A reservation is not created or changed here.',
  post: 'A production-order change posts nothing.',
  status: 'Status is not changed by this save. Created and released stay as they stand.',
  requirementDate: 'A component requirement date is not entered on this change. A new line does not receive one, and the order start is not used.',
  bomItem: 'The bill-of-material item is not changed here. Remove the line and add another. The old requirement date is not copied.',
  sourceMaterial: 'The source material is not changed here. Remove the line and add another. The old requirement date is not copied.',
  componentPlant: 'The component plant is not changed here. It stays the plant stored on the line.',
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
  bomItem: string | null;
  sourceMaterial: string | null;
  requirementDate: string | null;
}

/**
 * The date belongs to this material, plant, unit, BOM item, and source
 * material. Quantity and storage location are not part of that identity.
 * A different identity does not keep the old date, and no other date is made.
 */
function preservedRequirementDate(before: StandingComponent, after: StandingComponent): string | null {
  if (before.materialNumber !== after.materialNumber) return null;
  if (before.plant !== after.plant) return null;
  if (before.unit !== after.unit) return null;
  if ((before.bomItem ?? null) !== (after.bomItem ?? null)) return null;
  if ((before.sourceMaterial ?? null) !== (after.sourceMaterial ?? null)) return null;
  return before.requirementDate;
}

function componentFingerprint(row: StandingComponent): string {
  return [
    row.itemNumber,
    row.materialNumber,
    row.plant,
    row.unit,
    row.requiredQuantity,
    row.storageLocation ?? '',
    row.bomItem ?? '',
    row.sourceMaterial ?? '',
    row.requirementDate ?? '',
  ].join(':');
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
    'Operation dates are not stored, so the dates were not rescheduled. Stored operations were not changed.',
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
    const status = parseProductionOrderStatus(header.status);
    if (!status) {
      fail(`Status ${String(header.status)} is not a production-order status. Nothing was saved.`, 'The stored status is unsupported. It was not treated as created.');
    }
    if (status === 'TECHNICALLY_COMPLETED') {
      fail(
        `Production order ${orderNumber} is technically complete. Quantity, dates, and components were not changed.`,
        'Revoke technical completion before changing the order. This save does not revoke it.',
      );
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

    await tx.execute(sql`
      select item_number from production_order_component
       where client = ${input.client} and order_number = ${orderNumber}
       for update
    `);
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
      bomItem: row.bomItem,
      sourceMaterial: row.sourceMaterial,
      requirementDate: row.requirementDate,
    }]));
    const beforeComponents = [...components.values()].map(componentFingerprint).join('|');
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
          bomItem: null,
          sourceMaterial: null,
          requirementDate: null,
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
      const requiredQuantity = sameQuantity(required, current.requiredQuantity) ? current.requiredQuantity : required;
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
      components.set(itemNumber, { ...current, requiredQuantity, storageLocation: location });
    }
    if (components.size === 0) fail('An order needs at least one component.', 'Leave one component, or cancel the change.');
    const afterComponents = [...components.values()].map(componentFingerprint).join('|');
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

    // Header dates are not a component requirement date. This update does not
    // read or write production_order_component.requirement_date.
    await tx.update(productionOrder).set({
      orderQuantity: quantity,
      scheduledStart: start,
      scheduledFinish: finish,
      version: Number(header.version) + 1,
      changedBy: actor,
      changedAt: new Date(),
    }).where(and(eq(productionOrder.client, input.client), eq(productionOrder.orderNumber, orderNumber), eq(productionOrder.version, Number(header.version))));

    // A new line stores no requirement date and no BOM identity. An existing
    // line keeps its date only while material, plant, unit, BOM item, and
    // source material are unchanged. The order dates are not copied. A
    // dependent requirement is not closed or reopened.
    const removedDates = removed.filter((itemNumber) => standing.some((row) => row.itemNumber === itemNumber && row.requirementDate));
    for (const itemNumber of removed) {
      const deleted = await tx.delete(productionOrderComponent).where(and(
        eq(productionOrderComponent.client, input.client),
        eq(productionOrderComponent.orderNumber, orderNumber),
        eq(productionOrderComponent.itemNumber, itemNumber),
      )).returning({ itemNumber: productionOrderComponent.itemNumber });
      if (deleted.length !== 1) fail(`Component item ${itemNumber} was not removed. Nothing was saved.`);
    }
    let addedLine = false;
    let keptDatedQuantity = false;
    for (const component of components.values()) {
      const existing = standing.find((row) => row.itemNumber === component.itemNumber);
      if (!existing) {
        addedLine = true;
        await tx.insert(productionOrderComponent).values({
          client: input.client,
          orderNumber,
          itemNumber: component.itemNumber,
          materialNumber: component.materialNumber,
          plant: component.plant,
          storageLocation: component.storageLocation,
          requiredQuantity: component.requiredQuantity,
          unitOfMeasure: component.unit,
          bomItem: null,
          sourceMaterial: null,
          requirementDate: null,
          createdBy: actor,
        });
        continue;
      }
      const quantityChanged = !sameQuantity(String(existing.requiredQuantity), component.requiredQuantity);
      const locationChanged = (existing.storageLocation ?? '') !== (component.storageLocation ?? '');
      if (!quantityChanged && !locationChanged) continue;
      const original: StandingComponent = {
        itemNumber: existing.itemNumber,
        materialNumber: existing.materialNumber,
        plant: existing.plant,
        storageLocation: existing.storageLocation,
        requiredQuantity: String(existing.requiredQuantity),
        unit: existing.unitOfMeasure,
        bomItem: existing.bomItem,
        sourceMaterial: existing.sourceMaterial,
        requirementDate: existing.requirementDate,
      };
      const requirementDate = preservedRequirementDate(original, component);
      if (requirementDate) keptDatedQuantity = true;
      if (quantityChanged && !original.requirementDate) {
        warnings.push(`Component item ${component.itemNumber} had no requirement date. None was added.`);
      }
      const updated = await tx.update(productionOrderComponent).set({
        requiredQuantity: component.requiredQuantity,
        storageLocation: component.storageLocation,
        bomItem: existing.bomItem,
        sourceMaterial: existing.sourceMaterial,
        requirementDate,
        changedBy: actor,
        changedAt: new Date(),
      }).where(and(
        eq(productionOrderComponent.client, input.client),
        eq(productionOrderComponent.orderNumber, orderNumber),
        eq(productionOrderComponent.itemNumber, component.itemNumber),
        eq(productionOrderComponent.materialNumber, existing.materialNumber),
        eq(productionOrderComponent.plant, existing.plant),
        eq(productionOrderComponent.unitOfMeasure, existing.unitOfMeasure),
      )).returning({ itemNumber: productionOrderComponent.itemNumber });
      if (updated.length !== 1) {
        fail(
          `Component item ${component.itemNumber} was not saved. Nothing was saved.`,
          'The material, plant, and unit were not replaced, and the requirement date was not moved to another line.',
        );
      }
    }
    if (keptDatedQuantity) {
      warnings.push('A component requirement date was kept because the material, plant, unit, and bill-of-material identity did not change. It was not taken from the order start, finish, or today.');
    }
    if (start !== String(header.scheduled_start) || finish !== String(header.scheduled_finish)) {
      warnings.push(standing.some((row) => row.requirementDate)
        ? 'The scheduled dates changed. Component requirement dates were not recalculated. Each copied date was kept. It is not the order start or finish. The receipt date is the scheduled finish and is separate.'
        : 'The scheduled dates changed. No component requirement date was created from the order start, finish, or today.');
    }
    if (addedLine) {
      warnings.push('A new component has no requirement date. None was copied from a removed line, the order dates, or today.');
    }
    if (removedDates.length > 0) {
      warnings.push('A removed component is no longer planning demand. Its dependent requirement was not changed.');
    }

    const recorded = await recordChange(tx, {
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
    if (!recorded) fail('The component change was not recorded. Nothing was saved.');
  });

  const order = await getProductionOrderDisplay(input.client, orderNumber);
  if (!order) fail(`Production order ${orderNumber} does not stand after the save.`);
  return { order, changed: order.version !== input.expectedVersion, warnings };
}

export interface ProductionOrderLifecycleInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  expectedVersion: number;
  held: readonly string[];
  confirmed: boolean;
}

function requireLifecycleActor(input: ProductionOrderLifecycleInput, verb: 'completed' | 'revoked'): string {
  if (!holdsProductionOrderChangeAuthority(input.held)) {
    fail(
      `You do not hold the authority ${PRODUCTION_ORDER_CHANGE_CAPABILITY}.`,
      'Technical completion is part of production-order change. It is not a separate authority.',
    );
  }
  if (input.confirmed !== true) {
    fail(
      verb === 'completed'
        ? 'Technical completion was not confirmed. Nothing was saved.'
        : 'Revocation was not confirmed. Nothing was saved.',
      'Confirm the action. The order was not changed.',
    );
  }
  const orderNumber = clean(input.orderNumber);
  if (!orderNumber) fail('A production order number is required.');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    fail('Open the order again. The record version is required.', 'Display the order, then change it.');
  }
  const actor = clean(input.changedBy);
  if (!actor || actor.length > 60) fail('The user who changed the order is required.');
  return actor;
}

async function lockedOrder(tx: Tx, client: string, orderNumber: string, expectedVersion: number) {
  const found = await rows(tx, sql`
    select order_number, status, version, released_by, released_at
      from production_order
     where client = ${client} and order_number = ${orderNumber}
     for update
  `);
  const header = found[0];
  if (!header) fail(`Production order ${orderNumber} does not stand.`, 'Choose an order that stands in this tenant.');
  if (Number(header.version) !== expectedVersion) {
    fail('The production order was changed by someone else. Nothing was saved.', 'Open it again, then save.');
  }
  const status = parseProductionOrderStatus(header.status);
  if (!status) {
    fail(
      `Status ${String(header.status)} is not a production-order status. Nothing was saved.`,
      'The stored status is unsupported. It was not treated as created.',
    );
  }
  return { header, status };
}

export async function technicallyCompleteProductionOrder(
  input: ProductionOrderLifecycleInput,
): Promise<ProductionOrderChangeResult> {
  const actor = requireLifecycleActor(input, 'completed');
  const orderNumber = clean(input.orderNumber);
  await withTenant(input.client, async (tx) => {
    const { header, status } = await lockedOrder(tx, input.client, orderNumber, input.expectedVersion);
    if (status === 'TECHNICALLY_COMPLETED') {
      fail(
        `Production order ${orderNumber} is already technically complete. It was not completed again.`,
        'Revoke technical completion if the order must be changed.',
      );
    }
    const completedAt = new Date();
    const updated = await tx.update(productionOrder).set({
      status: 'TECHNICALLY_COMPLETED',
      technicallyCompletedBy: actor,
      technicallyCompletedAt: completedAt,
      version: Number(header.version) + 1,
      changedBy: actor,
      changedAt: completedAt,
    }).where(and(
      eq(productionOrder.client, input.client),
      eq(productionOrder.orderNumber, orderNumber),
      eq(productionOrder.version, Number(header.version)),
      eq(productionOrder.status, status),
    )).returning({ orderNumber: productionOrder.orderNumber });
    if (updated.length !== 1) {
      fail('The production order was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    const recorded = await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order',
      objectKey: orderNumber,
      changeType: 'TECO',
      changedBy: actor,
      transactionCode: PRODUCTION_ORDER_CHANGE_ALIAS,
      reason: `Production order ${orderNumber} technically completed`,
      before: { status },
      after: { status: 'TECHNICALLY_COMPLETED', technicallyCompletedBy: actor },
      fieldLabels: { status: 'Status', technicallyCompletedBy: 'Technically completed by' },
    });
    if (!recorded) fail('The technical completion was not recorded. Nothing was saved.');
  });
  const order = await getProductionOrderDisplay(input.client, orderNumber);
  if (!order) fail(`Production order ${orderNumber} does not stand after technical completion.`);
  return {
    order,
    changed: true,
    warnings: [
      'The component snapshot was not deleted.',
      'No reservation, capacity requirement, purchase document, or journal was changed.',
      'Goods receipt, component issue, and confirmation are not forbidden. The order fields cannot be changed until technical completion is revoked.',
    ],
  };
}

export async function revokeTechnicalCompletion(
  input: ProductionOrderLifecycleInput,
): Promise<ProductionOrderChangeResult> {
  const actor = requireLifecycleActor(input, 'revoked');
  const orderNumber = clean(input.orderNumber);
  await withTenant(input.client, async (tx) => {
    const { header, status } = await lockedOrder(tx, input.client, orderNumber, input.expectedVersion);
    if (status !== 'TECHNICALLY_COMPLETED') {
      fail(
        `Production order ${orderNumber} is not technically complete. Nothing was revoked.`,
        'Technical completion can be revoked only after it has been set.',
      );
    }
    const prior = priorStatusFromRelease(header.released_by, header.released_at);
    if (!prior.ok) {
      fail(
        'The release record is incomplete. Technical completion was not revoked.',
        'Released-by and released-at must both stand, or both be empty. Nothing was guessed.',
      );
    }
    const changedAt = new Date();
    const updated = await tx.update(productionOrder).set({
      status: prior.status,
      technicallyCompletedBy: null,
      technicallyCompletedAt: null,
      version: Number(header.version) + 1,
      changedBy: actor,
      changedAt,
    }).where(and(
      eq(productionOrder.client, input.client),
      eq(productionOrder.orderNumber, orderNumber),
      eq(productionOrder.version, Number(header.version)),
      eq(productionOrder.status, 'TECHNICALLY_COMPLETED'),
    )).returning({ orderNumber: productionOrder.orderNumber });
    if (updated.length !== 1) {
      fail('The production order was changed by someone else. Nothing was saved.', 'Open it again, then save.');
    }
    const recorded = await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order',
      objectKey: orderNumber,
      changeType: 'REVOKE_TECO',
      changedBy: actor,
      transactionCode: PRODUCTION_ORDER_CHANGE_ALIAS,
      reason: `Technical completion of production order ${orderNumber} revoked`,
      before: { status: 'TECHNICALLY_COMPLETED' },
      after: { status: prior.status, technicallyCompletedBy: null },
      fieldLabels: { status: 'Status', technicallyCompletedBy: 'Technically completed by' },
    });
    if (!recorded) fail('The revocation was not recorded. Nothing was saved.');
  });
  const order = await getProductionOrderDisplay(input.client, orderNumber);
  if (!order) fail(`Production order ${orderNumber} does not stand after revocation.`);
  return {
    order,
    changed: true,
    warnings: ['The component snapshot was not restored, because technical completion did not delete it.'],
  };
}
