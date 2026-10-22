import Link from 'next/link';
import type { ReactNode } from 'react';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import {
  INVOICE_OVERVIEW_CAPABILITY,
  INVOICE_OVERVIEW_ROUTE,
  InvoiceOverviewError,
  listInvoiceOverview,
  readInvoiceOverviewDocument,
  type InvoiceOverviewDocument,
  type InvoiceOverviewResult,
  type InvoiceOverviewSelection,
} from '@/modules/purchasing/invoice-overview';

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

function selectionOf(params: Record<string, string | string[] | undefined>): InvoiceOverviewSelection {
  return {
    companyFrom: last(params.companyFrom).toUpperCase(),
    companyTo: last(params.companyTo).toUpperCase(),
    fiscalYear: last(params.fiscalYear),
    vendorFrom: last(params.vendorFrom).toUpperCase(),
    vendorTo: last(params.vendorTo).toUpperCase(),
    orderFrom: last(params.orderFrom).toUpperCase(),
    orderTo: last(params.orderTo).toUpperCase(),
    postingDateFrom: last(params.postingDateFrom),
    postingDateTo: last(params.postingDateTo),
    documentFrom: last(params.documentFrom).toUpperCase(),
    documentTo: last(params.documentTo).toUpperCase(),
    reference: last(params.reference),
    lifecycle: last(params.lifecycle).toUpperCase(),
    category: last(params.category).toUpperCase(),
    purchasingOrg: last(params.purchasingOrg).toUpperCase(),
    sort: last(params.sort),
    direction: last(params.direction),
    maxHits: Number(last(params.maxHits)) || undefined,
    draft: last(params.draft),
    paymentBlock: last(params.paymentBlock),
    reversed: last(params.reversed),
    layout: last(params.layout),
    export: last(params.export),
    withoutOrder: last(params.withoutOrder),
    companyAuthorization: last(params.companyAuthorization),
    purchasingAuthorization: last(params.purchasingAuthorization),
    exchangeRate: last(params.exchangeRate),
    post: last(params.post),
    release: last(params.release),
    clear: last(params.clear),
  };
}

function money(amount: string | null): string {
  return amount ?? '—';
}

/**
 * Invoice overview — SCR-161.
 *
 * One list of the logistics invoices that stand. The search alias stays in
 * the catalogue. This screen does not post, release, clear, or export.
 */
export default async function InvoiceOverviewPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(INVOICE_OVERVIEW_ROUTE);
  const params = await searchParams;
  const asked = last(params.companyFrom) !== '' || last(params.fiscalYear) !== '' || last(params.draft) !== '';
  const selection = selectionOf(params);
  const canList = can(session, INVOICE_OVERVIEW_CAPABILITY);
  let result: InvoiceOverviewResult | null = null;
  let detail: InvoiceOverviewDocument | null = null;
  let listError: string | null = null;
  if (canList && asked) {
    try {
      result = await listInvoiceOverview({ client: session.user.client, selection });
      const document = last(params.document).toUpperCase();
      if (document) detail = await readInvoiceOverviewDocument(session.user.client, document);
    } catch (error) {
      listError = error instanceof InvoiceOverviewError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The invoice list could not be read.';
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('invoiceOverview.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('invoiceOverview.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/parked-invoice" className="btn btn-default min-h-11 sm:min-h-8">{t('parkedInvoice.title')}</Link>
            <Link href="/purchasing/blocked-invoice" className="btn btn-default min-h-11 sm:min-h-8">{t('invoiceOverview.toBlocked')}</Link>
            <Link href="/purchasing/invoice-verification" className="btn btn-default min-h-11 sm:min-h-8">{t('invoiceOverview.toPost')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('invoiceOverview.subtitle')}</p>
      </header>

      {!canList && <p className="text-sm text-red-700" role="alert">{t('invoiceOverview.capabilityMissing')}</p>}

      <section aria-labelledby="invoice-overview-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="invoice-overview-selection" className="text-sm font-semibold">{t('invoiceOverview.selection')}</h2>
        <p className="mt-1 text-xs text-ink-soft" data-invoice-overview-no-post>{t('invoiceOverview.noPost')}</p>
        <form method="get" action={INVOICE_OVERVIEW_ROUTE} className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('invoiceOverview.companyFrom')}>
              <ConstrainedField kind="company" name="companyFrom" defaultValue={selection.companyFrom} />
            </Field>
            <Field label={t('invoiceOverview.companyTo')}>
              <ConstrainedField kind="company" name="companyTo" defaultValue={selection.companyTo} />
            </Field>
            <Field label={t('invoiceOverview.fiscalYear')}>
              <input name="fiscalYear" className="input w-full" maxLength={4} required defaultValue={selection.fiscalYear} inputMode="numeric" />
            </Field>
            <Field label={t('invoiceOverview.vendorFrom')}>
              <ConstrainedField kind="supplier-company" name="vendorFrom" uppercase context={{ companyCode: selection.companyFrom }} defaultValue={selection.vendorFrom} />
            </Field>
            <Field label={t('invoiceOverview.vendorTo')}>
              <ConstrainedField kind="supplier-company" name="vendorTo" uppercase context={{ companyCode: selection.companyTo || selection.companyFrom }} defaultValue={selection.vendorTo} />
            </Field>
            <Field label={t('invoiceOverview.orderFrom')}>
              <ConstrainedField kind="purchase-order" name="orderFrom" uppercase defaultValue={selection.orderFrom} />
            </Field>
            <Field label={t('invoiceOverview.orderTo')}>
              <ConstrainedField kind="purchase-order" name="orderTo" uppercase defaultValue={selection.orderTo} />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('invoiceOverview.postingFrom')}>
              <input type="date" name="postingDateFrom" className="input w-full" defaultValue={selection.postingDateFrom} />
            </Field>
            <Field label={t('invoiceOverview.postingTo')}>
              <input type="date" name="postingDateTo" className="input w-full" defaultValue={selection.postingDateTo} />
            </Field>
            <Field label={t('invoiceOverview.documentFrom')}>
              <ConstrainedField kind="supplier-invoice" name="documentFrom" uppercase defaultValue={selection.documentFrom} />
            </Field>
            <Field label={t('invoiceOverview.documentTo')}>
              <ConstrainedField kind="supplier-invoice" name="documentTo" uppercase defaultValue={selection.documentTo} />
            </Field>
            <Field label={t('invoiceOverview.reference')}>
              <input name="reference" className="input w-full" maxLength={16} defaultValue={selection.reference} />
            </Field>
            <Field label={t('invoiceOverview.purchasingOrg')}>
              <ConstrainedField kind="purchasing-org" name="purchasingOrg" defaultValue={selection.purchasingOrg} />
            </Field>
            <Field label={t('invoiceOverview.lifecycle')}>
              <select name="lifecycle" className="input w-full" defaultValue={selection.lifecycle ?? ''}>
                <option value="">{t('invoiceOverview.allLifecycles')}</option>
                <option value="PARKED">{t('invoiceOverview.parked')}</option>
                <option value="POSTED">{t('invoiceOverview.posted')}</option>
                <option value="CANCELLED">{t('invoiceOverview.cancelled')}</option>
              </select>
            </Field>
            <Field label={t('invoiceOverview.category')}>
              <select name="category" className="input w-full" defaultValue={selection.category ?? ''}>
                <option value="">{t('invoiceOverview.allCategories')}</option>
                <option value="INVOICE">{t('invoiceOverview.invoice')}</option>
                <option value="CREDIT_MEMO">{t('invoiceOverview.creditMemo')}</option>
                <option value="SUBSEQUENT_DEBIT">{t('invoiceOverview.subsequentDebit')}</option>
                <option value="SUBSEQUENT_CREDIT">{t('invoiceOverview.subsequentCredit')}</option>
              </select>
            </Field>
            <Field label={t('invoiceOverview.sort')}>
              <select name="sort" className="input w-full" defaultValue={selection.sort || 'postingDate'}>
                <option value="postingDate">{t('invoiceOverview.postingDate')}</option>
                <option value="documentNumber">{t('invoiceOverview.document')}</option>
                <option value="supplier">{t('invoiceOverview.vendor')}</option>
                <option value="documentDate">{t('invoiceOverview.documentDate')}</option>
                <option value="grossAmount">{t('invoiceOverview.gross')}</option>
              </select>
            </Field>
            <Field label={t('invoiceOverview.direction')}>
              <select name="direction" className="input w-full" defaultValue={selection.direction || 'desc'}>
                <option value="desc">{t('invoiceOverview.descending')}</option>
                <option value="asc">{t('invoiceOverview.ascending')}</option>
              </select>
            </Field>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" data-invoice-overview-run>{t('invoiceOverview.run')}</button>
          </div>
        </form>
      </section>

      {listError && <p role="alert" className="text-sm text-red-700" data-invoice-overview-error>{listError}</p>}

      {result && (
        <section aria-labelledby="invoice-overview-list" className="rounded-card border border-line bg-surface p-4 shadow-card" data-invoice-overview>
          <h2 id="invoice-overview-list" className="text-sm font-semibold">{t('invoiceOverview.list')}</h2>
          <p className="mt-1 text-xs text-ink-soft" data-invoice-overview-nothing-written>{t('invoiceOverview.nothingWritten')}</p>
          <p className="mt-1 text-xs text-ink-soft" data-invoice-overview-year>{t('invoiceOverview.yearNote')}</p>
          <p className="mt-1 text-xs text-ink-soft" data-invoice-overview-amount>{t('invoiceOverview.amountNote')}</p>
          {result.warnings.map((warning) => <p key={warning} className="mt-2 text-sm">{warning}</p>)}
          {result.rows.length === 0 && <p className="mt-3 text-sm" data-invoice-overview-empty>{t('invoiceOverview.empty')}</p>}
          {result.rows.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">{t('invoiceOverview.document')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.lifecycle')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.category')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.company')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.vendor')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.reference')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.order')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.documentDate')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.postingDate')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.gross')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.companyAmount')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.payment')}</th>
                    <th className="px-2 py-2">{t('invoiceOverview.journal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={`${row.lifecycle}-${row.documentNumber}`} className="border-t border-line" data-invoice-overview-row={row.documentNumber}>
                      <td className="px-2 py-2">
                        <Link href={`${INVOICE_OVERVIEW_ROUTE}?document=${encodeURIComponent(row.documentNumber)}&companyFrom=${encodeURIComponent(row.companyCode)}&fiscalYear=${row.fiscalYear}`} className="underline">
                          {row.documentNumber}
                        </Link>
                        <span className="text-ink-faint"> · {row.fiscalYear}</span>
                        {row.cancellationOf && <span className="block text-xs" data-cancellation-of={row.documentNumber}>{t('invoiceOverview.cancels', { number: row.cancellationOf })}</span>}
                        {row.cancelledBy && <span className="block text-xs" data-cancelled-by={row.documentNumber}>{t('invoiceOverview.cancelledBy', { number: row.cancelledBy })}</span>}
                      </td>
                      <td className="px-2 py-2" data-lifecycle={row.documentNumber}>{row.lifecycle}</td>
                      <td className="px-2 py-2">{row.category ?? '—'}</td>
                      <td className="px-2 py-2">{row.companyCode}</td>
                      <td className="px-2 py-2">{row.supplierNumber}{row.supplierName ? ` · ${row.supplierName}` : ''}</td>
                      <td className="px-2 py-2">{row.reference}</td>
                      <td className="px-2 py-2">{row.purchaseOrderNumber}{row.purchasingOrg ? ` · ${row.purchasingOrg}` : ''}</td>
                      <td className="px-2 py-2">{row.documentDate}</td>
                      <td className="px-2 py-2" data-posting-date={row.documentNumber}>{row.postingDate ?? '—'}</td>
                      <td className="px-2 py-2">{row.grossAmount} {row.currency}</td>
                      <td className="px-2 py-2" data-company-amount={row.documentNumber}>{money(row.companyCurrencyAmount)}{row.companyCurrency ? ` ${row.companyCurrency}` : ''}</td>
                      <td className="px-2 py-2" data-payment-state={row.documentNumber}>{row.paymentState}</td>
                      <td className="px-2 py-2" data-journal={row.documentNumber}>
                        {row.journalHref ? <Link href={row.journalHref} className="underline">{row.journalDocumentNumber}</Link> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.totals.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm" data-invoice-overview-totals>
              {result.totals.map((total) => (
                <li key={`${total.lifecycle}-${total.currency}`}>
                  {total.lifecycle} · {total.currency} · {total.count} · {total.grossAmount}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {detail && (
        <section aria-labelledby="invoice-overview-detail" className="rounded-card border border-line bg-surface p-4 shadow-card" data-invoice-overview-detail>
          <h2 id="invoice-overview-detail" className="text-sm font-semibold">{detail.row.documentNumber}</h2>
          <p className="mt-1 text-sm" data-invoice-overview-identity>
            {detail.row.lifecycle} · {detail.row.companyCode} · {detail.row.supplierNumber} · {detail.row.currency}
          </p>
          {detail.row.lifecycle === 'PARKED' && (
            <p className="mt-1 text-sm" data-invoice-overview-no-journal>{t('invoiceOverview.noJournal')}</p>
          )}
          {detail.row.lifecycle === 'PARKED' && (
            <p className="mt-1 text-sm">
              <Link href={`/purchasing/parked-invoice?parked=${encodeURIComponent(detail.row.documentNumber)}`} className="underline" data-invoice-overview-park>
                {t('invoiceOverview.openPark')}
              </Link>
            </p>
          )}
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-ink-soft">
                <th className="py-1 pr-3">{t('invoiceOverview.line')}</th>
                <th className="py-1 pr-3">{t('invoiceOverview.quantity')}</th>
                <th className="py-1 pr-3">{t('invoiceOverview.net')}</th>
                <th className="py-1">{t('invoiceOverview.tax')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((line) => (
                <tr key={line.lineNumber} data-invoice-overview-line={line.lineNumber}>
                  <td className="py-1 pr-3">{line.lineNumber}</td>
                  <td className="py-1 pr-3">{line.quantity}</td>
                  <td className="py-1 pr-3">{line.netAmount}</td>
                  <td className="py-1">{line.taxAmount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
