'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { copyChart, type CopyChartActionState } from './actions';

export interface CopyChartChoice {
  code: string;
  name: string;
  /** Characters the chart's account numbers occupy, from OB13. */
  accountNumberLength: number;
}

/**
 * OBY7 Copy Chart of Accounts.
 *
 * The screen states its refusals while the operator is still choosing, because every one of
 * them is a property of the two charts picked rather than of data written: a chart cannot be
 * copied onto itself, and account numbers cannot move into a chart that holds fewer
 * characters than they need. The length rule has one lawful way through — padding, and only
 * when the target is wider — so the screen says which applies instead of leaving the operator
 * to guess after a failed submit. The service re-checks all of it, so these messages save a
 * round trip rather than replace a guard.
 *
 * Inputs go read-only while a copy is in flight. A finished copy revalidates the charts and
 * the account lists, which re-renders this form; typing into it during that revalidation is
 * how FS00's Account Group panel once lost a half-entered range.
 */
export function CopyChartForm({
  charts,
  canCopy,
}: {
  charts: CopyChartChoice[];
  canCopy: boolean;
}) {
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [copyLongTexts, setCopyLongTexts] = useState(true);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [padLeadingZeros, setPadLeadingZeros] = useState(false);
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<CopyChartActionState | null, FormData>(
    copyChart,
    null,
  );

  const sourceChart = charts.find((chart) => chart.code === source);
  const targetChart = charts.find((chart) => chart.code === target);
  const locked = !canCopy || pending;

  // Refusals, in the order the service checks them.
  const problems: string[] = [];
  if (!sourceChart || !targetChart) {
    problems.push(t('chartCopy.chooseBoth'));
  } else if (sourceChart.code === targetChart.code) {
    problems.push(t('chartCopy.sameChart'));
  } else if (targetChart.accountNumberLength < sourceChart.accountNumberLength) {
    // No option makes this lawful: truncating an account number would corrupt it.
    problems.push(t('chartCopy.targetShorter', {
      source: sourceChart.code,
      sourceLength: String(sourceChart.accountNumberLength),
      target: targetChart.code,
      targetLength: String(targetChart.accountNumberLength),
    }));
  } else if (targetChart.accountNumberLength > sourceChart.accountNumberLength && !padLeadingZeros) {
    problems.push(t('chartCopy.lengthNeedsPadding', {
      sourceLength: String(sourceChart.accountNumberLength),
      targetLength: String(targetChart.accountNumberLength),
    }));
  }
  if (!reason.trim()) problems.push(t('chartCopy.reasonRequired'));

  const canSubmit = canCopy && !pending && problems.length === 0;

  return (
    <section className="border border-line bg-white shadow-sm" aria-labelledby="oby7-copy-title">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel px-3 py-2 sm:px-4">
        <h2 id="oby7-copy-title" className="text-sm font-semibold text-ink">{t('chartCopy.title')}</h2>
        <span className="code text-2xs text-ink-soft">CFG.FIN.COA.COPY · OBY7</span>
      </header>

      <form action={formAction} className="grid gap-3 p-3 sm:grid-cols-2 sm:gap-4 sm:p-4">
        {charts.length === 0 ? (
          <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft sm:col-span-2">
            {t('chartCopy.noCharts')}
          </p>
        ) : (
          <>
            <div>
              <label htmlFor="oby7-source" className="field-label">
                {t('chartCopy.source')}
                <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
              </label>
              <select
                id="oby7-source"
                name="sourceChartOfAccounts"
                className="field-input"
                value={source}
                disabled={locked}
                onChange={(event) => setSource(event.target.value)}
              >
                <option value="">{t('chartCopy.choose')}</option>
                {charts.map((chart) => (
                  <option key={chart.code} value={chart.code}>
                    {chart.code} — {chart.name} ({t('chartCopy.characters', { count: String(chart.accountNumberLength) })})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="oby7-target" className="field-label">
                {t('chartCopy.target')}
                <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
              </label>
              <select
                id="oby7-target"
                name="targetChartOfAccounts"
                className="field-input"
                value={target}
                disabled={locked}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">{t('chartCopy.choose')}</option>
                {charts.map((chart) => (
                  <option key={chart.code} value={chart.code}>
                    {chart.code} — {chart.name} ({t('chartCopy.characters', { count: String(chart.accountNumberLength) })})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  name="copyLongTexts"
                  className="mt-1 h-4 w-4"
                  checked={copyLongTexts}
                  disabled={locked}
                  onChange={(event) => setCopyLongTexts(event.target.checked)}
                />
                <span>
                  {t('chartCopy.copyLongTexts')}
                  <span className="block text-xs text-ink-soft">{t('chartCopy.copyLongTextsHint')}</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  name="overwriteExisting"
                  className="mt-1 h-4 w-4"
                  checked={overwriteExisting}
                  disabled={locked}
                  onChange={(event) => setOverwriteExisting(event.target.checked)}
                />
                <span>
                  {t('chartCopy.overwriteExisting')}
                  <span className="block text-xs text-ink-soft">{t('chartCopy.overwriteExistingHint')}</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  name="padLeadingZeros"
                  className="mt-1 h-4 w-4"
                  checked={padLeadingZeros}
                  disabled={locked}
                  onChange={(event) => setPadLeadingZeros(event.target.checked)}
                />
                <span>
                  {t('chartCopy.padLeadingZeros')}
                  <span className="block text-xs text-ink-soft">{t('chartCopy.padLeadingZerosHint')}</span>
                </span>
              </label>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="oby7-reason" className="field-label">
                {t('chartCopy.reason')}
                <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
              </label>
              <textarea
                id="oby7-reason"
                name="reason"
                rows={2}
                maxLength={200}
                className="field-input"
                value={reason}
                readOnly={locked}
                placeholder={t('chartCopy.reasonPlaceholder')}
                onChange={(event) => setReason(event.target.value)}
              />
              <p className="mt-1 text-xs text-ink-soft">{t('chartCopy.reasonHint')}</p>
            </div>
          </>
        )}

        <div className="space-y-2 sm:col-span-2">
          {problems.map((problem) => (
            <p key={problem} className="border border-line bg-white p-3 text-sm text-ink-soft">
              {problem}
            </p>
          ))}
          {problems.length === 0 && charts.length > 0 && (
            <p className="border border-line bg-white p-3 text-sm text-ink-soft">
              {t('chartCopy.preview', { source, target })}
            </p>
          )}
          <p className="border border-line bg-white p-3 text-xs text-ink-soft">{t('chartCopy.tenantScope')}</p>

          {state?.ok && (
            <div role="status" className="border border-line bg-white p-3 text-sm text-ink">
              <p>{state.message}</p>
              {state.details && state.details.length > 0 && (
                <ul className="mt-1 list-disc space-y-1 ps-5 text-xs text-ink-soft">
                  {state.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {state && !state.ok && (
            <div role="alert" className="border border-line bg-white p-3 text-sm text-ink">
              <p>{state.message}</p>
              {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
            </div>
          )}

          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {pending ? t('chartCopy.copying') : t('chartCopy.submit')}
          </button>
        </div>
      </form>
    </section>
  );
}
