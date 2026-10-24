'use server';

import { can, requireSession } from '@/platform/auth/current';
import {
  ORDER_INFORMATION_CAPABILITY,
  ORDER_INFORMATION_ROUTE,
  OrderInformationError,
  orderInformationRefusal,
  saveOrderInformationLayout,
} from '@/modules/production/order-information';

export interface OrderInformationLayoutState {
  ok: boolean;
  message: string;
  layoutId?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function saveOrderInformationLayoutAction(
  _previous: OrderInformationLayoutState,
  form: FormData,
): Promise<OrderInformationLayoutState> {
  const session = await requireSession(ORDER_INFORMATION_ROUTE);
  if (!can(session, ORDER_INFORMATION_CAPABILITY)) {
    return { ok: false, message: `You do not hold the list capability (${ORDER_INFORMATION_CAPABILITY}).` };
  }
  const named = {
    cost: text(form, 'cost'),
    price: text(form, 'price'),
    sharedLayout: text(form, 'sharedLayout'),
    orderType: text(form, 'orderType'),
  };
  const refused = orderInformationRefusal(named);
  if (refused) return { ok: false, message: refused };
  try {
    const saved = await saveOrderInformationLayout(session.user.client, {
      owner: session.user.username,
      object: text(form, 'object'),
      listType: text(form, 'listType'),
      name: text(form, 'layoutName'),
      description: text(form, 'layoutDescription'),
      fields: form.getAll('field').map((value) => String(value)),
      sortField: text(form, 'sortField'),
      sortDirection: text(form, 'sortDirection'),
      isDefault: text(form, 'isDefault') === 'on',
      named,
    });
    return { ok: true, message: `Layout ${saved.name} was saved. It is private to you. The orders were not changed.`, layoutId: saved.layoutId };
  } catch (error) {
    if (error instanceof OrderInformationError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : 'The layout was not saved.' };
  }
}
