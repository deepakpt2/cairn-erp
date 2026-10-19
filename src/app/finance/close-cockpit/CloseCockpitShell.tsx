'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import type {
  CloseCycleKey, CloseEventView, ExecutionLogView, TaskListView, TaskView,
} from '@/modules/finance/close-cockpit';
import {
  createListAction, evidenceAction, executeTaskAction, finalizeListAction,
  overrideAction, processScheduledAction, releaseListAction, reopenAction, signoffAction,
  type CloseState,
} from './actions';

const INITIAL: CloseState = { ok: true };

/**
 * Period-end close cockpit (SCR-101 / CLOCO): pick or create a
 * closing cycle from a template, release it, execute its tasks
 * through the registered handlers, satisfy evidence/sign-off
 * gates, and finalize — which never closes or locks the period.
 */
export default function CloseCockpitShell({ canUse, companies, templates, lists, selected, tasks, executions, events }: {
  canUse: boolean;
  companies: Array<{ companyCode: string; name: string }>;
  templates: string[];
  lists: TaskListView[];
  selected: (CloseCycleKey & { list: TaskListView }) | null;
  tasks: TaskView[];
  executions: ExecutionLogView[];
  events: CloseEventView[];
}) {
  const [state, createAction, creating] = useActionState(createListAction, INITIAL);

  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.CLOSE.COCKPIT' })}
      </div>
    );
  }

  const cycleFields = selected && (
    <>
      <input type="hidden" name="companyCode" value={selected.companyCode} />
      <input type="hidden" name="taskListId" value={selected.taskListId} />
      <input type="hidden" name="fiscalYear" value={selected.fiscalYear} />
      <input type="hidden" name="postingPeriod" value={selected.postingPeriod} />
    </>
  );

  return (
    <div className="space-y-4">
      {state.message && !state.ok && (
        <div className="border border-signal-error/30 bg-signal-error-soft p-3">
          <p className="text-sm font-semibold text-signal-error">{state.message}</p>
          {state.remedy && <p className="mt-0.5 text-sm text-ink-soft">{state.remedy}</p>}
        </div>
      )}

      <form action={createAction} className="panel space-y-3 p-4" aria-label={t('close.createTitle')}>
        <h2 className="panel-title">{t('close.createTitle')}</h2>
        <div className="flex flex-wrap gap-3">
          <Field label={t('close.taskList')}>
            <input name="taskListId" maxLength={30} required className="field-input code w-48" placeholder="APRIL_CLOSE" />
          </Field>
          <Field label={t('close.companyCode')}>
            <select name="companyCode" className="field-input code w-48" defaultValue={companies[0]?.companyCode ?? ''}>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}
            </select>
          </Field>
          <Field label={t('close.fiscalYear')}>
            <input name="fiscalYear" type="number" required className="field-input code w-28" placeholder="2026" />
          </Field>
          <Field label={t('close.period')}>
            <input name="postingPeriod" type="number" min={1} max={16} required className="field-input code w-24" placeholder="4" />
          </Field>
          <Field label={t('close.template')}>
            <select name="templateCode" className="field-input code w-48" defaultValue={templates[0] ?? ''}>
              {templates.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </Field>
          <Field label={t('close.description')}>
            <input name="description" maxLength={80} className="field-input w-56" />
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={creating || templates.length === 0}>
          {creating ? t('close.creating') : t('close.create')}
        </button>
        {templates.length === 0 && <p className="text-sm text-signal-warn">{t('close.noTemplates')}</p>}
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
                  <Link
                    href={`/finance/close-cockpit?company=${encodeURIComponent(list.companyCode)}&list=${encodeURIComponent(list.taskListId)}&fy=${list.fiscalYear}&period=${list.postingPeriod}`}
                    className="text-sm text-accent hover:underline"
                  >
                    {t('close.open')}
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

      {selected && (
        <>
          <section className="panel space-y-3 p-4" aria-label={t('close.cycleActions')}>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="panel-title">
                {selected.taskListId} · {selected.companyCode} · {selected.fiscalYear}/{String(selected.postingPeriod).padStart(2, '0')}
              </h2>
              <span className="text-sm text-ink-soft">
                {selected.list.status} · {selected.list.completionPercent}% · {t('close.failedBlocked', { failed: selected.list.failedTasks, blocked: selected.list.blockedTasks })}
                {selected.list.criticalPathOpen ? ` · ${t('close.criticalOpen')}` : ''}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {selected.list.status === 'INITIAL' && (
                <form action={releaseListAction}>{cycleFields}<button className="btn btn-primary min-h-8" type="submit">{t('close.release')}</button></form>
              )}
              <form action={processScheduledAction}>{cycleFields}<button className="btn btn-default min-h-8" type="submit">{t('close.runScheduled')}</button></form>
              {selected.list.status === 'RELEASED' && (
                <form action={finalizeListAction}>{cycleFields}<button className="btn btn-default min-h-8" type="submit">{t('close.finalize')}</button></form>
              )}
            </div>
          </section>

          <section className="panel overflow-x-auto" aria-label={t('close.tasksTitle')}>
            <div className="panel-header"><h2 className="panel-title">{t('close.tasksTitle')}</h2></div>
            <table className="grid-table min-w-[72rem]">
              <thead>
                <tr>
                  <th>{t('close.task')}</th><th>{t('close.handler')}</th>
                  <th>{t('close.owner')}</th><th>{t('close.predecessors')}</th>
                  <th>{t('close.status')}</th><th className="text-end">{t('close.attempts')}</th>
                  <th>{t('close.execute')}</th><th>{t('close.gates')}</th><th>{t('close.override')}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.taskId}>
                    <td style={{ paddingLeft: `${0.75 + task.depth * 1.25}rem` }}>
                      {task.criticalPath && <span className="me-1 text-signal-warn" title={t('close.criticalPath')}>◆</span>}
                      {task.taskName} <span className="code text-ink-faint">({task.taskId})</span>
                      {task.overdue && <span className="ms-1 text-signal-error">{t('close.overdue')}</span>}
                      {task.evidenceRef && <span className="block text-2xs text-ink-faint">{t('close.evidence')}: {task.evidenceRef}</span>}
                      {task.signedOffBy && <span className="block text-2xs text-ink-faint">{t('close.signedOffBy', { user: task.signedOffBy })}</span>}
                    </td>
                    <td className="code">{task.handlerCode}</td>
                    <td className="code">{task.owner ?? '—'}</td>
                    <td className="code">{task.predecessors.join(', ') || '—'}</td>
                    <td>{task.status}</td>
                    <td className="tabular text-end">{task.attemptCount}</td>
                    <td>
                      <div className="flex gap-1">
                        <form action={executeTaskAction}>
                          {cycleFields}<input type="hidden" name="taskId" value={task.taskId} /><input type="hidden" name="mode" value="FOREGROUND" />
                          <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs" disabled={task.status === 'COMPLETED' || task.status === 'RUNNING'}>{t('close.run')}</button>
                        </form>
                        <form action={executeTaskAction}>
                          {cycleFields}<input type="hidden" name="taskId" value={task.taskId} /><input type="hidden" name="mode" value="BACKGROUND" />
                          <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs" disabled={task.status === 'COMPLETED' || task.status === 'RUNNING'}>{t('close.schedule')}</button>
                        </form>
                      </div>
                    </td>
                    <td>
                      <div className="flex flex-col gap-1">
                        <form action={evidenceAction} className="flex gap-1">
                          {cycleFields}<input type="hidden" name="taskId" value={task.taskId} />
                          <input name="evidenceRef" className="field-input min-h-8 w-28 px-2 text-2xs" placeholder={t('close.evidenceRef')} />
                          <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs">{t('close.attach')}</button>
                        </form>
                        <form action={signoffAction}>
                          {cycleFields}<input type="hidden" name="taskId" value={task.taskId} />
                          <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs">{t('close.signOff')}</button>
                        </form>
                      </div>
                    </td>
                    <td>
                      <div className="flex flex-col gap-1">
                        <form action={overrideAction} className="flex gap-1">
                          {cycleFields}<input type="hidden" name="taskId" value={task.taskId} />
                          <select name="newStatus" className="field-input min-h-8 w-28 px-1 text-2xs" defaultValue="COMPLETED">
                            {['RELEASED', 'COMPLETED', 'ERROR', 'BLOCKED'].map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                          <input name="reason" required className="field-input min-h-8 w-28 px-2 text-2xs" placeholder={t('close.reason')} />
                          <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs">{t('close.setStatus')}</button>
                        </form>
                        {task.status === 'COMPLETED' && (
                          <form action={reopenAction} className="flex gap-1">
                            {cycleFields}<input type="hidden" name="taskId" value={task.taskId} />
                            <input name="reason" required className="field-input min-h-8 w-28 px-2 text-2xs" placeholder={t('close.reason')} />
                            <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs">{t('close.reopen')}</button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {tasks.length === 0 && (
                  <tr><td colSpan={9} className="text-sm text-ink-soft">{t('close.tasksEmpty')}</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="panel" aria-label={t('close.executionsTitle')}>
            <div className="panel-header"><h2 className="panel-title">{t('close.executionsTitle')}</h2></div>
            <table className="grid-table">
              <thead>
                <tr><th>{t('close.task')}</th><th>{t('close.attempts')}</th><th>{t('close.executionMode')}</th><th>{t('close.status')}</th><th>{t('close.result')}</th></tr>
              </thead>
              <tbody>
                {executions.map((e) => (
                  <tr key={e.executionId}>
                    <td className="code">{e.taskId}</td>
                    <td className="tabular">{e.attempt}</td>
                    <td>{e.mode}</td>
                    <td>{e.status}</td>
                    <td className="text-sm">{e.errorDetails ?? e.resultSummary ?? '—'}{e.generatedDocumentNumber ? ` · ${e.generatedDocumentNumber}` : ''}</td>
                  </tr>
                ))}
                {executions.length === 0 && (
                  <tr><td colSpan={5} className="text-sm text-ink-soft">{t('close.executionsEmpty')}</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="panel" aria-label={t('close.eventsTitle')}>
            <div className="panel-header"><h2 className="panel-title">{t('close.eventsTitle')}</h2></div>
            <table className="grid-table">
              <thead>
                <tr><th>{t('close.when')}</th><th>{t('close.event')}</th><th>{t('close.task')}</th><th>{t('close.actor')}</th><th>{t('close.detail')}</th></tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.eventId}>
                    <td className="tabular text-2xs">{e.createdAt.slice(0, 19).replace('T', ' ')}</td>
                    <td className="code">{e.eventType}</td>
                    <td className="code">{e.taskId ?? '—'}</td>
                    <td className="code">{e.actor}</td>
                    <td className="text-sm">{[e.reason, e.detail].filter(Boolean).join(' — ') || '—'}</td>
                  </tr>
                ))}
                {events.length === 0 && (
                  <tr><td colSpan={5} className="text-sm text-ink-soft">{t('close.eventsEmpty')}</td></tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
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
