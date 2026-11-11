/**
 * The bell — Phase 7.
 *
 * A count of things you have not read, and a way to get to them. That is all.
 * It does not preview messages, because a preview is a second place the same
 * text has to be kept in step, and it does not mark anything seen on hover,
 * because opening is the one act the model recognises.
 *
 * The count is the message. A bare icon with no number makes "three things
 * need you" and "nothing needs you" look identical from across the room, which
 * is the one distinction this control exists to draw.
 *
 * Drawn as an inline SVG rather than a glyph so it does not change shape or
 * weight with the reader's font, and so a font that lacks the character
 * cannot quietly turn the bell into a box.
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
      className="relative inline-flex items-center gap-1 text-2xs text-ink-soft hover:text-accent"
      aria-label={label}
      title={label}
    >
      <svg
        viewBox="0 0 16 16"
        width="13"
        height="13"
        aria-hidden
        focusable="false"
        className={count > 0 ? 'text-ink' : 'text-ink-faint'}
      >
        <path
          d="M4 6.5a4 4 0 1 1 8 0v2.2l1.2 1.8H2.8L4 8.7V6.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M6.4 12.3a1.7 1.7 0 0 0 3.2 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
      {count > 0 ? (
        <span className="code font-medium text-ink">{count}</span>
      ) : null}
      <span className="sr-only">{t('notification.bell.label')}</span>
    </Link>
  );
}
