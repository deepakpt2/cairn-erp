'use server';

import { requireSession } from '@/platform/auth/current';
import {
  CONFIRMATION_CANCEL_ROUTE,
  ConfirmationCancelError,
  cancelConfirmation,
  type ConfirmationCancelResult,
} from '@/modules/production/confirmation-cancel';

export interface ConfirmationCancelActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  result?: ConfirmationCancelResult | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function cancelConfirmationAction(
  _previous: ConfirmationCancelActionState,
  form: FormData,
): Promise<ConfirmationCancelActionState> {
  const session = await requireSession(CONFIRMATION_CANCEL_ROUTE);
  try {
    const result = await cancelConfirmation(session.user.client, {
      requestedBy: session.user.username,
      requestKey: text(form, 'requestKey'),
      confirmationNumber: text(form, 'confirmationNumber'),
      reason: text(form, 'reason') || undefined,
      confirmed: text(form, 'confirmCancel') === 'on',
      capabilities: session.user.capabilities,
    });
    return {
      ok: true,
      result,
      message: result.replayed
        ? `Cancellation ${result.cancellationNumber} already stands for confirmation ${result.confirmationNumber}. It was not written again. ${result.movementNote}`
        : `Cancellation ${result.cancellationNumber} stands for confirmation ${result.confirmationNumber}. The original was not changed. The order status is still ${result.orderStatus}. ${result.movementNote}`,
    };
  } catch (error) {
    if (error instanceof ConfirmationCancelError) return { ok: false, message: error.message, remedy: error.remedy };
    return { ok: false, message: error instanceof Error ? error.message : 'The confirmation was not cancelled.' };
  }
}
