'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  PO_CREATE_CAPABILITY,
  PurchaseOrderError,
  changeOrder,
  createOrder,
} from '@/modules/purchasing/orders';

export interface OrderActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  orderNumber?: string;
  warnings?: string[];
}

const ROUTE = '/purchasing/orders';

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
    if (error instanceof PurchaseOrderError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
