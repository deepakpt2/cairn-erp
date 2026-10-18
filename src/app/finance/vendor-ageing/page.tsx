import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-ageing';

/**
 * Vendor ageing analysis (SCR-066 / S_ALR_87012085 as a search alias only).
 * Stage 1: the inert screen — selection and the ageing grid, rendered
 * empty. Read-only by contract: this screen posts nothing.
 */
export default async function VendorAgeingPage() {
  await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.AGEING · S_ALR_87012085</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorAgeing.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorAgeing.subtitle')}</p>
      </header>

      <section aria-labelledby="va-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="va-selection" className="text-sm font-semibold">Selection</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier from</span>
            <input name="supplierFrom" className="input w-full" placeholder="V10000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier to</span>
            <input name="supplierTo" className="input w-full" placeholder="V99999" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Key date</span>
            <input type="date" name="keyDate" className="input w-full" defaultValue={today} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">First threshold (days)</span>
            <input name="bucket1" className="input w-full" defaultValue={30} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Second threshold (days)</span>
            <input name="bucket2" className="input w-full" defaultValue={60} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Third threshold (days)</span>
            <input name="bucket3" className="input w-full" defaultValue={90} disabled />
          </label>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Standing is reconstructed as of the key date: an item stands when it posted on or before that date and
          was not cleared on or before it. Ageing runs on the due date; items not yet due stand apart from the
          overdue buckets.
        </p>
      </section>

      <section aria-labelledby="va-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="va-grid" className="text-sm font-semibold">Ageing</h2>
        <p className="mt-2 text-sm text-ink-soft">No ageing stands loaded. Choose a company, suppliers and a key date.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="px-2 py-2">Supplier</th><th className="px-2 py-2">Not yet due</th>
                <th className="px-2 py-2">1–30 days</th><th className="px-2 py-2">31–60 days</th>
                <th className="px-2 py-2">61–90 days</th><th className="px-2 py-2">Over 90 days</th>
                <th className="px-2 py-2">Total</th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Amounts stand in company-code currency. Choose a supplier to see the items behind its buckets.
        </p>
      </section>
    </div>
  );
}
