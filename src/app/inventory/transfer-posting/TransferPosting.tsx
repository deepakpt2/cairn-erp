'use client';

import { useActionState, useEffect, useState } from 'react';

import { t } from '@/platform/i18n';
import type { TransferDocumentView, TransferStockRow } from '@/modules/inventory/transfer-posting';
import { TRANSFER_SCENARIOS } from '@/modules/inventory/transfer-scenarios';
import {
  checkTransferAction, postTransferAction, reverseTransferAction, type TransferActionState,
} from './actions';

const INITIAL: TransferActionState = { ok: false, message: '' };

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function TransferPosting({ document, stock, canPost, today }: {
  document: TransferDocumentView | null;
  stock: TransferStockRow[];
  canPost: boolean;
  today: string;
}) {
  const [postState, postAction, posting] = useActionState(postTransferAction, INITIAL);
  const [checkState, checkAction, checking] = useActionState(checkTransferAction, INITIAL);
  const [reverseState, reverseAction, reversing] = useActionState(reverseTransferAction, INITIAL);
  // The key identifies one request. It must move on after a posting, or the next legitimate
  // transfer on the same page would be read as a replay of the first (SCR-145's defect, kept out).
  const [postKey, setPostKey] = useState(newRequestKey);
  const [reverseKey, setReverseKey] = useState(newRequestKey);
  useEffect(() => {
    if (postState.ok) setPostKey(newRequestKey());
  }, [postState]);
  useEffect(() => {
    if (reverseState.ok) setReverseKey(newRequestKey());
  }, [reverseState]);

  return (
    <>
      <section aria-labelledby="transfer-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="transfer-header" className="text-sm font-semibold">{t('mb1b.header')}</h2>
        <form method="get" action="/inventory/transfer-posting" className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.movementType')}</span>
            <select name="movementTypeCode" className="input w-full" defaultValue="311">
              {TRANSFER_SCENARIOS.map((s) => (
                <option key={s.code} value={s.code}>{s.code} · {s.description}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.postingDate')}</span>
            <input type="date" name="postingDate" className="input w-full" defaultValue={today} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.documentDate')}</span>
            <input type="date" name="documentDate" className="input w-full" defaultValue={today} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.headerText')}</span>
            <input name="headerText" maxLength={25} className="input w-full" placeholder={t('mb1b.headerTextPlaceholder')} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.material')}</span>
            <input name="material" className="input w-full" placeholder="MAT-…" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.document')}</span>
            <input name="doc" className="input w-full" placeholder={t('mb1b.documentPlaceholder')} />
          </label>
          <div>
            <button type="submit" className="btn btn-default mt-5 min-h-11 sm:min-h-8">{t('mb1b.load')}</button>
          </div>
        </form>
        <p className="mt-2 text-sm text-ink-soft">{t('mb1b.movementHint')}</p>
      </section>

      <section aria-labelledby="transfer-item" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="transfer-item" className="text-sm font-semibold">{t('mb1b.item')}</h2>
        {postState.message && (
          <p role="status" className={`mt-2 text-sm ${postState.ok ? 'text-ink' : 'text-red-700'}`}>
            {postState.message}{postState.remedy ? ` ${postState.remedy}` : ''}
          </p>
        )}
        <form action={postAction}>
          <input type="hidden" name="requestKey" value={postKey} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.movementType')}</span>
              <select name="movementTypeCode" className="input w-full" defaultValue="311" required>
                {TRANSFER_SCENARIOS.map((s) => (
                  <option key={s.code} value={s.code}>{s.code} · {s.description}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.material')}</span>
              <input name="materialNumber" className="input w-full" defaultValue={stock.length ? document?.lines[0]?.materialNumber ?? '' : ''} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.quantity')}</span>
              <input name="quantity" type="number" step="0.001" min="0.001" className="input w-full" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.stockType')}</span>
              <input name="stockType" className="input w-full" placeholder="QUALITY" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.issuingPlant')}</span>
              <input name="issuingPlant" className="input w-full" placeholder="1000" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.issuingLocation')}</span>
              <input name="issuingStorageLocation" className="input w-full" placeholder="0001" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.receivingPlant')}</span>
              <input name="receivingPlant" className="input w-full" placeholder="1000" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.receivingLocation')}</span>
              <input name="receivingStorageLocation" className="input w-full" placeholder="0002" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.postingDate')}</span>
              <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.documentDate')}</span>
              <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.externalReference')}</span>
              <input name="externalReference" maxLength={40} className="input w-full" placeholder={t('mb1b.externalReferencePlaceholder')} />
            </label>
            <label className="block sm:col-span-2 lg:col-span-3">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.headerText')}</span>
              <input name="headerText" maxLength={25} className="input w-full" />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || posting}>
              {posting ? t('mb1b.posting') : t('mb1b.post')}
            </button>
            <button
              type="submit"
              formAction={checkAction}
              data-transfer-check
              className="btn btn-default min-h-11 sm:min-h-8"
              disabled={!canPost || checking}
            >
              {checking ? t('mb1b.checking') : t('mb1b.check')}
            </button>
            <p className="text-sm text-ink-soft">{t('mb1b.postHint')}</p>
          </div>
        </form>

        {checkState.message && (
          <div data-transfer-preview className="mt-3 rounded-card border border-line bg-canvas p-3">
            <p role="status" className={`text-sm font-medium ${checkState.ok ? 'text-ink' : 'text-red-700'}`}>
              {checkState.message}{checkState.remedy ? ` ${checkState.remedy}` : ''}
            </p>
            {checkState.preview && (
              <>
                <p className="mt-1 text-xs uppercase tracking-wide text-ink-faint">{t('mb1b.previewTitle')}</p>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <div className="flex justify-between gap-3 border-b border-line/60 py-1">
                    <dt className="text-ink-soft">{t('mb1b.previewMovement')}</dt>
                    <dd data-preview-movement>{checkState.preview.movement.movementType} · {checkState.preview.movement.description}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-line/60 py-1">
                    <dt className="text-ink-soft">{t('mb1b.previewEntry')}</dt>
                    <dd data-preview-entry>{checkState.preview.entry.quantity.toFixed(3)} {checkState.preview.entry.unit}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-line/60 py-1">
                    <dt className="text-ink-soft">{t('mb1b.previewBase')}</dt>
                    <dd data-preview-base>{checkState.preview.base.quantity.toFixed(3)} {checkState.preview.base.unit}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-line/60 py-1">
                    <dt className="text-ink-soft">{t('mb1b.previewFrom')}</dt>
                    <dd data-preview-from>
                      {checkState.preview.from.plant}/{checkState.preview.from.storageLocation}/{checkState.preview.from.stockType}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-line/60 py-1">
                    <dt className="text-ink-soft">{t('mb1b.previewTo')}</dt>
                    <dd data-preview-to>
                      {checkState.preview.to.plant}/{checkState.preview.to.storageLocation}/{checkState.preview.to.stockType}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-line/60 py-1">
                    <dt className="text-ink-soft">{t('mb1b.previewStock')}</dt>
                    <dd data-preview-stock>
                      {checkState.preview.stock.onHand.toFixed(3)} → {checkState.preview.stock.after.toFixed(3)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-line/60 py-1">
                    <dt className="text-ink-soft">{t('mb1b.previewValue')}</dt>
                    <dd data-preview-value>
                      {checkState.preview.value.moves
                        ? `${checkState.preview.value.issuing.toFixed(2)} → ${checkState.preview.value.receiving.toFixed(2)}`
                        : t('mb1b.noValuation')
                      }
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-line/60 py-1">
                    <dt className="text-ink-soft">{t('mb1b.previewPeriod')}</dt>
                    <dd data-preview-period>{checkState.preview.period.fiscalYear}/{String(checkState.preview.period.period).padStart(2, '0')}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-line/60 py-1">
                    <dt className="text-ink-soft">{t('mb1b.previewJournal')}</dt>
                    <dd data-preview-journal>{checkState.preview.value.journalExpected ? 'yes' : t('mb1b.previewNoJournal')}</dd>
                  </div>
                </dl>
                <ul className="mt-2 space-y-1 text-sm text-ink-soft">
                  {checkState.preview.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      {stock.length > 0 && (
        <section aria-labelledby="transfer-stock" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="transfer-stock" className="text-sm font-semibold">{t('mb1b.stockOnHand')}</h2>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mb1b.columnLocation')}</th>
                <th className="py-1">{t('mb1b.columnStockType')}</th>
                <th className="py-1 text-right">{t('mb1b.columnQuantity')}</th>
              </tr>
            </thead>
            <tbody>
              {stock.map((row) => (
                <tr key={`${row.storageLocation}/${row.stockType}`} className="border-t border-line">
                  <td className="py-1">{row.storageLocation}</td>
                  <td className="py-1">{row.stockType}</td>
                  <td className="py-1 text-right tabular-nums">{Number(row.quantity).toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {document && (
        <section aria-labelledby="transfer-document" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="transfer-document" className="text-sm font-semibold">
            {t('mb1b.document')} {document.materialDocumentNumber}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {document.postingDate} · {document.status}
            {document.journalDocumentNumber ? ` · journal ${document.journalDocumentNumber}` : ` · ${t('mb1b.noJournal')}`}
            {document.reversalOf ? ` · ${t('mb1b.reversalOf')} ${document.reversalOf}` : ''}
          </p>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mb1b.columnLine')}</th>
                <th className="py-1">{t('mb1b.columnSide')}</th>
                <th className="py-1">{t('mb1b.columnMovement')}</th>
                <th className="py-1">{t('mb1b.columnPlant')}</th>
                <th className="py-1">{t('mb1b.columnLocation')}</th>
                <th className="py-1">{t('mb1b.columnStockType')}</th>
                <th className="py-1 text-right">{t('mb1b.columnQuantity')}</th>
                <th className="py-1 text-right">{t('mb1b.columnValue')}</th>
              </tr>
            </thead>
            <tbody>
              {document.lines.map((line) => (
                <tr key={line.lineNumber} data-line={line.lineNumber} data-side={line.lineDirection} className="border-t border-line">
                  <td className="py-1">{line.lineNumber}</td>
                  <td className="py-1">{line.lineDirection === 'ISSUE' ? t('mb1b.issue') : t('mb1b.receipt')}</td>
                  <td className="py-1">{line.movementType}</td>
                  <td className="py-1">{line.plant}</td>
                  <td className="py-1">{line.storageLocation}</td>
                  <td className="py-1">{line.stockType}</td>
                  <td className={`py-1 text-right tabular-nums ${line.lineDirection === 'ISSUE' ? 'text-red-700' : ''}`}>
                    {line.lineDirection === 'ISSUE' ? '−' : ''}{Number(line.quantity).toFixed(3)}
                  </td>
                  <td className="py-1 text-right tabular-nums">{Number(line.value).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {reverseState.message && (
            <p role="status" className={`mt-2 text-sm ${reverseState.ok ? 'text-ink' : 'text-red-700'}`}>
              {reverseState.message}{reverseState.remedy ? ` ${reverseState.remedy}` : ''}
            </p>
          )}
          {canPost && document.status === 'POSTED' && !document.reversalOf && (
            <form action={reverseAction} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="requestKey" value={reverseKey} />
              <input type="hidden" name="materialDocumentNumber" value={document.materialDocumentNumber} />
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.postingDate')}</span>
                <input type="date" name="postingDate" className="input" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{t('mb1b.documentDate')}</span>
                <input type="date" name="documentDate" className="input" defaultValue={today} required />
              </label>
              <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={reversing}>
                {reversing ? t('mb1b.reversing') : t('mb1b.reverse')}
              </button>
            </form>
          )}
        </section>
      )}
    </>
  );
}
