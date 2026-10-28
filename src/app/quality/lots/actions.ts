'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  LOT_CAPABILITY,
  LOT_ROUTE,
  InspectionLotError,
  openLot,
} from '@/modules/quality/lot';

const ROUTE = LOT_ROUTE;

export interface LotActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  lotNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/** The service's own words and remedy are the answer a refusal gives; anything else is a bug, not a refusal. */
function refuse(error: unknown): LotActionState {
  if (error instanceof InspectionLotError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

/**
 * Open a lot against one line of a posted material document.
 *
 * The line is chosen from what the tenant has received and no lot covers yet, so the form submits a document
 * number and a line number rather than a material, a quantity or a batch — those belong to the receipt, and
 * a copy typed into this form would be a second claim about goods the inventory engine already recorded.
 */
export async function openLotAction(
  _previous: LotActionState,
  form: FormData,
): Promise<LotActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, LOT_CAPABILITY)) {
    return {
      ok: false,
      message: 'You do not hold the inspection-lot capability.',
      remedy: 'Ask for QM.LOT.CREATE.',
    };
  }
  // One field names the goods: `MATERIAL DOCUMENT#LINE`, exactly as the picker row reads, so a submission
  // cannot pair a document with a line that belongs to another one.
  const named = text(form, 'line');
  const [materialDocumentNumber, lineNumber] = named.split('#');
  if (!materialDocumentNumber || !lineNumber) {
    return {
      ok: false,
      message: 'No receipt line was chosen.',
      remedy: 'Pick one of the lines the list offers, or open the lots of one document first with the filter.',
    };
  }
  if (!/^\d+$/.test(lineNumber)) {
    return {
      ok: false,
      message: `The line "${lineNumber}" is not a line number.`,
      remedy: 'Choose one of the lines the list offers rather than typing over it.',
    };
  }
  try {
    const lot = await openLot({
      client: session.user.client,
      changedBy: session.user.username,
      materialDocumentNumber,
      lineNumber: Number(lineNumber),
      inspectionNote: optional(form, 'inspectionNote'),
      requestKey: text(form, 'requestKey') || `QL-${session.user.username}-${Date.now()}`,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      lotNumber: lot.lotNumber,
      message: lot.replayed
        ? `Lot ${lot.lotNumber} was already opened by this submission; nothing was created twice.`
        : `Lot ${lot.lotNumber} opened against ${lot.source.materialDocumentNumber} line ${lot.source.lineNumber} `
          + `(${lot.source.baseQuantity} ${lot.source.baseUnit} of ${lot.source.materialNumber}).`,
      remedy: lot.replayed
        ? undefined
        : `The goods keep the ${lot.source.stockType.toLowerCase()} segment and the batch the receipt left them `
          + 'in. Nothing was posted, restricted or released.',
    };
  } catch (error) {
    return refuse(error);
  }
}
