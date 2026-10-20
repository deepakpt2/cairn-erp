'use client';

import { useActionState } from 'react';

import { t } from '@/platform/i18n';
import type { OutputListResult, OutputSelection } from '@/modules/inventory/material-document-output';
import {
  dispatchOneAction, recipientAction, runOutputsAction, type OutputActionState,
} from './actions';

const INITIAL: OutputActionState = { ok: false, message: '' };

/** STATUS's SAP digit, shown beside the word. */
const STATUS_ALIAS: Record<string, string> = { PENDING: '0', PROCESSED: '1', ERROR: '2' };
const MEDIUM_ALIAS: Record<string, string> = { PRINT: '1', EMAIL: '5' };
const DISPATCH_ALIAS: Record<string, string> = { IMMEDIATE: '1', PERIODIC: '3' };

export default function MaterialDocumentOutput({ result, selection, slip, route }: {
  result: OutputListResult | null;
  selection: OutputSelection;
  slip: { documentNumber: string; text: string } | null;
  route: string;
}) {
  const [runState, runAction, running] = useActionState(runOutputsAction, INITIAL);
  const [oneState, oneAction, dispatching] = useActionState(dispatchOneAction, INITIAL);
  const [recipientState, recipientSubmit, saving] = useActionState(recipientAction, INITIAL);

  return (
    <>
      <section aria-labelledby="output-selection" className="panel p-4">
        <h2 id="output-selection" className="text-sm font-semibold">{t('mb90.selection')}</h2>
        <form method="get" action={route} className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <label className="block">
            <span className="field-label">{t('mb90.outputType')}</span>
            <select name="outputType" className="input w-full" defaultValue={selection.outputType ?? ''}>
              <option value="">{t('mb90.any')}</option>
              <option value="WE01">WE01 · {t('mb90.we01')}</option>
              <option value="WA01">WA01 · {t('mb90.wa01')}</option>
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.medium')}</span>
            <select name="transmissionMedium" className="input w-full" defaultValue={selection.transmissionMedium ?? ''}>
              <option value="">{t('mb90.any')}</option>
              <option value="PRINT">{t('mb90.print')} (1)</option>
              <option value="EMAIL">{t('mb90.email')} (5)</option>
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.dispatchTime')}</span>
            <select name="dispatchTime" className="input w-full" defaultValue={selection.dispatchTime ?? ''}>
              <option value="">{t('mb90.any')}</option>
              <option value="IMMEDIATE">{t('mb90.immediate')} (1)</option>
              <option value="PERIODIC">{t('mb90.periodic')} (3)</option>
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.status')}</span>
            <select name="status" className="input w-full" defaultValue={selection.status ?? ''}>
              <option value="">{t('mb90.any')}</option>
              <option value="PENDING">{t('mb90.pending')} (0)</option>
              <option value="PROCESSED">{t('mb90.processed')} (1)</option>
              <option value="ERROR">{t('mb90.error')} (2)</option>
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.documentFrom')}</span>
            <input name="documentFrom" className="input w-full" defaultValue={selection.documentFrom ?? ''} />
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.documentTo')}</span>
            <input name="documentTo" className="input w-full" defaultValue={selection.documentTo ?? ''} />
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.year')}</span>
            <input name="documentYear" className="input w-full" maxLength={4} defaultValue={selection.documentYear ?? ''} />
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.plantFrom')}</span>
            <input name="plantFrom" className="input w-full" defaultValue={selection.plantFrom ?? ''} />
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.plantTo')}</span>
            <input name="plantTo" className="input w-full" defaultValue={selection.plantTo ?? ''} />
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.postingDateFrom')}</span>
            <input type="date" name="postingDateFrom" className="input w-full" defaultValue={selection.postingDateFrom ?? ''} />
          </label>
          <label className="block">
            <span className="field-label">{t('mb90.postingDateTo')}</span>
            <input type="date" name="postingDateTo" className="input w-full" defaultValue={selection.postingDateTo ?? ''} />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-default min-h-11 w-full sm:min-h-8">{t('mb90.show')}</button>
          </div>
        </form>

        <form action={runAction}>
          <input type="hidden" name="status" value="PENDING" />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={running}>
              {running ? t('mb90.running') : t('mb90.run')}
            </button>
            <p className="text-sm text-ink-soft">{t('mb90.runHint')}</p>
          </div>
        </form>
        <p role="status" className={`mt-2 text-sm ${runState.ok ? 'text-ink' : 'text-red-700'}`}>
          {runState.message}{runState.remedy ? ` ${runState.remedy}` : ''}
        </p>
      </section>

      {slip && (
        <section aria-labelledby="output-slip" className="panel p-4">
          <h2 id="output-slip" className="text-sm font-semibold">{t('mb90.slip')} · {slip.documentNumber}</h2>
          <pre data-slip={slip.documentNumber} className="mt-2 overflow-x-auto border border-line bg-surface-muted p-3 text-xs leading-5">
            {slip.text}
          </pre>
        </section>
      )}

      {result && (
        <section aria-labelledby="output-queue" className="panel p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="output-queue" className="text-sm font-semibold">
              {t('mb90.queue')} <span className="text-ink-faint">({result.rowCount})</span>
            </h2>
            <p className="text-xs text-ink-soft">
              {t('mb90.pending')} {result.pending} · {t('mb90.processed')} {result.processed} · {t('mb90.error')} {result.failed}
            </p>
          </div>

          <p role="status" className={`mt-2 text-sm ${oneState.ok ? 'text-ink' : 'text-red-700'}`}>
            {oneState.message}{oneState.remedy ? ` ${oneState.remedy}` : ''}
          </p>
          <p role="status" className={`mt-1 text-sm ${recipientState.ok ? 'text-ink' : 'text-red-700'}`}>
            {recipientState.message}{recipientState.remedy ? ` ${recipientState.remedy}` : ''}
          </p>

          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1">{t('mb90.columnDocument')}</th>
                  <th className="py-1">{t('mb90.columnYear')}</th>
                  <th className="py-1">{t('mb90.columnOutput')}</th>
                  <th className="py-1">{t('mb90.columnMedium')}</th>
                  <th className="py-1">{t('mb90.columnDispatch')}</th>
                  <th className="py-1">{t('mb90.columnStatus')}</th>
                  <th className="py-1 text-right">{t('mb90.columnSends')}</th>
                  <th className="py-1">{t('mb90.columnRecipient')}</th>
                  <th className="py-1">{t('mb90.columnLast')}</th>
                  <th className="py-1">{t('mb90.columnActions')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr
                    key={`${row.documentNumber}/${row.outputType}/${row.transmissionMedium}`}
                    data-document={row.documentNumber}
                    data-output={row.outputType}
                    data-medium={row.transmissionMedium}
                    data-status={row.status}
                    data-sends={row.sendCount}
                    className="border-t border-line align-top"
                  >
                    <td className="py-1"><span className="code">{row.documentNumber}</span></td>
                    <td className="py-1">{row.documentYear}</td>
                    <td className="py-1">{row.outputType} <span className="text-ink-soft">{row.outputTypeDescription}</span></td>
                    <td className="py-1">{row.transmissionMedium} <span className="text-ink-faint">({MEDIUM_ALIAS[row.transmissionMedium] ?? '?'})</span></td>
                    <td className="py-1">{row.dispatchTime} <span className="text-ink-faint">({DISPATCH_ALIAS[row.dispatchTime] ?? '?'})</span></td>
                    <td className="py-1">
                      <span data-status-code={row.statusCode}>{row.status}</span>
                      <span className="ms-1 text-ink-faint">({row.statusCode})</span>
                      {row.errorText ? <div className="text-xs text-red-700">{row.errorText}</div> : null}
                    </td>
                    <td className="py-1 text-right tabular-nums">{row.sendCount}</td>
                    <td className="py-1">{row.recipient ?? '—'}</td>
                    <td className="py-1 code text-xs">{row.lastProcessedAt ?? '—'}</td>
                    <td className="py-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <form action={oneAction}>
                          <input type="hidden" name="documentNumber" value={row.documentNumber} />
                          <input type="hidden" name="outputType" value={row.outputType} />
                          <input type="hidden" name="transmissionMedium" value={row.transmissionMedium} />
                          <button type="submit" className="btn btn-default min-h-9" disabled={dispatching || row.status === 'PROCESSED'}>
                            {t('mb90.dispatch')}
                          </button>
                        </form>
                        <a
                          className="link text-xs"
                          href={`${route}?preview=${encodeURIComponent(row.documentNumber)}`}
                        >
                          {t('mb90.preview')}
                        </a>
                      </div>
                      <form action={recipientSubmit} className="mt-1 flex flex-wrap items-center gap-1">
                        <input type="hidden" name="documentNumber" value={row.documentNumber} />
                        <input type="hidden" name="outputType" value={row.outputType} />
                        <input type="hidden" name="transmissionMedium" value={row.transmissionMedium} />
                        <input
                          name="recipient"
                          className="input w-40"
                          placeholder={t('mb90.recipient')}
                          defaultValue={row.recipient ?? ''}
                          aria-label={`${t('mb90.recipient')} ${row.documentNumber}`}
                        />
                        <button type="submit" className="btn btn-default min-h-9" disabled={saving}>
                          {t('mb90.setRecipient')}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.truncated && <p className="mt-2 text-xs text-ink-faint">{t('mb90.truncated')}</p>}
          <p className="mt-2 text-xs text-ink-faint">{t('mb90.footnote')}</p>
        </section>
      )}
    </>
  );
}
