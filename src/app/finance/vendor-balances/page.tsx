import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-balances';

/**
 * Vendor balances and due items (SCR-065 / FK10N as a search alias only).
 * Stage 1: the inert screen — selection, the period balance matrix and
 * the drill-down area, all rendered empty. Read-only by contract:
 * this screen posts nothing, clears nothing.
 */
export default async function VendorBalancesPage() {
  await requireSession(ROUTE);
  const year = new Date().getFullYear();

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.BALANCE · FK10N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorBalances.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorBalances.subtitle')}</p>
      </header>

      <section aria-labelledby="vb-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vb-selection" className="text-sm font-semibold">Selection</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier account</span>
            <input name="supplier" className="input w-full" placeholder="V10000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Fiscal year</span>
            <input name="fiscalYear" className="input w-full" defaultValue={year} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Display currency</span>
            <input name="displayCurrency" className="input w-full" placeholder="Company currency" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Period from</span>
            <input name="periodFrom" className="input w-full" placeholder="1" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Period to</span>
            <input name="periodTo" className="input w-full" placeholder="12" disabled />
          </label>
          <label className="flex items-end gap-2 pb-1">
            <input type="checkbox" name="specialPeriods" disabled />
            <span className="text-sm">Include special periods</span>
          </label>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Balances derive from the posted ledger at read time; closed periods remain reportable — period control
          governs posting, never reporting.
        </p>
      </section>

      <section aria-labelledby="vb-matrix" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vb-matrix" className="text-sm font-semibold">Period balances</h2>
        <p className="mt-2 text-sm text-ink-soft">No balances stand loaded. Choose a supplier, company and year.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="px-2 py-2">Period</th><th className="px-2 py-2">Opening balance</th>
                <th className="px-2 py-2">Debit turnover</th><th className="px-2 py-2">Credit turnover</th>
                <th className="px-2 py-2">Closing balance</th><th className="px-2 py-2">Items</th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
      </section>

      <section aria-labelledby="vb-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vb-items" className="text-sm font-semibold">Line items</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Choose a period in the matrix to see the vendor line items behind it — document, date, amounts, and any
          clearing standing against them.
        </p>
      </section>
    </div>
  );
}
