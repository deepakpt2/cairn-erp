'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import {
  cancelPhysicalInventoryAction,
  createPhysicalInventoryAction,
  type PhysicalInventoryActionState,
} from './actions';

const INITIAL: PhysicalInventoryActionState = { ok: false, message: '' };
const LINES = [1, 2, 3, 4, 5, 6];

export default function PhysicalInventoryShell({
  canCreate, canCancel, today,
}: { canCreate: boolean; canCancel: boolean; today: string }) {
  const [createState, createAction, creating] = useActionState(createPhysicalInventoryAction, INITIAL);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelPhysicalInventoryAction, INITIAL);
  const [requestKey] = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36));
  const cancelArgument = createState.document
    ? `${createState.document.inventoryDocumentNumber.trim()}/${createState.document.fiscalYear}`
    : null;
  const cancelLock = useChangeLock(
    'PHYSICAL_INVENTORY',
    cancelArgument,
    'INV.PHYINV.CANCEL',
    Boolean(cancelArgument) && canCancel,
  );

  return (
    <>
      <section aria-labelledby="count-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="count-header" className="text-sm font-semibold">{t('mi01.header')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('mi01.headerHint')}</p>
        <p role="status" className={`mt-2 text-sm ${createState.ok ? 'text-ink' : 'text-red-700'}`}>
          {createState.message}{createState.remedy ? ` ${createState.remedy}` : ''}
        </p>
        <form action={createAction}>
          <input type="hidden" name="requestKey" value={requestKey} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="field-label">{t('mi01.plant')}</span>
              <input name="plant" className="input w-full" placeholder="1000" required />
            </label>
            <label className="block">
              <span className="field-label">{t('mi01.storageLocation')}</span>
              <input name="storageLocation" className="input w-full" placeholder="0001" />
            </label>
            <label className="block">
              <span className="field-label">{t('mi01.plannedCountDate')}</span>
              <input type="date" name="plannedCountDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="flex items-center gap-2 pt-5">
              <input type="checkbox" name="postingBlock" className="h-4 w-4" />
              <span className="text-sm">{t('mi01.postingBlock')}</span>
            </label>
          </div>
          <p className="mt-2 text-xs text-ink-soft">{t('mi01.postingBlockHint')}</p>

          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mi01.columnLine')}</th>
                <th className="py-1">{t('mi01.columnMaterial')}</th>
                <th className="py-1">{t('mi01.columnBatch')}</th>
              </tr>
            </thead>
            <tbody>
              {LINES.map((n) => (
                <tr key={n} className="border-t border-line" data-count-line={n}>
                  <td className="py-1">{n}</td>
                  <td className="py-1">
                    <input name={`material-${n}`} className="input w-full" placeholder="MAT-…" />
                  </td>
                  <td className="py-1">
                    <input name={`batch-${n}`} maxLength={10} className="input w-28" placeholder="Batch" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canCreate || creating}>
              {creating ? t('mi01.creating') : t('mi01.create')}
            </button>
            {!canCreate && <p className="text-sm text-ink-soft">{t('mi01.noCreate')}</p>}
          </div>
        </form>
      </section>

      {createState.document && (
        <section aria-labelledby="count-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="count-result" className="text-sm font-semibold">
            {t('mi01.document')}{' '}
            <span className="code" data-inventory-document={createState.document.inventoryDocumentNumber}>
              {createState.document.inventoryDocumentNumber}
            </span>
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {t('mi01.plant')} {createState.document.plant}
            {' · '}{t('mi01.storageLocation')} {createState.document.storageLocation ?? t('mi01.wholePlant')}
            {' · '}{t('mi01.company')} {createState.document.companyCode}
            {' · '}{t('mi01.fiscalYear')} {createState.document.fiscalYear}
            {' · '}<span data-status={createState.document.status}>{createState.document.status}</span>
            {' · '}<span data-posting-block={String(createState.document.postingBlock)}>
              {createState.document.postingBlock ? t('mi01.blocked') : t('mi01.notBlocked')}
            </span>
          </p>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mi01.columnLine')}</th>
                <th className="py-1">{t('mi01.columnMaterial')}</th>
                <th className="py-1">{t('mi01.columnBatch')}</th>
                <th className="py-1 text-right">{t('mi01.columnStock')}</th>
              </tr>
            </thead>
            <tbody>
              {createState.document.items.map((item) => (
                <tr key={item.itemNumber} className="border-t border-line" data-item={item.itemNumber}>
                  <td className="py-1">{item.itemNumber}</td>
                  <td className="py-1">{item.materialNumber} · {item.description}</td>
                  <td className="py-1" data-batch={item.batch}>{item.batch || '—'}</td>
                  <td className="py-1 text-right tabular" data-stock={item.materialNumber}>
                    {item.stockQuantity} {item.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-soft">{t('mi01.countDeferred')}</p>
          {/* SAP enters counts on MI04, not on the document that raises them: this is the way there. */}
          <a
            className="mt-2 inline-block text-xs underline"
            href={`/inventory/physical-inventory-count?doc=${encodeURIComponent(createState.document.inventoryDocumentNumber)}&year=${createState.document.fiscalYear}`}
            data-count-entry-link
          >
            {t('mi01.countEntry')}
          </a>

          <LockNotice message={cancelLock?.mode === 'DISPLAY' ? cancelLock.message : null} remedy={cancelLock?.remedy} />
          <form action={cancelAction} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="inventoryDocumentNumber" value={createState.document.inventoryDocumentNumber} />
            <input type="hidden" name="fiscalYear" value={createState.document.fiscalYear} />
            <button
              type="submit"
              className="btn btn-default min-h-11 sm:min-h-8"
              disabled={!canCancel || cancelling || createState.document.status !== 'CREATED' || cancelLock?.mode !== 'CHANGE'}
            >
              {cancelling ? t('mi01.cancelling') : t('mi01.cancel')}
            </button>
            <span role="status" className={`text-sm ${cancelState.ok ? 'text-ink' : 'text-red-700'}`}>
              {cancelState.message}{cancelState.remedy ? ` ${cancelState.remedy}` : ''}
            </span>
          </form>
        </section>
      )}

      <p className="text-xs text-ink-soft">
        <Link className="text-accent hover:underline" href="/inventory/material-documents">
          {t('mi01.ledgerLink')}
        </Link>
      </p>
    </>
  );
}
