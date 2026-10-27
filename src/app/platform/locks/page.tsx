import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { listEnqueue } from '@/platform/lock/enqueue';

import { DeleteLock } from './DeleteLock';

export const dynamic = 'force-dynamic';

const ROUTE = '/platform/locks';

/**
 * How long the holder has been silent, as this page is rendered. The staleness itself is the platform's
 * judgement (`listEnqueue`), and a row that has fallen silent past the threshold is gone from the list
 * before it is drawn — this number is what an operator reads in the meantime, so that "answered 12 s ago"
 * and "answered 170 s ago" are visibly different rows rather than two timestamps to subtract by eye.
 */
function quietSeconds(heartbeatAt: string): number {
  const at = Date.parse(heartbeatAt);
  return Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 1000)) : 0;
}
const DISPLAY = 'PLT.LOCK.DISPLAY';
const DELETE = 'PLT.LOCK.DELETE';

/** SM12. The locks held while a document or a configuration row is open in change. */
export default async function LockMonitorPage() {
  const session = await requireSession(ROUTE);
  const allowed = can(session, DISPLAY);
  const rows = allowed ? await listEnqueue(session.user.client) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PLT.LOCK.DISPLAY · SM12</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('enqueue.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('enqueue.subtitle')}</p>
      </header>

      {!allowed && (
        <p role="status" className="text-sm text-ink-soft">{t('auth.readOnly', { authority: DISPLAY })}</p>
      )}

      {allowed && (
        <section className="panel overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th>{t('enqueue.user')}</th>
                <th>{t('enqueue.object')}</th>
                <th>{t('enqueue.argument')}</th>
                <th>{t('enqueue.mode')}</th>
                <th>{t('enqueue.transaction')}</th>
                <th>{t('enqueue.since')}</th>
                <th>{t('enqueue.heartbeat')}</th>
                <th title={t('enqueue.answerHint')}>{t('enqueue.answer')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.lockObject}/${row.argument}`}>
                  <td className="code">{row.ownerUser}</td>
                  <td className="code">{row.lockObject}</td>
                  <td className="code">{row.argument}</td>
                  <td>{row.mode}</td>
                  <td className="code">{row.transactionCode ?? '—'}</td>
                  <td className="text-xs">{row.acquiredAt}</td>
                  <td className="text-xs">{row.heartbeatAt}</td>
                  <td>
                    {row.stale
                      ? <span className="chip chip-warn">{t('enqueue.answerStale')}</span>
                      : <span className="text-xs text-ink-soft">{t('enqueue.answerFresh', { seconds: quietSeconds(row.heartbeatAt) })}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="p-4 text-sm text-ink-soft">{t('enqueue.empty')}</p>}
          {rows.length > 0 && <p className="px-4 pb-4 text-xs text-ink-faint">{t('enqueue.answerHint')}</p>}
        </section>
      )}

      {allowed && can(session, DELETE) && <DeleteLock />}
    </div>
  );
}
