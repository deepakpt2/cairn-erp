'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { t } from '@/platform/i18n';
import type { ComponentAvailability, OrderAvailabilityResult } from '@/modules/production/order-availability';

/**
 * CO09 slice 1's workbench. It is a client component for one reason: a check has to be
 * able to say it is still working, and a check that is still working must not be
 * startable twice. Everything else is rendered from the server's read.
 *
 * There is deliberately no control here that could be read as taking a quantity. The
 * only button runs the read; the only other actions are links to the screens that
 * already own the order, the material, and the stock/requirements list.
 */
export default function OrderAvailabilityWorkbench({
  canUse,
  canCheckOrder,
  canReadElements,
  orderNumber,
  itemNumber,
  horizonEnd,
  result,
  serviceError,
  serviceErrorKind,
}: {
  canUse: boolean;
  canCheckOrder: boolean;
  canReadElements: boolean;
  orderNumber: string;
  itemNumber: string;
  horizonEnd: string;
  result: OrderAvailabilityResult | null;
  serviceError: string | null;
  serviceErrorKind: 'unsupported' | 'failure';
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [order, setOrder] = useState(orderNumber);
  const [item, setItem] = useState(itemNumber);
  const [horizon, setHorizon] = useState(horizonEnd);
  const [pending, setPending] = useState(false);

  if (!canUse) {
    const missing = [
      !canCheckOrder ? t('co09.capabilityOrder') : null,
      !canReadElements ? t('co09.capabilityElements') : null,
    ].filter((line): line is string => line !== null);
    return (
      <div className="panel p-4 text-sm text-ink-soft" role="alert" data-co09-state="authz-failure">
        <p className="font-semibold text-ink">{t('co09.authzTitle')}</p>
        {missing.map((line) => <p key={line} className="mt-1">{line}</p>)}
        <p className="mt-2">{t('co09.authzRemedy')}</p>
      </div>
    );
  }

  const run = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const params = new URLSearchParams();
    if (order.trim()) params.set('order', order.trim().toUpperCase());
    if (item.trim()) params.set('item', item.trim());
    if (horizon.trim()) params.set('horizonEnd', horizon.trim());
    setPending(true);
    const query = params.toString();
    // A navigation that never completes must not leave the button dead, so the flag is
    // cleared on the settle of the same transition rather than in an effect.
    void Promise.resolve(router.push(query ? `${pathname}?${query}` : pathname)).finally(() => setPending(false));
  };

  const answered = result?.components ?? [];
  // The stock/requirements list always draws the opening stock element, even at zero,
  // so a component whose only element is stock is the empty case in disguise. That is
  // the state this banner is for: nothing the scope counts stands behind the order.
  const nothingCounted = answered.length > 0
    && answered.every((row) => row.elements.every((element) => element.elementType === 'STOCK'));

  return (
    <div className="space-y-4">
      <form onSubmit={run} className="panel space-y-3 p-4" aria-label={t('co09.selection')} data-co09-form>
        <div className="flex flex-wrap gap-3">
          <Field label={t('co09.order')}>
            <input name="order" value={order} onChange={(event) => setOrder(event.target.value)}
              maxLength={12} required className="field-input code w-40" placeholder="1000000123"
              aria-describedby="co09-order-help" />
            <p id="co09-order-help" className="mt-1 text-xs text-ink-faint">{t('co09.orderHelp')}</p>
          </Field>
          <Field label={t('co09.item')}>
            <input name="item" value={item} onChange={(event) => setItem(event.target.value)}
              maxLength={4} className="field-input code w-24" placeholder="1" />
          </Field>
          <Field label={t('co09.horizonEnd')}>
            <input name="horizonEnd" type="date" value={horizon} onChange={(event) => setHorizon(event.target.value)}
              className="field-input code w-40" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" data-co09-check
            disabled={pending} aria-busy={pending || undefined}>
            {pending ? t('co09.checking') : t('co09.check')}
          </button>
          <Link href={pathname} className="btn btn-default min-h-11 sm:min-h-8">{t('co09.reset')}</Link>
          <Link href="/production/production-order-display" className="btn btn-default min-h-11 sm:min-h-8">{t('co09.findOrder')}</Link>
          <Link href="/production/order-information" className="btn btn-default min-h-11 sm:min-h-8">{t('co09.orderList')}</Link>
        </div>
        <p className="text-xs text-ink-faint">{t('co09.readOnly')}</p>
      </form>

      {pending ? (
        <p className="panel p-3 text-sm text-ink-soft" role="status" data-co09-state="loading">{t('co09.loading')}</p>
      ) : null}

      {serviceError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          role="alert" data-co09-state={serviceErrorKind === 'unsupported' ? 'unsupported' : 'service-error'}>
          {serviceError}
        </div>
      ) : null}

      {!serviceError && result === null && !pending ? (
        <p className="panel p-4 text-sm text-ink-soft" role="status" data-co09-state="initial">{t('co09.initial')}</p>
      ) : null}

      {result ? (
        <section className="panel space-y-3 p-4" aria-label={t('co09.summary')} data-co09-order={result.orderNumber}
          data-co09-status={result.status}>
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Summary label={t('co09.order')} value={`${result.orderNumber} · ${t(`co09.status.${result.orderStatus}`)} · ${result.materialNumber}`} />
            <Summary label={t('co09.plant')} value={`${result.plant} · ${t('co09.plantLevel')}`} />
            <Summary label={t('co09.control')} value={result.checkingRule === null
              ? t('co09.controlMissing')
              : `${t('co09.orderType')} ${result.orderType ?? '—'} · ${t('co09.businessFunction')} ${result.businessFunction} · ${result.checkingRule}`} />
            <Summary label={t('co09.scope')} value={result.scopeKey ?? t('co09.scopeMissing')} />
          </div>
          <p className="text-xs text-ink-soft">
            {t('co09.quantity')} {result.orderQuantity.toFixed(3)} {result.unitOfMeasure}. {t('co09.componentCount', { count: result.components.length })} · {t('co09.checkedCount', { count: result.checkedCount })} · {t('co09.refusedCount', { count: result.refusedCount })} · {t('co09.excludedCount', { count: result.excludedCount })}
          </p>
          {result.message ? (
            <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              role="status" data-co09-state={result.status === 'NOT_CHECKED' ? 'not-checked' : 'incomplete-config'}>
              <span className="font-semibold">{result.message}</span>
              {result.remedy ? <span className="ms-2">{result.remedy}</span> : null}
            </p>
          ) : null}
          {nothingCounted ? (
            <p className="text-sm text-ink-soft" role="status" data-co09-state="no-elements">{t('co09.noElements')}</p>
          ) : null}
        </section>
      ) : null}

      {result ? (
        <section className="panel overflow-x-auto" aria-label={t('co09.components')}>
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold">{t('co09.components')}</h2>
            <span className="text-xs text-ink-soft">{t('co09.committedNotStored')}</span>
          </div>
          <table className="grid-table min-w-[76rem]">
            <thead>
              <tr>
                <th>{t('co09.item')}</th>
                <th>{t('co09.material')}</th>
                <th>{t('co09.group')}</th>
                <th>{t('co09.rule')}</th>
                <th>{t('co09.scope')}</th>
                <th className="text-end">{t('co09.required')}</th>
                <th>{t('co09.requirementDate')}</th>
                <th className="text-end">{t('co09.committed')}</th>
                <th className="text-end">{t('co09.cumulatedAtp')}</th>
                <th className="text-end">{t('co09.covered')}</th>
                <th className="text-end">{t('co09.shortage')}</th>
                <th>{t('co09.earliest')}</th>
                <th>{t('co09.outcome')}</th>
                <th>{t('co09.display')}</th>
              </tr>
            </thead>
            <tbody>
              {answered.map((row) => <ComponentRow key={`${row.itemNumber}|${row.materialNumber}`} row={row} plant={result.plant} />)}
            </tbody>
          </table>
        </section>
      ) : null}

      {result && result.warnings.length > 0 ? (
        <section className="panel p-4" aria-label={t('co09.notes')}>
          <ul className="list-disc space-y-1 ps-5 text-sm text-ink-soft">
            {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ComponentRow({ row, plant }: { row: ComponentAvailability; plant: string }) {
  const answeredNumber = row.outcome === 'AVAILABLE' || row.outcome === 'SHORT' || row.outcome === 'NO_ELEMENTS';
  const stateClass = row.outcome === 'AVAILABLE'
    ? 'text-emerald-800 dark:text-emerald-200'
    : row.outcome === 'SHORT' || !answeredNumber
      ? 'text-red-700 dark:text-red-300'
      : 'text-ink-soft';
  return (
    <>
      <tr data-co09-component={row.itemNumber} data-co09-outcome={row.outcome}
        data-co09-material={row.materialNumber} data-co09-committed="not-stored">
        <td className="text-end">{row.itemNumber}</td>
        <td className="code" title={row.description}>{row.materialNumber}</td>
        <td className="code">{row.checkingGroup ?? '—'}</td>
        <td className="code">{row.checkingRule ?? '—'}</td>
        <td className="code">{row.scopeKey ?? '—'}</td>
        <td className="text-end">{row.requiredQuantity.toFixed(3)} {row.unit}</td>
        <td className="code">{row.requirementDate ?? t('co09.undated')}</td>
        <td className="text-end" data-co09-committed-cell>{t('co09.notStored')}</td>
        <td className="text-end" data-co09-atp={row.cumulatedAtp === null ? '' : row.cumulatedAtp.toFixed(3)}>
          {row.cumulatedAtp === null ? '—' : row.cumulatedAtp.toFixed(3)}
        </td>
        <td className="text-end" data-co09-covered={row.coveredQuantity === null ? '' : row.coveredQuantity.toFixed(3)}>
          {row.coveredQuantity === null ? '—' : row.coveredQuantity.toFixed(3)}
        </td>
        <td className="text-end font-semibold" data-co09-shortage={row.shortageQuantity === null ? '' : row.shortageQuantity.toFixed(3)}>
          {row.shortageQuantity === null ? '—' : row.shortageQuantity.toFixed(3)}
        </td>
        <td className="code">{row.earliestFullCoverageDate ?? '—'}</td>
        <td className={`text-xs ${stateClass}`}>{t(`co09.outcome.${row.outcome}`)}</td>
        <td className="text-xs">
          <Link className="code" href={`/production/stock-requirements?material=${encodeURIComponent(row.materialNumber)}&plant=${encodeURIComponent(plant)}`}>
            {t('co09.display')}
          </Link>
        </td>
      </tr>
      {row.message ? (
        <tr data-co09-message={row.itemNumber}>
          <td colSpan={14} className="text-xs text-ink-soft">
            <span>{row.message}</span>
            {row.remedy ? <span className="ms-2 text-ink-faint">{row.remedy}</span> : null}
          </td>
        </tr>
      ) : null}
      {row.warnings.length > 0 ? (
        <tr data-co09-component-warnings={row.itemNumber}>
          <td colSpan={14}>
            <ul className="list-disc space-y-0.5 ps-5 text-xs text-amber-900 dark:text-amber-200">
              {row.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </td>
        </tr>
      ) : null}
      {row.elements.length > 0 ? (
        <tr data-co09-elements={row.itemNumber}>
          <td colSpan={14} className="align-top">
            <p className="mb-1 text-xs font-semibold text-ink-faint">{t('co09.elementCount', { count: row.elements.length })}</p>
            <table className="grid-table min-w-[52rem] text-xs">
              <thead>
                <tr>
                  <th>{t('co09.date')}</th>
                  <th>{t('co09.element')}</th>
                  <th>{t('co09.document')}</th>
                  <th className="text-end">{t('co09.itemCol')}</th>
                  <th className="text-end">{t('co09.receipt')}</th>
                  <th className="text-end">{t('co09.requirement')}</th>
                  <th className="text-end">{t('co09.cumulated')}</th>
                  <th>{t('co09.counted')}</th>
                </tr>
              </thead>
              <tbody>
                {row.elements.map((element, index) => (
                  <tr key={`${element.date}|${element.elementType}|${element.documentNumber}|${index}`}
                    data-co09-element={element.elementType} data-co09-element-date={element.date}
                    data-co09-own={element.ownDemand ? 'yes' : 'no'}>
                    <td className="code">{element.date}</td>
                    <td title={element.elementLabel}>{element.elementType}</td>
                    <td className="code">{element.documentNumber}</td>
                    <td className="text-end">{element.documentItem}</td>
                    <td className="text-end">{element.direction === 'RECEIPT' ? element.quantity.toFixed(3) : ''}</td>
                    <td className="text-end">{element.direction === 'REQUIREMENT' ? element.quantity.toFixed(3) : ''}</td>
                    <td className="text-end font-semibold">{element.cumulated.toFixed(3)}</td>
                    <td className="text-xs text-ink-faint">
                      {element.ownDemand ? t('co09.ownDemand') : t('co09.inScope')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <p className="code text-sm">{value}</p>
    </div>
  );
}
