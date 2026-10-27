/**
 * The one recovery sentence that belongs under a display-only change-lock notice.
 *
 * The lock is not taken back by the screen: it is released when the holding session leaves, signs out or
 * stops answering, and only at the object's next opening — or now, by an operator who deletes the row in the
 * lock monitor. That is the whole of it, and the wording says exactly that rather than promising a refresh
 * that does not happen. It lives here, next to `LockNotice`, so a screen opened through the client hook and a
 * screen opened during the server render of a page read the same sentence from the same place.
 */
import { t } from '@/platform/i18n';
import type { EnqueueOpen } from '@/platform/lock/enqueue';

/**
 * The remedy for a display-only opening, and only for one: a granted change lock has nothing to recover, and
 * a display result without a holder is an error the platform already explained in its own message.
 */
export function displayOnlyRemedy(open: EnqueueOpen | null | undefined): string | null {
  return open && open.mode === 'DISPLAY' && open.holder ? t('lock.displayOnlyRecovery') : null;
}
