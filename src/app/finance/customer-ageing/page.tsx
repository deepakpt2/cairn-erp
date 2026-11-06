import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CustomerAgeingError, getCustomerAgeing, type CustomerAgeingView,
} from '@/modules/finance/customer-ageing';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-ageing';
const fmt = (n: number) => n.toFixed(2);

type Params = {
  companyCode?: string; customerFrom?: string; customerTo?: string; keyDate?: string;
  bucket1?: string; bucket2?: string; bucket3?: string; customer?: string;
};

/**
 * Customer ageing analysis (SCR-070 / S_ALR_87012178 as a search alias only).
 * Read-only: standing reconstructs as of the key date.
 */
export default async function CustomerAgeingPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  let view: CustomerAgeingView | null = null;
  let loadError: string | null = null;
  if (params.companyCode) {
    try {
      view = await getCustomerAgeing(session.user.client, {
        companyCode: params.companyCode,
        keyDate: params.keyDate || today,
        customerFrom: params.customerFrom?.toUpperCase() || undefined,
        customerTo: params.customerTo?.toUpperCase() || undefined,
        thresholds: [
          Number(params.bucket1 ?? 30), Number(params.bucket2 ?? 60), Number(params.bucket3 ?? 90),
        ],
      });
    } catch (error) {
      if (error instanceof CustomerAgeingError) loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      else throw error;
    }
  }

  const bucketLabel = (i: number) => {
    if (!view) return ['', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'][i];
    const [a, b, c] = view.thresholds;
    return ['Not yet due', `1–${a} days`, `${a + 1}–${b} days`, `${b + 1}–${c} days`, `Over ${c} days`][i];
  };
  const customerHref = (customer: string) => {
    const q = new URLSearchParams({
      companyCode: params.companyCode ?? '', keyDate: params.keyDate || today, customer,
    });
    if (params.customerFrom) q.set('customerFrom', params.customerFrom);
    if (params.customerTo) q.set('customerTo', params.customerTo);
    if (params.bucket1) q.set('bucket1', params.bucket1);
    if (params.bucket2) q.set('bucket2', params.bucket2);
    if (params.bucket3) q.set('bucket3', params.bucket3);
    return `${ROUTE}?${q.toString()}`;
  };
  const detailItems = view && params.customer
    ? view.items.filter((i) => i.customer === params.customer)
    : [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
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

      <section aria-labelledby="ca-selection" className="border border-line bg-surface p-4">
        <h2 id="ca-selection" className="text-sm font-semibold">Selection</h2>
        <form method="get" action={ROUTE} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" defaultValue={params.companyCode ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer from</span>
            <input name="customerFrom" className="input w-full" placeholder="C10000" defaultValue={params.customerFrom ?? ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer to</span>
            <input name="customerTo" className="input w-full" placeholder="C99999" defaultValue={params.customerTo ?? ''} />
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
            {' '}{fmt(view.grandTotal)} standing open across {view.customers.length} customers.
          </p>
        )}
      </section>

      <section aria-labelledby="ca-grid" className="border border-line bg-surface p-4">
        <h2 id="ca-grid" className="text-sm font-semibold">Ageing</h2>
        {!view ? (
          <p className="mt-2 text-sm text-ink-soft">No ageing stands loaded. Choose a company, customers and a key date.</p>
        ) : view.customers.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No items stand open as of the key date.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Customer</th>
                  {[0, 1, 2, 3, 4].map((i) => <th key={i}>{bucketLabel(i)}</th>)}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {view.customers.map((row) => (
                  <tr key={row.customer}>
                    <td>
                      <Link href={customerHref(row.customer)} className="underline">{row.customer}</Link>
                    </td>
                    {row.buckets.map((v, i) => <td key={i}>{fmt(v)}</td>)}
                    <td>{fmt(row.total)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td>Company total</td>
                  {view.totals.map((v, i) => <td key={i}>{fmt(v)}</td>)}
                  <td>{fmt(view.grandTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {view && params.customer && (
          <>
            <h3 className="mt-4 text-sm font-semibold">Items for {params.customer}</h3>
            {detailItems.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No items stand for this customer as of the key date.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="grid-table text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th>Document</th><th>Posting date</th>
                      <th>Due date</th><th>Days overdue</th>
                      <th>Bucket</th><th>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailItems.map((item) => (
                      <tr key={`${item.documentNumber}-${item.lineNumber}`}>
                        <td>{item.documentNumber}</td>
                        <td>{item.postingDate}</td>
                        <td>{item.dueDate}</td>
                        <td>{item.daysOverdue}</td>
                        <td>{bucketLabel(item.bucket)}</td>
                        <td>{fmt(item.signed)} {item.currency}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-sm text-ink-soft">
              Line-item detail with clearing standing stands on the{' '}
              <Link className="underline" href={`/finance/customer-balances?customer=${params.customer}&companyCode=${view.companyCode}&fiscalYear=${view.keyDate.slice(0, 4)}`}>
                customer balances
              </Link>{' '}
              screen.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
