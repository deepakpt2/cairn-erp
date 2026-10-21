'use server';

/**
 * SCR-148 — the only mutation-shaped door on a read-only list.
 *
 * Display reads. Naming a posting or a recount is refused in the service's own words, so a
 * crafted request cannot turn the list into the transaction that follows it.
 */
import { requireSession } from '@/platform/auth/current';
import { can } from '@/platform/auth/current';
import {
  PHYSICAL_INVENTORY_DIFF_LIST_CAPABILITY,
  PHYSICAL_INVENTORY_DIFF_LIST_ROUTE,
  PhysicalInventoryDifferenceError,
  openDifferenceWorkflow,
} from '@/modules/inventory/physical-inventory-differences';

export interface DifferenceWorkflowState {
  ok: boolean;
  message: string;
  remedy?: string;
}

export async function openDifferenceWorkflowAction(
  _previous: DifferenceWorkflowState,
  form: FormData,
): Promise<DifferenceWorkflowState> {
  const session = await requireSession(PHYSICAL_INVENTORY_DIFF_LIST_ROUTE);
  if (!can(session, PHYSICAL_INVENTORY_DIFF_LIST_CAPABILITY)) {
    return { ok: false, message: `You do not hold the difference list capability (${PHYSICAL_INVENTORY_DIFF_LIST_CAPABILITY}).` };
  }
  const workflow = String(form.get('workflow') ?? '').trim().toUpperCase();
  if (workflow !== 'DISPLAY' && workflow !== 'POST' && workflow !== 'RECOUNT') {
    return { ok: false, message: 'That navigation is not a workflow this list answers.' };
  }
  try {
    const document = await openDifferenceWorkflow(session.user.client, {
      workflow,
      documentNumber: String(form.get('documentNumber') ?? ''),
      fiscalYear: Number(String(form.get('fiscalYear') ?? '0')),
    });
    if (workflow === 'DISPLAY' && !document) {
      return { ok: false, message: 'That physical inventory document does not stand.' };
    }
    return { ok: true, message: document ? `Document ${document.documentNumber} displayed. Nothing was written.` : 'Nothing was written.' };
  } catch (caught) {
    if (caught instanceof PhysicalInventoryDifferenceError) {
      return { ok: false, message: caught.message, remedy: caught.remedy };
    }
    throw caught;
  }
}
