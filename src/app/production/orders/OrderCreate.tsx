'use client';

import { useActionState, useEffect, useState } from 'react';

import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import { createOrderAction, releaseOrderAction, type OrderActionState } from './actions';

const INITIAL: OrderActionState = { ok: false, message: '' };

export default function OrderCreate({
  canCreate, canRelease, today,
}: { canCreate: boolean; canRelease: boolean; today: string }) {
  const [created, createAction, creating] = useActionState(createOrderAction, INITIAL);
  const [released, releaseAction, releasing] = useActionState(releaseOrderAction, INITIAL);
  const [requestKey] = useState(() => Math.random().toString(36).slice(2) + Date.now().toString(36));
  const [releaseNumber, setReleaseNumber] = useState('');
  const order = released.order ?? created.order ?? null;
  useEffect(() => {
    if (created.order?.orderNumber) setReleaseNumber(created.order.orderNumber);
  }, [created.order?.orderNumber]);
  const releaseLock = useChangeLock(
    'PRODUCTION_ORDER',
    releaseNumber.trim() || null,
    'PROD.ORDER.RELEASE',
    Boolean(releaseNumber.trim()) && canRelease,
  );

  return (
    <>
      <section aria-labelledby="order-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="order-create" className="text-sm font-semibold">{t('co01.createHeader')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('co01.createHint')}</p>
        <p role="status" className={`mt-2 text-sm ${created.ok ? 'text-ink' : 'text-red-700'}`}>
          {created.message}{created.remedy ? ` ${created.remedy}` : ''}
        </p>

        <form action={createAction}>
          <input type="hidden" name="requestKey" value={requestKey} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block">
              <span className="field-label">{t('co01.material')}</span>
              <input name="materialNumber" className="input w-full" placeholder="MAT-FG" required />
            </label>
            <label className="block">
              <span className="field-label">{t('co01.plant')}</span>
              <input name="plant" className="input w-full" placeholder="1000" required />
            </label>
            <label className="block">
              <span className="field-label">Order type</span>
              <input name="orderType" maxLength={4} className="input code w-full" placeholder="PP01" required />
              <span className="mt-1 block text-xs text-ink-soft">A standing category 10 type is required. A scheduling profile does not propose one. Saving does not run an availability check.</span>
            </label>
            <label className="block">
              <span className="field-label">{t('co01.quantity')}</span>
              <input name="orderQuantity" type="number" step="0.001" min="0.001" className="input w-full" required />
            </label>
            <label className="block">
              <span className="field-label">Batch</span>
              <input name="batch" maxLength={10} className="input w-full" placeholder="Existing batch" />
            </label>
            <label className="block">
              <span className="field-label">{t('co01.start')}</span>
              <input type="date" name="scheduledStart" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="field-label">{t('co01.finish')}</span>
              <input type="date" name="scheduledFinish" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="field-label">{t('co01.version')}</span>
              <input name="productionVersion" maxLength={4} className="input w-full" placeholder="0001" />
              <span className="mt-1 block text-xs text-ink-soft">{t('co01.versionHint')}</span>
            </label>
          </div>

          <h3 className="mt-4 text-sm font-semibold">{t('co01.components')}</h3>
          <p className="mt-1 text-xs text-ink-soft">{t('co01.componentsHint')}</p>
          {created.preview && (
            <div className="mt-3" data-preview-version={created.preview.productionVersion}>
              <p className="text-sm">
                {t('co01.bom')} {created.preview.bomUsage}/{created.preview.bomAlternative}
              </p>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                    <th className="py-1">{t('co01.columnItem')}</th>
                    <th className="py-1">{t('co01.columnBomItem')}</th>
                    <th className="py-1">{t('co01.columnMaterial')}</th>
                    <th className="py-1">{t('co01.columnSource')}</th>
                    <th className="py-1">{t('co01.columnPlant')}</th>
                    <th className="py-1 text-right">{t('co01.columnQuantity')}</th>
                  </tr>
                </thead>
                <tbody>
                  {created.preview.components.map((component) => (
                    <tr key={component.bomItem} className="border-t border-line" data-bom-item={component.bomItem}>
                      <td className="py-1">{component.orderItemNumber}</td>
                      <td className="py-1">{component.bomItem}</td>
                      <td className="py-1">{component.materialNumber}</td>
                      <td className="py-1">{component.sourceMaterial}</td>
                      <td className="py-1">{component.plant}</td>
                      <td className="py-1 text-right tabular">{component.requiredQuantity} {component.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {created.preview.warnings.length > 0 && (
                <p className="mt-2 text-xs text-ink-soft">{created.preview.warnings.join(' ')}</p>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="submit" name="intent" value="check" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canCreate || creating}>
              {creating ? t('co01.checking') : t('co01.check')}
            </button>
            <button type="submit" name="intent" value="create" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canCreate || creating}>
              {creating ? t('co01.creating') : t('co01.create')}
            </button>
            {!canCreate && <p className="text-sm text-ink-soft">{t('co01.noCreate')}</p>}
          </div>
        </form>
      </section>

      {created.ok && created.order && (
        <section aria-labelledby="order-release" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="order-release" className="text-sm font-semibold">{t('co01.releaseHeader')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('co01.releaseHint')}</p>
          <p role="status" className={`mt-2 text-sm ${released.ok ? 'text-ink' : 'text-red-700'}`}>
            {released.message}{released.remedy ? ` ${released.remedy}` : ''}
          </p>
          <LockNotice message={releaseLock?.mode === 'DISPLAY' ? releaseLock.message : null} />
          <form action={releaseAction} className="mt-2 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="field-label">{t('co01.orderNumber')}</span>
              <input
                name="orderNumber"
                className="input w-48"
                value={releaseNumber}
                onChange={(event) => setReleaseNumber(event.target.value)}
                required
              />
            </label>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canRelease || releasing || releaseLock?.mode !== 'CHANGE'}>
              {t('co01.release')}
            </button>
            {!canRelease && <p className="text-sm text-ink-soft">{t('co01.noRelease')}</p>}
          </form>
        </section>
      )}

      {order && (
        <section aria-labelledby="order-summary" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="order-summary" className="text-sm font-semibold">
            {t('co01.order')} <span className="code" data-order-number={order.orderNumber}>{order.orderNumber}</span>
          </h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="field-label">{t('co01.material')}</dt><dd>{order.materialNumber} · {order.materialDescription ?? '—'}</dd></div>
            <div><dt className="field-label">{t('co01.plant')}</dt><dd>{order.plant}</dd></div>
            <div><dt className="field-label">Order type</dt><dd className="code" data-order-type={order.orderType ?? ''}>{order.orderType ?? 'Not assigned'}</dd></div>
            <div><dt className="field-label">{t('co01.company')}</dt><dd data-company-code={order.companyCode}>{order.companyCode}</dd></div>
            <div><dt className="field-label">{t('co01.quantity')}</dt><dd>{order.orderQuantity} {order.unit}</dd></div>
            <div><dt className="field-label">{t('co01.start')}</dt><dd>{order.scheduledStart}</dd></div>
            <div><dt className="field-label">{t('co01.finish')}</dt><dd>{order.scheduledFinish}</dd></div>
            <div><dt className="field-label">{t('co01.status')}</dt><dd data-status={order.status}>{order.status}</dd></div>
            <div>
              <dt className="field-label">{t('co01.version')}</dt>
              <dd data-production-version={order.productionVersion ?? ''}>{order.productionVersion ?? '—'}{order.bomUsage ? ` · ${order.bomUsage}/${order.bomAlternative}` : ''}</dd>
            </div>
            <div><dt className="field-label">Profile</dt><dd className="code">{order.schedulingProfile || '—'}</dd></div>
            <div><dt className="field-label">Batch</dt><dd className="code">{order.batch || '—'}</dd></div>
            <div><dt className="field-label">{t('co01.releasedBy')}</dt><dd>{order.releasedBy ?? '—'}{order.releasedAt ? ` · ${order.releasedAt}` : ''}</dd></div>
          </dl>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('co01.columnItem')}</th>
                <th className="py-1">{t('co01.columnBomItem')}</th>
                <th className="py-1">{t('co01.columnMaterial')}</th>
                <th className="py-1">{t('co01.columnPlant')}</th>
                <th className="py-1">{t('co01.columnLocation')}</th>
                <th className="py-1 text-right">{t('co01.columnQuantity')}</th>
              </tr>
            </thead>
            <tbody>
              {order.components.map((c) => (
                <tr key={c.itemNumber} className="border-t border-line" data-item={c.itemNumber} data-bom-item={c.bomItem ?? ''}>
                  <td className="py-1">{c.itemNumber}</td>
                  <td className="py-1">{c.bomItem ?? '—'}</td>
                  <td className="py-1">{c.materialNumber} · {c.materialDescription ?? '—'}</td>
                  <td className="py-1">{c.plant}</td>
                  <td className="py-1">{c.storageLocation ?? '—'}</td>
                  <td className="py-1 text-right tabular">{c.requiredQuantity} {c.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
