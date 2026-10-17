'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import {
  MaterialTypeError,
  deleteAccountCategoryReference,
  deleteMaterialType,
  saveAccountCategoryReference,
  saveMaterialType,
  saveTypeValuation,
  setMaterialTypeActive,
} from '@/modules/inventory/material-type-definition';

export interface MaterialTypeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/material-types';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): MaterialTypeActionState {
  if (error instanceof MaterialTypeError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveMaterialTypeAction(
  _previous: MaterialTypeActionState,
  form: FormData,
): Promise<MaterialTypeActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await saveMaterialType({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      materialType: read(form, 'materialType'),
      name: read(form, 'name'),
      defaultProcurementType: read(form, 'defaultProcurementType'),
      defaultPriceControl: read(form, 'defaultPriceControl'),
      internalNumberRange: read(form, 'internalNumberRange'),
      externalNumberRange: read(form, 'externalNumberRange'),
      accountCategoryReference: read(form, 'accountCategoryReference'),
      externalPurchaseOrders: read(form, 'externalPurchaseOrders'),
      internalPurchaseOrders: read(form, 'internalPurchaseOrders'),
      isConfigurable: read(form, 'isConfigurable') === 'on',
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Material type ${result.materialType} saved.` }
      : { ok: true, message: `Material type ${result.materialType} already holds these facts; nothing was changed.` };
  } catch (error) {
    return fail(error);
  }
}

export async function setMaterialTypeActiveAction(
  _previous: MaterialTypeActionState,
  form: FormData,
): Promise<MaterialTypeActionState> {
  const session = await requireSession(ROUTE);
  const active = read(form, 'active') === 'true';
  try {
    const result = await setMaterialTypeActive({
      client: session.user.client,
      changedBy: session.user.username,
      materialType: read(form, 'materialType'),
      active,
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Material type ${result.materialType} ${active ? 'reactivated' : 'deactivated'}.` }
      : { ok: true, message: `Material type ${result.materialType} already stands ${active ? 'active' : 'inactive'}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteMaterialTypeAction(
  _previous: MaterialTypeActionState,
  form: FormData,
): Promise<MaterialTypeActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await deleteMaterialType({
      client: session.user.client,
      changedBy: session.user.username,
      materialType: read(form, 'materialType'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Material type ${result.materialType} deleted.` };
  } catch (error) {
    return fail(error);
  }
}

export async function saveAccountCategoryReferenceAction(
  _previous: MaterialTypeActionState,
  form: FormData,
): Promise<MaterialTypeActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await saveAccountCategoryReference({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      reference: read(form, 'reference'),
      name: read(form, 'name'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Account category reference ${result.reference} saved.` }
      : { ok: true, message: `Account category reference ${result.reference} already holds this name.` };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteAccountCategoryReferenceAction(
  _previous: MaterialTypeActionState,
  form: FormData,
): Promise<MaterialTypeActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await deleteAccountCategoryReference({
      client: session.user.client,
      changedBy: session.user.username,
      reference: read(form, 'reference'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Account category reference ${result.reference} deleted.` };
  } catch (error) {
    return fail(error);
  }
}

export async function saveTypeValuationAction(
  _previous: MaterialTypeActionState,
  form: FormData,
): Promise<MaterialTypeActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await saveTypeValuation({
      client: session.user.client,
      changedBy: session.user.username,
      materialType: read(form, 'materialType'),
      plant: read(form, 'plant'),
      quantityUpdating: read(form, 'quantityUpdating') === 'on',
      valueUpdating: read(form, 'valueUpdating') === 'on',
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? { ok: true, message: `Updating for type ${result.materialType} at plant ${result.plant} saved.` }
      : { ok: true, message: `Updating for type ${result.materialType} at plant ${result.plant} already stands as shown.` };
  } catch (error) {
    return fail(error);
  }
}
