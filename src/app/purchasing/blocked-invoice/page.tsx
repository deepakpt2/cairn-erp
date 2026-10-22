import Link from 'next/link';
import type { ReactNode } from 'react';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import {
  BLOCKED_INVOICE_CAPABILITY,
  BLOCKED_INVOICE_HOLD_CAPABILITY,
  BLOCKED_INVOICE_ROUTE,
  BlockedInvoiceError,
  listBlockEvents,
  listBlockedInvoices,
  type BlockedInvoiceRow,
  type BlockEventRow,
} from '@/modules/purchasing/blocked-invoice';

import { PlaceHoldForm, ReleaseHoldForm } from './BlockedInvoiceForms';

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

/**
 * Release blocked invoices — SCR-162.
 *
 * One manual hold on a posted supplier invoice. The payment run reads the
 * same hold. A release does not post, clear, or change the invoice amount.
 * The search alias stays in the catalogue.
 */
export default async function BlockedInvoicePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(BLOCKED_INVOICE_ROUTE);
  const params = await searchParams;
  const companyFrom = last(params.companyFrom).toUpperCase();
  const companyTo = last(params.companyTo).toUpperCase();
  const fiscalYear = last(params.fiscalYear);
  const supplier = last(params.supplier).toUpperCase();
  const orderNumber = last(params.orderNumber).toUpperCase();
  const reference = last(params.reference);
  const invoiceNumber = last(params.invoiceNumber).toUpperCase();
  const includeReleased = last(params.includeReleased) === '1';
  const notice = last(params.notice);
  const selection: Record<string, string> = {
    companyFrom, companyTo, fiscalYear, supplier, orderNumber, reference,
  };
  if (includeReleased) selection.includeReleased = '1';
  const asked = companyFrom !== '' || fiscalYear !== '';
  const canRelease = can(session, BLOCKED_INVOICE_CAPABILITY);
  const canPlace = can(session, BLOCKED_INVOICE_HOLD_CAPABILITY);
  let rows: BlockedInvoiceRow[] = [];
  let events: BlockEventRow[] = [];
  let listError: string | null = null;
  if (canRelease && asked) {
    try {
      rows = await listBlockedInvoices({
        client: session.user.client,
        companyFrom,
        companyTo,
        fiscalYear,
        supplier,
        orderNumber,
        reference,
        invoiceNumber,
        includeReleased,
      });
      if (invoiceNumber) events = await listBlockEvents(session.user.client, invoiceNumber);
    } catch (error) {
      listError = error instanceof BlockedInvoiceError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The blocked invoices could not be read.';
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('blockedInvoice.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('blockedInvoice.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/purchasing/invoice-overview" className="btn btn-default min-h-11 sm:min-h-8">{t('invoiceOverview.title')}</Link>
            <Link href="/finance/payment-run" className="btn btn-default min-h-11 sm:min-h-8">{t('blockedInvoice.paymentRun')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('blockedInvoice.subtitle')}</p>
        {notice && <p className="mt-3 text-sm" role="status" data-blocked-invoice-notice>{notice}</p>}
      </header>

      {!canRelease && <p className="text-sm text-red-700" role="alert">{t('blockedInvoice.capabilityMissing')}</p>}

      <section aria-labelledby="blocked-invoice-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="blocked-invoice-selection" className="text-sm font-semibold">{t('blockedInvoice.selection')}</h2>
        <p className="mt-1 text-xs text-ink-soft" data-blocked-invoice-no-post>{t('blockedInvoice.noPost')}</p>
        <form method="get" action={BLOCKED_INVOICE_ROUTE} className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('blockedInvoice.companyFrom')}>
              <ConstrainedField kind="company" name="companyFrom" defaultValue={companyFrom} />
            </Field>
            <Field label={t('blockedInvoice.companyTo')}>
              <ConstrainedField kind="company" name="companyTo" defaultValue={companyTo} />
            </Field>
            <Field label={t('blockedInvoice.fiscalYear')}>
              <input name="fiscalYear" className="input w-full" maxLength={4} required defaultValue={fiscalYear} inputMode="numeric" />
            </Field>
            <Field label={t('blockedInvoice.vendor')}>
              <ConstrainedField kind="supplier-company" name="supplier" uppercase context={{ companyCode: companyFrom }} defaultValue={supplier} />
            </Field>
            <Field label={t('blockedInvoice.order')}>
              <ConstrainedField kind="purchase-order" name="orderNumber" uppercase defaultValue={orderNumber} />
            </Field>
            <Field label={t('blockedInvoice.reference')}>
              <input name="reference" className="input w-full" defaultValue={reference} maxLength={40} />
            </Field>
            <Field label={t('blockedInvoice.invoice')}>
              <ConstrainedField kind="supplier-invoice" name="invoiceNumber" uppercase defaultValue={invoiceNumber} />
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="includeReleased" value="1" defaultChecked={includeReleased} />
              {t('blockedInvoice.includeReleased')}
            </label>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" data-blocked-invoice-list>{t('blockedInvoice.list')}</button>
          </div>
        </form>
        {listError && <p className="mt-3 text-sm text-red-700" role="alert" data-blocked-invoice-error>{listError}</p>}
      </section>

      {canPlace && (
        <section aria-labelledby="blocked-invoice-place" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="blocked-invoice-place" className="text-sm font-semibold">{t('blockedInvoice.place')}</h2>
          <p className="mt-1 text-xs text-ink-soft">{t('blockedInvoice.placeNote')}</p>
          <div className="mt-3">
            <PlaceHoldForm
              invoiceNumber={invoiceNumber}
              invoiceLabel={t('blockedInvoice.invoice')}
              commentLabel={t('blockedInvoice.comment')}
              checkLabel={t('blockedInvoice.check')}
              placeLabel={t('blockedInvoice.place')}
              selection={selection}
              checkingLabel={t('blockedInvoice.checking')}
              placingLabel={t('blockedInvoice.placing')}
            />
          </div>
        </section>
      )}

      <section aria-labelledby="blocked-invoice-list" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="blocked-invoice-list" className="text-sm font-semibold">{t('blockedInvoice.holds')}</h2>
        <p className="mt-1 text-xs text-ink-soft" data-blocked-invoice-manual-only>{t('blockedInvoice.manualOnly')}</p>
        {asked && !listError && rows.length === 0 && <p className="mt-3 text-sm text-ink-soft" data-blocked-invoice-empty>{t('blockedInvoice.empty')}</p>}
        {rows.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[64rem] text-left text-sm">
              <thead className="text-xs text-ink-soft">
                <tr>
                  <th className="py-2 pr-3">{t('blockedInvoice.invoice')}</th>
                  <th className="py-2 pr-3">{t('blockedInvoice.vendor')}</th>
                  <th className="py-2 pr-3">{t('blockedInvoice.reason')}</th>
                  <th className="py-2 pr-3">{t('blockedInvoice.source')}</th>
                  <th className="py-2 pr-3">{t('blockedInvoice.payment')}</th>
                  <th className="py-2 pr-3">{t('blockedInvoice.gross')}</th>
                  <th className="py-2 pr-3">{t('blockedInvoice.journal')}</th>
                  <th className="py-2">{t('blockedInvoice.release')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.invoiceNumber} className="border-t border-line align-top" data-blocked-invoice-row={row.invoiceNumber}>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{row.invoiceNumber}</div>
                      <div className="text-xs text-ink-soft">{row.companyCode} · {row.fiscalYear}</div>
                    </td>
                    <td className="py-2 pr-3">{row.supplierNumber}<div className="text-xs text-ink-soft">{row.supplierName}</div></td>
                    <td className="py-2 pr-3">
                      <div>{t('blockedInvoice.manual')}</div>
                      <div className="text-xs text-ink-soft">{row.active ? t('blockedInvoice.active') : t('blockedInvoice.released')} · {row.comment}</div>
                    </td>
                    <td className="py-2 pr-3">{row.createdBy}</td>
                    <td className="py-2 pr-3">{row.paymentState === 'OPEN' ? t('blockedInvoice.open') : row.paymentState === 'PAID' ? t('blockedInvoice.paid') : t('blockedInvoice.inProposal')}{row.proposalRun ? ` ${row.proposalRun}` : ''}</td>
                    <td className="py-2 pr-3">{row.grossAmount} {row.currency}</td>
                    <td className="py-2 pr-3" data-blocked-invoice-journal={row.invoiceNumber}>{row.journalDocumentNumber ?? '—'}</td>
                    <td className="py-2">
                      {row.active && row.paymentState === 'OPEN' && canRelease ? (
                        <ReleaseHoldForm
                          invoiceNumber={row.invoiceNumber}
                          version={row.version}
                          commentLabel={t('blockedInvoice.comment')}
                          checkLabel={t('blockedInvoice.check')}
                          releaseLabel={t('blockedInvoice.release')}
                          checkingLabel={t('blockedInvoice.checking')}
                          releasingLabel={t('blockedInvoice.releasing')}
                          selection={selection}
                        />
                      ) : (
                        <span className="text-xs text-ink-soft">{row.active ? t('blockedInvoice.notEligible') : t('blockedInvoice.released')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {events.length > 0 && (
        <section aria-labelledby="blocked-invoice-events" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="blocked-invoice-events" className="text-sm font-semibold" data-blocked-invoice-events>{t('blockedInvoice.events')}</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {events.map((event) => (
              <li key={event.eventId} className="border-t border-line pt-2">
                {event.action} · {event.outcome} · {event.actor} · {event.createdAt} · {event.comment}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
