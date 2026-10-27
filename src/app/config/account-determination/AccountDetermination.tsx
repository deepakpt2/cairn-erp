'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import type {
  AccountDeterminationRow,
  ChartChoice,
  GlAccountChoice,
  PostingEvent,
  ValuationClassChoice,
} from '@/modules/foundation/account-determination';
import {
  deleteDeterminationAction,
  saveDeterminationAction,
  type AccountDeterminationActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

/** The action's answer, refusal or confirmation, with the remedy underneath it. */
function DetMessage({ state }: { state: AccountDeterminationActionState }) {
  if (!state.message) return null;
  return (
    <div
      role={state.ok ? 'status' : 'alert'}
      className="border border-line bg-white p-3 text-sm text-ink"
    >
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

function DialogHeader({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
      <div>
        <span className="code text-xs text-ink-faint">OBYC · {sub}</span>
        <p className="font-semibold">{label}</p>
      </div>
      <button
        type="button"
        className="btn btn-default min-h-11 sm:min-h-9"
        onClick={(event) => {
          const details = event.currentTarget.closest('details');
          if (details) details.open = false;
        }}
      >
        {t('common.close')}
      </button>
    </div>
  );
}

function ReasonField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {t('acctDet.reason')}<RequiredMark />
      </label>
      <textarea
        id={id}
        name="reason"
        className="field-input"
        rows={2}
        maxLength={500}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function EventLabel({ entry }: { entry: PostingEvent }) {
  return (
    <>
      {t(`acctDet.event.${entry.event}`)}{' '}
      <span className="code text-ink-faint">({entry.referenceAlias})</span>
    </>
  );
}

/**
 * The modifier and account fields, behind the chart/event heading: the
 * modifier columns appear exactly where the event's catalogue row says
 * they belong. The G/L account is chosen from the chart's own accounts of
 * the kind the event expects — the service judges the same list per
 * failure for any value a request carries.
 */
function DeterminationFields({
  idPrefix,
  entry,
  chart,
  valuationClasses,
  glChoices,
  row,
}: {
  idPrefix: string;
  entry: PostingEvent;
  chart: string;
  valuationClasses: ValuationClassChoice[];
  glChoices: GlAccountChoice[];
  row: AccountDeterminationRow | null;
}) {
  const accounts = glChoices.filter(
    (choice) => choice.chartOfAccounts === chart && choice.glAccountType === entry.expectedAccountKind,
  );
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {entry.usesValuationClass && (
          <div>
            <label htmlFor={`${idPrefix}-valuation-class`} className="field-label">{t('acctDet.valuationClass')}</label>
            <select id={`${idPrefix}-valuation-class`} name="valuationClass" className="field-input" defaultValue={row?.valuationClass ?? ''}>
              <option value="">{t('acctDet.anyValuationClass')}</option>
              {valuationClasses.map((choice) => (
                <option key={choice.valuationClass} value={choice.valuationClass}>
                  {choice.valuationClass} — {choice.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {entry.usesGeneralModifier && !row && (
          <div>
            <label htmlFor={`${idPrefix}-modifier`} className="field-label">{t('acctDet.generalModifier')}</label>
            <input id={`${idPrefix}-modifier`} name="generalModifier" className="field-input code" maxLength={4} defaultValue="" />
            <p className="mt-1 text-xs text-ink-soft">{t('acctDet.generalModifierHint')}</p>
          </div>
        )}
        <div>
          <label htmlFor={`${idPrefix}-gl-account`} className="field-label">
            {t('acctDet.glAccount')}<RequiredMark />
          </label>
          <select id={`${idPrefix}-gl-account`} name="glAccount" className="field-input" defaultValue={row?.glAccount ?? ''} required>
            <option value="">{t('acctDet.chooseGlAccount')}</option>
            {accounts.map((choice) => (
              <option key={choice.accountNumber} value={choice.accountNumber}>
                {choice.accountNumber} — {choice.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-soft">
            {t('acctDet.expectedKind')}: {t(`acctDet.kind.${entry.expectedAccountKind}`)}
          </p>
        </div>
      </div>
    </>
  );
}

function KeyInputs({ row }: { row: AccountDeterminationRow }) {
  return (
    <>
      <input type="hidden" name="chartOfAccounts" value={row.chartOfAccounts} />
      <input type="hidden" name="event" value={row.event} />
      <input type="hidden" name="valuationClass" value={row.valuationClass} />
      <input type="hidden" name="generalModifier" value={row.generalModifier} />
    </>
  );
}

function RowDialogs({
  row,
  entry,
  valuationClasses,
  glChoices,
}: {
  row: AccountDeterminationRow;
  entry: PostingEvent;
  valuationClasses: ValuationClassChoice[];
  glChoices: GlAccountChoice[];
}) {
  const [changeReason, setChangeReason] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [changeState, changeAction, changePending] = useActionState<AccountDeterminationActionState, FormData>(
    saveDeterminationAction,
    { ok: true },
  );
  const [deleteState, deleteAction, deletePending] = useActionState<AccountDeterminationActionState, FormData>(
    deleteDeterminationAction,
    { ok: true },
  );
  const keySuffix = `${row.chartOfAccounts}-${row.event}-${row.valuationClass || 'ANY'}-${row.generalModifier || 'NONE'}`;
  const sub = `${row.chartOfAccounts} · ${row.event}`;
  const argument = [row.chartOfAccounts, row.event, row.valuationClass, row.generalModifier].map((part) => part.trim()).join('/');
  const [changeOpen, setChangeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const changeLock = useChangeLock('ACCOUNT_DETERMINATION', argument, 'CFG.FIN.ACCTDET.DEFINE', changeOpen);
  const deleteLock = useChangeLock('ACCOUNT_DETERMINATION', argument, 'CFG.FIN.ACCTDET.DEFINE', deleteOpen);

  return (
    <div className="flex gap-3">
      <details className="min-w-16" onToggle={(event) => setChangeOpen(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
          {t('acctDet.change')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('acctDet.change')} ${row.event}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={`${t('acctDet.change')} ${row.glAccount}`} sub={sub} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3" action={changeAction}>
                <input type="hidden" name="mode" value="CHANGE" />
                <KeyInputs row={row} />
                <DeterminationFields idPrefix={`acct-det-${keySuffix}`} entry={entry} chart={row.chartOfAccounts} valuationClasses={valuationClasses} glChoices={glChoices} row={row} />
                <ReasonField id={`acct-det-change-reason-${keySuffix}`} value={changeReason} onChange={setChangeReason} />
                <DetMessage state={changeState} />
                <LockNotice message={changeLock?.mode === 'DISPLAY' ? changeLock.message : null} remedy={changeLock?.remedy} />
                <button type="submit" className="btn-primary" disabled={changePending || !changeReason.trim() || changeLock?.mode !== 'CHANGE'}>
                  {t('acctDet.save')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>

      <details className="min-w-16" onToggle={(event) => setDeleteOpen(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-signal-error hover:underline sm:min-h-9">
          {t('acctDet.delete')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('acctDet.delete')} ${row.event}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={t('acctDet.delete')} sub={sub} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3" action={deleteAction}>
                <KeyInputs row={row} />
                <p className="text-sm text-ink-soft">{t('acctDet.deleteNote')}</p>
                <ReasonField id={`acct-det-delete-reason-${keySuffix}`} value={deleteReason} onChange={setDeleteReason} />
                <DetMessage state={deleteState} />
                <LockNotice message={deleteLock?.mode === 'DISPLAY' ? deleteLock.message : null} remedy={deleteLock?.remedy} />
                <button type="submit" className="btn-primary" disabled={deletePending || !deleteReason.trim() || deleteLock?.mode !== 'CHANGE'}>
                  {t('acctDet.delete')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>
    </div>
  );
}

export function AccountDetermination({
  rows,
  charts,
  valuationClasses,
  glChoices,
  events,
  canMaintain,
}: {
  rows: AccountDeterminationRow[];
  charts: ChartChoice[];
  valuationClasses: ValuationClassChoice[];
  glChoices: GlAccountChoice[];
  events: PostingEvent[];
  canMaintain: boolean;
}) {
  const [chart, setChart] = useState('');
  const [event, setEvent] = useState('');
  const [reason, setReason] = useState('');
  const [createState, createAction, createPending] = useActionState<AccountDeterminationActionState, FormData>(
    saveDeterminationAction,
    { ok: true },
  );
  const entry = events.find((candidate) => candidate.event === event);
  const visible = entry && chart
    ? rows.filter((row) => row.chartOfAccounts === chart && row.event === event)
    : [];

  return (
    <>
      <section className="panel overflow-hidden" aria-labelledby="acct-det-create-title">
        <div className="panel-header">
          <h2 id="acct-det-create-title" className="panel-title">{t('acctDet.newTitle')}</h2>
        </div>
        <form className="space-y-3 p-4" action={createAction}>
          <input type="hidden" name="mode" value="CREATE" />
          <input type="hidden" name="chartOfAccounts" value={chart} />
          <input type="hidden" name="event" value={event} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="acct-det-chart" className="field-label">
                {t('acctDet.chart')}<RequiredMark />
              </label>
              <select id="acct-det-chart" className="field-input" value={chart} onChange={(change) => setChart(change.target.value)}>
                <option value="">{t('acctDet.chooseChart')}</option>
                {charts.map((choice) => (
                  <option key={choice.chartOfAccounts} value={choice.chartOfAccounts}>
                    {choice.chartOfAccounts} — {choice.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="acct-det-event" className="field-label">
                {t('acctDet.event')}<RequiredMark />
              </label>
              <select id="acct-det-event" className="field-input" value={event} onChange={(change) => setEvent(change.target.value)}>
                <option value="">{t('acctDet.chooseEvent')}</option>
                {events.map((candidate) => (
                  <option key={candidate.event} value={candidate.event}>
                    {t(`acctDet.event.${candidate.event}`)} ({candidate.referenceAlias})
                  </option>
                ))}
              </select>
            </div>
          </div>
          {entry && chart && (
            <>
              <DeterminationFields idPrefix="acct-det" entry={entry} chart={chart} valuationClasses={valuationClasses} glChoices={glChoices} row={null} />
              <ReasonField id="acct-det-reason" value={reason} onChange={setReason} />
              <DetMessage state={createState} />
              <button type="submit" className="btn-primary" disabled={createPending || !reason.trim()}>
                {t('acctDet.create')}
              </button>
            </>
          )}
        </form>
      </section>

      <section className="panel overflow-hidden" aria-labelledby="acct-det-grid-title">
        <div className="panel-header">
          <h2 id="acct-det-grid-title" className="panel-title">{t('acctDet.gridTitle')}</h2>
        </div>
        {!entry || !chart ? (
          <p className="p-4 text-sm text-ink-soft">{t('acctDet.noChartEvent')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[47.5rem]">
              <thead>
                <tr>
                  <th>{t('acctDet.chart')}</th>
                  <th>{t('acctDet.event')}</th>
                  {entry.usesValuationClass && <th>{t('acctDet.valuationClass')}</th>}
                  {entry.usesGeneralModifier && <th>{t('acctDet.generalModifier')}</th>}
                  <th>{t('acctDet.glAccount')}</th>
                  {canMaintain && <th>{t('acctDet.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={4 + (entry.usesValuationClass ? 1 : 0) + (entry.usesGeneralModifier ? 1 : 0) + (canMaintain ? 1 : 0)} className="text-ink-soft">
                      {t('acctDet.empty')}
                    </td>
                  </tr>
                ) : (
                  visible.map((row) => (
                    <tr key={`${row.chartOfAccounts}|${row.event}|${row.valuationClass}|${row.generalModifier}`}>
                      <td><span className="code">{row.chartOfAccounts}</span></td>
                      <td><EventLabel entry={entry} /></td>
                      {entry.usesValuationClass && (
                        <td>{row.valuationClass === '' ? t('acctDet.anyValuationClass') : <span className="code">{row.valuationClass}</span>}</td>
                      )}
                      {entry.usesGeneralModifier && (
                        <td>{row.generalModifier === '' ? '—' : <span className="code">{row.generalModifier}</span>}</td>
                      )}
                      <td><span className="code">{row.glAccount}</span></td>
                      {canMaintain && (
                        <td>
                          <RowDialogs row={row} entry={entry} valuationClasses={valuationClasses} glChoices={glChoices} />
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
