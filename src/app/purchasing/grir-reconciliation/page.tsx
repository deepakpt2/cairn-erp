import Link from 'next/link';
import type { ReactNode } from 'react';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import {
  GRIR_CLEARING_ROUTE,
  GrIrClearingError,
} from '@/modules/purchasing/grir-clearing';
import {
  GRIR_RECONCILIATION_CAPABILITY,
  GRIR_RECONCILIATION_ROUTE,
  listGrIrExceptions,
  type GrIrExceptionCategory,
  type GrIrExceptionRow,
} from '@/modules/purchasing/grir-reconciliation';

export const dynamic = 'force-dynamic';

const CATEGORIES: GrIrExceptionCategory[] = [
  'COMPLETED_WITH_RESIDUAL',
  'INVOICE_BEFORE_GR',
  'VALUE_VARIANCE',
  'EXPECTED_OUTSTANDING',
  'UNRESOLVED',
];

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

function yes(value: boolean, label: string): string {
  return value ? label : '—';
}

/**
 * Reconcile GR/IR — the exception worklist.
 *
 * The list is a reading of what was posted, and it writes nothing. A row is
 * not an instruction to clear: it is the reason a balance still stands, and
 * the documents that made it, so the person who owns the order can decide
 * what to do about it. Where the balance has to be cleared, the clearing
 * screen is the place that posts — with its own authorization, its own
 * reason and its own reversal.
 */
export default async function GrIrReconciliationPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(GRIR_RECONCILIATION_ROUTE);
  const params = await searchParams;
  const companyFrom = last(params.companyFrom).toUpperCase();
  const companyTo = last(params.companyTo).toUpperCase();
  const orderFrom = last(params.orderFrom).toUpperCase();
  const orderTo = last(params.orderTo).toUpperCase();
  const itemNumber = last(params.itemNumber);
  const plantFrom = last(params.plantFrom).toUpperCase();
  const plantTo = last(params.plantTo).toUpperCase();
  const keyDate = last(params.keyDate);
  const category = last(params.category).toUpperCase() as GrIrExceptionCategory | '';
  const canView = can(session, GRIR_RECONCILIATION_CAPABILITY);

  let rows: GrIrExceptionRow[] = [];
  let totals = { rows: 0, balance: 0, byCategory: {} as Record<GrIrExceptionCategory, number> };
  let listError: string | null = null;
  if (canView && companyFrom && keyDate) {
    try {
      const result = await listGrIrExceptions({
        client: session.user.client,
        companyFrom, companyTo, orderFrom, orderTo, itemNumber, plantFrom, plantTo, keyDate,
        ...(category ? { categories: [category] } : {}),
      });
      rows = result.rows;
      totals = result.totals;
    } catch (error) {
      listError = error instanceof GrIrClearingError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The GR/IR balances could not be read.';
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('grirReconciliation.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('grirReconciliation.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href={`${GRIR_CLEARING_ROUTE}?companyFrom=${encodeURIComponent(companyFrom)}&keyDate=${encodeURIComponent(keyDate)}`} className="btn btn-default min-h-11 sm:min-h-8">{t('grirClearing.title')}</Link>
            <Link href="/purchasing/invoice-overview" className="btn btn-default min-h-11 sm:min-h-8">{t('invoiceOverview.title')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('grirReconciliation.subtitle')}</p>
      </header>

      {!canView && <p className="text-sm text-red-700" role="alert">{t('grirReconciliation.capabilityMissing')}</p>}

      <section aria-labelledby="grir-recon-selection" className="border border-line bg-surface p-4">
        <h2 id="grir-recon-selection" className="text-sm font-semibold">{t('grirReconciliation.selection')}</h2>
        <p className="mt-1 text-xs text-ink-soft" data-grir-recon-writes-nothing>{t('grirReconciliation.writesNothing')}</p>
        <form method="get" action={GRIR_RECONCILIATION_ROUTE} className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('grirReconciliation.companyFrom')}>
              <ConstrainedField kind="company" name="companyFrom" defaultValue={companyFrom} />
            </Field>
            <Field label={t('grirReconciliation.companyTo')}>
              <ConstrainedField kind="company" name="companyTo" defaultValue={companyTo} />
            </Field>
            <Field label={t('grirReconciliation.orderFrom')}>
              <ConstrainedField kind="purchase-order" name="orderFrom" uppercase defaultValue={orderFrom} />
            </Field>
            <Field label={t('grirReconciliation.orderTo')}>
              <ConstrainedField kind="purchase-order" name="orderTo" uppercase defaultValue={orderTo} />
            </Field>
            <Field label={t('grirReconciliation.item')}>
              <input name="itemNumber" className="input w-full" defaultValue={itemNumber} maxLength={5} inputMode="numeric" />
            </Field>
            <Field label={t('grirReconciliation.plantFrom')}>
              <ConstrainedField kind="plant" name="plantFrom" defaultValue={plantFrom} />
            </Field>
            <Field label={t('grirReconciliation.plantTo')}>
              <ConstrainedField kind="plant" name="plantTo" defaultValue={plantTo} />
            </Field>
            <Field label={t('grirReconciliation.keyDate')}>
              <input name="keyDate" type="date" className="input w-full" required defaultValue={keyDate} />
            </Field>
            <Field label={t('grirReconciliation.category')}>
              <select name="category" className="input w-full" defaultValue={category}>
                <option value="">{t('grirReconciliation.all')}</option>
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>{t(`grirReconciliation.category.${value}`)}</option>
                ))}
              </select>
            </Field>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" data-grir-recon-list>{t('grirReconciliation.list')}</button>
          </div>
        </form>
        {listError && <p className="mt-3 text-sm text-red-700" role="alert" data-grir-recon-error>{listError}</p>}
      </section>

      <section aria-labelledby="grir-recon-exceptions" className="border border-line bg-surface p-4">
        <h2 id="grir-recon-exceptions" className="text-sm font-semibold">{t('grirReconciliation.exceptions')}</h2>
        {companyFrom && keyDate && (
          <p className="mt-1 text-xs text-ink-soft" data-grir-recon-totals>
            {totals.rows} {t('grirReconciliation.totalRows')} · {totals.balance.toFixed(2)} {t('grirReconciliation.totalBalance')}
            {Object.entries(totals.byCategory).filter(([, n]) => n > 0).map(([name, n]) => (
              <span key={name}> · {n} {t(`grirReconciliation.category.${name}`)}</span>
            ))}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft" data-grir-recon-empty>{t('grirReconciliation.empty')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-sm">
              <thead>
                <tr className="text-left text-ink-soft">
                  <th>{t('grirReconciliation.order')}</th>
                  <th>{t('grirReconciliation.material')}</th>
                  <th>{t('grirReconciliation.quantities')}</th>
                  <th>{t('grirReconciliation.outstanding')}</th>
                  <th>{t('grirReconciliation.completion')}</th>
                  <th>{t('grirReconciliation.balance')}</th>
                  <th>{t('grirReconciliation.standing')}</th>
                  <th>{t('grirReconciliation.documents')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.orderNumber}-${row.itemNumber}`} className="align-top" data-grir-recon-row={row.orderNumber} data-grir-recon-item={row.itemNumber} data-grir-recon-category={row.category}>
                    <td>
                      <Link className="underline" href={`/purchasing/purchase-order-display?order=${encodeURIComponent(row.orderNumber)}`}>{row.orderNumber}</Link>
                      {' / '}{row.itemNumber}
                      <div className="text-ink-soft">
                        {row.companyCode} · {row.plant} · {row.supplier}
                      </div>
                    </td>
                    <td>
                      {row.materialNumber ?? '—'}
                      <div className="text-ink-soft">{row.shortText}</div>
                    </td>
                    <td>
                      {row.orderedQuantity} / {row.receivedQuantity} / {row.invoicedQuantity} {row.unit}
                    </td>
                    <td>
                      {row.outstandingGrQuantity} {row.unit} / {row.outstandingInvoiceQuantity} {row.unit}
                      <div className="text-ink-soft">
                        {row.invoiceBasis === 'GOODS_RECEIPT'
                          ? t('grirReconciliation.basisGoodsReceipt')
                          : t('grirReconciliation.basisOrdered')}
                      </div>
                    </td>
                    <td>
                      {yes(row.deliveryCompleted, t('grirReconciliation.deliveryCompleted'))}
                      {' / '}
                      {yes(row.finalInvoiceIndicator, t('grirReconciliation.finalInvoice'))}
                    </td>
                    <td>
                      {row.grIrBalance.toFixed(2)} {row.currency}
                      {row.clearedToDate !== 0 && (
                        <div className="text-ink-soft">
                          {row.postedBalance.toFixed(2)} posted · {row.clearedToDate.toFixed(2)} cleared
                        </div>
                      )}
                      <div className="text-ink-soft">{row.grIrAccount ?? '—'}</div>
                    </td>
                    <td>
                      <span data-grir-recon-reason-category>{t(`grirReconciliation.category.${row.category}`)}</span>
                      <div className="text-ink-soft" data-grir-recon-reason>{row.reason}</div>
                      {row.refusal && <div className="text-red-700" data-grir-recon-refusal>{row.refusal}</div>}
                    </td>
                    <td>
                      <div className="flex flex-col gap-1 text-xs">
                        {row.documents.goodsReceipts.length === 0
                          ? <span className="text-ink-soft">no goods receipt</span>
                          : row.documents.goodsReceipts.map((document) => (
                            <Link key={document} className="underline" href={`/inventory/material-document-list?purchaseOrderFrom=${encodeURIComponent(row.orderNumber)}&purchaseOrderTo=${encodeURIComponent(row.orderNumber)}&postingDateFrom=2000-01-01&postingDateTo=${encodeURIComponent(keyDate)}`}>{document}</Link>
                          ))}
                        {row.documents.invoices.map((invoiceNumber) => (
                          <Link key={invoiceNumber} className="underline" href={`/purchasing/invoice-verification?invoice=${encodeURIComponent(invoiceNumber)}`}>{invoiceNumber}</Link>
                        ))}
                        {row.documents.clearings.map((documentNumber) => (
                          <Link key={documentNumber} className="underline" href={`/finance/journal/document?document=${encodeURIComponent(documentNumber)}&company=${encodeURIComponent(row.companyCode)}&year=${keyDate.slice(0, 4)}`}>{documentNumber}</Link>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
