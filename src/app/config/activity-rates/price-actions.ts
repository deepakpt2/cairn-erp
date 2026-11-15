'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY_PRICE_CAPABILITY,
  ACTIVITY_PRICE_ROUTE,
  ActivityPriceError,
  calculateActivityPrices,
  previewActivityPrices,
  type ActivityPriceRunView,
} from '@/modules/foundation/activity-price';

export interface PriceRunState {
  ok: boolean;
  message?: string;
  remedy?: string;
  /** 'preview' shows what would be written; 'calculate' shows what was written. */
  mode?: 'preview' | 'calculate';
  view?: ActivityPriceRunView;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Preview or calculate activity prices (KSPI). FormData: `controllingArea`, `fiscalYear`,
 * `planVersion`, `periodFrom`, `periodTo`, `basis` (ANNUAL | PERIOD), `reason`, hidden `requestKey`,
 * and `action` (`preview` or `calculate`, from the button pressed).
 */
export async function activityPriceAction(_prev: PriceRunState, form: FormData): Promise<PriceRunState> {
  const session = await requireSession(ACTIVITY_PRICE_ROUTE);
  if (!can(session, ACTIVITY_PRICE_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${ACTIVITY_PRICE_CAPABILITY}.`, remedy: `Ask an administrator for ${ACTIVITY_PRICE_CAPABILITY}.` };
  }
  const mode = text(form, 'action') === 'calculate' ? 'calculate' : 'preview';
  const input = {
    client: session.user.client,
    changedBy: session.user.username,
    controllingArea: text(form, 'controllingArea'),
    fiscalYear: Number(text(form, 'fiscalYear')),
    planVersion: text(form, 'planVersion') || '000',
    periodFrom: Number(text(form, 'periodFrom')),
    periodTo: Number(text(form, 'periodTo')),
    basis: (text(form, 'basis') === 'PERIOD' ? 'PERIOD' : 'ANNUAL') as 'ANNUAL' | 'PERIOD',
    // A preview writes nothing and records nothing; the reason is asked of the calculation.
    reason: text(form, 'reason') || (mode === 'preview' ? 'preview' : ''),
    requestKey: text(form, 'requestKey') || undefined,
  };
  const options = { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } };
  try {
    if (mode === 'preview') {
      const view = await previewActivityPrices(input, options);
      return {
        ok: !view.blocked, mode, view,
        message: view.blocked
          ? `Preview: the calculation would be refused — ${view.refusals.length} reason${view.refusals.length === 1 ? '' : 's'} below.`
          : `Preview: ${view.pairs.filter((p) => p.status === 'CALCULATED').length} price${view.pairs.filter((p) => p.status === 'CALCULATED').length === 1 ? '' : 's'} would be calculated. Nothing is written yet.`,
      };
    }
    const view = await calculateActivityPrices(input, options);
    revalidatePath(ACTIVITY_PRICE_ROUTE);
    revalidatePath('/controlling/cost-center-report');
    return {
      ok: true, mode, view,
      message: view.written?.changed
        ? `Prices calculated and written to ${view.written.rows} period row${view.written.rows === 1 ? '' : 's'}. Rounding residual ${view.totalResidual} ${view.currency}.`
        : 'Prices calculated: every price already stood as calculated; nothing changed.',
    };
  } catch (error) {
    if (error instanceof ActivityPriceError) return { ok: false, mode, message: error.message, remedy: error.remedy };
    throw error;
  }
}
