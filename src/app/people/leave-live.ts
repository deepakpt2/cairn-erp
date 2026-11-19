/**
 * Shared glue for the leave screens' server actions: the live-session access object and the refusal state.
 * Actions never pass capability arrays; every leave service re-reads the session, capability and company scope.
 */
import { requireSession } from '@/platform/auth/current';
import { isLeaveError } from '@/modules/people/leave-access';
import { TimeLeaveError } from '@/modules/people/time-leave';

export interface LeaveActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  code?: string;
}

export async function liveLeave(route: string) {
  const session = await requireSession(route);
  return {
    client: session.user.client,
    username: session.user.username,
    access: { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
  };
}

/** A service refusal becomes screen state; anything else is a real fault and is rethrown. */
export function leaveRefusal(error: unknown): LeaveActionState {
  if (isLeaveError(error)) return { ok: false, message: error.message, remedy: error.remedy, code: error.code };
  if (error instanceof TimeLeaveError) return { ok: false, message: error.message, remedy: error.remedy, code: error.code ?? undefined };
  throw error;
}

export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}
