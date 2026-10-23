/**
 * Create and release a production order — SCR-138 / CO01 (SAP alias only).
 *
 * The order master the next round's 261 will post against. Two acts, deliberately
 * separate: **create** records what is to be produced, where, how much and when, with
 * its components; **release** is the single step that allows work to be charged to it,
 * and it records who released it and when. Nothing posts to the ledger here, and nothing
 * moves stock: an order is a plan, and a plan that moved stock would be a posting.
 *
 * The company code is **derived from the plant**, never typed and never stored — the MB03
 * ruling (§26.877) applied to an order. The plant must be extended to the produced
 * material, as it must be in SAP, and every component must be extended to the plant it
 * will be consumed from.
 *
 * The components are a **snapshot**: canon carries no BOM master, so what the order says
 * it needs is what it needs. A later issue may consume them; nothing recomputes them,
 * and nothing here reads a routings or capacity master, which canon does not have.
 *
 * Deferred by name: TECO / technically complete, order closure, deletion flags, the
 * finished-goods receipt (PROD.ORDER.GR), settlement (PROD.ORDER.SETTLE), availability
 * checking (ATP), batch, collective orders, and external order numbering.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { recordChange } from '../../platform/change';
import { plant as plantTable } from '../foundation/schema';
import { material, materialPlant } from './schema';
import { resolveStorageLocation, StorageLocationError } from './storage-location';
import { productionOrder, productionOrderComponent } from './schema';

export const PRODUCTION_ORDER_CAPABILITY = 'PROD.ORDER.CREATE';
export const PRODUCTION_ORDER_RELEASE_CAPABILITY = 'PROD.ORDER.RELEASE';
export const PRODUCTION_ORDER_ROUTE = '/production/orders';
export const PRODUCTION_ORDER_ALIAS = 'CO01';

export class ProductionOrderError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ProductionOrderError';
    this.remedy = remedy;
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ProductionOrderComponentInput {
  materialNumber: string;
  plant: string;
  storageLocation?: string;
  requiredQuantity: number;
}

export interface ProductionOrderComponentView {
  itemNumber: number;
  materialNumber: string;
  materialDescription: string | null;
  plant: string;
  storageLocation: string | null;
  requiredQuantity: string;
  unit: string;
  createdAt: string;
}

export interface ProductionOrderView {
  orderNumber: string;
  materialNumber: string;
  materialDescription: string | null;
  plant: string;
  /** Derived from the plant, never typed and never stored. */
  companyCode: string;
  orderQuantity: string;
  unit: string;
  scheduledStart: string;
  scheduledFinish: string;
  status: 'CREATED' | 'RELEASED';
  releasedBy: string | null;
  releasedAt: string | null;
  createdAt: string;
  components: ProductionOrderComponentView[];
}

function requireDate(value: string, what: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new ProductionOrderError(`${what} ${value || '(empty)'} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  }
  return trimmed;
}

async function toView(tx: Tx, client: string, header: typeof productionOrder.$inferSelect): Promise<ProductionOrderView> {
  const [produced] = await tx.select({ description: material.description }).from(material).where(and(
    eq(material.client, client), eq(material.materialNumber, header.materialNumber),
  ));
  const [plantRow] = await tx.select({ companyCode: plantTable.companyCode }).from(plantTable).where(and(
    eq(plantTable.client, client), eq(plantTable.plant, header.plant),
  ));
  const rows = await tx.select().from(productionOrderComponent)
    .where(and(
      eq(productionOrderComponent.client, client),
      eq(productionOrderComponent.orderNumber, header.orderNumber),
    ))
    .orderBy(asc(productionOrderComponent.itemNumber));
  const componentNumbers = rows.map((r) => r.materialNumber);
  const descriptions = componentNumbers.length === 0 ? [] : await tx.select({
    materialNumber: material.materialNumber, description: material.description,
  }).from(material).where(and(
    eq(material.client, client), inArray(material.materialNumber, componentNumbers),
  ));
  const descriptionOf = new Map(descriptions.map((d) => [d.materialNumber, d.description]));

  return {
    orderNumber: header.orderNumber,
    materialNumber: header.materialNumber,
    materialDescription: produced?.description ?? null,
    plant: header.plant,
    companyCode: plantRow?.companyCode ?? '',
    orderQuantity: header.orderQuantity,
    unit: header.unitOfMeasure,
    scheduledStart: header.scheduledStart,
    scheduledFinish: header.scheduledFinish,
    status: header.status as 'CREATED' | 'RELEASED',
    releasedBy: header.releasedBy,
    releasedAt: header.releasedAt ? header.releasedAt.toISOString() : null,
    createdAt: header.createdAt.toISOString(),
    components: rows.map((r) => ({
      itemNumber: r.itemNumber,
      materialNumber: r.materialNumber,
      materialDescription: descriptionOf.get(r.materialNumber) ?? null,
      plant: r.plant,
      storageLocation: r.storageLocation,
      requiredQuantity: r.requiredQuantity,
      unit: r.unitOfMeasure,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function getProductionOrder(client: string, orderNumber: string): Promise<ProductionOrderView | null> {
  const number = orderNumber.trim();
  if (!number) return null;
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(productionOrder).where(and(
      eq(productionOrder.client, client), eq(productionOrder.orderNumber, number),
    ));
    return header ? toView(tx, client, header) : null;
  });
}

export interface CreateProductionOrderInput {
  client: string;
  createdBy: string;
  materialNumber: string;
  plant: string;
  orderQuantity: number;
  scheduledStart: string;
  scheduledFinish: string;
  components: ProductionOrderComponentInput[];
  requestKey?: string;
}

/**
 * Create an order. Every master is judged before anything is written — the material,
 * the plant and its company, the material's extension to that plant, each component and
 * its storage location — so a refusal leaves no half-created order behind.
 */
export async function createProductionOrder(input: CreateProductionOrderInput): Promise<ProductionOrderView> {
  const plant = input.plant.trim();
  const materialNumber = input.materialNumber.trim();
  if (!materialNumber) {
    throw new ProductionOrderError('The material to be produced is required.', 'Enter the material the order will make.');
  }
  if (!plant) {
    throw new ProductionOrderError('A plant is required.', 'Enter the plant the order will be produced in.');
  }
  if (!(input.orderQuantity > 0)) {
    throw new ProductionOrderError(
      `The order quantity ${input.orderQuantity} is not a positive quantity.`,
      'Enter a quantity greater than zero.',
    );
  }
  const start = requireDate(input.scheduledStart, 'The scheduled start');
  const finish = requireDate(input.scheduledFinish, 'The scheduled finish');
  if (finish < start) {
    throw new ProductionOrderError(
      `The scheduled finish ${finish} stands before the scheduled start ${start}.`,
      'Enter a finish on or after the start.',
    );
  }
  if (input.components.length === 0) {
    throw new ProductionOrderError(
      'An order needs at least one component.',
      'Enter the components the order will consume, or cancel the order.',
    );
  }

  return withTenant(input.client, async (tx) => {
    if (input.requestKey) {
      const [replay] = await tx.select().from(productionOrder).where(and(
        eq(productionOrder.client, input.client),
        eq(productionOrder.requestKey, input.requestKey),
      ));
      if (replay) return toView(tx, input.client, replay);
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/production-order`}, 0))`);

    const [produced] = await tx.select().from(material).where(and(
      eq(material.client, input.client), eq(material.materialNumber, materialNumber),
    ));
    if (!produced) throw new ProductionOrderError(`Material ${materialNumber} does not exist.`);
    if (produced.markedForDeletion) {
      throw new ProductionOrderError(
        `Material ${materialNumber} is flagged for deletion.`,
        'Cancel the deletion flag, then create the order.',
      );
    }
    if (!produced.baseUnit) {
      throw new ProductionOrderError(
        `Material ${materialNumber} carries no base unit.`,
        'Complete the material master, then create the order.',
      );
    }

    const [plantRow] = await tx.select().from(plantTable).where(and(
      eq(plantTable.client, input.client), eq(plantTable.plant, plant),
    ));
    if (!plantRow) throw new ProductionOrderError(`Plant ${plant} does not exist.`);
    if (!plantRow.companyCode) {
      throw new ProductionOrderError(
        `Plant ${plant} carries no company code, so the order has none.`,
        'Assign the plant to a company code, then create the order.',
      );
    }

    const [extended] = await tx.select().from(materialPlant).where(and(
      eq(materialPlant.client, input.client),
      eq(materialPlant.materialNumber, materialNumber),
      eq(materialPlant.plant, plant),
    ));
    if (!extended) {
      throw new ProductionOrderError(
        `Material ${materialNumber} is not extended to plant ${plant}.`,
        `Extend the material to plant ${plant}, then create the order.`,
      );
    }

    // Every component is judged before the header is drawn or written.
    const prepared: Array<{
      materialNumber: string; plant: string; storageLocation: string | null;
      requiredQuantity: number; unit: string;
    }> = [];
    for (const [index, component] of input.components.entries()) {
      const position = (index + 1) * 10;
      const componentNumber = component.materialNumber.trim();
      if (!componentNumber) {
        throw new ProductionOrderError(`Component item ${position} needs a material.`, 'Enter the component material.');
      }
      if (!(component.requiredQuantity > 0)) {
        throw new ProductionOrderError(
          `Component item ${position} requires a positive quantity.`,
          'Enter a quantity greater than zero.',
        );
      }
      const [componentMaterial] = await tx.select().from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, componentNumber),
      ));
      if (!componentMaterial) throw new ProductionOrderError(`Material ${componentNumber} does not exist.`);
      if (componentMaterial.markedForDeletion) {
        throw new ProductionOrderError(
          `Material ${componentNumber} is flagged for deletion.`,
          'Cancel the deletion flag, then add it to the order.',
        );
      }
      const componentPlant = (component.plant || plant).trim();
      const [componentPlantRow] = await tx.select().from(plantTable).where(and(
        eq(plantTable.client, input.client), eq(plantTable.plant, componentPlant),
      ));
      if (!componentPlantRow) throw new ProductionOrderError(`Plant ${componentPlant} does not exist.`);
      const [componentExtended] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, componentNumber),
        eq(materialPlant.plant, componentPlant),
      ));
      if (!componentExtended) {
        throw new ProductionOrderError(
          `Material ${componentNumber} is not extended to plant ${componentPlant}.`,
          `Extend the material to plant ${componentPlant}, then add it to the order.`,
        );
      }
      let location: string | null = null;
      try {
        const resolved = await resolveStorageLocation(tx, {
          client: input.client,
          plant: componentPlant,
          typed: component.storageLocation,
          required: false,
          applyPlantDefault: false,
          verb: 'Issue from',
        });
        location = resolved.storageLocation || null;
      } catch (caught) {
        if (caught instanceof StorageLocationError) {
          throw new ProductionOrderError(
            caught.message,
            `Enter a storage location that belongs to plant ${componentPlant}, or leave it empty.`,
          );
        }
        throw caught;
      }
      prepared.push({
        materialNumber: componentNumber,
        plant: componentPlant,
        storageLocation: location,
        requiredQuantity: component.requiredQuantity,
        unit: componentMaterial.baseUnit ?? '',
      });
    }

    const drawn = await allocateNumber(tx, {
      client: input.client, objectCode: 'PRODORDER', allocatedBy: input.createdBy,
    });
    const orderNumber = drawn.display;

    const [header] = await tx.insert(productionOrder).values({
      client: input.client,
      orderNumber,
      materialNumber,
      plant,
      orderQuantity: String(input.orderQuantity),
      unitOfMeasure: produced.baseUnit,
      scheduledStart: start,
      scheduledFinish: finish,
      status: 'CREATED',
      requestKey: input.requestKey ?? null,
      createdBy: input.createdBy,
    }).returning();

    for (const [index, component] of prepared.entries()) {
      await tx.insert(productionOrderComponent).values({
        client: input.client,
        orderNumber,
        itemNumber: (index + 1) * 10,
        materialNumber: component.materialNumber,
        plant: component.plant,
        storageLocation: component.storageLocation,
        requiredQuantity: String(component.requiredQuantity),
        unitOfMeasure: component.unit,
        createdBy: input.createdBy,
      });
    }

    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order',
      objectKey: orderNumber,
      changeType: 'CREATE',
      changedBy: input.createdBy,
      reason: `Order for ${materialNumber} at plant ${plant}, ${prepared.length} component(s)`,
      after: {
        orderNumber,
        materialNumber,
        plant,
        orderQuantity: String(input.orderQuantity),
        unitOfMeasure: produced.baseUnit,
        scheduledStart: start,
        scheduledFinish: finish,
        status: 'CREATED',
      },
    });

    return toView(tx, input.client, header);
  });
}

/**
 * Release an order — the one act that lets work be charged to it. A release of a
 * released order is not an error to shout about: it returns the order as it stands,
 * so a double submit neither fails nor rewrites the release.
 */
export async function releaseProductionOrder(input: {
  client: string;
  orderNumber: string;
  releasedBy: string;
}): Promise<ProductionOrderView> {
  const number = input.orderNumber.trim();
  if (!number) throw new ProductionOrderError('An order number is required.', 'Enter the order to release.');

  return withTenant(input.client, async (tx) => {
    const [header] = await tx.select().from(productionOrder).where(and(
      eq(productionOrder.client, input.client), eq(productionOrder.orderNumber, number),
    ));
    if (!header) {
      throw new ProductionOrderError(
        `Production order ${number} does not exist.`,
        'Check the order number, or create the order first.',
      );
    }
    if (header.status === 'RELEASED') return toView(tx, input.client, header);

    const [released] = await tx.update(productionOrder).set({
      status: 'RELEASED',
      releasedBy: input.releasedBy,
      releasedAt: new Date(),
      changedBy: input.releasedBy,
      changedAt: new Date(),
    }).where(and(
      eq(productionOrder.client, input.client), eq(productionOrder.orderNumber, number),
    )).returning();

    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order',
      objectKey: number,
      changeType: 'RELEASE',
      changedBy: input.releasedBy,
      reason: `Order ${number} released for production`,
      before: { status: 'CREATED' },
      after: { status: 'RELEASED', releasedBy: input.releasedBy },
    });

    return toView(tx, input.client, released);
  });
}
