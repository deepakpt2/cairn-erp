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
 * The components are a **snapshot**. Creating an order does not read a material BOM.
 * A saved order is not rewritten when a BOM changes. A later issue may consume the
 * snapshot; nothing recomputes it, and nothing here reads a routing or capacity master.
 *
 * Deferred by name: TECO / technically complete, order closure, deletion flags, the
 * finished-goods receipt (PROD.ORDER.GR), settlement (PROD.ORDER.SETTLE), availability
 * checking (ATP), collective orders, and external order numbering. A finished-good
 * batch may be named when that batch already stands. A new batch is created only when
 * the scheduling profile snapshotted at create says so. OPKP is not this screen.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { recordChange } from '../../platform/change';
import { plant as plantTable } from '../foundation/schema';
import { material, materialPlant } from './schema';
import { resolveStorageLocation, StorageLocationError } from './storage-location';
import { productionOrder, productionOrderComponent } from './schema';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';
import { readWipBatchFlag } from '../production/wip-batch';
import {
  ensureOrderBatch,
  readMaterialSchedulingProfile,
  SchedulingProfileError,
  type BatchCreation,
  type ReleaseOnCreate,
} from './scheduling-profile';

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
  batch: string;
  schedulingProfile: string;
  releaseOnCreate: ReleaseOnCreate;
  batchCreation: BatchCreation;
  status: 'CREATED' | 'RELEASED';
  releasedBy: string | null;
  releasedAt: string | null;
  createdAt: string;
  components: ProductionOrderComponentView[];
  /** OMCWB was read. A WIP batch was not created. */
  wipBatchActive: 'X' | ' ';
  wipBatchCreated: false;
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
  const wipBatchActive = await readWipBatchFlag(tx, client);

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
    batch: header.batchNumber,
    schedulingProfile: header.schedulingProfile,
    releaseOnCreate: header.releaseOnCreate.trim() === 'X' ? 'X' : ' ',
    batchCreation: header.batchCreation.trim() === '1' || header.batchCreation.trim() === '2'
      ? header.batchCreation.trim() as BatchCreation
      : ' ',
    status: header.status as 'CREATED' | 'RELEASED',
    releasedBy: header.releasedBy,
    releasedAt: header.releasedAt ? header.releasedAt.toISOString() : null,
    wipBatchActive,
    wipBatchCreated: false,
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
  /** A batch that already stands for the finished good. The order does not create it. */
  batch?: string;
  components: ProductionOrderComponentInput[];
  requestKey?: string;
}

/**
 * Create an order. Every master is judged before anything is written — the material,
 * the plant and its company, the material's extension to that plant, each component and
 * its storage location — so a refusal leaves no half-created order behind.
 */
export interface CreateProductionOrderResult extends ProductionOrderView {
  releaseNote: string | null;
}

export async function createProductionOrder(input: CreateProductionOrderInput): Promise<CreateProductionOrderResult> {
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
    const profile = await readMaterialSchedulingProfile(tx, input.client, materialNumber, plant)
      .catch((caught) => {
        if (caught instanceof SchedulingProfileError) throw new ProductionOrderError(caught.message, caught.remedy);
        throw caught;
      });
    const snapshot = profile ?? { profile: '', releaseOnCreate: ' ' as const, batchCreation: ' ' as const };
    let batchNumber = '';
    if ((input.batch ?? '').trim()) {
      try {
        batchNumber = await resolvePostingBatch(tx, {
          client: input.client, materialNumber, plant, batch: input.batch,
        });
      } catch (caught) {
        if (caught instanceof BatchPostingError) throw new ProductionOrderError(caught.message, caught.remedy);
        throw caught;
      }
    }
    try {
      batchNumber = await ensureOrderBatch(tx, {
        client: input.client,
        materialNumber,
        plant,
        batchNumber,
        batchCreation: snapshot.batchCreation,
        moment: 'CREATE',
        changedBy: input.createdBy,
      });
    } catch (caught) {
      if (caught instanceof SchedulingProfileError) {
        throw new ProductionOrderError(`${caught.message} No order was saved.`, caught.remedy);
      }
      throw caught;
    }

    const [header] = await tx.insert(productionOrder).values({
      client: input.client,
      orderNumber,
      materialNumber,
      plant,
      orderQuantity: String(input.orderQuantity),
      batchNumber,
      schedulingProfile: snapshot.profile,
      releaseOnCreate: snapshot.releaseOnCreate,
      batchCreation: snapshot.batchCreation,
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

    if (snapshot.releaseOnCreate !== 'X') {
      return { ...(await toView(tx, input.client, header)), releaseNote: null };
    }
    await tx.execute(sql`SAVEPOINT opkp_release`);
    try {
      const released = await releaseProductionOrderInTx(tx, {
        client: input.client,
        orderNumber,
        releasedBy: input.createdBy,
      });
      await tx.execute(sql`RELEASE SAVEPOINT opkp_release`);
      return { ...released, releaseNote: null };
    } catch (caught) {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT opkp_release`);
      const reason = caught instanceof ProductionOrderError
        ? caught.message
        : 'Release at creation failed.';
      const [standing] = await tx.select().from(productionOrder).where(and(
        eq(productionOrder.client, input.client),
        eq(productionOrder.orderNumber, orderNumber),
      ));
      return {
        ...(await toView(tx, input.client, standing ?? header)),
        releaseNote: `Release at creation did not happen. ${reason} The order stands created.`,
      };
    }
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

  return withTenant(input.client, (tx) => releaseProductionOrderInTx(tx, {
    client: input.client,
    orderNumber: number,
    releasedBy: input.releasedBy,
  }));
}

async function releaseProductionOrderInTx(tx: Tx, input: {
  client: string;
  orderNumber: string;
  releasedBy: string;
}): Promise<ProductionOrderView> {
  const [header] = await tx.select().from(productionOrder).where(and(
    eq(productionOrder.client, input.client),
    eq(productionOrder.orderNumber, input.orderNumber),
  )).for('update');
  if (!header) {
    throw new ProductionOrderError(
      `Production order ${input.orderNumber} does not exist.`,
      'Check the order number, or create the order first.',
    );
  }
  if (header.status === 'RELEASED') return toView(tx, input.client, header);
  let batchNumber = header.batchNumber;
  try {
    batchNumber = await ensureOrderBatch(tx, {
      client: input.client,
      materialNumber: header.materialNumber,
      plant: header.plant,
      batchNumber: header.batchNumber,
      batchCreation: header.batchCreation.trim() === '1' || header.batchCreation.trim() === '2'
        ? header.batchCreation.trim() as BatchCreation
        : ' ',
      moment: 'RELEASE',
      changedBy: input.releasedBy,
    });
  } catch (caught) {
    if (caught instanceof SchedulingProfileError) throw new ProductionOrderError(caught.message, caught.remedy);
    throw caught;
  }

  const [released] = await tx.update(productionOrder).set({
    status: 'RELEASED',
    batchNumber,
    releasedBy: input.releasedBy,
    releasedAt: new Date(),
    changedBy: input.releasedBy,
    changedAt: new Date(),
  }).where(and(
    eq(productionOrder.client, input.client),
    eq(productionOrder.orderNumber, input.orderNumber),
  )).returning();

  await recordChange(tx, {
    client: input.client,
    objectClass: 'production_order',
    objectKey: input.orderNumber,
    changeType: 'RELEASE',
    changedBy: input.releasedBy,
    reason: `Order ${input.orderNumber} released for production`,
    before: { status: 'CREATED', batch: header.batchNumber },
    after: { status: 'RELEASED', releasedBy: input.releasedBy, batch: batchNumber },
  });

  return toView(tx, input.client, released);
}
