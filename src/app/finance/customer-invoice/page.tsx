import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-invoice';

/**
 * Customer invoice posting, direct (SCR-067 / FB70 as a search alias only).
 * Stage 1: the inert screen — header, the revenue line grid with its
 * balance shown, and the document area, all rendered empty.
 */
export default async function CustomerInvoicePage() {
  await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.INVOICE.POST · FB70</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('customerInvoice.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('customerInvoice.subtitle')}</p>
      </header>

      <section aria-labelledby="ci-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ci-header" className="text-sm font-semibold">Header</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Load invoice</span>
            <input name="invoice" className="input w-full" placeholder="Invoice number" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer</span>
            <input name="customer" className="input w-full" placeholder="C10000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
            <input name="currency" className="input w-full" placeholder="USD" disabled />
          </label>
        </div>
      </section>

      <section aria-labelledby="ci-lines" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ci-lines" className="text-sm font-semibold">Invoice</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
            <input name="reference" className="input w-full" placeholder="INV-2026-001" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
            <input type="date" name="documentDate" className="input w-full" defaultValue={today} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
            <input type="date" name="postingDate" className="input w-full" defaultValue={today} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Payment terms</span>
            <input name="paymentTerms" className="input w-full" placeholder="From customer" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Gross amount (tax included)</span>
            <input name="grossAmount" className="input w-full" placeholder="0.00" disabled />
          </label>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="px-2 py-2">G/L account</th><th className="px-2 py-2">Net amount (tax excluded)</th>
                <th className="px-2 py-2">Tax code</th><th className="px-2 py-2">Profit centre</th>
                <th className="px-2 py-2">Text</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-line">
                <td className="px-2 py-2"><input className="input w-full" placeholder="800000" disabled /></td>
                <td className="px-2 py-2"><input className="input w-full" placeholder="0.00" disabled /></td>
                <td className="px-2 py-2"><input className="input w-full" disabled /></td>
                <td className="px-2 py-2"><input className="input w-full" disabled /></td>
                <td className="px-2 py-2"><input className="input w-full" disabled /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-sm text-ink-soft">Balance: lines net 0.00 + tax 0.00 = 0.00.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>Post invoice</button>
        </div>
      </section>

      <section aria-labelledby="ci-document" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ci-document" className="text-sm font-semibold">Posted document</h2>
        <p className="mt-2 text-sm text-ink-soft">
          No invoice stands loaded. A posted invoice is immutable: correct it by credit memo or reversal, never by deletion.
        </p>
      </section>
    </div>
  );
}
