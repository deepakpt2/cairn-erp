import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/clearing-reset';

/**
 * Reset cleared items (SCR-071 / FBRA as a search alias only).
 * Stage 1: the inert screen — clearing-document selection, the
 * review of what the document cleared, and the reset result,
 * all rendered empty.
 */
export default async function ClearingResetPage() {
  await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.CLEARING.RESET · FBRA</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('clearingReset.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('clearingReset.subtitle')}</p>
      </header>

      <section aria-labelledby="cr-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cr-selection" className="text-sm font-semibold">Clearing document</h2>
        <form method="get" action={ROUTE} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Clearing document</span>
            <input name="clearingDocument" className="input w-full" placeholder="1000/2026/1" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Fiscal year</span>
            <input name="fiscalYear" className="input w-full" placeholder="2026" disabled />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled>Display clearing</button>
          </div>
        </form>
      </section>

      <section aria-labelledby="cr-review" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cr-review" className="text-sm font-semibold">Cleared items</h2>
        <p className="mt-2 text-sm text-ink-soft">No clearing stands loaded. Choose a company, clearing document and year.</p>
      </section>

      <section aria-labelledby="cr-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cr-result" className="text-sm font-semibold">Reset</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Resetting lifts the clearing stamp from every item the document cleared; the items stand open again.
          No journal posts and no document changes — the reset itself stands on record with its reason.
        </p>
      </section>
    </div>
  );
}
