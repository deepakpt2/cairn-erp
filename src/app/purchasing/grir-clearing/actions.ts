'use server';

/**
 * SCR-163 — the GR/IR clearing screen's door.
 *
 * A check calls the preview and writes nothing. Post and reverse call the
 * service. A delivery cost, a consignment, a service, a stock movement and
 * an export are passed through, so the service refuses them by name.
 */
import { can, requireSession } from '@/platform/auth/current';
import {
  GRIR_CLEARING_POST_CAPABILITY,
  GRIR_CLEARING_REVERSE_CAPABILITY,
  GRIR_CLEARING_ROUTE,
  GrIrClearingError,
  postGrIrClearing,
  previewGrIrClearing,
  reverseGrIrClearing,
} from '@/modules/purchasing/grir-clearing';

export interface GrIrClearingActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  wrote?: boolean;
  documentNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function named(form: FormData): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const name of ['deliveryCost', 'consignment', 'service', 'accountAssignment', 'currency', 'exchangeRate', 'quantity', 'stock', 'movement', 'approval', 'batch', 'export', 'paymentBlock', 'outbox', 'uuid', 'valueOnly']) {
    const value = text(form, name);
    if (value) extra[name] = value;
  }
  return extra;
}

function refused(caught: unknown): GrIrClearingActionState | null {
  if (!(caught instanceof GrIrClearingError)) return null;
  return { ok: false, message: caught.message, remedy: caught.remedy };
}

function missing(which: 'post' | 'reverse'): GrIrClearingActionState {
  const capability = which === 'post' ? GRIR_CLEARING_POST_CAPABILITY : GRIR_CLEARING_REVERSE_CAPABILITY;
  return { ok: false, message: `You do not hold ${capability}.` };
}

export async function checkGrIrClearingAction(_state: GrIrClearingActionState, form: FormData): Promise<GrIrClearingActionState> {
  const session = await requireSession(GRIR_CLEARING_ROUTE);
  if (!can(session, GRIR_CLEARING_POST_CAPABILITY) && !can(session, 'PROC.GRIR.MAINTAIN')) {
    return missing('post');
  }
  const category = text(form, 'category');
  if (category && category !== 'STANDARD') {
    return { ok: false, message: 'That clearing category is not supported this round.' };
  }
  try {
    const preview = await previewGrIrClearing({
      client: session.user.client,
      orderNumber: text(form, 'orderNumber'),
      itemNumber: Number(text(form, 'itemNumber')),
      keyDate: text(form, 'keyDate'),
      named: named(form),
    });
    return { ok: true, wrote: false, message: preview.message };
  } catch (caught) {
    return refused(caught) ?? { ok: false, message: 'The residual could not be checked.' };
  }
}

export async function postGrIrClearingAction(_state: GrIrClearingActionState, form: FormData): Promise<GrIrClearingActionState> {
  const session = await requireSession(GRIR_CLEARING_ROUTE);
  if (!can(session, GRIR_CLEARING_POST_CAPABILITY)) return missing('post');
  const category = text(form, 'category');
  if (category && category !== 'STANDARD') {
    return { ok: false, message: 'That clearing category is not supported this round.' };
  }
  try {
    const result = await postGrIrClearing({
      client: session.user.client,
      changedBy: session.user.username,
      orderNumber: text(form, 'orderNumber'),
      itemNumber: Number(text(form, 'itemNumber')),
      keyDate: text(form, 'keyDate'),
      postingDate: text(form, 'postingDate'),
      fingerprint: text(form, 'fingerprint'),
      comment: text(form, 'comment'),
      requestKey: text(form, 'requestKey'),
      acknowledgeFurtherActivity: text(form, 'acknowledge') === '1',
      named: named(form),
    });
    return {
      ok: true,
      wrote: result.wrote,
      documentNumber: result.documentNumber,
      message: result.wrote
        ? `GR/IR on ${result.orderNumber}/${result.itemNumber} was cleared by ${result.documentNumber}. Stock was not changed.`
        : `The same request already stood. ${result.documentNumber} was not written again.`,
    };
  } catch (caught) {
    return refused(caught) ?? { ok: false, message: 'The residual could not be cleared.' };
  }
}

export async function reverseGrIrClearingAction(_state: GrIrClearingActionState, form: FormData): Promise<GrIrClearingActionState> {
  const session = await requireSession(GRIR_CLEARING_ROUTE);
  if (!can(session, GRIR_CLEARING_REVERSE_CAPABILITY)) return missing('reverse');
  try {
    const result = await reverseGrIrClearing({
      client: session.user.client,
      changedBy: session.user.username,
      documentNumber: text(form, 'documentNumber'),
      fiscalYear: Number(text(form, 'fiscalYear')),
      reversalDate: text(form, 'reversalDate'),
      comment: text(form, 'comment'),
      requestKey: text(form, 'requestKey'),
      named: named(form),
    });
    return {
      ok: true,
      wrote: result.wrote,
      documentNumber: result.documentNumber,
      message: result.wrote
        ? `The clearing was reversed by ${result.documentNumber}. The original document was not deleted.`
        : `The same request already stood. ${result.documentNumber} was not written again.`,
    };
  } catch (caught) {
    return refused(caught) ?? { ok: false, message: 'The clearing could not be reversed.' };
  }
}
