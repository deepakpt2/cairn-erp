import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/payment-run';

/**
 * Payment run (SCR-063 / F110 as a search alias only; inert in
 * stage 1, live since stage 3).
 */
export default async function PaymentRunPage() {
  await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.PAYMENTRUN.EXECUTE · F110</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('paymentRun.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('paymentRun.subtitle')}</p>
      </header>

      <section aria-labelledby="pr-status" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="pr-status" className="text-sm font-semibold">Status</h2>
        <p className="mt-2 text-sm text-ink-soft">No payment run stands selected.</p>
      </section>

      <section aria-labelledby="pr-parameters" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="pr-parameters" className="text-sm font-semibold">Parameters</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Run date</span>
            <input type="date" className="input w-full" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Identification</span>
            <input className="input w-full" disabled maxLength={5} placeholder="APR01" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
            <input type="date" className="input w-full" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Documents entered up to</span>
            <input type="date" className="input w-full" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Next payment date</span>
            <input type="date" className="input w-full" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company codes</span>
            <input className="input w-full" disabled placeholder="1000" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Payment methods</span>
            <input className="input w-full" disabled placeholder="T" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier range</span>
            <input className="input w-full" disabled placeholder="V10000" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>Save parameters</button>
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" disabled>Create proposal</button>
        </div>
      </section>

      <section aria-labelledby="pr-proposal" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="pr-proposal" className="text-sm font-semibold">Proposal</h2>
        <p className="mt-2 text-sm text-ink-soft">
          The proposed payments and their exceptions stand here from the next build step.
        </p>
        <div className="mt-3">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
            Execute payments
          </button>
        </div>
      </section>
    </div>
  );
}
