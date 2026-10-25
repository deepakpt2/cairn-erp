/**
 * OPJH. Production order type customizing.
 *
 * The SAP key is the client and a four-character order type. It is not a plant
 * key. Plant-dependent parameters are a separate record. The category is
 * production order only. Saving a type does not create
 * an order, change numbering, or define checking control.
 */
import { and, asc, eq } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { productionOrderType } from './schema';

export const ACTIVITY = 'CFG.PROD.ORDERTYPE.DEFINE';
export const ROUTE = '/config/production-order-types';
export const ALIAS = 'OPJH';
export const LOCK_OBJECT = 'PRODUCTION_ORDER_TYPE';
export const PRODUCTION_ORDER_CATEGORY = '10';

export const ORDER_TYPE_GAPS = [
  'The order type is client customizing. It is not keyed by plant. Plant-dependent parameters are a separate record and are not stored here.',
  'Number range, settlement profile, status profile, release, scheduling, costing, and residence time are not stored.',
  'Checking control is not stored on this type. A type does not decide whether an availability check runs. It is a separate record.',
  'Creating a type does not create a production order and does not change numbering. Order creation and conversion do not read this table.',
] as const;

const REFUSED: Record<string, string> = {
  plant: 'A production order type is not keyed by plant. Plant-dependent parameters are a separate record.',
  numberRange: 'A number range is not stored on the order type. Order numbering is not changed.',
  settlementProfile: 'A settlement profile is not stored. Settlement is not configured here.',
  statusProfile: 'A status profile is not stored. Order status is not taken from this type.',
  releaseImmediately: 'Release immediately is not stored. Release stays a separate act.',
  checkingControl: 'Checking control is not stored on this type. This type does not run an availability check.',
  costing: 'Costing is not stored on the order type.',
  residenceTime: 'Residence time is not stored.',
  internalOrder: 'An internal order type is not this customizing. The category is production order only.',
  processOrder: 'A process order type is not this customizing.',
};

export class ProductionOrderTypeError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ProductionOrderTypeError';
    this.remedy = remedy;
  }
}

export interface ProductionOrderTypeRow {
  orderType: string;
  description: string;
  orderCategory: typeof PRODUCTION_ORDER_CATEGORY;
  version: number;
}

export function holdsOrderTypeAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], ACTIVITY);
}

export function productionOrderTypeRefusal(input: Record<string, string | undefined>): string | null {
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
  throw new ProductionOrderTypeError(message, remedy);
}

function rejectExtensions(extensions: Record<string, string | undefined> | undefined): void {
  const message = productionOrderTypeRefusal(extensions ?? {});
  if (message) fail(message, 'Leave the unsupported field unset. Nothing was saved.');
}

function requireKey(raw: string): string {
  if (raw !== raw.trim()) {
    fail('The order type has surrounding spaces. They were not removed. Nothing was saved.', 'Type four characters without spaces.');
  }
  if (!/^[A-Z0-9]{4}$/.test(raw)) {
    fail(`Order type ${raw || '(blank)'} is not four characters, A to Z or 0 to 9. It was not padded.`, 'Use four characters, for example PP01. A plant is not part of the key.');
  }
  return raw;
}

function requireDescription(raw: string): string {
  const description = raw.trim();
  if (!description || description.length > 40) {
    fail('The description is required and may be at most 40 characters. Nothing was saved.', 'Enter the description in the tenant language.');
  }
  return description;
}

function requireReason(raw: string): string {
  const reason = raw.trim();
  if (!reason) fail('A reason is required. Nothing was saved.', 'Say why this type changes.');
  return reason;
}

export async function listProductionOrderTypes(client: string): Promise<{
  types: ProductionOrderTypeRow[];
  gaps: readonly string[];
}> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(productionOrderType)
      .where(eq(productionOrderType.client, client))
      .orderBy(asc(productionOrderType.orderType));
    return {
      types: rows.map((row) => ({
        orderType: row.orderType,
        description: row.description,
        orderCategory: PRODUCTION_ORDER_CATEGORY,
        version: row.version,
      })),
      gaps: ORDER_TYPE_GAPS,
    };
  });
}

export async function saveProductionOrderType(input: {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE' | 'DELETE';
  orderType: string;
  description: string;
  version: number;
  reason: string;
  extensions?: Record<string, string | undefined>;
}): Promise<ProductionOrderTypeRow | null> {
  rejectExtensions(input.extensions);
  const orderType = requireKey(input.orderType);
  const reason = requireReason(input.reason);
  const description = input.mode === 'DELETE' ? '' : requireDescription(input.description);

  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(productionOrderType)
      .where(and(eq(productionOrderType.client, input.client), eq(productionOrderType.orderType, orderType)))
      .for('update');
    if (input.mode === 'CREATE') {
      if (existing) fail(`Order type ${orderType} already stands. Nothing was saved.`, 'Change the standing type, or choose another key.');
      await tx.insert(productionOrderType).values({
        client: input.client,
        orderType,
        description,
        orderCategory: PRODUCTION_ORDER_CATEGORY,
        version: 1,
        createdBy: input.changedBy,
      });
    } else {
      if (!existing) fail(`Order type ${orderType} does not stand. Nothing was saved.`, 'Create it first.');
      if (existing.version !== input.version) {
        fail(`Order type ${orderType} was opened at version ${input.version}, and version ${existing.version} now stands. Nothing was saved.`, 'Reload the type and save again.');
      }
      if (existing.orderCategory !== PRODUCTION_ORDER_CATEGORY) {
        fail(`Order type ${orderType} is not a production order type. Nothing was saved.`, 'This screen maintains category 10 only.');
      }
      if (input.mode === 'DELETE') {
        await tx.delete(productionOrderType).where(and(
          eq(productionOrderType.client, input.client),
          eq(productionOrderType.orderType, orderType),
        ));
      } else {
        await tx.update(productionOrderType).set({
          description,
          version: existing.version + 1,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(productionOrderType.client, input.client),
          eq(productionOrderType.orderType, orderType),
        ));
      }
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order_type',
      objectKey: orderType,
      changeType: input.mode === 'CREATE' ? 'CREATE' : input.mode === 'DELETE' ? 'DELETE' : 'CHANGE',
      changedBy: input.changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: existing ? { description: existing.description, orderCategory: existing.orderCategory } : undefined,
      after: input.mode === 'DELETE' ? undefined : { description, orderCategory: PRODUCTION_ORDER_CATEGORY },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    if (input.mode === 'DELETE') return null;
    return {
      orderType,
      description,
      orderCategory: PRODUCTION_ORDER_CATEGORY,
      version: input.mode === 'CREATE' ? 1 : existing!.version + 1,
    };
  });
}
