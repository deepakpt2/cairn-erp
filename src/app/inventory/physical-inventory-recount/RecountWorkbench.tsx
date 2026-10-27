'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';

import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import { t } from '@/platform/i18n';
import {
  cancelRecountAction,
  checkRecountAction,
  createRecountAction,
  type RecountActionState,
} from './actions';

const INITIAL: RecountActionState = { ok: false, message: '' };
const ROUTE = '/inventory/physical-inventory-recount';

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface RecountLineView {
  itemNumber: number;
  materialNumber: string;
  stockType: string;
  batch?: string;
  countStatus: string;
  bookQuantity: string;
  countedQuantity: string;
  difference: string;
  bookQuantityNow: string;
  eligible: boolean;
  reason: string | null;
  recountDocumentNumber: string | null;
  recountFiscalYear: number | null;
}

export interface RecountDocumentView {
  documentNumber: string;
  fiscalYear: number;
  plant: string;
  storageLocation: string | null;
  status: string;
  plannedCountDate: string;
  items: RecountLineView[];
}

/**
 * The person selects counted items. The recount quantity is not entered here. Check writes
 * nothing. Create writes a new document. Cancel releases the link and does not reverse.
 */
export default function RecountWorkbench({
  document,
  requestedNumber,
  requestedYear,
  canRecount,
  displayOnly = false,
  today,
}: {
  document: RecountDocumentView | null;
  requestedNumber: string;
  requestedYear: string;
  canRecount: boolean;
  displayOnly?: boolean;
  today: string;
}) {
  const [checkState, checkAction, checking] = useActionState(checkRecountAction, INITIAL);
  const [createState, createAction, creating] = useActionState(createRecountAction, INITIAL);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelRecountAction, INITIAL);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [selected, setSelected] = useState<number[]>([]);
  const [cancelNumber, setCancelNumber] = useState('');
  const [cancelYear, setCancelYear] = useState(requestedYear);
  const writable = canRecount && !displayOnly;

  useEffect(() => {
    if (createState.ok) setRequestKey(newRequestKey());
  }, [createState]);
  useEffect(() => {
    setSelected([]);
  }, [document?.documentNumber, document?.fiscalYear, document?.status]);

  const eligible = document?.items.filter((line) => line.eligible) ?? [];
  const raised = createState.recount;
  useEffect(() => {
    if (!raised) return;
    setCancelNumber(raised.recountDocumentNumber);
    setCancelYear(String(raised.recountFiscalYear));
  }, [raised]);
  const cancelLock = useChangeLock(
    'PHYSICAL_INVENTORY',
    cancelNumber.trim() ? `${cancelNumber.trim()}/${cancelYear.trim()}` : null,
    'INV.PHYINV.RECOUNT',
    canRecount && Boolean(cancelNumber.trim()),
  );

  return (
    <>
      <section aria-labelledby="recount-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="recount-lookup" className="text-sm font-semibold">{t('recount.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('recount.document')}</span>
            <input name="doc" className="input" defaultValue={document?.documentNumber ?? requestedNumber} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('recount.fiscalYear')}</span>
            <input name="year" className="input w-28" inputMode="numeric" defaultValue={document?.fiscalYear ?? requestedYear} required />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('recount.load')}</button>
        </form>
        {requestedNumber && !document && (
          <p role="status" className="mt-2 text-sm text-red-700">
            {t('recount.notFound', { document: requestedNumber, year: requestedYear })}
          </p>
        )}
      </section>

      {!canRecount && <p className="text-sm text-ink-soft">{t('recount.capabilityMissing')}</p>}

      {document && (
        <section aria-labelledby="recount-document" data-recount-document className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="recount-document" className="text-sm font-semibold">
            {document.documentNumber} · {document.fiscalYear}
          </h2>
          <dl className="mt-2 grid gap-x-6 text-sm sm:grid-cols-4">
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('recount.plant')}</dt><dd>{document.plant}</dd></div>
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('recount.location')}</dt><dd>{document.storageLocation ?? '—'}</dd></div>
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('recount.status')}</dt><dd data-recount-status>{document.status}</dd></div>
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('recount.plannedCount')}</dt><dd>{document.plannedCountDate}</dd></div>
          </dl>
          <p className="mt-2 text-sm text-ink-soft">{t('recount.notAPosting')}</p>

          <form action={createAction} className="mt-3">
            <input type="hidden" name="documentNumber" value={document.documentNumber} />
            <input type="hidden" name="fiscalYear" value={document.fiscalYear} />
            <input type="hidden" name="requestKey" value={requestKey} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="py-1 pr-2">{t('recount.select')}</th>
                    <th className="py-1 pr-2">{t('recount.columnItem')}</th>
                    <th className="py-1 pr-2">{t('recount.columnMaterial')}</th>
                    <th className="py-1 pr-2">{t('recount.columnStockType')}</th>
                    <th className="py-1 pr-2">{t('recount.columnBook')}</th>
                    <th className="py-1 pr-2">{t('recount.columnCounted')}</th>
                    <th className="py-1 pr-2">{t('recount.columnDifference')}</th>
                    <th className="py-1 pr-2">{t('recount.columnNow')}</th>
                    <th className="py-1 pr-2">{t('recount.columnReason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {document.items.map((line) => (
                    <tr key={line.itemNumber} data-recount-line={line.itemNumber} className="border-b border-line/60">
                      <td className="py-1 pr-2">
                        <input
                          type="checkbox"
                          name="item"
                          value={line.itemNumber}
                          checked={selected.includes(line.itemNumber)}
                          disabled={!writable || !line.eligible}
                          onChange={(event) => {
                            setSelected((current) => event.target.checked
                              ? [...current, line.itemNumber]
                              : current.filter((item) => item !== line.itemNumber));
                          }}
                          aria-label={`${t('recount.select')} ${line.itemNumber}`}
                        />
                      </td>
                      <td className="py-1 pr-2">{line.itemNumber}</td>
                      <td className="py-1 pr-2">{line.materialNumber}{line.batch ? ` · ${line.batch}` : ''}</td>
                      <td className="py-1 pr-2" data-recount-stock-type>{line.stockType}</td>
                      <td className="py-1 pr-2 tabular-nums">{line.bookQuantity || '—'}</td>
                      <td className="py-1 pr-2 tabular-nums" data-recount-counted>{line.countedQuantity || '—'}</td>
                      <td className="py-1 pr-2 tabular-nums">{line.difference || '—'}</td>
                      <td className="py-1 pr-2 tabular-nums" data-recount-book-now>{line.bookQuantityNow}</td>
                      <td className="py-1 pr-2 text-ink-soft" data-recount-reason>
                        {line.reason ?? (line.eligible ? t('recount.eligible') : '')}
                        {line.recountDocumentNumber && (
                          <>
                            {' '}
                            <Link href={`${ROUTE}?doc=${encodeURIComponent(line.recountDocumentNumber)}&year=${line.recountFiscalYear}`}>
                              {line.recountDocumentNumber}
                            </Link>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-default min-h-11 sm:min-h-8"
                disabled={!writable || eligible.length === 0}
                onClick={() => setSelected(eligible.map((line) => line.itemNumber))}
              >
                {t('recount.selectEligible')}
              </button>
              <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setSelected([])}>
                {t('recount.clearSelection')}
              </button>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('recount.plannedDate')}</span>
                <input type="date" name="plannedRecountDate" className="input w-full" defaultValue={today} />
                <span className="mt-1 block text-xs text-ink-faint">{t('recount.plannedDateHint')}</span>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('recount.reason')}</span>
                <input name="reason" className="input w-full" aria-describedby="recount-reason-hint" />
                <span id="recount-reason-hint" className="mt-1 block text-xs text-ink-faint">{t('recount.reasonHint')}</span>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('recount.headerText')}</span>
                <input name="headerText" className="input w-full" aria-describedby="recount-header-hint" />
                <span id="recount-header-hint" className="mt-1 block text-xs text-ink-faint">{t('recount.headerTextHint')}</span>
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!writable || creating || selected.length === 0}>
                {creating ? t('recount.creating') : t('recount.create')}
              </button>
              <button
                type="submit"
                formAction={checkAction}
                data-recount-check
                className="btn btn-default min-h-11 sm:min-h-8"
                disabled={!writable || checking || selected.length === 0}
              >
                {checking ? t('recount.checking') : t('recount.check')}
              </button>
            </div>
          </form>

          {checkState.message && (
            <div data-recount-preview className="mt-3 rounded-card border border-line bg-canvas p-3">
              <p role="status" className={`text-sm font-medium ${checkState.ok ? 'text-ink' : 'text-red-700'}`}>
                {checkState.message}{checkState.remedy ? ` ${checkState.remedy}` : ''}
              </p>
              {checkState.preview && (
                <>
                  <p className="mt-2 text-xs uppercase tracking-wide text-ink-faint">{t('recount.previewTitle')}</p>
                  <p className="mt-1 text-sm text-ink-soft">{t('recount.previewNote')}</p>
                  <table className="mt-2 w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                        <th className="py-1 pr-2">{t('recount.columnItem')}</th>
                        <th className="py-1 pr-2">{t('recount.columnStockType')}</th>
                        <th className="py-1 pr-2">{t('recount.columnBook')}</th>
                        <th className="py-1 pr-2">{t('recount.columnCounted')}</th>
                        <th className="py-1 pr-2">{t('recount.columnNow')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checkState.preview.items.map((item) => (
                        <tr key={item.itemNumber} className="border-b border-line/60">
                          <td className="py-1 pr-2">{item.itemNumber}</td>
                          <td className="py-1 pr-2">{item.stockType}</td>
                          <td className="py-1 pr-2 tabular-nums">{item.originalBookQuantity}</td>
                          <td className="py-1 pr-2 tabular-nums">{item.originalCountedQuantity}</td>
                          <td className="py-1 pr-2 tabular-nums" data-recount-preview-book>{item.bookQuantityNow}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}

          {createState.message && (
            <div data-recount-result className="mt-3 rounded-card border border-line bg-canvas p-3">
              <p role="status" className={`text-sm font-medium ${createState.ok ? 'text-ink' : 'text-red-700'}`}>
                {createState.message}{createState.remedy ? ` ${createState.remedy}` : ''}
              </p>
              {raised && (
                <p className="mt-2 text-sm">
                  <Link
                    href={`/inventory/physical-inventory-count?doc=${encodeURIComponent(raised.recountDocumentNumber)}&year=${raised.recountFiscalYear}`}
                    className="text-accent hover:underline"
                    data-recount-count-link
                  >
                    {t('recount.toCount', { document: raised.recountDocumentNumber })}
                  </Link>
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="recount-cancel" data-recount-cancel className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="recount-cancel" className="text-sm font-semibold">{t('recount.cancelTitle')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('recount.cancelHint')}</p>
        <form action={cancelAction} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('recount.recountDocument')}</span>
            <input name="recountDocumentNumber" className="input" value={cancelNumber} onChange={(event) => setCancelNumber(event.target.value)} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('recount.fiscalYear')}</span>
            <input name="recountFiscalYear" className="input w-28" inputMode="numeric" value={cancelYear} onChange={(event) => setCancelYear(event.target.value)} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('recount.reason')}</span>
            <input name="reason" className="input" required />
          </label>
          <LockNotice message={cancelLock?.mode === 'DISPLAY' ? cancelLock.message : null} remedy={cancelLock?.remedy} />
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canRecount || cancelling || cancelLock?.mode !== 'CHANGE'}>
            {cancelling ? t('recount.cancelling') : t('recount.cancel')}
          </button>
        </form>
        {cancelState.message && (
          <p role="status" className={`mt-2 text-sm ${cancelState.ok ? 'text-ink' : 'text-red-700'}`}>
            {cancelState.message}{cancelState.remedy ? ` ${cancelState.remedy}` : ''}
          </p>
        )}
      </section>
    </>
  );
}
