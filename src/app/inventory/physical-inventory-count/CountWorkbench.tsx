'use client';

import { useActionState, useEffect, useState } from 'react';

import { t } from '@/platform/i18n';
import type { CountDocumentView, CountHistoryEntry } from '@/modules/inventory/physical-inventory-count';
import { clearCountAction, submitCountsAction, type CountActionState } from './actions';

const INITIAL: CountActionState = { ok: false, message: '' };

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * The count grid.
 *
 * One row per item — material, stock type, the book quantity the count answers for, the quantity
 * counted, its unit, an explicit zero, the date, the counter and a note. Rows already counted carry
 * their version so the service can refuse a write made against a stale screen.
 *
 * The request key moves on after every successful save: a key fixed for the life of the page would
 * make the second save a replay of the first, which is the defect MBRL, MIGO and MB1B each had to
 * fix in turn.
 */
export default function CountWorkbench({
  document,
  history,
  canCount,
  canCorrect,
  today,
}: {
  document: CountDocumentView;
  history: CountHistoryEntry[];
  canCount: boolean;
  canCorrect: boolean;
  today: string;
}) {
  const [state, action, saving] = useActionState(submitCountsAction, INITIAL);
  const [clearState, clearAction, clearing] = useActionState(clearCountAction, INITIAL);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [clearKey, setClearKey] = useState(newRequestKey);
  const [zeroed, setZeroed] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (state.ok) setRequestKey(newRequestKey());
  }, [state]);
  useEffect(() => {
    if (clearState.ok) setClearKey(newRequestKey());
  }, [clearState]);

  const counted = document.items.filter((i) => i.countStatus === 'COUNTED');
  const uncounted = document.items.filter((i) => i.countStatus !== 'COUNTED');

  return (
    <>
      <section aria-labelledby="count-status" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="count-status" className="text-sm font-semibold">{t('mi04.statusTitle')}</h2>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex justify-between gap-3 border-b border-line/60 py-1">
            <dt className="text-ink-soft">{t('mi04.companyCode')}</dt>
            <dd data-count-company>{document.companyCode}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line/60 py-1">
            <dt className="text-ink-soft">{t('mi04.documentStatus')}</dt>
            <dd data-count-document-status>{document.status}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line/60 py-1">
            <dt className="text-ink-soft">{t('mi04.items')}</dt>
            <dd data-count-items>{document.counts.items}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line/60 py-1">
            <dt className="text-ink-soft">{t('mi04.counted')}</dt>
            <dd data-count-counted>{document.counts.counted}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line/60 py-1">
            <dt className="text-ink-soft">{t('mi04.uncounted')}</dt>
            <dd data-count-uncounted>{document.counts.uncounted}</dd>
          </div>
        </dl>
        {document.postingBlock && (
          <p className="mt-2 text-sm text-ink-soft">{t('mi04.blockHint')}</p>
        )}
        {document.ineligibleReason && (
          <p role="status" className="mt-2 text-sm text-red-700">{document.ineligibleReason}</p>
        )}
        {state.message && (
          <p role="status" data-count-message className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
            {state.message}{state.remedy ? ` ${state.remedy}` : ''}
          </p>
        )}
      </section>

      <section aria-labelledby="count-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="count-grid" className="text-sm font-semibold">{t('mi04.gridTitle')}</h2>
        <form action={action}>
          <input type="hidden" name="documentNumber" value={document.documentNumber} />
          <input type="hidden" name="fiscalYear" value={document.fiscalYear} />
          <input type="hidden" name="requestKey" value={requestKey} />
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mi04.countDate')}</span>
              <input type="date" name="countDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mi04.counter')}</span>
              <input name="counterName" maxLength={35} className="input w-full" placeholder={t('mi04.counterPlaceholder')} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mi04.reason')}</span>
              <input name="reason" maxLength={200} className="input w-full" placeholder={t('mi04.reasonPlaceholder')} />
            </label>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1 pr-2">{t('mi04.columnItem')}</th>
                  <th className="py-1 pr-2">{t('mi04.columnMaterial')}</th>
                  <th className="py-1 pr-2">{t('mi04.columnStockType')}</th>
                  <th className="py-1 pr-2 text-right">{t('mi04.columnBook')}</th>
                  <th className="py-1 pr-2">{t('mi04.columnCounted')}</th>
                  <th className="py-1 pr-2">{t('mi04.columnUnit')}</th>
                  <th className="py-1 pr-2">{t('mi04.columnZero')}</th>
                  <th className="py-1 pr-2">{t('mi04.columnDate')}</th>
                  <th className="py-1 pr-2 text-right">{t('mi04.columnDifference')}</th>
                  <th className="py-1 pr-2">{t('mi04.columnCountStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {document.items.map((item, index) => {
                  const n = index + 1;
                  const isCounted = item.countStatus === 'COUNTED';
                  const zero = zeroed[item.itemNumber] ?? item.zeroCount;
                  return (
                    <tr key={item.itemNumber} data-count-line={item.itemNumber} className="border-t border-line align-top">
                      <td className="py-1 pr-2">
                        {item.itemNumber}
                        <input type="hidden" name={`item-${n}`} value={item.itemNumber} />
                        <input type="hidden" name={`version-${n}`} value={item.version} />
                      </td>
                      <td className="py-1 pr-2">
                        {item.materialNumber}
                        <span className="block text-xs text-ink-faint">{item.description}</span>
                      </td>
                      <td className="py-1 pr-2">{item.stockType}</td>
                      <td className="py-1 pr-2 text-right tabular-nums" data-count-book>
                        {Number(item.bookQuantity).toFixed(3)} {item.bookUnit}
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          name={`quantity-${n}`}
                          type="number"
                          step="0.001"
                          min="0"
                          className="input w-24"
                          defaultValue={item.countedQuantity ?? ''}
                          disabled={!canCount || zero}
                          aria-label={`${t('mi04.columnCounted')} ${item.itemNumber}`}
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          name={`unit-${n}`}
                          className="input w-16"
                          defaultValue={item.entryUnit ?? item.baseUnit}
                          disabled={!canCount}
                          aria-label={`${t('mi04.columnUnit')} ${item.itemNumber}`}
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          type="checkbox"
                          name={`zero-${n}`}
                          defaultChecked={item.zeroCount}
                          disabled={!canCount}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setZeroed((current) => ({ ...current, [item.itemNumber]: checked }));
                          }}
                          aria-label={`${t('mi04.columnZero')} ${item.itemNumber}`}
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          type="date"
                          name={`date-${n}`}
                          className="input w-36"
                          defaultValue={item.countDate ?? ''}
                          disabled={!canCount}
                          aria-label={`${t('mi04.columnDate')} ${item.itemNumber}`}
                        />
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums" data-count-difference>
                        {item.differenceQuantity === null ? '—' : Number(item.differenceQuantity).toFixed(3)}
                      </td>
                      <td className="py-1 pr-2">
                        <span data-count-line-status>{item.countStatus}</span>
                        {item.zeroCount && <span className="block text-xs text-ink-faint">{t('mi04.zeroRecorded')}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="btn btn-primary min-h-11 sm:min-h-8"
              disabled={!canCount || saving || !document.eligible}
            >
              {saving ? t('mi04.saving') : t('mi04.save')}
            </button>
            <p className="text-sm text-ink-soft">{t('mi04.saveHint')}</p>
          </div>
        </form>

        {uncounted.length > 0 && (
          <p className="mt-2 text-sm text-ink-soft" data-count-remaining>
            {t('mi04.remaining')}: {uncounted.map((i) => i.itemNumber).join(', ')}
          </p>
        )}
      </section>

      <section aria-labelledby="count-corrections" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="count-corrections" className="text-sm font-semibold">{t('mi04.correctionsTitle')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('mi04.correctionsHint')}</p>
        {clearState.message && (
          <p role="status" className={`mt-2 text-sm ${clearState.ok ? 'text-ink' : 'text-red-700'}`}>
            {clearState.message}{clearState.remedy ? ` ${clearState.remedy}` : ''}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-3">
          {counted.map((item) => (
            <form key={item.itemNumber} action={clearAction} className="flex items-end gap-2 rounded border border-line p-2">
              <input type="hidden" name="documentNumber" value={document.documentNumber} />
              <input type="hidden" name="fiscalYear" value={document.fiscalYear} />
              <input type="hidden" name="itemNumber" value={item.itemNumber} />
              <input type="hidden" name="version" value={item.version} />
              <input type="hidden" name="requestKey" value={`${clearKey}-${item.itemNumber}`} />
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                  {t('mi04.clearReason')} · {item.itemNumber}
                </span>
                <input name="reason" className="input" maxLength={200} required disabled={!canCorrect} />
              </label>
              <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canCorrect || clearing}>
                {t('mi04.clear')}
              </button>
            </form>
          ))}
        </div>

        {history.length > 0 && (
          <div className="mt-4" data-count-history>
            <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mi04.historyTitle')}</h3>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1">{t('mi04.columnItem')}</th>
                  <th className="py-1">{t('mi04.historyWhen')}</th>
                  <th className="py-1">{t('mi04.historyWho')}</th>
                  <th className="py-1">{t('mi04.historyField')}</th>
                  <th className="py-1">{t('mi04.historyFrom')}</th>
                  <th className="py-1">{t('mi04.historyTo')}</th>
                  <th className="py-1">{t('mi04.historyReason')}</th>
                </tr>
              </thead>
              <tbody>
                {history.flatMap((entry) => entry.fields.map((field, index) => (
                  <tr key={`${entry.itemNumber}-${entry.changedAt.toISOString()}-${field.field}`} className="border-t border-line">
                    <td className="py-1">{entry.itemNumber}</td>
                    <td className="py-1">{entry.changedAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
                    <td className="py-1">{entry.changedBy}</td>
                    <td className="py-1">{field.fieldLabel}</td>
                    <td className="py-1 tabular-nums">{field.oldValue ?? '—'}</td>
                    <td className="py-1 tabular-nums">{field.newValue ?? '—'}</td>
                    {/* The reason belongs to the change, not to each field it touched. */}
                    <td className="py-1">{index === 0 ? (entry.reason ?? '—') : ''}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
