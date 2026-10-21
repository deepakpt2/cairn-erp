'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  PHYSICAL_INVENTORY_CANCEL_CAPABILITY,
  PHYSICAL_INVENTORY_CREATE_CAPABILITY,
  PHYSICAL_INVENTORY_ROUTE,
  PhysicalInventoryError,
  cancelPhysicalInventory,
  createPhysicalInventory,
  type PhysicalInventoryView,
} from '@/modules/inventory/physical-inventory';

export interface PhysicalInventoryActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  document?: PhysicalInventoryView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

const LINE_COUNT = 6;

export async function createPhysicalInventoryAction(
  _previous: PhysicalInventoryActionState,
  form: FormData,
): Promise<PhysicalInventoryActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_CREATE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the physical inventory capability.' };
  }

  const materials: string[] = [];
  for (let n = 1; n <= LINE_COUNT; n += 1) {
    const materialNumber = text(form, `material-${n}`);
    if (materialNumber) materials.push(materialNumber);
  }

  try {
    const document = await createPhysicalInventory({
      client: session.user.client,
      createdBy: session.user.username,
      plant: text(form, 'plant'),
      storageLocation: text(form, 'storageLocation') || undefined,
      plannedCountDate: text(form, 'plannedCountDate'),
      postingBlock: text(form, 'postingBlock') === 'on',
      materials,
      requestKey: text(form, 'requestKey'),
    });
    revalidatePath(PHYSICAL_INVENTORY_ROUTE);
    return {
      ok: true,
      message: `Created: physical inventory document ${document.inventoryDocumentNumber}.`,
      document,
    };
  } catch (caught) {
    if (caught instanceof PhysicalInventoryError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, document: null };
    }
    return { ok: false, message: 'The count document could not be created.', document: null };
  }
}

export async function cancelPhysicalInventoryAction(
  _previous: PhysicalInventoryActionState,
  form: FormData,
): Promise<PhysicalInventoryActionState> {
  const session = await requireSession(PHYSICAL_INVENTORY_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_CANCEL_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the physical inventory cancel capability.' };
  }

  try {
    const document = await cancelPhysicalInventory({
      client: session.user.client,
      changedBy: session.user.username,
      inventoryDocumentNumber: text(form, 'inventoryDocumentNumber'),
      fiscalYear: Number(text(form, 'fiscalYear') || '0'),
    });
    revalidatePath(PHYSICAL_INVENTORY_ROUTE);
    return {
      ok: true,
      message: `Cancelled: physical inventory document ${document.inventoryDocumentNumber}.`,
      document,
    };
  } catch (caught) {
    if (caught instanceof PhysicalInventoryError) {
      return { ok: false, message: caught.message, remedy: caught.remedy, document: null };
    }
    return { ok: false, message: 'The count document could not be cancelled.', document: null };
  }
}

/** Cancel from the list — the same act, reached from the row instead of the result panel. */
export async function cancelListedAction(form: FormData): Promise<void> {
  const session = await requireSession(PHYSICAL_INVENTORY_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_CANCEL_CAPABILITY)) return;
  try {
    await cancelPhysicalInventory({
      client: session.user.client,
      changedBy: session.user.username,
      inventoryDocumentNumber: text(form, 'inventoryDocumentNumber'),
      fiscalYear: Number(text(form, 'fiscalYear') || '0'),
    });
  } catch (caught) {
    if (!(caught instanceof PhysicalInventoryError)) throw caught;
  }
  revalidatePath(PHYSICAL_INVENTORY_ROUTE);
}
