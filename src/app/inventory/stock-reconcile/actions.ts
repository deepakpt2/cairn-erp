'use server';

/**
 * SCR-144 / INV.STOCK.RECONCILE — the one write on a read-mostly screen.
 *
 * The rebuild is not a movement: it posts nothing, values nothing and journals nothing. It
 * recomputes a dimension from the documents that already exist, so a green run means the ledger
 * and the projection agree, not that stock was created. It refuses while a count holds the
 * dimension open, because that count is about to compare against this very number.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  RECONCILE_CAPABILITY,
  rebuildStockDimension,
} from '@/modules/inventory/stock-reconcile';

const RECONCILE_ROUTE = '/inventory/stock-reconcile';

export interface RebuildState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const text = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();

export async function rebuildAction(
  _previous: RebuildState,
  form: FormData,
): Promise<RebuildState> {
  const session = await requireSession(RECONCILE_ROUTE);
  if (!can(session, RECONCILE_CAPABILITY)) {
    return { ok: false, message: `You do not hold the reconciliation capability (${RECONCILE_CAPABILITY}).` };
  }
  const materialNumber = text(form, 'materialNumber');
  const plant = text(form, 'plant');
  const storageLocation = text(form, 'storageLocation') || null;
  const stockType = text(form, 'stockType');

  try {
    const { ledgerQuantity } = await rebuildStockDimension({
      client: session.user.client,
      changedBy: session.user.username,
      materialNumber, plant, storageLocation, stockType,
    });
    revalidatePath(RECONCILE_ROUTE);
    if (Number(ledgerQuantity) === 0) {
      return {
        ok: true,
        message: `Rebuilt ${materialNumber} ${plant}/${storageLocation ?? '—'} ${stockType}: the ledger knows none, so the projection row was removed.`,
      };
    }
    return {
      ok: true,
      message: `Rebuilt ${materialNumber} ${plant}/${storageLocation ?? '—'} ${stockType} to ${ledgerQuantity}.`,
    };
  } catch (caught) {
    const error = caught as { message?: string; remedy?: string };
    return {
      ok: false,
      message: error?.message ?? 'The dimension could not be rebuilt.',
      remedy: error?.remedy,
    };
  }
}
