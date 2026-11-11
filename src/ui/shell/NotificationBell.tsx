/**
 * The bell — Phase 7.
 *
 * A count of things you have not read, and a way to get to them. That is all.
 * It does not preview messages, because a preview is a second place the same
 * text has to be kept in step, and it does not mark anything seen on hover,
 * because opening is the one act the model recognises.
 *
 * Rendered only when there is something to say. On a quiet day the header is
 * shorter, which is what quiet should look like.
 */
import Link from 'next/link';

import { getSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { unreadCount } from '@/platform/notification/notify';

const INBOX = '/platform/notifications';

export async function NotificationBell() {
  const session = await getSession();
  if (!session) return null;

  let count = 0;
  try {
    count = await unreadCount(session.user.client, session.user.userId);
  } catch {
    // The bell is decoration. A failure to count must never take the header,
    // and therefore every screen in the application, down with it.
    return null;
  }

  const label = count > 0 ? t('notification.bell.unseen', { count }) : t('notification.bell.none');

  return (
    <Link
      href={INBOX}
      className="relative inline-flex items-center gap-1 text-2xs text-ink-soft hover:text-ink"
      aria-label={label}
      title={label}
    >
      <span aria-hidden>{count > 0 ? '\u25CF' : '\u25CB'}</span>
      {count > 0 ? (
        <span className="code font-medium text-ink">{count}</span>
      ) : null}
      <span className="sr-only">{t('notification.bell.label')}</span>
    </Link>
  );
}
