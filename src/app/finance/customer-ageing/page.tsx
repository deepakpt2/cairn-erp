import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-ageing';

/**
 * Customer ageing analysis (SCR-070 / S_ALR_87012178 as a search alias only).
 * Stage 1: the inert screen — selection, the ageing matrix and the
 * item detail, all rendered empty.
 * Read-only by contract: standing will reconstruct as of the key date.
 */
export default async function CustomerAgeingPage() {
  await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.AGEING · S_ALR_87012178</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('customerAgeing.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('customerAgeing.subtitle')}</p>
      </header>

      <section aria-labelledby="ca-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ca-selection" className="text-sm font-semibold">Selection</h2>
        <form method="get" action={ROUTE} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer from</span>
            <input name="customerFrom" className="input w-full" placeholder="C10000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer to</span>
            <input name="customerTo" className="input w-full" placeholder="C99999" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Key date</span>
            <input type="date" name="keyDate" className="input w-full" defaultValue={today} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">First threshold (days)</span>
            <input name="bucket1" className="input w-full" defaultValue="30" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Second threshold (days)</span>
            <input name="bucket2" className="input w-full" defaultValue="60" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Third threshold (days)</span>
            <input name="bucket3" className="input w-full" defaultValue="90" disabled />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled>Age the open items</button>
          </div>
        </form>
      </section>

      <section aria-labelledby="ca-matrix" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ca-matrix" className="text-sm font-semibold">Ageing by customer</h2>
        <p className="mt-2 text-sm text-ink-soft">No items stand aged. Choose a company and a key date.</p>
      </section>

      <section aria-labelledby="ca-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ca-items" className="text-sm font-semibold">Line items</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Choose a customer in the matrix to see the open items behind its buckets — document, posting and due
          dates, days overdue and amount.
        </p>
      </section>
    </div>
  );
}
