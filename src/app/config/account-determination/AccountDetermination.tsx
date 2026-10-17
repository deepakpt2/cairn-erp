'use client';

import { useState } from 'react';

import { t } from '@/platform/i18n';
import type {
  AccountDeterminationRow,
  ChartChoice,
  PostingEvent,
  ValuationClassChoice,
} from '@/modules/foundation/account-determination';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function InertNote() {
  return (
    <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
      {t('acctDet.inert')}
    </p>
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

function ReasonField({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {t('acctDet.reason')}<RequiredMark />
      </label>
      <textarea id={id} name="reason" className="field-input" rows={2} maxLength={500} disabled />
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
 * The fields a create and a change share, behind the chart/event heading:
 * the modifier columns appear exactly where the event's catalogue row says
 * they belong. The G/L account is the one changeable field.
 */
function DeterminationFields({
  idPrefix,
  entry,
  valuationClasses,
  row,
}: {
  idPrefix: string;
  entry: PostingEvent;
  valuationClasses: ValuationClassChoice[];
  row: AccountDeterminationRow | null;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {entry.usesValuationClass && (
          <div>
            <label htmlFor={`${idPrefix}-valuation-class`} className="field-label">{t('acctDet.valuationClass')}</label>
            <select id={`${idPrefix}-valuation-class`} name="valuationClass" className="field-input" defaultValue={row?.valuationClass ?? ''} disabled>
              <option value="">{t('acctDet.anyValuationClass')}</option>
              {valuationClasses.map((choice) => (
                <option key={choice.valuationClass} value={choice.valuationClass}>
                  {choice.valuationClass} — {choice.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {entry.usesGeneralModifier && (
          <div>
            <label htmlFor={`${idPrefix}-modifier`} className="field-label">{t('acctDet.generalModifier')}</label>
            <input id={`${idPrefix}-modifier`} name="generalModifier" className="field-input code" maxLength={4} defaultValue={row?.generalModifier ?? ''} disabled />
            <p className="mt-1 text-xs text-ink-soft">{t('acctDet.generalModifierHint')}</p>
          </div>
        )}
        <div>
          <label htmlFor={`${idPrefix}-gl-account`} className="field-label">
            {t('acctDet.glAccount')}<RequiredMark />
          </label>
          <input id={`${idPrefix}-gl-account`} name="glAccount" className="field-input code" maxLength={10} defaultValue={row?.glAccount ?? ''} placeholder="130000" disabled />
          <p className="mt-1 text-xs text-ink-soft">
            {t('acctDet.expectedKind')}: {t(`acctDet.kind.${entry.expectedAccountKind}`)}
          </p>
        </div>
      </div>
    </>
  );
}

function RowDialogs({
  row,
  entry,
  valuationClasses,
}: {
  row: AccountDeterminationRow;
  entry: PostingEvent;
  valuationClasses: ValuationClassChoice[];
}) {
  const keySuffix = `${row.chartOfAccounts}-${row.event}-${row.valuationClass || 'ANY'}-${row.generalModifier || 'NONE'}`;
  const sub = `${row.chartOfAccounts} · ${row.event}`;
  return (
    <div className="flex gap-3">
      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
          {t('acctDet.change')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('acctDet.change')} ${row.event}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={`${t('acctDet.change')} ${row.glAccount}`} sub={sub} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3">
                <DeterminationFields idPrefix={`acct-det-${keySuffix}`} entry={entry} valuationClasses={valuationClasses} row={row} />
                <ReasonField id={`acct-det-change-reason-${keySuffix}`} />
                <InertNote />
                <button type="submit" className="btn-primary" disabled>
                  {t('acctDet.save')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>

      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-signal-error hover:underline sm:min-h-9">
          {t('acctDet.delete')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('acctDet.delete')} ${row.event}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={t('acctDet.delete')} sub={sub} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3">
                <p className="text-sm text-ink-soft">{t('acctDet.deleteNote')}</p>
                <ReasonField id={`acct-det-delete-reason-${keySuffix}`} />
                <InertNote />
                <button type="submit" className="btn-primary" disabled>
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
  events,
  canMaintain,
  inert,
}: {
  rows: AccountDeterminationRow[];
  charts: ChartChoice[];
  valuationClasses: ValuationClassChoice[];
  events: PostingEvent[];
  canMaintain: boolean;
  inert?: boolean;
}) {
  void inert;
  const [chart, setChart] = useState('');
  const [event, setEvent] = useState('');
  const entry = events.find((candidate) => candidate.event === event);
  const visible = entry && chart
    ? rows.filter((row) => row.chartOfAccounts === chart && row.event === event)
    : [];

  return (
    <>
      <section className="panel overflow-hidden" aria-labelledby="acct-det-select-title">
        <div className="panel-header">
          <h2 id="acct-det-select-title" className="panel-title">{t('acctDet.newTitle')}</h2>
        </div>
        <form className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="acct-det-chart" className="field-label">
                {t('acctDet.chart')}<RequiredMark />
              </label>
              <select id="acct-det-chart" name="chartOfAccounts" className="field-input" value={chart} onChange={(change) => setChart(change.target.value)}>
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
              <select id="acct-det-event" name="event" className="field-input" value={event} onChange={(change) => setEvent(change.target.value)}>
                <option value="">{t('acctDet.chooseEvent')}</option>
                {events.map((candidate) => (
                  <option key={candidate.event} value={candidate.event}>
                    {t(`acctDet.event.${candidate.event}`)} ({candidate.referenceAlias})
                  </option>
                ))}
              </select>
            </div>
          </div>
          {entry && (
            <>
              <DeterminationFields idPrefix="acct-det" entry={entry} valuationClasses={valuationClasses} row={null} />
              <ReasonField id="acct-det-reason" />
              <InertNote />
              <button type="submit" className="btn-primary" disabled>
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
            <table className="grid-table min-w-[760px]">
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
                          <RowDialogs row={row} entry={entry} valuationClasses={valuationClasses} />
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
