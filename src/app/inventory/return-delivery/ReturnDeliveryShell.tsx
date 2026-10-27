'use client';

/**
 * SCR-145 / MBRL — the return-to-vendor workbench.
 *
 * The screen states the returnable quantity and refuses to let it be typed: only the return
 * quantity is an input. Everything else — material, plant, storage location, the order it came
 * from — is read from the receipt line, because a return that could invent those would not be a
 * return of anything. A reference that cannot be returned is shown with its reason, never hidden.
 */
import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';

import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import { t } from '@/platform/i18n';
import type { ReturnDocumentView, ReturnableDocument } from '@/modules/inventory/return-delivery';
import {
  loadReferenceAction, postReturnAction,
  type PostReturnState, type ReferenceState,
} from './actions';

const INITIAL_REFERENCE: ReferenceState = { ok: false, message: '', document: null };
const INITIAL_POST: PostReturnState = { ok: false, message: '', posted: null };

export default function ReturnDeliveryShell({
  canPost,
  today,
}: {
  canPost: boolean;
  today: string;
}) {
  const [reference, loadReference, loading] = useActionState(loadReferenceAction, INITIAL_REFERENCE);
  const [posted, post, posting] = useActionState(postReturnAction, INITIAL_POST);
  const document: ReturnableDocument | null = reference.document;
  const returnLock = useChangeLock(
    'MATERIAL_DOCUMENT',
    document ? document.documentNumber.trim() : null,
    'INV.RETURN.POST',
    Boolean(document) && canPost,
  );

  /**
   * The idempotency key belongs to *this* submission, not to the document and the day. Two
   * returns of the same receipt on the same day are two returns; keying them alike made the
   * second one replay the first and post nothing — a defect the browser target caught. The seed
   * keeps a genuine retry of one submission replaying correctly, and the round moves the key on
   * only once a posting has succeeded.
   */
  const [seed] = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36));
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (posted.ok) setRound((r) => r + 1);
  }, [posted.ok, posted.posted]);
  const requestKey = `${seed}-${round}`;

  return (
    <>
      <section aria-labelledby="return-reference" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="return-reference" className="text-sm font-semibold">{t('mbrl.referenceHeader')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('mbrl.referenceHint')}</p>
        <p role="status" className={`mt-2 text-sm ${reference.ok ? 'text-ink' : 'text-red-700'}`}>
          {reference.message}
        </p>
        <form action={loadReference} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="field-label">{t('mbrl.referenceDocument')}</span>
            <input name="documentNumber" className="input w-48" placeholder="4900000001" required />
          </label>
          <label className="block">
            <span className="field-label">{t('mbrl.referenceYear')}</span>
            <input name="documentYear" type="number" className="input w-28" placeholder="2026" />
          </label>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={loading}>
            {loading ? t('mbrl.loading') : t('mbrl.load')}
          </button>
        </form>
      </section>

      {document && (
        <section aria-labelledby="return-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="return-items" className="text-sm font-semibold">
            {t('mbrl.itemsHeader')} <span className="code" data-reference-document={document.documentNumber}>{document.documentNumber}</span>
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {t('mbrl.itemsHint')}
            {' · '}
            <Link
              className="text-accent hover:underline"
              href={`/inventory/material-documents?document=${encodeURIComponent(document.documentNumber)}&fiscalYear=${document.documentYear}`}
            >
              {t('mbrl.openOriginal')}
            </Link>
          </p>

          <form action={post} className="mt-3">
            <input type="hidden" name="documentNumber" value={document.documentNumber} />
            <input type="hidden" name="documentYear" value={document.documentYear} />
            <input type="hidden" name="requestKey" value={requestKey} />

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1">{t('mbrl.columnLine')}</th>
                  <th className="py-1">{t('mbrl.columnMaterial')}</th>
                  <th className="py-1">{t('mbrl.columnOrder')}</th>
                  <th className="py-1">{t('mbrl.columnPlant')}</th>
                  <th className="py-1">{t('mbrl.columnLocation')}</th>
                  <th className="py-1 text-right">{t('mbrl.columnOriginal')}</th>
                  <th className="py-1 text-right">{t('mbrl.columnReturned')}</th>
                  <th className="py-1 text-right">{t('mbrl.columnRemaining')}</th>
                  <th className="py-1 text-right">{t('mbrl.columnReturn')}</th>
                  <th className="py-1">{t('mbrl.columnUnit')}</th>
                </tr>
              </thead>
              <tbody>
                {document.items.map((item) => (
                  <tr
                    key={item.lineNumber}
                    className="border-t border-line"
                    data-item={item.lineNumber}
                    data-eligible={item.eligible ? 'true' : 'false'}
                  >
                    <td className="py-1">{item.lineNumber}</td>
                    <td className="py-1 code">{item.materialNumber}{item.batch ? ` · Batch ${item.batch}` : ''}</td>
                    <td className="py-1 code">{item.purchaseOrderNumber ?? '—'}{item.purchaseOrderItem ? `/${item.purchaseOrderItem}` : ''}</td>
                    <td className="py-1 code">{item.plant}</td>
                    <td className="py-1 code">{item.storageLocation ?? '—'}</td>
                    <td className="py-1 text-right tabular">{item.originalQuantity.toFixed(3)}</td>
                    <td className="py-1 text-right tabular">{item.previouslyReturned.toFixed(3)}</td>
                    <td className="py-1 text-right tabular" data-remaining={item.lineNumber}>{item.remaining.toFixed(3)}</td>
                    <td className="py-1 text-right">
                      <input type="hidden" name={`originalLine-${item.lineNumber}`} value={item.lineNumber} />
                      <input
                        name={`quantity-${item.lineNumber}`}
                        type="number" step="0.001" min="0" max={item.remaining}
                        className="input w-24 text-right"
                        disabled={!item.eligible || !canPost}
                        aria-label={`${t('mbrl.columnReturn')} ${item.lineNumber}`}
                      />
                    </td>
                    <td className="py-1">
                      <input
                        name={`unit-${item.lineNumber}`}
                        className="input w-16 uppercase"
                        placeholder={item.unit}
                        maxLength={6}
                        disabled={!item.eligible || !canPost}
                        aria-label={`${t('mbrl.columnUnit')} ${item.lineNumber}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {document.items.some((i) => !i.eligible) && (
              <ul className="mt-2 space-y-1 text-sm text-ink-soft">
                {document.items.filter((i) => !i.eligible).map((i) => (
                  <li key={i.lineNumber} data-refusal={i.lineNumber}>{i.refusal}</li>
                ))}
              </ul>
            )}

            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="field-label">{t('mbrl.postingDate')}</span>
                <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="field-label">{t('mbrl.documentDate')}</span>
                <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="field-label">{t('mbrl.headerText')}</span>
                <input name="headerText" className="input w-full" maxLength={25} />
              </label>
              <label className="block">
                <span className="field-label">{t('mbrl.externalReference')}</span>
                <input name="externalReference" className="input w-full" maxLength={40} />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <LockNotice message={returnLock?.mode === 'DISPLAY' ? returnLock.message : null} remedy={returnLock?.remedy} />
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || posting || returnLock?.mode !== 'CHANGE'}>
                {posting ? t('mbrl.posting') : t('mbrl.post')}
              </button>
              {!canPost && <p className="text-sm text-ink-soft">{t('mbrl.noPost')}</p>}
              <p className="text-sm text-ink-faint">{t('mbrl.noDelivery')}</p>
            </div>
          </form>
        </section>
      )}

      <section aria-labelledby="return-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="return-result" className="text-sm font-semibold">{t('mbrl.resultHeader')}</h2>
        <p role="status" className={`mt-2 text-sm ${posted.ok ? 'text-ink' : 'text-red-700'}`}>
          {posted.message}{posted.remedy ? ` ${posted.remedy}` : ''}
        </p>
        {posted.posted && (
          <div className="mt-2 text-sm">
            <p>
              {t('mbrl.document')}{' '}
              <span className="code" data-return-document={posted.posted.materialDocumentNumber}>{posted.posted.materialDocumentNumber}</span>
              {' · '}
              {t('mbrl.reverses')}{' '}
              <span className="code" data-returns-against={posted.posted.returnsAgainst?.documentNumber ?? ''}>
                {posted.posted.returnsAgainst?.documentNumber ?? '—'}
              </span>
              {' · '}
              {t('mbrl.journal')}{' '}
              {posted.posted.journalDocumentNumber ? (
                <Link
                  className="code text-accent hover:underline"
                  href={`/finance/journal/document?document=${encodeURIComponent(posted.posted.journalDocumentNumber)}`}
                >
                  {posted.posted.journalDocumentNumber}
                </Link>
              ) : '—'}
            </p>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1">{t('mbrl.columnLine')}</th>
                  <th className="py-1">{t('mbrl.columnMaterial')}</th>
                  <th className="py-1">{t('mbrl.columnLocation')}</th>
                  <th className="py-1 text-right">{t('mbrl.columnReturn')}</th>
                  <th className="py-1 text-right">{t('mbrl.columnValue')}</th>
                </tr>
              </thead>
              <tbody>
                {posted.posted.lines.map((line) => (
                  <tr key={line.lineNumber} className="border-t border-line" data-line={line.materialNumber}>
                    <td className="py-1">{line.lineNumber}</td>
                    <td className="py-1">{line.materialNumber}{line.batch ? ` · Batch ${line.batch}` : ''}</td>
                    <td className="py-1">{line.storageLocation ?? '—'}</td>
                    <td className="py-1 text-right tabular">{line.quantity} {line.unit}</td>
                    <td className="py-1 text-right tabular">{line.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
