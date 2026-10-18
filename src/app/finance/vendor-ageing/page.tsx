import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  VendorAgeingError, getVendorAgeing, type VendorAgeingView,
} from '@/modules/finance/vendor-ageing';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-ageing';
const fmt = (n: number) => n.toFixed(2);

type Params = {
  companyCode?: string; supplierFrom?: string; supplierTo?: string; keyDate?: string;
  bucket1?: string; bucket2?: string; bucket3?: string; supplier?: string;
};

/**
 * Vendor ageing analysis (SCR-066 / S_ALR_87012085 as a search alias only).
 * Read-only: standing reconstructs as of the key date.
 */
export default async function VendorAgeingPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  let view: VendorAgeingView | null = null;
  let loadError: string | null = null;
  if (params.companyCode) {
    try {
      view = await getVendorAgeing(session.user.client, {
        companyCode: params.companyCode,
        keyDate: params.keyDate || today,
        supplierFrom: params.supplierFrom?.toUpperCase() || undefined,
        supplierTo: params.supplierTo?.toUpperCase() || undefined,
        thresholds: [
          Number(params.bucket1 ?? 30), Number(params.bucket2 ?? 60), Number(params.bucket3 ?? 90),
        ],
      });
    } catch (error) {
      if (error instanceof VendorAgeingError) loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      else throw error;
    }
  }

  const bucketLabel = (i: number) => {
    if (!view) return ['', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'][i];
    const [a, b, c] = view.thresholds;
    return ['Not yet due', `1–${a} days`, `${a + 1}–${b} days`, `${b + 1}–${c} days`, `Over ${c} days`][i];
  };
  const supplierHref = (supplier: string) => {
    const q = new URLSearchParams({
      companyCode: params.companyCode ?? '', keyDate: params.keyDate || today, supplier,
    });
    if (params.supplierFrom) q.set('supplierFrom', params.supplierFrom);
    if (params.supplierTo) q.set('supplierTo', params.supplierTo);
    if (params.bucket1) q.set('bucket1', params.bucket1);
    if (params.bucket2) q.set('bucket2', params.bucket2);
    if (params.bucket3) q.set('bucket3', params.bucket3);
    return `${ROUTE}?${q.toString()}`;
  };
  const detailItems = view && params.supplier
    ? view.items.filter((i) => i.supplier === params.supplier)
    : [];

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
        <form method="get" action={ROUTE} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" defaultValue={params.companyCode ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier from</span>
            <input name="supplierFrom" className="input w-full" placeholder="V10000" defaultValue={params.supplierFrom ?? ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier to</span>
            <input name="supplierTo" className="input w-full" placeholder="V99999" defaultValue={params.supplierTo ?? ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Key date</span>
            <input type="date" name="keyDate" className="input w-full" defaultValue={params.keyDate ?? today} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">First threshold (days)</span>
            <input name="bucket1" className="input w-full" defaultValue={params.bucket1 ?? '30'} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Second threshold (days)</span>
            <input name="bucket2" className="input w-full" defaultValue={params.bucket2 ?? '60'} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Third threshold (days)</span>
            <input name="bucket3" className="input w-full" defaultValue={params.bucket3 ?? '90'} />
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Age the open items</button>
          </div>
        </form>
        {loadError && <p role="status" className="mt-2 text-sm text-red-700">{loadError}</p>}
        {view && (
          <p className="mt-2 text-sm">
            Company <strong>{view.companyCode}</strong> as of <strong>{view.keyDate}</strong>, in {view.currency}:
            {' '}{fmt(view.grandTotal)} standing open across {view.suppliers.length} suppliers.
          </p>
        )}
      </section>

      <section aria-labelledby="va-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="va-grid" className="text-sm font-semibold">Ageing</h2>
        {!view ? (
          <p className="mt-2 text-sm text-ink-soft">No ageing stands loaded. Choose a company, suppliers and a key date.</p>
        ) : view.suppliers.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No items stand open as of the key date.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Supplier</th>
                  {[0, 1, 2, 3, 4].map((i) => <th key={i} className="px-2 py-2">{bucketLabel(i)}</th>)}
                  <th className="px-2 py-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {view.suppliers.map((row) => (
                  <tr key={row.supplier} className="border-t border-line">
                    <td className="px-2 py-2">
                      <Link href={supplierHref(row.supplier)} className="underline">{row.supplier}</Link>
                    </td>
                    {row.buckets.map((v, i) => <td key={i} className="px-2 py-2">{fmt(v)}</td>)}
                    <td className="px-2 py-2">{fmt(row.total)}</td>
                  </tr>
                ))}
                <tr className="border-t border-line font-semibold">
                  <td className="px-2 py-2">Company total</td>
                  {view.totals.map((v, i) => <td key={i} className="px-2 py-2">{fmt(v)}</td>)}
                  <td className="px-2 py-2">{fmt(view.grandTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {view && params.supplier && (
          <>
            <h3 className="mt-4 text-sm font-semibold">Items for {params.supplier}</h3>
            {detailItems.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No items stand for this supplier as of the key date.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Document</th><th className="px-2 py-2">Posting date</th>
                      <th className="px-2 py-2">Due date</th><th className="px-2 py-2">Days overdue</th>
                      <th className="px-2 py-2">Bucket</th><th className="px-2 py-2">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailItems.map((item) => (
                      <tr key={`${item.documentNumber}-${item.lineNumber}`} className="border-t border-line">
                        <td className="px-2 py-2">{item.documentNumber}</td>
                        <td className="px-2 py-2">{item.postingDate}</td>
                        <td className="px-2 py-2">{item.dueDate}</td>
                        <td className="px-2 py-2">{item.daysOverdue}</td>
                        <td className="px-2 py-2">{bucketLabel(item.bucket)}</td>
                        <td className="px-2 py-2">{fmt(item.signed)} {item.currency}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-sm text-ink-soft">
              Line-item detail with clearing standing stands on the{' '}
              <Link className="underline" href={`/finance/vendor-balances?supplier=${params.supplier}&companyCode=${view.companyCode}&fiscalYear=${view.keyDate.slice(0, 4)}`}>
                vendor balances
              </Link>{' '}
              screen.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
