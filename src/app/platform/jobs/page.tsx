import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { listRuns, type JobRunView } from '@/platform/job/monitor';

import { JobControls } from './JobControls';

export const dynamic = 'force-dynamic';

const ROUTE = '/platform/jobs';
const DISPLAY = 'PLT.JOB.DISPLAY';
const CANCEL = 'PLT.JOB.CANCEL';
const RETRY = 'PLT.JOB.RETRY';

const CHIP: Record<string, string> = {
  QUEUED: 'chip chip-neutral',
  RUNNING: 'chip chip-info',
  BLOCKED: 'chip chip-warn',
  SUCCEEDED: 'chip chip-ok',
  FAILED: 'chip chip-error',
  CANCELLED: 'chip chip-neutral',
  DEAD_LETTER: 'chip chip-error',
};

/**
 * What the operator needs, in one line per run.
 *
 * A run that is BLOCKED says who is holding what: without that, the page would
 * invite the operator to cancel something that is only waiting, which is the
 * most expensive mistake available here.
 */
function why(run: JobRunView): string | null {
  if (run.status === 'BLOCKED') {
    const docs = run.blockedOn?.documents ?? [];
    const who = docs
      .map((d) => `${d.lockObject}/${d.argument}${d.holderUser ? ` — ${d.holderUser}` : ''}`)
      .join(', ');
    if (who) return t('jobs.blockedOn', { documents: who });
  }
  if (run.errorText) return run.errorText;
  if (run.resultSummary) return run.resultSummary;
  if (run.progressText) return run.progressText;
  return null;
}

/** SM37. Background jobs: what is running, what finished, and what stopped. */
export default async function JobMonitorPage() {
  const session = await requireSession(ROUTE);
  const allowed = can(session, DISPLAY);
  const runs = allowed ? await listRuns(session.user.client, { limit: 100 }) : [];
  const open = runs.filter((r) => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER'].includes(r.status));
  const done = runs.filter((r) => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER'].includes(r.status));

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PLT.JOB.DISPLAY · SM37</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('jobs.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('jobs.subtitle')}</p>
      </header>

      {!allowed && (
        <p role="status" className="text-sm text-ink-soft">{t('auth.readOnly', { authority: DISPLAY })}</p>
      )}

      {allowed && (
        <>
          <section className="panel overflow-x-auto">
            <h2 className="px-4 pt-3 text-sm font-semibold">{t('jobs.openHeading')}</h2>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>{t('jobs.job')}</th>
                  <th>{t('jobs.submitter')}</th>
                  <th>{t('jobs.status')}</th>
                  <th>{t('jobs.progress')}</th>
                  <th>{t('jobs.queued')}</th>
                  <th>{t('jobs.why')}</th>
                  <th>{t('jobs.action')}</th>
                </tr>
              </thead>
              <tbody>
                {open.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <span className="code">{run.jobCode}</span>
                      {run.jobName && <div className="text-xs text-ink-faint">{run.jobName}</div>}
                    </td>
                    <td className="code">{run.triggeredBy}</td>
                    <td>
                      <span className={CHIP[run.status] ?? 'chip'}>{run.status}</span>
                      {run.retryCount > 0 && (
                        <div className="text-xs text-ink-faint">
                          {t('jobs.attempt', { n: run.retryCount + 1, of: run.maxRetries + 1 })}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded bg-line">
                          <div
                            className="h-full bg-ink-faint"
                            style={{ width: `${Math.min(100, Math.max(0, run.progressPercent))}%` }}
                          />
                        </div>
                        <span className="text-xs">{run.progressPercent}%</span>
                      </div>
                    </td>
                    <td className="text-xs">{run.queuedAt}</td>
                    <td className="max-w-sm text-sm text-ink-soft">{why(run) ?? '—'}</td>
                    <td>
                      <JobControls
                        runId={run.id}
                        canCancel={run.canCancel && can(session, CANCEL)}
                        canRetry={run.canRetry && can(session, RETRY)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {open.length === 0 && <p className="p-4 text-sm text-ink-soft">{t('jobs.openEmpty')}</p>}
          </section>

          <section className="panel overflow-x-auto">
            <h2 className="px-4 pt-3 text-sm font-semibold">{t('jobs.historyHeading')}</h2>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>{t('jobs.job')}</th>
                  <th>{t('jobs.submitter')}</th>
                  <th>{t('jobs.status')}</th>
                  <th>{t('jobs.finished')}</th>
                  <th>{t('jobs.why')}</th>
                  <th>{t('jobs.action')}</th>
                </tr>
              </thead>
              <tbody>
                {done.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <span className="code">{run.jobCode}</span>
                      {run.jobName && <div className="text-xs text-ink-faint">{run.jobName}</div>}
                    </td>
                    <td className="code">{run.triggeredBy}</td>
                    <td><span className={CHIP[run.status] ?? 'chip'}>{run.status}</span></td>
                    <td className="text-xs">{run.finishedAt ?? '—'}</td>
                    <td className="max-w-sm text-sm text-ink-soft">{why(run) ?? '—'}</td>
                    <td>
                      <JobControls
                        runId={run.id}
                        canCancel={false}
                        canRetry={run.canRetry && can(session, RETRY)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {done.length === 0 && <p className="p-4 text-sm text-ink-soft">{t('jobs.historyEmpty')}</p>}
          </section>
        </>
      )}
    </div>
  );
}
