import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/purchasing/invoice-verification';

/**
 * Invoice verification (SCR-062 / MIRO as a search alias only;
 * inert in stage 1, live since stage 3).
 */
export default async function InvoiceVerificationPage() {
  await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.INV.RECORD · MIRO</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('invoiceVerification.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('invoiceVerification.subtitle')}</p>
      </header>

      <section aria-labelledby="iv-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="iv-header" className="text-sm font-semibold">Invoice header</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Invoice category</span>
            <select className="input w-full" disabled defaultValue="INVOICE">
              <option value="INVOICE">Invoice</option>
              <option value="CREDIT_MEMO">Credit memo</option>
              <option value="SUBSEQUENT_DEBIT">Subsequent debit</option>
              <option value="SUBSEQUENT_CREDIT">Subsequent credit</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Purchase order</span>
            <input className="input w-full" disabled placeholder="Order number" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier reference</span>
            <input className="input w-full" disabled placeholder="Supplier invoice number" maxLength={16} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Gross amount</span>
            <input className="input w-full" disabled placeholder="0.00" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Invoice date</span>
            <input type="date" className="input w-full" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
            <input type="date" className="input w-full" disabled />
          </label>
        </div>
      </section>

      <section aria-labelledby="iv-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="iv-items" className="text-sm font-semibold">Items</h2>
        <p className="mt-2 text-sm text-ink-soft">
          No order loaded. The order&apos;s invoiceable items — ordered, received, already
          invoiced and remaining quantities beside their expected amounts — stand here
          from the next build step, with the balance shown before posting.
        </p>
        <div className="mt-3">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
            Post invoice
          </button>
        </div>
      </section>
    </div>
  );
}
