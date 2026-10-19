import Link from 'next/link';
import { t } from '@/platform/i18n';
import { CLOSE_TASK_HANDLERS, type TaskListView, type TaskView } from '@/modules/finance/close-cockpit';

/**
 * Period-end close cockpit (SCR-101 / CLOCO): select or create a
 * closing cycle, then work its task tree — release, execute,
 * evidence, sign-off, finalize. Completing the list never closes
 * or locks the financial period.
 */
export default function CloseCockpitShell({ canUse, lists, tasks }: {
  canUse: boolean;
  lists: TaskListView[];
  tasks: TaskView[];
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.CLOSE.COCKPIT' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form className="panel space-y-3 p-4" aria-label={t('close.cycleTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('close.taskList')}>
            <input name="taskListId" maxLength={30} className="field-input code w-56" placeholder="MONTH_END" />
          </Field>
          <Field label={t('close.companyCode')}>
            <input name="companyCode" maxLength={4} className="field-input code w-32" placeholder="1000" />
          </Field>
          <Field label={t('close.fiscalYear')}>
            <input name="fiscalYear" inputMode="numeric" className="field-input code w-28" placeholder="2026" />
          </Field>
          <Field label={t('close.period')}>
            <input name="postingPeriod" inputMode="numeric" className="field-input code w-24" placeholder="4" />
          </Field>
          <Field label={t('close.executionMode')}>
            <select name="executionMode" className="field-input w-44" defaultValue="FOREGROUND">
              <option value="FOREGROUND">Foreground</option>
              <option value="BACKGROUND">Background</option>
            </select>
          </Field>
          <Field label={t('close.statusFilter')}>
            <select name="statusFilter" className="field-input w-44" defaultValue="">
              <option value="">{t('close.allStatuses')}</option>
              {['INITIAL', 'RELEASED', 'RUNNING', 'COMPLETED', 'ERROR', 'BLOCKED'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label={t('close.ownerFilter')}>
            <input name="owner" maxLength={12} className="field-input code w-36" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
            {t('close.loadCycle')}
          </button>
          <span className="text-2xs text-ink-faint">{t('close.handlersHint', { handlers: CLOSE_TASK_HANDLERS.map((h) => h.code).join(', ') })}</span>
        </div>
      </form>

      <section className="panel" aria-label={t('close.listsTitle')}>
        <div className="panel-header">
          <h2 className="panel-title">{t('close.listsTitle')}</h2>
          <span className="text-2xs text-ink-faint">{t('close.noLockHint')}</span>
        </div>
        <table className="grid-table">
          <thead>
            <tr>
              <th>{t('close.taskList')}</th><th>{t('close.companyCode')}</th>
              <th>{t('close.cycle')}</th><th>{t('close.status')}</th>
              <th className="text-end">{t('close.progress')}</th><th />
            </tr>
          </thead>
          <tbody>
            {lists.map((list) => (
              <tr key={`${list.taskListId}-${list.fiscalYear}-${list.postingPeriod}`}>
                <td className="code">{list.taskListId}</td>
                <td className="code">{list.companyCode}</td>
                <td className="tabular">{list.fiscalYear} / {String(list.postingPeriod).padStart(2, '0')}</td>
                <td>{list.status}</td>
                <td className="tabular text-end">{list.completionPercent}% ({list.completedTasks}/{list.totalTasks})</td>
                <td>
                  <Link href={`/finance/journal?company=${encodeURIComponent(list.companyCode)}`} className="text-sm text-accent hover:underline">
                    {t('close.openJournal')}
                  </Link>
                </td>
              </tr>
            ))}
            {lists.length === 0 && (
              <tr><td colSpan={6} className="text-sm text-ink-soft">{t('close.listsEmpty')}</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel" aria-label={t('close.tasksTitle')}>
        <div className="panel-header">
          <h2 className="panel-title">{t('close.tasksTitle')}</h2>
        </div>
        <table className="grid-table">
          <thead>
            <tr>
              <th>{t('close.task')}</th><th>{t('close.handler')}</th>
              <th>{t('close.owner')}</th><th>{t('close.predecessors')}</th>
              <th>{t('close.status')}</th><th className="text-end">{t('close.attempts')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.taskId}>
                <td style={{ paddingLeft: `${0.75 + task.depth * 1.25}rem` }}>
                  {task.criticalPath && <span className="me-1 text-signal-warn" title={t('close.criticalPath')}>◆</span>}
                  {task.taskName} <span className="code text-ink-faint">({task.taskId})</span>
                </td>
                <td className="code">{task.handlerCode}</td>
                <td className="code">{task.owner ?? '—'}</td>
                <td className="code">{task.predecessors.join(', ') || '—'}</td>
                <td>{task.status}</td>
                <td className="tabular text-end">{task.attemptCount}</td>
              </tr>
            ))}
            {tasks.length === 0 && (
              <tr><td colSpan={6} className="text-sm text-ink-soft">{t('close.tasksEmpty')}</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
