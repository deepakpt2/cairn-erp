'use client';

import { useActionState, useEffect, useState } from 'react';

import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import { t } from '@/platform/i18n';
import {
  checkPostingAction,
  postDifferencesAction,
  reversePostingAction,
  type PostingActionState,
} from './actions';

const INITIAL: PostingActionState = { ok: false, message: '' };
const ROUTE = '/inventory/physical-inventory-posting';

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** One material document. The lock is taken when this confirm opens, not for every history row. */
function ReversePosting({
  number,
  today,
  reverseKey,
  action,
  reversing,
}: {
  number: string;
  today: string;
  reverseKey: string;
  action: (payload: FormData) => void;
  reversing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lock = useChangeLock('MATERIAL_DOCUMENT', number, 'INV.REVERSE', open);
  const held = lock?.mode === 'CHANGE';
  return (
    <details className="mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-accent">{t('diffpost.reverse')}</summary>
      <form action={action} className="mt-2 flex flex-wrap items-end gap-3">
        <input type="hidden" name="materialDocumentNumber" value={number} />
        <input type="hidden" name="requestKey" value={reverseKey} />
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('diffpost.postingDate')}</span>
          <input type="date" name="postingDate" className="input" defaultValue={today} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('diffpost.documentDate')}</span>
          <input type="date" name="documentDate" className="input" defaultValue={today} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('diffpost.headerText')}</span>
          <input name="headerText" className="input w-44" />
        </label>
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
        <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={reversing || !held}>
          {reversing ? t('diffpost.reversing') : t('diffpost.reverse')}
        </button>
      </form>
    </details>
  );
}

export interface PostingLineView {
  itemNumber: number;
  materialNumber: string;
  stockType: string;
  difference: string;
  direction: 'SHORTAGE' | 'SURPLUS';
  quantity: string;
  eligible: boolean;
  reason: string | null;
}

export interface PostingDocumentView {
  documentNumber: string;
  fiscalYear: number;
  plant: string;
  storageLocation: string | null;
  status: string;
  lines: PostingLineView[];
}

export interface PostingHistoryView {
  itemNumber: number;
  materialDocumentNumber: string;
  postedDifference: string;
  reversedQuantity: string;
  reversalDocumentNumber: string | null;
  journalDocumentNumber: string | null;
  postingDate: string;
}

/**
 * The person selects items. The quantity is the whole remaining difference, so there is no
 * quantity to type. Check writes nothing. Post writes. Reverse is a different permission.
 */
export default function PostingWorkbench({
  document,
  history,
  requestedNumber,
  requestedYear,
  canPost,
  displayOnly = false,
  canReverse,
  today,
}: {
  document: PostingDocumentView | null;
  history: PostingHistoryView[];
  requestedNumber: string;
  requestedYear: string;
  canPost: boolean;
  displayOnly?: boolean;
  canReverse: boolean;
  today: string;
}) {
  const [checkState, checkAction, checking] = useActionState(checkPostingAction, INITIAL);
  const [postState, postAction, posting] = useActionState(postDifferencesAction, INITIAL);
  const [reverseState, reverseAction, reversing] = useActionState(reversePostingAction, INITIAL);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [reverseKey, setReverseKey] = useState(newRequestKey);
  const writable = canPost && !displayOnly;
  const [selected, setSelected] = useState<number[]>([]);

  useEffect(() => {
    if (postState.ok) setRequestKey(newRequestKey());
  }, [postState]);
  useEffect(() => {
    if (reverseState.ok) setReverseKey(newRequestKey());
  }, [reverseState]);
  useEffect(() => {
    setSelected([]);
  }, [document?.documentNumber, document?.fiscalYear, document?.status, history.length]);

  const eligible = document?.lines.filter((line) => line.eligible) ?? [];
  const documents = [...new Set(history.map((row) => row.materialDocumentNumber))];

  return (
    <>
      <section aria-labelledby="posting-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="posting-lookup" className="text-sm font-semibold">{t('diffpost.lookupTitle')}</h2>
        <form method="get" action={ROUTE} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('diffpost.document')}</span>
            <input name="doc" className="input" defaultValue={document?.documentNumber ?? requestedNumber} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('diffpost.fiscalYear')}</span>
            <input name="year" className="input w-28" inputMode="numeric" defaultValue={document?.fiscalYear ?? requestedYear} required />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">{t('diffpost.load')}</button>
        </form>
        {requestedNumber && !document && (
          <p role="status" className="mt-2 text-sm text-red-700">
            {t('diffpost.notFound', { document: requestedNumber, year: requestedYear })}
          </p>
        )}
      </section>

      {!canPost && <p className="text-sm text-ink-soft">{t('diffpost.capabilityMissing')}</p>}
      {canPost && !canReverse && <p className="text-sm text-ink-soft">{t('diffpost.reverseMissing')}</p>}

      {document && (
        <section aria-labelledby="posting-document" data-posting-document className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="posting-document" className="text-sm font-semibold">
            {document.documentNumber} · {document.fiscalYear}
          </h2>
          <dl className="mt-2 grid gap-x-6 text-sm sm:grid-cols-4">
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('diffpost.plant')}</dt><dd>{document.plant}</dd></div>
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('diffpost.location')}</dt><dd>{document.storageLocation ?? '—'}</dd></div>
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('diffpost.status')}</dt><dd data-posting-status>{document.status}</dd></div>
          </dl>
          {!document.storageLocation && (
            <p className="mt-2 text-sm text-ink-soft">{t('diffpost.noLocation')}</p>
          )}
          <p className="mt-2 text-sm text-ink-soft">{t('diffpost.wholeDifference')}</p>

          <form action={postAction} className="mt-3">
            <input type="hidden" name="documentNumber" value={document.documentNumber} />
            <input type="hidden" name="fiscalYear" value={document.fiscalYear} />
            <input type="hidden" name="requestKey" value={requestKey} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="py-1 pr-2">{t('diffpost.select')}</th>
                    <th className="py-1 pr-2">{t('diffpost.columnItem')}</th>
                    <th className="py-1 pr-2">{t('diffpost.columnMaterial')}</th>
                    <th className="py-1 pr-2">{t('diffpost.columnStockType')}</th>
                    <th className="py-1 pr-2">{t('diffpost.columnDifference')}</th>
                    <th className="py-1 pr-2">{t('diffpost.columnDirection')}</th>
                    <th className="py-1 pr-2">{t('diffpost.columnQuantity')}</th>
                    <th className="py-1 pr-2">{t('diffpost.columnReason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {document.lines.map((line) => (
                    <tr key={line.itemNumber} data-posting-line={line.itemNumber} className="border-b border-line/60">
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
                          aria-label={`${t('diffpost.select')} ${line.itemNumber}`}
                        />
                      </td>
                      <td className="py-1 pr-2">{line.itemNumber}</td>
                      <td className="py-1 pr-2">{line.materialNumber}</td>
                      <td className="py-1 pr-2">{line.stockType}</td>
                      <td className="py-1 pr-2 tabular-nums" data-posting-difference>{line.difference || '—'}</td>
                      <td className="py-1 pr-2" data-posting-direction={line.direction}>
                        {line.direction === 'SHORTAGE' ? t('diffpost.shortage') : t('diffpost.surplus')}
                      </td>
                      <td className="py-1 pr-2 tabular-nums">{line.eligible ? line.quantity : '—'}</td>
                      <td className="py-1 pr-2 text-ink-soft" data-posting-reason>{line.reason ?? (line.eligible ? t('diffpost.eligible') : '')}</td>
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
                {t('diffpost.selectEligible')}
              </button>
              <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setSelected([])}>
                {t('diffpost.clearSelection')}
              </button>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('diffpost.postingDate')}</span>
                <input type="date" name="postingDate" className="input w-full" defaultValue={today} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('diffpost.documentDate')}</span>
                <input type="date" name="documentDate" className="input w-full" defaultValue={today} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('diffpost.headerText')}</span>
                <input name="headerText" className="input w-full" aria-describedby="header-text-hint" />
                <span id="header-text-hint" className="mt-1 block text-xs text-ink-faint">{t('diffpost.headerTextHint')}</span>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('diffpost.externalReference')}</span>
                <input name="externalReference" className="input w-full" aria-describedby="reference-hint" />
                <span id="reference-hint" className="mt-1 block text-xs text-ink-faint">{t('diffpost.externalReferenceHint')}</span>
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!writable || posting || selected.length === 0}>
                {posting ? t('diffpost.posting') : t('diffpost.post')}
              </button>
              <button
                type="submit"
                formAction={checkAction}
                data-posting-check
                className="btn btn-default min-h-11 sm:min-h-8"
                disabled={!writable || checking || selected.length === 0}
              >
                {checking ? t('diffpost.checking') : t('diffpost.check')}
              </button>
            </div>
          </form>

          {checkState.message && (
            <div data-posting-preview className="mt-3 rounded-card border border-line bg-canvas p-3">
              <p role="status" className={`text-sm font-medium ${checkState.ok ? 'text-ink' : 'text-red-700'}`}>
                {checkState.message}{checkState.remedy ? ` ${checkState.remedy}` : ''}
              </p>
              {checkState.preview && (
                <>
                  <p className="mt-2 text-xs uppercase tracking-wide text-ink-faint">{t('diffpost.previewTitle')}</p>
                  <p className="mt-1 text-sm" data-posting-journal>
                    {checkState.preview.journalRequired ? t('diffpost.journalYes') : t('diffpost.journalNo')}
                  </p>
                  <p className="text-sm text-ink-soft" data-posting-period>
                    {t('diffpost.period')}: {checkState.preview.materialPeriod}
                  </p>
                  <p className="text-xs text-ink-faint">{t('diffpost.estimateNote')}</p>
                  <table className="mt-2 w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                        <th className="py-1 pr-2">{t('diffpost.columnItem')}</th>
                        <th className="py-1 pr-2">{t('diffpost.movement')}</th>
                        <th className="py-1 pr-2">{t('diffpost.columnQuantity')}</th>
                        <th className="py-1 pr-2">{t('diffpost.amount')}</th>
                        <th className="py-1 pr-2">{t('diffpost.inventoryAccount')}</th>
                        <th className="py-1 pr-2">{t('diffpost.offsetAccount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checkState.preview.lines.map((line) => (
                        <tr key={line.itemNumber} data-posting-preview-line={line.itemNumber} className="border-b border-line/60">
                          <td className="py-1 pr-2">{line.itemNumber}</td>
                          <td className="py-1 pr-2" data-posting-movement>{line.movementType}</td>
                          <td className="py-1 pr-2 tabular-nums">{line.quantity}</td>
                          <td className="py-1 pr-2 tabular-nums" data-posting-amount>
                            {line.postingValue === null ? '—' : `${line.postingValue} ${line.currency ?? ''}`}
                          </td>
                          <td className="py-1 pr-2">{line.inventoryAccount ?? '—'}</td>
                          <td className="py-1 pr-2">{line.offsetAccount ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}

          {postState.message && (
            <p role="status" data-posting-result className={`mt-3 text-sm ${postState.ok ? 'text-ink' : 'text-red-700'}`}>
              {postState.message}{postState.remedy ? ` ${postState.remedy}` : ''}
            </p>
          )}
        </section>
      )}

      {document && (
        <section aria-labelledby="posting-history" data-posting-history className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="posting-history" className="text-sm font-semibold">{t('diffpost.historyTitle')}</h2>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">{t('diffpost.noHistory')}</p>
          ) : (
            documents.map((number) => {
              const rows = history.filter((row) => row.materialDocumentNumber === number);
              const open = rows.some((row) => Number(row.reversedQuantity) < Math.abs(Number(row.postedDifference)));
              return (
                <div key={number} className="mt-3 border-t border-line/60 pt-3" data-posting-history-document={number}>
                  <p className="text-sm font-medium">{number}</p>
                  <table className="mt-1 w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                        <th className="py-1 pr-2">{t('diffpost.columnItem')}</th>
                        <th className="py-1 pr-2">{t('diffpost.columnPosted')}</th>
                        <th className="py-1 pr-2">{t('diffpost.columnReversed')}</th>
                        <th className="py-1 pr-2">{t('diffpost.columnJournal')}</th>
                        <th className="py-1 pr-2">{t('diffpost.postingDate')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={`${number}-${row.itemNumber}`}>
                          <td className="py-1 pr-2">{row.itemNumber}</td>
                          <td className="py-1 pr-2 tabular-nums">{row.postedDifference}</td>
                          <td className="py-1 pr-2 tabular-nums">{row.reversedQuantity}</td>
                          <td className="py-1 pr-2">{row.journalDocumentNumber ?? '—'}</td>
                          <td className="py-1 pr-2">{row.postingDate}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {open && canReverse && (
                    <ReversePosting
                      number={number}
                      today={today}
                      reverseKey={reverseKey}
                      action={reverseAction}
                      reversing={reversing}
                    />
                  )}
                  {open && !canReverse && <p className="mt-2 text-xs text-ink-faint">{t('diffpost.reverseMissing')}</p>}
                </div>
              );
            })
          )}
          {reverseState.message && (
            <p role="status" data-posting-reversal className={`mt-3 text-sm ${reverseState.ok ? 'text-ink' : 'text-red-700'}`}>
              {reverseState.message}{reverseState.remedy ? ` ${reverseState.remedy}` : ''}
            </p>
          )}
        </section>
      )}
    </>
  );
}
