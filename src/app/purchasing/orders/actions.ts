'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PO_CREATE_CAPABILITY,
  PurchaseOrderError,
  changeOrder,
  createOrder,
} from '@/modules/purchasing/orders';
import {
  RELEASE_CAPABILITIES,
  ReleaseError,
  cancelDocumentRelease,
  releaseDocument,
} from '@/modules/purchasing/release';

export interface OrderActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  orderNumber?: string;
  warnings?: string[];
}

const ROUTE = '/purchasing/orders';

export async function releaseOrderAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RELEASE_CAPABILITIES.PURCHASE_ORDER)) {
    return { ok: false, message: 'You do not hold the purchase-order release capability.' };
  }
  const number = form.get('orderNumberValue');
  const code = form.get('releaseCode');
  try {
    const state = await releaseDocument({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: 'PURCHASE_ORDER',
      documentNumber: typeof number === 'string' ? number : '',
      releaseCode: typeof code === 'string' ? code : '',
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: state.status === 'RELEASED'
        ? `Purchase order ${number} is fully released.`
        : `Purchase order ${number} released through step ${state.currentStep} of ${state.steps.length}.`,
    };
  } catch (error) {
    if (error instanceof ReleaseError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function cancelOrderReleaseAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RELEASE_CAPABILITIES.PURCHASE_ORDER)) {
    return { ok: false, message: 'You do not hold the purchase-order release capability.' };
  }
  const number = form.get('orderNumberValue');
  try {
    await cancelDocumentRelease({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: 'PURCHASE_ORDER',
      documentNumber: typeof number === 'string' ? number : '',
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Release of purchase order ${number} cancelled; it stands at the first step again.` };
  } catch (error) {
    if (error instanceof ReleaseError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function saveOrderAction(
  _previous: OrderActionState,
  form: FormData,
): Promise<OrderActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PO_CREATE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the purchase-order create capability.' };
  }
  const payload = form.get('payload');
  const orderNumber = form.get('orderNumber');
  try {
    const input = JSON.parse(typeof payload === 'string' ? payload : '{}') as {
      documentType?: string;
      supplierNumber?: string;
      purchasingOrg?: string;
      purchasingGroup?: string;
      companyCode?: string;
      currency?: string;
      items?: unknown[];
    };
    const base = {
      client: session.user.client,
      changedBy: session.user.username,
      documentType: input.documentType ?? 'STANDARD',
      supplierNumber: input.supplierNumber ?? '',
      purchasingOrg: input.purchasingOrg ?? '',
      purchasingGroup: input.purchasingGroup ?? '',
      companyCode: input.companyCode ?? '',
      currency: input.currency ?? '',
      items: (input.items ?? []) as never[],
    };
    const editing = typeof orderNumber === 'string' && orderNumber;
    if (editing) {
      await assertChangeForSession(session, { lockObject: 'PURCHASE_ORDER', argument: orderNumber });
    }
    const result = editing
      ? await changeOrder({ ...base, orderNumber })
      : await createOrder(base);
    revalidatePath(ROUTE);
    return {
      ok: true,
      orderNumber: result.orderNumber,
      warnings: result.warnings,
      message: editing
        ? `Purchase order ${result.orderNumber} saved.`
        : `Purchase order ${result.orderNumber} created.`,
    };
  } catch (error) {
    if (error instanceof PurchaseOrderError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
