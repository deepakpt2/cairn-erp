import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-balances';

/**
 * Customer balances (SCR-069 / FD10N as a search alias only).
 * Stage 1: the inert screen — selection, the period-balance matrix,
 * and the line-item drill-down, all rendered empty.
 * Read-only by contract: balances will derive from the posted ledger
 * at read time; this screen never posts.
 */
export default async function CustomerBalancesPage() {
  await requireSession(ROUTE);
  const year = new Date().getFullYear();

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.BALANCE · FD10N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('customerBalances.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('customerBalances.subtitle')}</p>
      </header>

      <section aria-labelledby="cb-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cb-selection" className="text-sm font-semibold">Selection</h2>
        <form method="get" action={ROUTE} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer account</span>
            <input name="customer" className="input w-full" placeholder="C10000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Fiscal year</span>
            <input name="fiscalYear" className="input w-full" defaultValue={String(year)} disabled />
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
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled>Display balances</button>
          </div>
        </form>
      </section>

      <section aria-labelledby="cb-matrix" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cb-matrix" className="text-sm font-semibold">Period balances</h2>
        <p className="mt-2 text-sm text-ink-soft">No balances stand loaded. Choose a customer, company and year.</p>
      </section>

      <section aria-labelledby="cb-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cb-items" className="text-sm font-semibold">Line items</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Choose a period in the matrix to see the customer line items behind it — document, date, amounts, and any
          clearing standing against them.
        </p>
      </section>
    </div>
  );
}
