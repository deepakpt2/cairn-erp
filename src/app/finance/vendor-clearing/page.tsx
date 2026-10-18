import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-clearing';

/**
 * Vendor open-item clearing (SCR-064 / F-44 as a search alias only).
 * Stage 1: the inert screen — selection, the open-item grid with its
 * live difference, the three dates, and the cleared history, all
 * rendered empty. Nothing reads, nothing writes.
 */
export default async function VendorClearingPage() {
  await requireSession(ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.AP.CLEAR · F-44</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorClearing.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorClearing.subtitle')}</p>
      </header>

      <section aria-labelledby="vc-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vc-selection" className="text-sm font-semibold">Selection</h2>
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
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Clearing date</span>
            <input type="date" name="clearingDate" className="input w-full" defaultValue={today} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
            <input type="date" name="postingDate" className="input w-full" defaultValue={today} disabled />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
            <input type="date" name="documentDate" className="input w-full" defaultValue={today} disabled />
          </label>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          The clearing date stamps the cleared items; the posting date drives the clearing journal and its
          financial period; the document date is recorded on the clearing document. They are three distinct dates.
        </p>
      </section>

      <section aria-labelledby="vc-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vc-items" className="text-sm font-semibold">Open items</h2>
        <p className="mt-2 text-sm text-ink-soft">
          No open items stand loaded. Invoices, credit memos and payments for the supplier stand here together,
          debit and credit, until they are cleared.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="px-2 py-2">Select</th><th className="px-2 py-2">Document</th>
                <th className="px-2 py-2">Posting date</th><th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Amount</th>
                <th className="px-2 py-2">Signed</th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <p className="mt-2 text-sm text-ink-soft">Assigned 0.00 · difference 0.00. The difference must stand at zero before posting.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>Post clearing</button>
        </div>
      </section>

      <section aria-labelledby="vc-history" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vc-history" className="text-sm font-semibold">Cleared history</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Nothing stands cleared for this selection yet. A posted clearing is history: it is preserved, never edited or deleted.
        </p>
      </section>
    </div>
  );
}
