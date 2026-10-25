'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PRODUCTION_ORDER_CAPABILITY,
  PRODUCTION_ORDER_RELEASE_CAPABILITY,
  PRODUCTION_ORDER_ROUTE,
  ProductionOrderError,
  createProductionOrder,
  previewProductionOrderBom,
  releaseProductionOrder,
  type OrderBomSnapshot,
  type ProductionOrderView,
} from '@/modules/inventory/production-orders';

export interface OrderActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  order?: ProductionOrderView | null;
  preview?: OrderBomSnapshot | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function refusedOverride(form: FormData): string | null {
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (/^component(Material|Plant|Sloc|Quantity)-\d+$/.test(key) || key === 'bomUsage' || key === 'bomAlternative' || key === 'components') {
      return key;
    }
  }
  return null;
}

export async function createOrderAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(PRODUCTION_ORDER_ROUTE);
  if (!can(session, PRODUCTION_ORDER_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the production order create capability.' };
  }
  const override = refusedOverride(form);
  if (override) {
    return {
      ok: false,
      message: `A typed component or BOM alternative (${override}) is not accepted. Components are taken from the selected production version.`,
      remedy: 'Leave the component list empty. Check the bill of material, then create the order.',
      order: null,
      preview: null,
    };
  }
  const orderType = text(form, 'orderType');
  if (!orderType) {
    return {
      ok: false,
      message: 'A production order type is required. Nothing was saved.',
      remedy: 'Enter a standing category 10 production order type. A scheduling profile does not propose one.',
      order: null,
      preview: null,
    };
  }
  const header = {
    client: session.user.client,
    materialNumber: text(form, 'materialNumber'),
    plant: text(form, 'plant'),
    orderQuantity: Number(text(form, 'orderQuantity') || '0'),
    scheduledFinish: text(form, 'scheduledFinish'),
    orderType,
    productionVersion: text(form, 'productionVersion') || undefined,
  };
  if (text(form, 'intent') === 'check') {
    try {
      const preview = await previewProductionOrderBom(header);
      return {
        ok: true,
        message: `Production version ${preview.productionVersion} uses bill of material ${preview.bomUsage}/${preview.bomAlternative}. Nothing was saved.`,
        preview,
        order: null,
      };
    } catch (caught) {
      if (caught instanceof ProductionOrderError) {
        return { ok: false, message: caught.message, remedy: caught.remedy, order: null, preview: null };
      }
      return { ok: false, message: 'The bill of material could not be read.', order: null, preview: null };
    }
  }
  try {
    const order = await createProductionOrder({
      client: header.client,
      createdBy: session.user.username,
      materialNumber: header.materialNumber,
      plant: header.plant,
      orderQuantity: header.orderQuantity,
      scheduledStart: text(form, 'scheduledStart'),
      scheduledFinish: header.scheduledFinish,
      batch: text(form, 'batch') || undefined,
      productionVersion: header.productionVersion,
      orderType,
      requestKey: text(form, 'requestKey') || undefined,
    });
    revalidatePath(PRODUCTION_ORDER_ROUTE);
    const note = order.releaseNote ? ` ${order.releaseNote}` : '';
    const warnings = order.snapshotWarnings?.length ? ` ${order.snapshotWarnings.join(' ')}` : '';
    const released = order.status === 'RELEASED' ? ' and released by the scheduling profile' : '';
    const version = order.productionVersion ? ` Production version ${order.productionVersion}, bill of material ${order.bomUsage}/${order.bomAlternative}.` : '';
    return { ok: true, message: `Order ${order.orderNumber} created${released}.${version}${note}${warnings}`, order, preview: null };
  } catch (caught) {
    if (caught instanceof ProductionOrderError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, order: null, preview: null };
    }
    return { ok: false, message: 'The order could not be created.', order: null, preview: null };
  }
}

export async function releaseOrderAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(PRODUCTION_ORDER_ROUTE);
  if (!can(session, PRODUCTION_ORDER_RELEASE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the production order release capability.' };
  }
  try {
    await assertChangeForSession(session, { lockObject: 'PRODUCTION_ORDER', argument: text(form, 'orderNumber') });
    const order = await releaseProductionOrder({
      client: session.user.client,
      orderNumber: text(form, 'orderNumber'),
      releasedBy: session.user.username,
    });
    revalidatePath(PRODUCTION_ORDER_ROUTE);
    return { ok: true, message: `Order ${order.orderNumber} released.`, order };
  } catch (caught) {
    if (caught instanceof ProductionOrderError || caught instanceof EnqueueError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, order: null };
    }
    return { ok: false, message: 'The order could not be released.', order: null };
  }
}
