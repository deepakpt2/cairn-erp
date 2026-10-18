import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/incoming-payment';

/**
 * Incoming payment entry and allocation (SCR-068 / F-28 as a search alias only).
 * Stage 1: the inert screen — header and bank data, the open-item
 * allocation list with its live difference, and the result area,
 * all rendered empty.
 */
export default async function IncomingPaymentPage() {
  await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AR.PAYMENT.ENTER · F-28</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('incomingPayment.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('incomingPayment.subtitle')}</p>
      </header>

      <section aria-labelledby="ip-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ip-header" className="text-sm font-semibold">Header and bank data</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer</span>
            <input name="customer" className="input w-full" placeholder="C10000" disabled />
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
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Clearing date</span>
            <input type="date" name="clearingDate" className="input w-full" defaultValue={today} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Bank / cash G/L account</span>
            <input name="bankAccount" className="input w-full" placeholder="101000" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Incoming amount</span>
            <input name="amount" className="input w-full" placeholder="0.00" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
            <input name="currency" className="input w-full" placeholder="USD" disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
            <input name="reference" className="input w-full" placeholder="BANK-REF-001" disabled />
          </label>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          The posting date selects the accounting period; the document date never does. The clearing date stamps
          the cleared items and stands as its own date.
        </p>
      </section>

      <section aria-labelledby="ip-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ip-items" className="text-sm font-semibold">Open items</h2>
        <p className="mt-2 text-sm text-ink-soft">
          No open items stand loaded. The customer's uncleared receivable items stand here for allocation.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="px-2 py-2">Select</th><th className="px-2 py-2">Document</th>
                <th className="px-2 py-2">Posting date</th><th className="px-2 py-2">Due date</th>
                <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Outstanding</th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Allocated 0.00 · difference 0.00. The allocation must equal the incoming amount before posting — a
          difference is never silently resolved.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>Post payment</button>
        </div>
      </section>

      <section aria-labelledby="ip-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ip-result" className="text-sm font-semibold">Payment</h2>
        <p className="mt-2 text-sm text-ink-soft">
          No payment stands posted in this session. A posted payment and its clearing are history: never edited,
          never deleted.
        </p>
      </section>
    </div>
  );
}
