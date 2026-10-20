import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { listBusinessPartners } from '@/modules/foundation/business-partners';
import { listCompanyCodes } from '@/modules/foundation/services';
import {
  VendorAgeingError, getVendorAgeing, type AgeingItem, type VendorAgeingView,
} from '@/modules/finance/vendor-ageing';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/vendor-ageing';
const fmt = (n: number) => n.toFixed(2);

type Params = {
  companyCode?: string; companyFrom?: string; companyTo?: string;
  supplierFrom?: string; supplierTo?: string; keyDate?: string;
  bucket1?: string; bucket2?: string; bucket3?: string;
  includeSpecialGl?: string; level?: string; sort?: string; supplier?: string;
};

const LEVELS = ['VENDOR', 'DOCUMENT', 'LINE'] as const;
const SORTS = ['VENDOR', 'DOCUMENT_DATE', 'POSTING_DATE', 'BASELINE_DATE', 'DUE_DATE', 'OVERDUE_DAYS'] as const;
type Level = (typeof LEVELS)[number];
type Sort = (typeof SORTS)[number];

const SORT_LABEL: Record<Sort, string> = {
  VENDOR: 'Vendor',
  DOCUMENT_DATE: 'Document date',
  POSTING_DATE: 'Posting date',
  BASELINE_DATE: 'Baseline date',
  DUE_DATE: 'Due date',
  OVERDUE_DAYS: 'Overdue days',
};

/**
 * Vendor ageing analysis (SCR-066, reworked SCR-120 / S_ALR_87012085 as
 * a search alias only). Read-only: standing reconstructs as of the
 * key date. Stage 1 renders the full selection and output shape over
 * the standing derivation; the repaired derivation (reconciliation-
 * account eligibility, canonical due dates, special G/L inclusion)
 * lands in stage 3.
 */
export default async function VendorAgeingPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const level: Level = LEVELS.includes(params.level as Level) ? (params.level as Level) : 'VENDOR';
  const sort: Sort = SORTS.includes(params.sort as Sort) ? (params.sort as Sort) : 'VENDOR';
  const keyDate = params.keyDate || today;

  const companies = await listCompanyCodes(session.user.client);
  const codes = companies.map((c) => c.companyCode).sort();
  let selected: string[] = [];
  if (params.companyCode) selected = [params.companyCode.toUpperCase()];
  else if (params.companyFrom || params.companyTo) {
    const from = (params.companyFrom ?? '').toUpperCase();
    const to = (params.companyTo ?? '').toUpperCase();
    selected = codes.filter((c) => (!from || c >= from) && (!to || c <= to));
  }

  const partners = await listBusinessPartners(session.user.client);
  const nameOf = new Map(partners.map((p) => [p.partnerNumber, p.name]));

  const views: VendorAgeingView[] = [];
  const errors: string[] = [];
  for (const companyCode of selected) {
    try {
      views.push(await getVendorAgeing(session.user.client, {
        companyCode,
        keyDate,
        supplierFrom: params.supplierFrom?.toUpperCase() || undefined,
        supplierTo: params.supplierTo?.toUpperCase() || undefined,
        thresholds: [
          Number(params.bucket1 ?? 30), Number(params.bucket2 ?? 60), Number(params.bucket3 ?? 90),
        ],
      }));
    } catch (error) {
      if (error instanceof VendorAgeingError) errors.push(error.remedy ? `${error.message} ${error.remedy}` : error.message);
      else throw error;
    }
  }

  const bucketLabel = (view: VendorAgeingView, i: number) => {
    const [a, b, c] = view.thresholds;
    return ['Not yet due', `1–${a} days`, `${a + 1}–${b} days`, `${b + 1}–${c} days`, `Over ${c} days`][i];
  };

  const drillHref = (view: VendorAgeingView, supplier: string) => {
    const q = new URLSearchParams({
      companyCode: view.companyCode, keyDate, supplier, level, sort,
    });
    if (params.supplierFrom) q.set('supplierFrom', params.supplierFrom);
    if (params.supplierTo) q.set('supplierTo', params.supplierTo);
    if (params.bucket1) q.set('bucket1', params.bucket1);
    if (params.bucket2) q.set('bucket2', params.bucket2);
    if (params.bucket3) q.set('bucket3', params.bucket3);
    if (params.includeSpecialGl) q.set('includeSpecialGl', params.includeSpecialGl);
    return `${ROUTE}?${q.toString()}`;
  };

  const itemSort = (items: AgeingItem[]): AgeingItem[] => {
    const by = {
      VENDOR: (a: AgeingItem, b: AgeingItem) => a.supplier.localeCompare(b.supplier) || a.dueDate.localeCompare(b.dueDate),
      DOCUMENT_DATE: (a: AgeingItem, b: AgeingItem) => a.postingDate.localeCompare(b.postingDate),
      POSTING_DATE: (a: AgeingItem, b: AgeingItem) => a.postingDate.localeCompare(b.postingDate),
      BASELINE_DATE: (a: AgeingItem, b: AgeingItem) => a.dueDate.localeCompare(b.dueDate),
      DUE_DATE: (a: AgeingItem, b: AgeingItem) => a.dueDate.localeCompare(b.dueDate),
      OVERDUE_DAYS: (a: AgeingItem, b: AgeingItem) => b.daysOverdue - a.daysOverdue,
    }[sort];
    return [...items].sort(by);
  };

  const itemRows = (view: VendorAgeingView, items: AgeingItem[]) => (
    <div className="mt-2 overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-ink-faint">
            <th className="px-2 py-2">Document</th><th className="px-2 py-2">Fiscal year</th>
            <th className="px-2 py-2">Line</th><th className="px-2 py-2">Posting date</th>
            <th className="px-2 py-2">Due date</th><th className="px-2 py-2">Days overdue</th>
            <th className="px-2 py-2">Bucket</th><th className="px-2 py-2">Remaining amount</th>
            <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Document display</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.documentNumber}-${item.fiscalYear}-${item.lineNumber}`} className="border-t border-line">
              <td className="px-2 py-2">{item.documentNumber}</td>
              <td className="px-2 py-2">{item.fiscalYear}</td>
              <td className="px-2 py-2">{item.lineNumber}</td>
              <td className="px-2 py-2">{item.postingDate}</td>
              <td className="px-2 py-2">{item.dueDate}</td>
              <td className="px-2 py-2">{item.daysOverdue}</td>
              <td className="px-2 py-2">{bucketLabel(view, item.bucket)}</td>
              <td className="px-2 py-2">{fmt(item.signed)}</td>
              <td className="px-2 py-2">{item.currency}</td>
              <td className="px-2 py-2">
                <Link className="underline" href={`/finance/journal/document?document=${encodeURIComponent(item.documentNumber)}&company=${view.companyCode}&year=${item.fiscalYear}`}>
                  Display
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
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
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code from</span>
            <input name="companyFrom" className="input w-full" placeholder="1000" defaultValue={params.companyFrom ?? params.companyCode ?? ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code to</span>
            <input name="companyTo" className="input w-full" placeholder="1000" defaultValue={params.companyTo ?? ''} />
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
            <input type="date" name="keyDate" className="input w-full" defaultValue={keyDate} required />
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
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Summarization level</span>
            <select name="level" className="input w-full" defaultValue={level}>
              <option value="VENDOR">Vendor totals</option>
              <option value="DOCUMENT">Document details</option>
              <option value="LINE">Line items</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Sort by</span>
            <select name="sort" className="input w-full" defaultValue={sort}>
              {SORTS.map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="flex items-end gap-2">
            <input type="checkbox" name="includeSpecialGl" defaultChecked={params.includeSpecialGl === 'on'} />
            <span className="text-sm">Include special G/L transactions</span>
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Age the open items</button>
          </div>
        </form>
        {errors.map((message) => (
          <p key={message} role="status" className="mt-2 text-sm text-red-700">{message}</p>
        ))}
        {views.map((view) => (
          <p key={view.companyCode} className="mt-2 text-sm">
            Company <strong>{view.companyCode}</strong> as of <strong>{view.keyDate}</strong>, in {view.currency}:
            {' '}{fmt(view.grandTotal)} standing open across {view.suppliers.length} suppliers.
          </p>
        ))}
        <p className="mt-2 text-sm text-ink-soft">
          A standing item&apos;s remaining amount is its full line amount: partial payments stand as
          their own open items and net inside the supplier total, and an item cleared after the key
          date still stands. A clearing reset erases the clearing stamps, so standing from before
          a reset cannot be reconstructed.
        </p>
      </section>

      {views.length === 0 && (
        <section aria-labelledby="va-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="va-grid" className="text-sm font-semibold">Ageing</h2>
          <p className="mt-2 text-sm text-ink-soft">No ageing stands loaded. Choose company codes, suppliers and a key date.</p>
        </section>
      )}

      {views.map((view) => {
        const drilled = params.supplier
          ? itemSort(view.items.filter((i) => i.supplier === params.supplier))
          : [];
        return (
          <section key={view.companyCode} aria-labelledby={`va-grid-${view.companyCode}`} className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 id={`va-grid-${view.companyCode}`} className="text-sm font-semibold">
              Ageing — company {view.companyCode} ({view.currency})
            </h2>
            {view.suppliers.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No items stand open as of the key date.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Supplier</th><th className="px-2 py-2">Name</th>
                      <th className="px-2 py-2">Items</th>
                      {[0, 1, 2, 3, 4].map((i) => <th key={i} className="px-2 py-2">{bucketLabel(view, i)}</th>)}
                      <th className="px-2 py-2">Total</th><th className="px-2 py-2">Currency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.suppliers.map((row) => (
                      <tr key={row.supplier} className="border-t border-line">
                        <td className="px-2 py-2">
                          <Link href={drillHref(view, row.supplier)} className="underline">{row.supplier}</Link>
                        </td>
                        <td className="px-2 py-2">{nameOf.get(row.supplier) ?? ''}</td>
                        <td className="px-2 py-2">{view.items.filter((i) => i.supplier === row.supplier).length}</td>
                        {row.buckets.map((v, i) => <td key={i} className="px-2 py-2">{fmt(v)}</td>)}
                        <td className="px-2 py-2">{fmt(row.total)}</td>
                        <td className="px-2 py-2">{view.currency}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-line font-semibold">
                      <td className="px-2 py-2" colSpan={3}>Company total</td>
                      {view.totals.map((v, i) => <td key={i} className="px-2 py-2">{fmt(v)}</td>)}
                      <td className="px-2 py-2">{fmt(view.grandTotal)}</td>
                      <td className="px-2 py-2">{view.currency}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {level === 'LINE' && itemRows(view, itemSort(view.items))}

            {level === 'DOCUMENT' && view.items.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Supplier</th><th className="px-2 py-2">Document</th>
                      <th className="px-2 py-2">Fiscal year</th><th className="px-2 py-2">Lines</th>
                      <th className="px-2 py-2">Due date</th><th className="px-2 py-2">Days overdue</th>
                      <th className="px-2 py-2">Remaining amount</th><th className="px-2 py-2">Currency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...new Map(view.items.map((i) => [`${i.supplier}|${i.documentNumber}|${i.fiscalYear}`, i])).values()].map((first) => {
                      const lines = view.items.filter((i) => i.supplier === first.supplier && i.documentNumber === first.documentNumber && i.fiscalYear === first.fiscalYear);
                      return (
                        <tr key={`${first.supplier}-${first.documentNumber}-${first.fiscalYear}`} className="border-t border-line">
                          <td className="px-2 py-2">{first.supplier}</td>
                          <td className="px-2 py-2">{first.documentNumber}</td>
                          <td className="px-2 py-2">{first.fiscalYear}</td>
                          <td className="px-2 py-2">{lines.length}</td>
                          <td className="px-2 py-2">{first.dueDate}</td>
                          <td className="px-2 py-2">{first.daysOverdue}</td>
                          <td className="px-2 py-2">{fmt(lines.reduce((s, i) => s + i.signed, 0))}</td>
                          <td className="px-2 py-2">{first.currency}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {params.supplier && (
              <>
                <h3 className="mt-4 text-sm font-semibold">Items for {params.supplier}</h3>
                {drilled.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-soft">No items stand for this supplier as of the key date.</p>
                ) : itemRows(view, drilled)}
                <p className="mt-2 text-sm text-ink-soft">
                  Vendor line items with clearing standing stand on the{' '}
                  <Link className="underline" href={`/finance/vendor-balances?supplier=${params.supplier}&companyCode=${view.companyCode}&fiscalYear=${keyDate.slice(0, 4)}`}>
                    vendor balances
                  </Link>{' '}
                  screen.
                </p>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
