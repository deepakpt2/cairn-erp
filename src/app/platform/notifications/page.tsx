/**
 * The inbox — Phase 7.
 *
 * Everything the model is, on one screen: a list of messages, newest first,
 * unseen first, each one openable and each one marked seen when opened. There
 * is no archive, no filter, no dismiss, no snooze, no per-user preference.
 * Those are the things this screen is deliberately without.
 *
 * Opening is a navigation, not a click handler, so the message resolves even
 * without JavaScript and the back button still works.
 */
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { listInbox } from '@/platform/notification/notify';

export const dynamic = 'force-dynamic';

const ROUTE = '/platform/notifications';
const DISPLAY = 'PLT.NOTIFY.DISPLAY';

/**
 * How long ago, in the short form an inbox wants.
 *
 * "3d ago" and not "3 days ago": the column is narrow, the precision is not
 * useful below a day, and an inbox is scanned rather than read.
 */
function ageLabel(createdAt: Date, today: Date): string {
  const days = Math.floor((today.getTime() - createdAt.getTime()) / 86_400_000);
  if (days <= 0) return t('notification.age.today');
  return t('notification.age.days', { days });
}

export default async function NotificationsPage() {
  const session = await requireSession(ROUTE);
  const mayRead = can(session, DISPLAY);
  if (!mayRead) {
    return (
      <main className="p-6">
        <h1 className="text-lg font-semibold text-ink">{t('notification.inbox.title')}</h1>
        <p className="mt-2 text-sm text-ink-soft">{t('notification.inbox.empty')}</p>
      </main>
    );
  }

  const client = session.user.client;
  const rows = await listInbox(client, session.user.userId);
  const today = new Date();
  const unseen = rows.filter((row) => row.isUnseen).length;

  return (
    <main className="p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t('notification.inbox.title')}</h1>
          <p className="mt-1 text-xs text-ink-soft">{t('notification.inbox.subtitle')}</p>
        </div>
        {unseen > 0 ? (
          <span className="chip chip-info">{t('notification.unseen', { count: unseen })}</span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="panel mt-4 p-4">
          <p className="text-sm text-ink">{t('notification.inbox.empty')}</p>
          <p className="mt-1 text-xs text-ink-soft">{t('notification.inbox.emptyHint')}</p>
        </div>
      ) : (
        <table className="grid-table mt-4 text-xs">
          <thead>
            <tr>
              <th className="text-start">{t('notification.inbox.title')}</th>
              <th className="w-24 text-start">When</th>
              <th className="w-20 text-start">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.notificationId} className={row.isUnseen ? 'font-medium' : 'text-ink-soft'}>
                <td>{row.title}</td>
                <td className="text-ink-faint">{ageLabel(row.createdAt, today)}</td>
                <td>
                  <Link
                    href={`/platform/notifications/${row.notificationId}`}
                    className="text-accent hover:underline"
                  >
                    {t('notification.open')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
