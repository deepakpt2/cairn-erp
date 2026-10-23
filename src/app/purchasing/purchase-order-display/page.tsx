import Link from 'next/link';
import type { ReactNode } from 'react';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { PO_CREATE_CAPABILITY } from '@/modules/purchasing/orders';
import {
  PO_DISPLAY_CAPABILITY,
  PO_DISPLAY_ROUTE,
  PurchaseOrderDisplayError,
  openPurchaseOrderDisplay,
  type DisplayedOrder,
} from '@/modules/purchasing/purchase-order-display';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function stateLabel(state: string): string {
  const key = `poDisplay.state.${state}`;
  const label = t(key);
  return label === key ? state : label;
}

function OrderView({ order, canChange }: { order: DisplayedOrder; canChange: boolean }) {
  return (
    <section aria-labelledby="po-display-document" className="space-y-4" data-po-display>
      <div className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="po-display-document" className="text-sm font-semibold" data-po-number>{order.orderNumber}</h2>
        <p className="mt-1 text-sm" data-po-identity>
          <span data-po-supplier>{order.supplierNumber}{order.supplierName ? ` · ${order.supplierName}` : ''}</span>
          {' · '}
          <span data-po-company>{order.companyCode}</span>
          {' · '}
          <span data-po-currency>{order.currency}</span>
          {' · '}
          <span data-po-date>{order.documentDate}</span>
        </p>
        <p className="mt-1 text-xs text-ink-soft" data-po-nothing-written>{t('poDisplay.nothingWritten')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-po-no-period>{t('poDisplay.noPeriod')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-po-name-current>{t('poDisplay.nameCurrent')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-po-not-stored>{t('poDisplay.notStored')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-po-no-status>{t('poDisplay.noStatus')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-po-no-revision>{t('poDisplay.noRevision')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-po-no-condition>{t('poDisplay.noCondition')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-po-header-state>{t('poDisplay.headerState')} {stateLabel(order.headerState)}</p>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-ink-soft">{t('poDisplay.documentType')}</dt><dd data-po-type>{order.documentType}</dd></div>
          <div><dt className="text-ink-soft">{t('poDisplay.purchasingOrg')}</dt><dd>{order.purchasingOrg}</dd></div>
          <div><dt className="text-ink-soft">{t('poDisplay.purchasingGroup')}</dt><dd>{order.purchasingGroup}</dd></div>
          <div><dt className="text-ink-soft">{t('poDisplay.created')}</dt><dd data-po-created>{order.createdBy} · {order.createdAt}</dd></div>
          <div><dt className="text-ink-soft">{t('poDisplay.releaseFlag')}</dt><dd data-po-release-flag>{order.releaseStatus}</dd></div>
          <div>
            <dt className="text-ink-soft">{t('poDisplay.release')}</dt>
            <dd data-po-release>
              {order.release.status}
              {order.release.strategyCode ? ` · ${order.release.strategyCode}` : ''}
              {order.release.steps.length > 0 ? ` · ${order.release.currentStep}/${order.release.steps.length}` : ''}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-ink-soft" data-po-no-release>{t('poDisplay.noRelease')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {canChange && (
            <Link href={`/purchasing/orders?order=${encodeURIComponent(order.orderNumber)}`} className="btn btn-default min-h-11 sm:min-h-8" data-po-change>
              {t('poDisplay.toChange')}
            </Link>
          )}
          <Link href="/inventory/goods-receipt" className="btn btn-default min-h-11 sm:min-h-8" data-po-receipt>{t('poDisplay.toReceipt')}</Link>
          <Link href={`/purchasing/invoice-overview?companyFrom=${encodeURIComponent(order.companyCode)}&fiscalYear=${order.documentDate.slice(0, 4)}&orderFrom=${encodeURIComponent(order.orderNumber)}&orderTo=${encodeURIComponent(order.orderNumber)}`} className="btn btn-default min-h-11 sm:min-h-8" data-po-invoices>
            {t('poDisplay.toInvoices')}
          </Link>
          <Link href={`/purchasing/grir-clearing?companyFrom=${encodeURIComponent(order.companyCode)}&orderFrom=${encodeURIComponent(order.orderNumber)}&orderTo=${encodeURIComponent(order.orderNumber)}&keyDate=${encodeURIComponent(order.documentDate)}`} className="btn btn-default min-h-11 sm:min-h-8" data-po-grir>
            {t('poDisplay.toClearing')}
          </Link>
        </div>
        <p className="mt-2 text-xs text-ink-soft" data-po-navigation>{t('poDisplay.navigation')}</p>
      </div>

      {order.items.map((item) => (
        <section key={item.itemNumber} aria-labelledby={`po-item-${item.itemNumber}`} className="rounded-card border border-line bg-surface p-4 shadow-card" data-po-item={item.itemNumber}>
          <h3 id={`po-item-${item.itemNumber}`} className="text-sm font-semibold">
            {item.itemNumber} · {item.shortText}
          </h3>
          <p className="mt-1 text-sm">
            {item.materialNumber ?? t('poDisplay.notProvided')} · {item.plant}
            {item.storageLocation ? ` · ${item.storageLocation}` : ` · ${t('poDisplay.notProvided')}`}
            {item.batch ? ` · Batch ${item.batch}` : ''}
            {' · '}{item.itemCategory}
            {item.markedForDeletion ? ` · ${t('poDisplay.marked')}` : ''}
          </p>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div><dt className="text-ink-soft">{t('poDisplay.ordered')}</dt><dd data-po-ordered={item.itemNumber}>{item.orderedQuantity} {item.unit}</dd></div>
            <div><dt className="text-ink-soft">{t('poDisplay.received')}</dt><dd data-po-received={item.itemNumber}>{item.receivedQuantity}</dd></div>
            <div><dt className="text-ink-soft">{t('poDisplay.invoiced')}</dt><dd data-po-invoiced={item.itemNumber}>{item.invoicedQuantity}</dd></div>
            <div><dt className="text-ink-soft">{t('poDisplay.remainingDeliver')}</dt><dd>{item.remainingToDeliver}</dd></div>
            <div><dt className="text-ink-soft">{t('poDisplay.remainingInvoice')}</dt><dd>{item.remainingToInvoice}</dd></div>
            <div><dt className="text-ink-soft">{t('poDisplay.itemState')}</dt><dd data-po-item-state={item.itemNumber}>{stateLabel(item.state)}</dd></div>
            <div><dt className="text-ink-soft">{t('poDisplay.price')}</dt><dd>{item.netPrice} / {item.priceUnit}</dd></div>
            <div><dt className="text-ink-soft">{t('poDisplay.netValue')}</dt><dd data-po-net={item.itemNumber}>{item.netValue} {order.currency}</dd></div>
            <div><dt className="text-ink-soft">{t('poDisplay.tax')}</dt><dd>{item.taxCode ?? t('poDisplay.notProvided')}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-ink-soft" data-po-net-stored>{t('poDisplay.netStored')}</p>
          <p className="mt-1 text-xs text-ink-soft" data-po-conversion={item.itemNumber}>
            {item.conversion.baseUnit == null
              ? t('poDisplay.conversionAbsent')
              : item.conversion.sameUnit
                ? t('poDisplay.conversionSame', { unit: item.unit })
                : item.conversion.numerator != null && item.conversion.denominator != null
                  ? t('poDisplay.conversionStored', { unit: item.unit, base: item.conversion.baseUnit, numerator: String(item.conversion.numerator), denominator: String(item.conversion.denominator) })
                  : t('poDisplay.conversionMissing', { unit: item.unit, base: item.conversion.baseUnit })}
          </p>
          <p className="mt-1 text-xs text-ink-soft">
            {item.requisitionNumber
              ? <Link className="underline" href={`/purchasing/requisitions?req=${encodeURIComponent(item.requisitionNumber)}`} data-po-requisition={item.itemNumber}>{item.requisitionNumber} / {item.requisitionItem}</Link>
              : t('poDisplay.noRequisition')}
            {' · '}
            {item.infoRecordNumber ?? t('poDisplay.noInfoRecord')}
            {' · '}
            {item.sourceNumber ?? t('poDisplay.noSource')}
            {' · '}
            {t('poDisplay.noContract')}
          </p>

          <h4 className="mt-4 text-sm font-semibold">{t('poDisplay.schedules')}</h4>
          {item.schedules.length === 0 ? (
            <p className="mt-1 text-sm text-ink-soft" data-po-no-schedule={item.itemNumber}>{t('poDisplay.noSchedule')}</p>
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-ink-soft">
                  <th className="py-1 pr-3">{t('poDisplay.line')}</th>
                  <th className="py-1 pr-3">{t('poDisplay.deliveryDate')}</th>
                  <th className="py-1">{t('poDisplay.quantity')}</th>
                </tr>
              </thead>
              <tbody>
                {item.schedules.map((line) => (
                  <tr key={line.lineNumber} data-po-schedule={`${item.itemNumber}-${line.lineNumber}`}>
                    <td className="py-1 pr-3">{line.lineNumber}</td>
                    <td className="py-1 pr-3">{line.deliveryDate}</td>
                    <td className="py-1">{line.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-1 text-xs text-ink-soft">{t('poDisplay.scheduleNote')}</p>

          <h4 className="mt-4 text-sm font-semibold">{t('poDisplay.assignments')}</h4>
          {item.assignments.length === 0 ? (
            <p className="mt-1 text-sm text-ink-soft" data-po-no-assignment={item.itemNumber}>{t('poDisplay.noAssignment')}</p>
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-ink-soft">
                  <th className="py-1 pr-3">{t('poDisplay.line')}</th>
                  <th className="py-1 pr-3">{t('poDisplay.costCenter')}</th>
                  <th className="py-1 pr-3">{t('poDisplay.gl')}</th>
                  <th className="py-1 pr-3">{t('poDisplay.percent')}</th>
                  <th className="py-1">{t('poDisplay.share')}</th>
                </tr>
              </thead>
              <tbody>
                {item.assignments.map((line) => (
                  <tr key={line.lineNumber} data-po-assignment={`${item.itemNumber}-${line.lineNumber}`}>
                    <td className="py-1 pr-3">{line.lineNumber}</td>
                    <td className="py-1 pr-3">{line.costCenter}</td>
                    <td className="py-1 pr-3">{line.glAccount}</td>
                    <td className="py-1 pr-3">{line.distributionPercentage}</td>
                    <td className="py-1" data-po-share={`${item.itemNumber}-${line.lineNumber}`}>{line.assignedValue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-1 text-xs text-ink-soft" data-po-share-note>{t('poDisplay.shareNote')}</p>
        </section>
      ))}

      <section aria-labelledby="po-display-history" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="po-display-history" className="text-sm font-semibold">{t('poDisplay.history')}</h2>
        <p className="mt-1 text-xs text-ink-soft" data-po-history-note>{t('poDisplay.historyNote')}</p>
        {order.historyTruncated && <p className="mt-1 text-sm text-ink-soft">{t('poDisplay.truncated')}</p>}
        <h3 className="mt-3 text-sm font-semibold">{t('poDisplay.goods')}</h3>
        {order.goods.length === 0 ? <p className="mt-1 text-sm text-ink-soft" data-po-no-goods>{t('poDisplay.noGoods')}</p> : (
          <table className="mt-2 w-full text-sm">
            <tbody>
              {order.goods.map((row) => (
                <tr key={`${row.documentNumber}-${row.lineNumber}`} data-po-goods={row.documentNumber}>
                  <td className="py-1 pr-3">
                    <Link className="underline" href={`/inventory/material-documents?document=${encodeURIComponent(row.documentNumber)}&fiscalYear=${row.documentYear}`}>{row.documentNumber}</Link>
                    {' / '}{row.lineNumber} · {row.itemNumber} · {row.direction} · {row.status}
                    {row.reversalOf ? ` · ${t('poDisplay.reversalOf')} ${row.reversalOf}` : ''}
                    {row.reversedBy ? ` · ${t('poDisplay.reversedBy')} ${row.reversedBy}` : ''}
                    {row.returnOf ? ` · ${t('poDisplay.returnOf')} ${row.returnOf}` : ''}
                  </td>
                  <td className="py-1">{row.entryQuantity} {row.entryUnit} · {row.postingDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3 className="mt-3 text-sm font-semibold">{t('poDisplay.invoices')}</h3>
        {order.invoices.length === 0 ? <p className="mt-1 text-sm text-ink-soft" data-po-no-invoice>{t('poDisplay.noInvoice')}</p> : (
          <table className="mt-2 w-full text-sm">
            <tbody>
              {order.invoices.map((row) => (
                <tr key={`${row.invoiceNumber}-${row.lineNumber}`} data-po-invoice={row.invoiceNumber}>
                  <td className="py-1 pr-3">
                    <Link className="underline" href={`/purchasing/invoice-overview?companyFrom=${encodeURIComponent(order.companyCode)}&fiscalYear=${row.fiscalYear}&orderFrom=${encodeURIComponent(order.orderNumber)}&orderTo=${encodeURIComponent(order.orderNumber)}`}>{row.invoiceNumber}</Link>
                    {' · '}{row.category} · {row.status} · {row.itemNumber}
                    {row.cancellationOf ? ` · ${t('poDisplay.cancels')} ${row.cancellationOf}` : ''}
                    {row.cancelledBy ? ` · ${t('poDisplay.cancelledBy')} ${row.cancelledBy}` : ''}
                    {row.journalDocumentNumber
                      ? <> · <Link className="underline" href={`/finance/journal/document?document=${encodeURIComponent(row.journalDocumentNumber)}&company=${encodeURIComponent(order.companyCode)}&year=${row.fiscalYear}`}>{row.journalDocumentNumber}</Link></>
                      : ` · ${t('poDisplay.noJournal')}`}
                  </td>
                  <td className="py-1">{row.quantity} {row.unit} · {row.netAmount} {row.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3 className="mt-3 text-sm font-semibold">{t('poDisplay.parks')}</h3>
        {order.parks.length === 0 ? <p className="mt-1 text-sm text-ink-soft" data-po-no-park>{t('poDisplay.noPark')}</p> : (
          <ul className="mt-2 space-y-1 text-sm">
            {order.parks.map((row) => (
              <li key={`${row.parkedNumber}-${row.itemNumber}`} data-po-park={row.parkedNumber}>
                <Link className="underline" href={`/purchasing/parked-invoice?parked=${encodeURIComponent(row.parkedNumber)}`}>{row.parkedNumber}</Link>
                {' · '}{row.itemNumber} · {row.quantity} · {row.netAmount} {row.currency} · {t('poDisplay.parkNote')}
              </li>
            ))}
          </ul>
        )}
        <h3 className="mt-3 text-sm font-semibold">{t('poDisplay.clearings')}</h3>
        {order.clearings.length === 0 ? <p className="mt-1 text-sm text-ink-soft" data-po-no-clearing>{t('poDisplay.noClearing')}</p> : (
          <ul className="mt-2 space-y-1 text-sm">
            {order.clearings.map((row) => (
              <li key={`${row.documentNumber}-${row.itemNumber}`} data-po-clearing={row.documentNumber}>
                <Link className="underline" href={`/finance/journal/document?document=${encodeURIComponent(row.documentNumber)}&company=${encodeURIComponent(order.companyCode)}&year=${row.fiscalYear}`}>{row.documentNumber}</Link>
                {' · '}{row.itemNumber} · {row.allocatedAmount} {row.currency}
                {row.reversedBy ? ` · ${t('poDisplay.reversedBy')} ${row.reversedBy}` : ''}
              </li>
            ))}
          </ul>
        )}
        <h3 className="mt-3 text-sm font-semibold">{t('poDisplay.changes')}</h3>
        {order.changes.length === 0 ? <p className="mt-1 text-sm text-ink-soft" data-po-no-change>{t('poDisplay.noChange')}</p> : (
          <table className="mt-2 w-full text-sm" data-po-changes>
            <tbody>
              {order.changes.map((row, index) => (
                <tr key={`${row.changedAt}-${row.fieldName ?? index}`}>
                  <td className="py-1 pr-3">{row.fieldName ?? row.changeType}</td>
                  <td className="py-1 pr-3">{row.oldValue ?? t('poDisplay.notProvided')}</td>
                  <td className="py-1 pr-3">{row.newValue ?? t('poDisplay.notProvided')}</td>
                  <td className="py-1">{row.changedBy}{row.reason ? ` · ${row.reason}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}

/**
 * Display purchase order — SCR-164.
 *
 * One screen reads a standing purchase order. The number is the key. Nothing
 * is written. The search alias stays in the catalogue.
 */
export default async function PurchaseOrderDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PO_DISPLAY_ROUTE);
  const raw = await searchParams;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const text = last(value);
    if (text) params[name] = text;
  }
  const canDisplay = can(session, PO_DISPLAY_CAPABILITY);
  const canChange = can(session, PO_CREATE_CAPABILITY);
  let refusal: { message: string; remedy?: string } | null = null;
  let opened: DisplayedOrder | null = null;
  let missing = '';
  let search: Awaited<ReturnType<typeof openPurchaseOrderDisplay>>['search'] = null;
  if (canDisplay && Object.keys(params).length > 0) {
    try {
      const result = await openPurchaseOrderDisplay(session.user.client, params);
      refusal = result.refusal;
      search = result.search;
      if (result.order?.found) opened = result.order.order;
      else if (result.order) missing = result.order.message;
    } catch (error) {
      refusal = error instanceof PurchaseOrderDisplayError
        ? { message: error.message, remedy: error.remedy }
        : { message: t('poDisplay.unreadable') };
    }
  } else if (canDisplay) {
    try {
      search = (await openPurchaseOrderDisplay(session.user.client, {})).search;
    } catch (error) {
      refusal = error instanceof PurchaseOrderDisplayError
        ? { message: error.message }
        : { message: t('poDisplay.unreadable') };
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('poDisplay.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('poDisplay.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('poDisplay.subtitle')}</p>
      </header>

      {!canDisplay && <p className="text-sm text-red-700" role="alert">{t('poDisplay.capabilityMissing')}</p>}

      <section aria-labelledby="po-display-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="po-display-selection" className="text-sm font-semibold">{t('poDisplay.selection')}</h2>
        <p className="mt-1 text-xs text-ink-soft" data-po-read-only>{t('poDisplay.readOnly')}</p>
        <form method="get" action={PO_DISPLAY_ROUTE} className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('poDisplay.order')}>
              <ConstrainedField kind="purchase-order" name="order" uppercase defaultValue={params.order ?? ''} />
            </Field>
            <Field label={t('poDisplay.supplier')}>
              <ConstrainedField kind="supplier-purchasing" name="supplier" uppercase defaultValue={params.supplier ?? ''} />
            </Field>
            <Field label={t('poDisplay.purchasingOrg')}>
              <ConstrainedField kind="purchasing-org" name="purchasingOrg" defaultValue={params.purchasingOrg ?? ''} />
            </Field>
            <Field label={t('poDisplay.plant')}>
              <ConstrainedField kind="plant" name="plant" defaultValue={params.plant ?? ''} />
            </Field>
            <Field label={t('poDisplay.dateFrom')}>
              <input name="documentDateFrom" type="date" className="input w-full" defaultValue={params.documentDateFrom ?? ''} />
            </Field>
            <Field label={t('poDisplay.dateTo')}>
              <input name="documentDateTo" type="date" className="input w-full" defaultValue={params.documentDateTo ?? ''} />
            </Field>
            <Field label={t('poDisplay.releaseFlag')}>
              <select name="releaseStatus" className="input w-full" defaultValue={params.releaseStatus ?? ''}>
                <option value="">{t('poDisplay.any')}</option>
                <option value="UNRELEASED">{t('poDisplay.state.UNRELEASED')}</option>
                <option value="RELEASED">{t('poDisplay.state.RELEASED')}</option>
              </select>
            </Field>
            <Field label={t('poDisplay.itemStateFilter')}>
              <select name="itemState" className="input w-full" defaultValue={params.itemState ?? ''}>
                <option value="">{t('poDisplay.any')}</option>
                <option value="OPEN">{t('poDisplay.state.OPEN')}</option>
                <option value="PARTIALLY_DELIVERED">{t('poDisplay.state.PARTIALLY_DELIVERED')}</option>
                <option value="DELIVERED">{t('poDisplay.state.DELIVERED')}</option>
                <option value="COMPLETED">{t('poDisplay.state.COMPLETED')}</option>
                <option value="MARKED">{t('poDisplay.state.MARKED')}</option>
                <option value="MIXED">{t('poDisplay.state.MIXED')}</option>
              </select>
            </Field>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" data-po-open>{t('poDisplay.open')}</button>
          </div>
        </form>
        {refusal && (
          <p className="mt-3 text-sm text-red-700" role="alert" data-po-refused>
            {refusal.message}{refusal.remedy ? ` ${refusal.remedy}` : ''}
          </p>
        )}
        {missing && <p className="mt-3 text-sm text-red-700" role="alert" data-po-missing>{missing}</p>}
      </section>

      {opened && <OrderView order={opened} canChange={canChange} />}

      {search && (
        <section aria-labelledby="po-display-list" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="po-display-list" className="text-sm font-semibold">{search.recent ? t('poDisplay.recent') : t('poDisplay.matches')}</h2>
          {search.truncated && <p className="mt-1 text-xs text-ink-soft">{t('poDisplay.searchTruncated')}</p>}
          {search.rows.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft" data-po-empty>{t('poDisplay.empty')}</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <tbody>
                {search.rows.map((row) => (
                  <tr key={row.orderNumber} data-po-hit={row.orderNumber}>
                    <td className="py-1 pr-3">
                      <Link className="underline" href={`${PO_DISPLAY_ROUTE}?order=${encodeURIComponent(row.orderNumber)}`}>{row.orderNumber}</Link>
                    </td>
                    <td className="py-1 pr-3">{row.supplierNumber}{row.supplierName ? ` · ${row.supplierName}` : ''}</td>
                    <td className="py-1 pr-3">{row.documentDate}</td>
                    <td className="py-1 pr-3">{row.releaseStatus}</td>
                    <td className="py-1">{stateLabel(row.headerState)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
