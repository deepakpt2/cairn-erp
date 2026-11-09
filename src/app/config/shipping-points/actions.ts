'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  SHIPPING_POINT_CAPABILITY,
  ShippingPointMaintenanceError,
  assignShippingPoint,
  changeShippingPointAssignmentStatus,
  changeShippingPointStatus,
  changeShippingConditionStatus,
  defineShippingCondition,
  defineShippingPoint,
} from '@/modules/sales/shipping-point-maintenance';

export interface ShippingPointActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/shipping-points';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function flag(form: FormData, name: string): boolean {
  const raw = text(form, name);
  return raw === 'on' || raw === 'true' || raw === 'yes';
}

function refuse(error: unknown): ShippingPointActionState {
  if (error instanceof ShippingPointMaintenanceError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function denied(): ShippingPointActionState {
  return {
    ok: false,
    message: `You do not hold the authority ${SHIPPING_POINT_CAPABILITY}.`,
    remedy: 'Ask an administrator for an exact-code role assignment; wildcard role patterns do not grant this authority.',
  };
}

/** Name a place goods are loaded from. */
export async function defineShippingPointAction(
  _previous: ShippingPointActionState,
  form: FormData,
): Promise<ShippingPointActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SHIPPING_POINT_CAPABILITY)) return denied();
  try {
    await defineShippingPoint({
      client: session.user.client,
      changedBy: session.user.username,
      shippingPoint: text(form, 'shippingPoint'),
      name: text(form, 'name'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'The shipping point stands. It can be assigned to a plant.' };
  } catch (error) {
    return refuse(error);
  }
}

/** Withdraw a shipping point, or restore one. A withdrawn point loads nothing. */
export async function changeShippingPointAction(
  _previous: ShippingPointActionState,
  form: FormData,
): Promise<ShippingPointActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SHIPPING_POINT_CAPABILITY)) return denied();
  try {
    const isActive = flag(form, 'isActive');
    await changeShippingPointStatus({
      client: session.user.client,
      changedBy: session.user.username,
      shippingPoint: text(form, 'shippingPoint'),
      isActive,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: isActive
        ? 'The shipping point loads again.'
        : 'The shipping point is withdrawn. No delivery can be raised through it until it is restored.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Name a way of wanting goods to arrive. */
export async function defineShippingConditionAction(
  _previous: ShippingPointActionState,
  form: FormData,
): Promise<ShippingPointActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SHIPPING_POINT_CAPABILITY)) return denied();
  try {
    await defineShippingCondition({
      client: session.user.client,
      changedBy: session.user.username,
      shippingCondition: text(form, 'shippingCondition'),
      description: text(form, 'description'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'The shipping condition stands. A customer can carry it, and a row can be maintained for it.' };
  } catch (error) {
    return refuse(error);
  }
}

/** Withdraw a shipping condition, or restore one. */
export async function changeShippingConditionAction(
  _previous: ShippingPointActionState,
  form: FormData,
): Promise<ShippingPointActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SHIPPING_POINT_CAPABILITY)) return denied();
  try {
    const isActive = flag(form, 'isActive');
    await changeShippingConditionStatus({
      client: session.user.client,
      changedBy: session.user.username,
      shippingCondition: text(form, 'shippingCondition'),
      isActive,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: isActive
        ? 'The shipping condition stands again.'
        : 'The shipping condition is withdrawn. A customer still carrying it is refused by name until it is restored or cleared.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Assign a plant and a combination to a dock. */
export async function assignShippingPointAction(
  _previous: ShippingPointActionState,
  form: FormData,
): Promise<ShippingPointActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SHIPPING_POINT_CAPABILITY)) return denied();
  try {
    await assignShippingPoint({
      client: session.user.client,
      changedBy: session.user.username,
      deliveringPlant: text(form, 'deliveringPlant'),
      shippingCondition: text(form, 'shippingCondition'),
      loadingGroup: text(form, 'loadingGroup'),
      shippingPoint: text(form, 'shippingPoint'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'The plant is assigned. Deliveries of that combination go through that dock.' };
  } catch (error) {
    return refuse(error);
  }
}

/** Withdraw an assignment, or restore one. */
export async function changeShippingPointAssignmentAction(
  _previous: ShippingPointActionState,
  form: FormData,
): Promise<ShippingPointActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, SHIPPING_POINT_CAPABILITY)) return denied();
  try {
    const isActive = flag(form, 'isActive');
    await changeShippingPointAssignmentStatus({
      client: session.user.client,
      changedBy: session.user.username,
      deliveringPlant: text(form, 'deliveringPlant'),
      shippingCondition: text(form, 'shippingCondition'),
      loadingGroup: text(form, 'loadingGroup'),
      isActive,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: isActive
        ? 'The row answers again.'
        : 'The row is withdrawn. A delivery of that combination is refused and names this screen.',
    };
  } catch (error) {
    return refuse(error);
  }
}
