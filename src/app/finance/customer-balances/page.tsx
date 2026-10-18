import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CustomerBalanceError, getCustomerBalances, type CustomerBalanceView,
} from '@/modules/finance/customer-balances';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/customer-balances';
const fmt = (n: number) => n.toFixed(2);

/**
 * Customer balances (SCR-069 / FD10N as a search alias only).
 * Read-only: balances derive from the posted ledger at read time.
 */
export default async function CustomerBalancesPage({ searchParams }: {
  searchParams: Promise<{
    customer?: string; companyCode?: string; fiscalYear?: string; displayCurrency?: string;
    periodFrom?: string; periodTo?: string; specialPeriods?: string; period?: string;
  }>;
}) {
  const params = await searchParams;
  return <BalancesShell params={params} />;
}

async function BalancesShell({ params }: {
  params: {
    customer?: string; companyCode?: string; fiscalYear?: string; displayCurrency?: string;
    periodFrom?: string; periodTo?: string; specialPeriods?: string; period?: string;
  };
}) {
  const session = await requireSession(ROUTE);
  const year = new Date().getFullYear();
  let view: CustomerBalanceView | null = null;
  let loadError: string | null = null;
  if (params.customer && params.companyCode) {
    try {
      view = await getCustomerBalances(session.user.client, {
        customer: params.customer.toUpperCase(),
        companyCode: params.companyCode,
        fiscalYear: Number(params.fiscalYear ?? year),
        displayCurrency: params.displayCurrency || undefined,
        periodFrom: params.periodFrom ? Number(params.periodFrom) : undefined,
        periodTo: params.periodTo ? Number(params.periodTo) : undefined,
        specialPeriods: params.specialPeriods === 'on',
        selectedPeriod: params.period ? Number(params.period) : undefined,
      });
    } catch (error) {
      if (error instanceof CustomerBalanceError) loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      else throw error;
    }
  }

  const drillHref = (period: number) => {
    const q = new URLSearchParams({
      customer: params.customer ?? '', companyCode: params.companyCode ?? '',
      fiscalYear: params.fiscalYear ?? String(year), period: String(period),
    });
    if (params.displayCurrency) q.set('displayCurrency', params.displayCurrency);
    if (params.specialPeriods) q.set('specialPeriods', params.specialPeriods);
    return `${ROUTE}?${q.toString()}`;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
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
            <input name="customer" className="input w-full" placeholder="C10000" defaultValue={params.customer ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-full" placeholder="1000" defaultValue={params.companyCode ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Fiscal year</span>
            <input name="fiscalYear" className="input w-full" defaultValue={params.fiscalYear ?? String(year)} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Display currency</span>
            <input name="displayCurrency" className="input w-full" placeholder="Company currency" defaultValue={params.displayCurrency ?? ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Period from</span>
            <input name="periodFrom" className="input w-full" placeholder="1" defaultValue={params.periodFrom ?? ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Period to</span>
            <input name="periodTo" className="input w-full" placeholder="12" defaultValue={params.periodTo ?? ''} />
          </label>
          <label className="flex items-end gap-2 pb-1">
            <input type="checkbox" name="specialPeriods" defaultChecked={params.specialPeriods === 'on'} />
            <span className="text-sm">Include special periods</span>
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Display balances</button>
          </div>
        </form>
        {loadError && <p role="status" className="mt-2 text-sm text-red-700">{loadError}</p>}
        {view && (
          <p className="mt-2 text-sm">
            Customer <strong>{view.customer}</strong> in company <strong>{view.companyCode}</strong>,
            fiscal year {view.fiscalYear}, in {view.currency}: debit turnover {fmt(view.yearDebit)},
            credit turnover {fmt(view.yearCredit)}, closing balance {fmt(view.yearClosing)}.
          </p>
        )}
      </section>

      <section aria-labelledby="cb-matrix" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cb-matrix" className="text-sm font-semibold">Period balances</h2>
        {!view ? (
          <p className="mt-2 text-sm text-ink-soft">No balances stand loaded. Choose a customer, company and year.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Period</th><th className="px-2 py-2">Opening balance</th>
                  <th className="px-2 py-2">Debit turnover</th><th className="px-2 py-2">Credit turnover</th>
                  <th className="px-2 py-2">Closing balance</th><th className="px-2 py-2">Items</th>
                </tr>
              </thead>
              <tbody>
                {view.periods.map((row) => (
                  <tr key={row.period} className="border-t border-line">
                    <td className="px-2 py-2">
                      <Link href={drillHref(row.period)} className="underline">
                        {row.period}{row.special ? ' (special)' : ''}
                      </Link>
                    </td>
                    <td className="px-2 py-2">{fmt(row.opening)}</td>
                    <td className="px-2 py-2">{fmt(row.debitTurnover)}</td>
                    <td className="px-2 py-2">{fmt(row.creditTurnover)}</td>
                    <td className="px-2 py-2">{fmt(row.closing)}</td>
                    <td className="px-2 py-2">{row.itemCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="cb-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cb-items" className="text-sm font-semibold">Line items</h2>
        {!view || !view.selectedPeriod ? (
          <p className="mt-2 text-sm text-ink-soft">
            Choose a period in the matrix to see the customer line items behind it — document, date, amounts, and any
            clearing standing against them.
          </p>
        ) : view.items.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No line items stand behind period {view.selectedPeriod}.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Document</th><th className="px-2 py-2">Posting date</th>
                  <th className="px-2 py-2">Type</th><th className="px-2 py-2">D/C</th>
                  <th className="px-2 py-2">Document amount</th><th className="px-2 py-2">Local amount</th>
                  <th className="px-2 py-2">Cleared by</th><th className="px-2 py-2">Clearing date</th>
                </tr>
              </thead>
              <tbody>
                {view.items.map((item) => (
                  <tr key={`${item.documentNumber}-${item.lineNumber}`} className="border-t border-line">
                    <td className="px-2 py-2">{item.documentNumber}</td>
                    <td className="px-2 py-2">{item.postingDate}</td>
                    <td className="px-2 py-2">{item.documentType}</td>
                    <td className="px-2 py-2">{item.debitCredit}</td>
                    <td className="px-2 py-2">{item.documentAmount} {item.documentCurrency}</td>
                    <td className="px-2 py-2">{item.localAmount}</td>
                    <td className="px-2 py-2">{item.clearingDocument ?? '—'}</td>
                    <td className="px-2 py-2">{item.clearingDate ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
