/**
 * OPL8. Parameters for one production order type in one plant.
 *
 * The SAP key is the plant and the order type. The plant must already stand,
 * and the order type must already stand. The category is production order only.
 * A task list type and a production version selection may be stored. Saving
 * does not create an order, change numbering, or define checking control.
 * Order creation and planned-order conversion read the stored selection for
 * the same plant and order type. A row here is not proof that the type stands.
 */
import { and, asc, eq } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { plant } from '../foundation/schema';
import { markActivityComplete } from '../../platform/tenancy';
import { productionOrderType, productionOrderTypeParameter, routingTaskListType } from './schema';

export const ACTIVITY = 'CFG.PROD.ORDERPARAM.DEFINE';
export const ROUTE = '/config/order-type-parameters';
export const ALIAS = 'OPL8';
export const LOCK_OBJECT = 'PRODUCTION_ORDER_TYPE_PARAMETER';
export const PRODUCTION_ORDER_CATEGORY = '10';

export const ORDER_PARAMETER_GAPS = [
  'The key is a standing plant and a standing production order type. The plant key is not shortened.',
  'A task list type is optional. Naming it does not select a routing.',
  'Production version selection is read when a production version is resolved for the same plant and order type. The documented values are 0, automatic selection, and 1, manual selection. Blank is the initial value, not a documented selection method. Saving it does not select a version, and MRP does not read it.',
  'Routing selection is not stored. A BOM application and a routing selection ID are not stored, because those masters do not stand.',
  'Costing, settlement, release, a status profile, and scheduling are not stored. Checking control is not stored on these parameters. It is a separate record. Creating this record does not create an order. Order creation and conversion read the stored production version selection for the same plant and order type. They do not use another plant or order type.',
] as const;

const REFUSED: Record<string, string> = {
  routingSelection: 'Routing selection is not stored. It does not select a routing.',
  bomApplication: 'A BOM application is not stored. No application master stands.',
  selectionId: 'A routing selection ID is not stored. No selection-ID master stands.',
  costingVariant: 'A costing variant is not stored. Costing is not configured here.',
  settlementProfile: 'A settlement profile is not stored. Settlement is not configured here.',
  defaultRule: 'A default settlement rule is not stored.',
  statusProfile: 'A status profile is not stored. Order status is not taken from these parameters.',
  releaseImmediately: 'Release is not stored. Release stays a separate act.',
  checkingControl: 'Checking control is not stored on these parameters. These parameters do not run an availability check.',
  reservation: 'A reservation or missing-parts profile is not stored.',
  scheduling: 'Scheduling parameters are not stored. Scheduling is a separate step.',
  numberRange: 'A number range is not stored. Order numbering is not changed.',
  graphicsProfile: 'A graphics profile is not stored.',
  mrpController: 'A substitute MRP controller is not stored.',
  processOrder: 'Process-order parameters are not this customizing.',
};

export class OrderTypeParameterError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'OrderTypeParameterError';
    this.remedy = remedy;
  }
}

export type ProductionVersionSelection = ' ' | '0' | '1';

export interface OrderTypeParameterRow {
  plant: string;
  orderType: string;
  orderCategory: typeof PRODUCTION_ORDER_CATEGORY;
  taskListType: string | null;
  productionVersionSelection: ProductionVersionSelection;
  version: number;
}

export function holdsOrderTypeParameterAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], ACTIVITY);
}

export function orderTypeParameterRefusal(input: Record<string, string | undefined>): string | null {
  for (const [key, message] of Object.entries(REFUSED)) {
    if ((input[key] ?? '').trim()) return message;
  }
  const category = (input.orderCategory ?? '').trim();
  if (category && category !== PRODUCTION_ORDER_CATEGORY) {
    return `Order category ${category} is not a production order. Nothing was saved.`;
  }
  return null;
}

function fail(message: string, remedy?: string): never {
  throw new OrderTypeParameterError(message, remedy);
}

function rejectExtensions(extensions: Record<string, string | undefined> | undefined): void {
  const message = orderTypeParameterRefusal(extensions ?? {});
  if (message) fail(message, 'Leave the unsupported field unset. Nothing was saved.');
}

function requirePlantKey(raw: string): string {
  if (raw !== raw.trim()) {
    fail('The plant has surrounding spaces. They were not removed. Nothing was saved.', 'Type the standing plant key.');
  }
  if (!raw || raw.length > 10) {
    fail(`Plant ${raw || '(blank)'} does not stand. Nothing was saved.`, 'Choose a plant from the plant master. The key is not shortened.');
  }
  return raw;
}

function requireOrderType(raw: string): string {
  if (raw !== raw.trim()) {
    fail('The order type has surrounding spaces. They were not removed. Nothing was saved.', 'Type the standing order type.');
  }
  if (!/^[A-Z0-9]{4}$/.test(raw)) {
    fail(`Order type ${raw || '(blank)'} is not four characters, A to Z or 0 to 9. It was not padded.`, 'Define the production order type first.');
  }
  return raw;
}

function requireTaskListType(raw: string): string | null {
  if (raw === '' || raw === ' ') return null;
  if (raw !== raw.trim()) {
    fail('The task list type has surrounding spaces. They were not removed. Nothing was saved.', 'Leave it blank, or type one standing character.');
  }
  if (!/^[A-Z0-9]$/.test(raw)) {
    fail(`Task list type ${raw} is not one character, A to Z or 0 to 9. Nothing was saved.`, 'Leave it blank, or choose a type that already stands.');
  }
  return raw;
}

function requireSelection(raw: string): ProductionVersionSelection {
  if (raw === '' || raw === ' ') return ' ';
  if (raw !== raw.trim()) {
    fail('The production version selection has surrounding spaces. Nothing was saved.', 'Use blank, 0, or 1.');
  }
  if (raw === '0' || raw === '1') return raw;
  fail(
    `Production version selection ${raw} is not blank, 0, or 1. Nothing was saved.`,
    '0 means automatic selection and 1 means manual selection. Blank is the initial value, not a documented selection method. Saving a value does not select a version.',
  );
}

function requireReason(raw: string): string {
  const reason = raw.trim();
  if (!reason) fail('A reason is required. Nothing was saved.', 'Say why these parameters change.');
  return reason;
}

function rowOf(row: {
  plant: string;
  orderType: string;
  taskListType: string | null;
  productionVersionSelection: string;
  version: number;
}): OrderTypeParameterRow {
  return {
    plant: row.plant,
    orderType: row.orderType,
    orderCategory: PRODUCTION_ORDER_CATEGORY,
    taskListType: row.taskListType,
    productionVersionSelection: row.productionVersionSelection as ProductionVersionSelection,
    version: row.version,
  };
}

export async function listOrderTypeParameters(client: string): Promise<{
  parameters: OrderTypeParameterRow[];
  gaps: readonly string[];
}> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(productionOrderTypeParameter)
      .where(eq(productionOrderTypeParameter.client, client))
      .orderBy(asc(productionOrderTypeParameter.plant), asc(productionOrderTypeParameter.orderType));
    return { parameters: rows.map(rowOf), gaps: ORDER_PARAMETER_GAPS };
  });
}

export async function saveOrderTypeParameter(input: {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE' | 'DELETE';
  plant: string;
  orderType: string;
  taskListType: string;
  productionVersionSelection: string;
  version: number;
  reason: string;
  extensions?: Record<string, string | undefined>;
}): Promise<OrderTypeParameterRow | null> {
  rejectExtensions(input.extensions);
  const plantKey = requirePlantKey(input.plant);
  const orderType = requireOrderType(input.orderType);
  const taskListType = input.mode === 'DELETE' ? null : requireTaskListType(input.taskListType);
  const selection = input.mode === 'DELETE' ? ' ' : requireSelection(input.productionVersionSelection);
  const reason = requireReason(input.reason);

  return withTenant(input.client, async (tx) => {
    const [site] = await tx.select({ plant: plant.plant }).from(plant)
      .where(and(eq(plant.client, input.client), eq(plant.plant, plantKey)));
    if (!site) {
      fail(`Plant ${plantKey} does not stand in this tenant. Nothing was saved.`, 'Choose a plant from the plant master.');
    }
    const [type] = await tx.select().from(productionOrderType)
      .where(and(eq(productionOrderType.client, input.client), eq(productionOrderType.orderType, orderType)));
    if (!type) {
      fail(`Order type ${orderType} does not stand in this tenant. Nothing was saved.`, 'Define the production order type first.');
    }
    if (type.orderCategory !== PRODUCTION_ORDER_CATEGORY) {
      fail(`Order type ${orderType} is not a production order type. Nothing was saved.`, 'This screen maintains category 10 only.');
    }
    if (taskListType) {
      const [task] = await tx.select({ taskListType: routingTaskListType.taskListType }).from(routingTaskListType)
        .where(and(eq(routingTaskListType.client, input.client), eq(routingTaskListType.taskListType, taskListType)));
      if (!task) {
        fail(`Task list type ${taskListType} does not stand. Nothing was saved.`, 'Leave it blank, or define the task list type first. Naming it does not select a routing.');
      }
    }
    const [existing] = await tx.select().from(productionOrderTypeParameter)
      .where(and(
        eq(productionOrderTypeParameter.client, input.client),
        eq(productionOrderTypeParameter.plant, plantKey),
        eq(productionOrderTypeParameter.orderType, orderType),
      ))
      .for('update');
    if (input.mode === 'CREATE') {
      if (existing) fail(`Parameters for ${plantKey} / ${orderType} already stand. Nothing was saved.`, 'Change the standing record, or choose another plant or type.');
      await tx.insert(productionOrderTypeParameter).values({
        client: input.client,
        plant: plantKey,
        orderType,
        orderCategory: PRODUCTION_ORDER_CATEGORY,
        taskListType,
        productionVersionSelection: selection,
        version: 1,
        createdBy: input.changedBy,
      });
    } else {
      if (!existing) fail(`Parameters for ${plantKey} / ${orderType} do not stand. Nothing was saved.`, 'Create them first.');
      if (existing.version !== input.version) {
        fail(`Parameters for ${plantKey} / ${orderType} were opened at version ${input.version}, and version ${existing.version} now stands. Nothing was saved.`, 'Reload the record and save again.');
      }
      if (input.mode === 'DELETE') {
        await tx.delete(productionOrderTypeParameter).where(and(
          eq(productionOrderTypeParameter.client, input.client),
          eq(productionOrderTypeParameter.plant, plantKey),
          eq(productionOrderTypeParameter.orderType, orderType),
        ));
      } else {
        await tx.update(productionOrderTypeParameter).set({
          taskListType,
          productionVersionSelection: selection,
          version: existing.version + 1,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(productionOrderTypeParameter.client, input.client),
          eq(productionOrderTypeParameter.plant, plantKey),
          eq(productionOrderTypeParameter.orderType, orderType),
        ));
      }
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order_type_parameter',
      objectKey: `${plantKey}/${orderType}`,
      changeType: input.mode === 'CREATE' ? 'CREATE' : input.mode === 'DELETE' ? 'DELETE' : 'CHANGE',
      changedBy: input.changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: existing ? {
        taskListType: existing.taskListType,
        productionVersionSelection: existing.productionVersionSelection,
        orderCategory: existing.orderCategory,
      } : undefined,
      after: input.mode === 'DELETE' ? undefined : {
        taskListType,
        productionVersionSelection: selection,
        orderCategory: PRODUCTION_ORDER_CATEGORY,
      },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    if (input.mode === 'DELETE') return null;
    return {
      plant: plantKey,
      orderType,
      orderCategory: PRODUCTION_ORDER_CATEGORY,
      taskListType,
      productionVersionSelection: selection,
      version: input.mode === 'CREATE' ? 1 : existing!.version + 1,
    };
  });
}

/**
 * Read T399X-PVSEL for one plant and one order type.
 * Only 0 and 1 are selection methods. Blank is not treated as either.
 * A missing row is not replaced by another plant, order type, or tenant.
 * This does not prove that the order type stands.
 */
export function productionVersionSelectionOf(
  value: string | null | undefined,
  plant: string,
  orderType: string,
): '0' | '1' {
  if (value === '0' || value === '1') return value;
  if (value == null || value === ' ' || value === '') {
    fail(
      `Production version selection for plant ${plant} and order type ${orderType} is blank. Blank is not a selection method. A production version was not selected.`,
      'Set the selection to 0 or 1. It was not treated as either.',
    );
  }
  fail(
    `Production version selection ${value} for plant ${plant} and order type ${orderType} is not 0 or 1. A production version was not selected.`,
    'Use 0 for automatic selection or 1 for manual selection. The value was not guessed.',
  );
}

export async function readProductionVersionSelection(
  tx: Tx,
  client: string,
  plant: string,
  orderType: string,
): Promise<'0' | '1'> {
  const found = await tx.select({
    productionVersionSelection: productionOrderTypeParameter.productionVersionSelection,
  }).from(productionOrderTypeParameter).where(and(
    eq(productionOrderTypeParameter.client, client),
    eq(productionOrderTypeParameter.plant, plant),
    eq(productionOrderTypeParameter.orderType, orderType),
  ));
  if (found.length === 0) {
    fail(
      `Order type parameters do not stand for plant ${plant} and order type ${orderType}. A production version was not selected.`,
      'Define the parameters for this plant and order type. Another plant or order type was not used.',
    );
  }
  if (found.length > 1) {
    fail(
      `More than one order type parameter row stands for plant ${plant} and order type ${orderType}. None was used.`,
      'Correct the parameters. The first row was not chosen.',
    );
  }
  return productionVersionSelectionOf(found[0]?.productionVersionSelection, plant, orderType);
}

/**
 * Manual selection requires the caller's version. Automatic selection does not.
 * A version the caller did supply is returned either way, so the selector can
 * validate it. Automatic selection does not discard that name and does not
 * invent one.
 */
export function productionVersionForSelection(
  selection: '0' | '1',
  requested: string | null | undefined,
  plant: string,
  orderType: string,
): string | undefined {
  const named = requested?.trim() ? requested.trim() : undefined;
  if (selection === '1' && !named) {
    fail(
      `Plant ${plant} and order type ${orderType} require a production version. None was entered.`,
      'Enter a production version for this material and plant. The first version was not chosen.',
    );
  }
  return named;
}
