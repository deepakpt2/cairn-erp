/**
 * Create and release a production order — SCR-138 / CO01 (SAP alias only).
 *
 * The order master a 261 component issue posts against (SCR-139, from MIGO), and the row a
 * confirmation, a finished-goods receipt and a technical completion act on. Two acts, deliberately
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
 * The components are a **snapshot**. The CO01 screen selects a production version and
 * reads that bill of material. A caller-supplied component list is not re-read from the BOM
 * and is not given a production version. Conversion derives its snapshot and persists that version.
 * A saved order is not rewritten when a BOM or production version changes. A later issue
 * may consume the snapshot; nothing recomputes it. When a version selects the
 * snapshot, that routing's operations are copied in the same save. An
 * independent component list is not given operations. A later routing edit
 * does not rewrite either snapshot.
 * Capacity is not read.
 *
 * What this screen is *not*, because each of these is a different one and was wired
 * after this module was written: change and display of a saved order
 * (`production-order-change.ts`, `production-order-display.ts` — the change carries the
 * quantity, the dates and the component snapshot), technical completion and its
 * revocation (`technicallyCompleteProductionOrder`, `revokeTechnicalCompletion`, both in
 * `production-order-change.ts`), the finished-goods receipt (`production-receipt.ts`
 * under `PROD.ORDER.GR`, MIGO 101 + R08), confirmations and time tickets, and the
 * availability overview (`order-availability.ts`, read only — it writes no commitment
 * and no reservation, which is its stated contract, not an omission).
 *
 * Still refused by name here, and nowhere else: order closure, a deletion flag on the
 * order, settlement of a production order (`PROD.ORDER.SETTLE` is granted by the
 * registry and settles nothing, because no cost basis stands on the order to settle —
 * `docs/DEFERRED_ISSUES.md` DI-012), collective manufacturing orders, and external
 * order numbering. A finished-good batch may be named when that batch already stands.
 * A new batch is created only when the scheduling profile snapshotted at create says
 * so. OPKP is not this screen.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { recordChange } from '../../platform/change';
import { plant as plantTable } from '../foundation/schema';
import { material, materialPlant } from './schema';
import { resolveStorageLocation, StorageLocationError } from './storage-location';
import { productionOrder, productionOrderComponent } from './schema';
import { parseProductionOrderStatus, type ProductionOrderStatus } from '../production/production-order-status';
import { OrderBomSnapshotError, resolveOrderBomSnapshot, type OrderBomSnapshot } from '../production/order-bom-snapshot';
import { OrderOperationSnapshotError, insertOrderOperationSnapshot } from '../production/order-operation-snapshot';
import { productionOrderType } from '../production/schema';

export type { OrderBomSnapshot };
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
  /** Null when the line was supplied rather than copied from a BOM item. */
  bomItem: string | null;
  sourceMaterial: string | null;
  /** Null when no matching dependent requirement established a date. */
  requirementDate: string | null;
  createdAt: string;
}

export interface ProductionOrderView {
  orderNumber: string;
  materialNumber: string;
  materialDescription: string | null;
  plant: string;
  /** Null when the order was created without a type. It is not filled in later. */
  orderType: string | null;
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
  status: ProductionOrderStatus;
  releasedBy: string | null;
  releasedAt: string | null;
  createdAt: string;
  components: ProductionOrderComponentView[];
  /** OMCWB was read. A WIP batch was not created. */
  wipBatchActive: 'X' | ' ';
  wipBatchCreated: false;
  /** Null unless planned-order conversion created this order. */
  plannedOrderNumber: string | null;
  /** Null when an independent snapshot was supplied. Set when a version selected the snapshot. */
  productionVersion: string | null;
  bomUsage: string | null;
  bomAlternative: string | null;
}

function requireAssignedOrderType(raw: string | undefined): string {
  if (raw == null || raw.trim() === '') {
    throw new ProductionOrderError(
      'A production order type is required. Nothing was saved.',
      'Enter a standing category 10 production order type. A scheduling profile does not propose one.',
    );
  }
  if (raw !== raw.trim()) {
    throw new ProductionOrderError(
      'The order type has surrounding spaces. They were not removed. Nothing was saved.',
      'Type the standing production order type. It was not padded or trimmed.',
    );
  }
  if (!/^[A-Z0-9]{4}$/.test(raw)) {
    throw new ProductionOrderError(
      `Order type ${raw} is not four characters, A to Z or 0 to 9. It was not padded. Nothing was saved.`,
      'Define the production order type first. The first type was not chosen.',
    );
  }
  return raw;
}

function requireDate(value: string, what: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new ProductionOrderError(`${what} ${value || '(empty)'} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  }
  return trimmed;
}

function storedStatus(value: string): ProductionOrderStatus {
  const status = parseProductionOrderStatus(value);
  if (!status) {
    throw new ProductionOrderError(
      `Status ${value} is not a production-order status.`,
      'The stored status is unsupported. It was not treated as created.',
    );
  }
  return status;
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
    orderType: header.orderType,
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
    status: storedStatus(header.status),
    releasedBy: header.releasedBy,
    releasedAt: header.releasedAt ? header.releasedAt.toISOString() : null,
    wipBatchActive,
    wipBatchCreated: false,
    plannedOrderNumber: header.plannedOrderNumber,
    productionVersion: header.productionVersion,
    bomUsage: header.bomUsage,
    bomAlternative: header.bomAlternative,
    createdAt: header.createdAt.toISOString(),
    components: rows.map((r) => ({
      itemNumber: r.itemNumber,
      materialNumber: r.materialNumber,
      materialDescription: descriptionOf.get(r.materialNumber) ?? null,
      plant: r.plant,
      storageLocation: r.storageLocation,
      requiredQuantity: r.requiredQuantity,
      unit: r.unitOfMeasure,
      bomItem: r.bomItem,
      sourceMaterial: r.sourceMaterial,
      requirementDate: r.requirementDate,
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
  /**
   * Present only for a caller that already resolved the snapshot, including
   * planned-order conversion. The CO01 screen omits this and derives the lines.
   */
  components?: ProductionOrderComponentInput[];
  /**
   * Named version passed to the selector. Not a BOM alternative.
   * Refused when components are supplied, so it is not attached to an independent snapshot.
   */
  productionVersion?: string;
  /**
   * Required. The caller names a standing category-10 type. A blank value is
   * not a type. Material, plant, profile, and the first standing type are not used.
   * An order-type parameter is not read.
   */
  orderType: string;
  requestKey?: string;
}

/**
 * Create an order. Every master is judged before anything is written — the material,
 * the plant and its company, the material's extension to that plant, each component and
 * its storage location — so a refusal leaves no half-created order behind.
 */
export interface CreateProductionOrderResult extends ProductionOrderView {
  releaseNote: string | null;
  snapshotWarnings?: string[];
}

export async function previewProductionOrderBom(input: {
  client: string;
  materialNumber: string;
  plant: string;
  orderQuantity: number;
  scheduledFinish: string;
  orderType: string;
  productionVersion?: string;
}): Promise<OrderBomSnapshot> {
  const materialNumber = input.materialNumber.trim();
  const plant = input.plant.trim();
  const orderType = input.orderType.trim();
  if (!materialNumber) {
    throw new ProductionOrderError('The material to be produced is required.', 'Enter the material the order will make.');
  }
  if (!plant) throw new ProductionOrderError('A plant is required.', 'Enter the plant the order will be produced in.');
  if (!orderType) {
    throw new ProductionOrderError(
      'A production order type is required. Nothing was saved.',
      'Enter a standing category 10 production order type. A scheduling profile does not propose one.',
    );
  }
  if (!(input.orderQuantity > 0)) {
    throw new ProductionOrderError(
      `The order quantity ${input.orderQuantity} is not a positive quantity.`,
      'Enter a quantity greater than zero.',
    );
  }
  const finish = requireDate(input.scheduledFinish, 'The scheduled finish');
  return withTenant(input.client, async (tx) => {
    const [type] = await tx.select().from(productionOrderType).where(and(
      eq(productionOrderType.client, input.client),
      eq(productionOrderType.orderType, orderType),
    ));
    if (!type) {
      throw new ProductionOrderError(
        `Order type ${orderType} does not stand in this tenant. Nothing was saved.`,
        'Define the production order type first. An order-type parameter is not proof that the type stands.',
      );
    }
    if (type.orderCategory !== '10') {
      throw new ProductionOrderError(
        `Order type ${orderType} is not a production order type. Nothing was saved.`,
        'Use a category 10 type. Process orders and networks are not assigned here.',
      );
    }
    try {
      return await resolveOrderBomSnapshot(tx, {
        client: input.client,
        materialNumber,
        plant,
        orderQuantity: input.orderQuantity,
        scheduledFinish: finish,
        orderType,
        productionVersion: input.productionVersion,
      });
    } catch (caught) {
      if (caught instanceof OrderBomSnapshotError) throw new ProductionOrderError(caught.message, caught.remedy);
      throw caught;
    }
  });
}

export async function createProductionOrder(
  input: CreateProductionOrderInput,
  options?: { tx?: Tx; plannedOrderNumber?: string | null },
): Promise<CreateProductionOrderResult> {
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
  const assignedOrderType = requireAssignedOrderType(input.orderType);
  const start = requireDate(input.scheduledStart, 'The scheduled start');
  const finish = requireDate(input.scheduledFinish, 'The scheduled finish');
  if (finish < start) {
    throw new ProductionOrderError(
      `The scheduled finish ${finish} stands before the scheduled start ${start}.`,
      'Enter a finish on or after the start.',
    );
  }
  if (input.components && input.components.length === 0) {
    throw new ProductionOrderError(
      'An order needs at least one component.',
      'Enter the components the order will consume, or cancel the order.',
    );
  }

  const run = async (tx: Tx): Promise<CreateProductionOrderResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/production-order`}, 0))`);
    if (input.requestKey) {
      const [replay] = await tx.select().from(productionOrder).where(and(
        eq(productionOrder.client, input.client),
        eq(productionOrder.requestKey, input.requestKey),
      ));
      if (replay) return toView(tx, input.client, replay);
    }

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
    const [type] = await tx.select().from(productionOrderType).where(and(
      eq(productionOrderType.client, input.client),
      eq(productionOrderType.orderType, assignedOrderType),
    ));
    if (!type) {
      throw new ProductionOrderError(
        `Order type ${assignedOrderType} does not stand in this tenant. Nothing was saved.`,
        'Define the production order type first. An order-type parameter is not proof that the type stands.',
      );
    }
    if (type.orderCategory !== '10') {
      throw new ProductionOrderError(
        `Order type ${assignedOrderType} is not a production order type. Nothing was saved.`,
        'Use a category 10 type. Process orders and networks are not assigned here.',
      );
    }
    if (!extended) {
      throw new ProductionOrderError(
        `Material ${materialNumber} is not extended to plant ${plant}.`,
        `Extend the material to plant ${plant}, then create the order.`,
      );
    }

    if (input.components && input.productionVersion?.trim()) {
      throw new ProductionOrderError(
        'A production version cannot be attached to a component snapshot that was supplied separately. Nothing was saved.',
        'Leave the version blank when the components are already supplied, or omit the components and let the selected version supply the bill of material.',
      );
    }
    let derived: OrderBomSnapshot | null = null;
    if (!input.components) {
      try {
        derived = await resolveOrderBomSnapshot(tx, {
          client: input.client,
          materialNumber,
          plant,
          orderQuantity: input.orderQuantity,
          scheduledFinish: finish,
          orderType: assignedOrderType,
          productionVersion: input.productionVersion,
        });
      } catch (caught) {
        if (caught instanceof OrderBomSnapshotError) throw new ProductionOrderError(caught.message, caught.remedy);
        throw caught;
      }
    }
    const lines = derived
      ? derived.components.map((component) => ({
        materialNumber: component.materialNumber,
        plant: component.plant,
        requiredQuantity: Number(component.requiredQuantity),
        storageLocation: undefined,
        orderItemNumber: component.orderItemNumber,
        bomItem: component.bomItem,
        sourceMaterial: component.sourceMaterial,
      }))
      : input.components!.map((component) => ({
        materialNumber: component.materialNumber,
        plant: component.plant,
        storageLocation: component.storageLocation,
        requiredQuantity: component.requiredQuantity,
        orderItemNumber: undefined as number | undefined,
        bomItem: null as string | null,
        sourceMaterial: null as string | null,
      }));

    // Every component is judged before the header is drawn or written.
    const prepared: Array<{
      materialNumber: string; plant: string; storageLocation: string | null;
      requiredQuantity: number; unit: string;
      orderItemNumber: number; bomItem: string | null; sourceMaterial: string | null;
    }> = [];
    for (const [index, component] of lines.entries()) {
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
        orderItemNumber: component.orderItemNumber ?? position,
        bomItem: component.bomItem,
        sourceMaterial: component.sourceMaterial,
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
      plannedOrderNumber: options?.plannedOrderNumber?.trim() || null,
      orderType: assignedOrderType,
      productionVersion: derived?.productionVersion ?? null,
      bomUsage: derived?.bomUsage ?? null,
      bomAlternative: derived?.bomAlternative ?? null,
      createdBy: input.createdBy,
    }).returning();

    for (const component of prepared) {
      // requirement_date stays null. CO01 has no component scheduling date.
      // Conversion may set it later in this same transaction, and only by
      // copying a matching dependent requirement. The order dates are not used.
      await tx.insert(productionOrderComponent).values({
        client: input.client,
        orderNumber,
        itemNumber: component.orderItemNumber,
        materialNumber: component.materialNumber,
        plant: component.plant,
        storageLocation: component.storageLocation,
        requiredQuantity: String(component.requiredQuantity),
        unitOfMeasure: component.unit,
        bomItem: component.bomItem,
        sourceMaterial: component.sourceMaterial,
        createdBy: input.createdBy,
      });
    }

    if (derived) {
      try {
        await insertOrderOperationSnapshot(tx, {
          client: input.client,
          orderNumber,
          createdBy: input.createdBy,
          operations: derived.operations,
        });
      } catch (caught) {
        if (caught instanceof OrderOperationSnapshotError) {
          throw new ProductionOrderError(`${caught.message} No order was saved.`, caught.remedy);
        }
        throw caught;
      }
    }

    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order',
      objectKey: orderNumber,
      changeType: 'CREATE',
      changedBy: input.createdBy,
      reason: `Order for ${materialNumber} at plant ${plant}, ${prepared.length} component(s)${options?.plannedOrderNumber?.trim() ? `. Converted from planned order ${options.plannedOrderNumber.trim()}` : ''}`,
      after: {
        orderNumber,
        materialNumber,
        plant,
        orderQuantity: String(input.orderQuantity),
        unitOfMeasure: produced.baseUnit,
        scheduledStart: start,
        scheduledFinish: finish,
        status: 'CREATED',
        orderType: assignedOrderType,
        ...(options?.plannedOrderNumber?.trim() ? { plannedOrderNumber: options.plannedOrderNumber.trim() } : {}),
        ...(derived ? {
          productionVersion: derived.productionVersion,
          bomUsage: derived.bomUsage,
          bomAlternative: derived.bomAlternative,
          operations: derived.operations.map((operation) => operation.operationNumber),
        } : {}),
      },
    });

    if (snapshot.releaseOnCreate !== 'X') {
      return { ...(await toView(tx, input.client, header)), releaseNote: null, snapshotWarnings: derived?.warnings ?? [] };
    }
    await tx.execute(sql`SAVEPOINT opkp_release`);
    try {
      const released = await releaseProductionOrderInTx(tx, {
        client: input.client,
        orderNumber,
        releasedBy: input.createdBy,
      });
      await tx.execute(sql`RELEASE SAVEPOINT opkp_release`);
      return { ...released, releaseNote: null, snapshotWarnings: derived?.warnings ?? [] };
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
        snapshotWarnings: derived?.warnings ?? [],
      };
    }
  };
  return options?.tx ? run(options.tx) : withTenant(input.client, run);
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
  if (header.status === 'TECHNICALLY_COMPLETED') {
    throw new ProductionOrderError(
      `Production order ${input.orderNumber} is technically complete. It was not released.`,
      'Revoke technical completion before releasing the order.',
    );
  }
  if (header.status !== 'CREATED') {
    throw new ProductionOrderError(
      `Status ${header.status} is not a production-order status.`,
      'The stored status is unsupported. It was not treated as created.',
    );
  }
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
    version: sql`${productionOrder.version} + 1`,
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
