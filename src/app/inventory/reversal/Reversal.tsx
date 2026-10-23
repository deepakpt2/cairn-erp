'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import type { ReversalDocumentView } from '@/modules/inventory/material-document-reversal';
import { reverseMaterialDocumentAction, type ReversalActionState } from './actions';

const INITIAL: ReversalActionState = { ok: false, message: '' };

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function Reversal({ document, canPost, displayOnly = false, today }: {
  document: ReversalDocumentView | null;
  canPost: boolean;
  displayOnly?: boolean;
  today: string;
}) {
  const [state, action, working] = useActionState(reverseMaterialDocumentAction, INITIAL);
  const [requestKey] = useState(newRequestKey);
  const open = document?.lines.filter((line) => Number(line.remainingQuantity) > 0) ?? [];
  const reversible = Boolean(document) && !document!.reversalOf && open.length > 0;

  return (
    <>
      <section aria-labelledby="reversal-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="reversal-lookup" className="text-sm font-semibold">{t('mbst.lookup')}</h2>
        <form method="get" action="/inventory/reversal" className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mbst.document')}</span>
            <input name="doc" className="input w-full" placeholder={t('mbst.documentPlaceholder')} defaultValue={document?.materialDocumentNumber ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mbst.fiscalYear')}</span>
            <input name="fiscalYear" inputMode="numeric" maxLength={4} className="input w-full" defaultValue={document?.documentYear ?? ''} />
          </label>
          <div>
            <button type="submit" className="btn btn-default mt-5 min-h-11 sm:min-h-8">{t('mbst.load')}</button>
          </div>
        </form>
        <p className="mt-2 text-sm text-ink-soft">{t('mbst.lookupHint')}</p>
      </section>

      {document && (
        <section aria-labelledby="reversal-document" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="reversal-document" className="text-sm font-semibold">
            {t('mbst.document')} {document.materialDocumentNumber}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {document.postingDate} · <span data-status={document.status}>{document.status}</span>
            {document.journalDocumentNumber ? ` · ${t('mbst.journal')} ${document.journalDocumentNumber}` : ` · ${t('mbst.noJournal')}`}
            {document.reversalOf ? ` · ${t('mbst.reversalOf')} ${document.reversalOf}` : ''}
            {document.reversedBy ? ` · ${t('mbst.reversedBy')} ${document.reversedBy}` : ''}
          </p>

          {state.message && (
            <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
              {state.message}{state.remedy ? ` ${state.remedy}` : ''}
            </p>
          )}

          {document.status !== 'REVERSED' && !document.reversalOf && (
            <form action={action} className="mt-3">
              <input type="hidden" name="materialDocumentNumber" value={document.materialDocumentNumber} />
              <input type="hidden" name="requestKey" value={requestKey} />
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mbst.select')}</th>
                <th className="py-1">{t('mbst.columnLine')}</th>
                <th className="py-1">{t('mbst.columnSide')}</th>
                <th className="py-1">{t('mbst.columnMovement')}</th>
                <th className="py-1">{t('mbst.columnMaterial')}</th>
                <th className="py-1">{t('mbst.columnPlant')}</th>
                <th className="py-1">{t('mbst.columnLocation')}</th>
                <th className="py-1">{t('mbst.columnBatch')}</th>
                <th className="py-1 text-right">{t('mbst.columnQuantity')}</th>
                <th className="py-1 text-right">{t('mbst.columnReversed')}</th>
                <th className="py-1 text-right">{t('mbst.columnOpen')}</th>
              </tr>
            </thead>
            <tbody>
              {document.lines.map((line) => (
                <tr
                  key={line.lineNumber}
                  data-line={line.lineNumber}
                  data-side={line.lineDirection}
                  data-remaining={line.remainingQuantity}
                  className="border-t border-line"
                >
                  <td className="py-1">
                    <input
                      type="checkbox"
                      name="lines"
                      value={line.lineNumber}
                      defaultChecked={Number(line.remainingQuantity) > 0}
                      disabled={Number(line.remainingQuantity) <= 0}
                      aria-label={`${t('mbst.select')} ${line.lineNumber}`}
                    />
                  </td>
                  <td className="py-1">{line.lineNumber}</td>
                  <td className="py-1">{line.lineDirection === 'ISSUE' ? t('mbst.issue') : t('mbst.receipt')}</td>
                  <td className="py-1">{line.movementType}</td>
                  <td className="py-1">{line.materialNumber}</td>
                  <td className="py-1">{line.plant}</td>
                  <td className="py-1">{line.storageLocation}</td>
                  <td className="code py-1" data-batch={line.batch}>{line.batch || '—'}</td>
                  <td className="py-1 text-right tabular-nums">{Number(line.quantity).toFixed(3)}</td>
                  <td className="py-1 text-right tabular-nums">{line.reversedQuantity}</td>
                  <td className="py-1 text-right tabular-nums">{line.remainingQuantity}</td>
                </tr>
              ))}
            </tbody>
          </table>


              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mbst.postingDate')}</span>
                  <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mbst.documentDate')}</span>
                  <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mbst.headerText')}</span>
                  <input name="headerText" maxLength={25} className="input w-full" />
                </label>
                <div className="flex items-end">
                  <button type="submit" className="btn btn-primary min-h-11 w-full sm:min-h-8" disabled={!canPost || displayOnly || working}>
                    {working ? t('mbst.reversing') : t('mbst.reverse')}
                  </button>
                </div>
              </div>
            </form>
          )}
          {!reversible && (
            <p className="mt-2 text-sm text-ink-soft">
              {document.reversalOf ? t('mbst.isReversal') : t('mbst.nothingOpen')}
            </p>
          )}
        </section>
      )}
    </>
  );
}
