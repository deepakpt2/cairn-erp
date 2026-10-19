import Link from 'next/link';

import type { JournalItemsResult } from '@/modules/finance/journal-items';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

export default function ItemsForm({ result, error, canList }: {
  result: JournalItemsResult | null;
  error: string | null;
  canList: boolean;
}) {
  return (
    <>
      <section aria-labelledby="ji-select" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ji-select" className="text-sm font-semibold">Selection</h2>
        <form method="get" className="mt-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className={labelCls}>G/L account from</span>
              <input name="accountFrom" className={inputCls} placeholder="400000" required />
            </label>
            <label className="block">
              <span className={labelCls}>G/L account to</span>
              <input name="accountTo" className={inputCls} placeholder="499999" />
            </label>
            <label className="block">
              <span className={labelCls}>Company codes</span>
              <input name="companyCodes" className={inputCls} placeholder="1000" required />
            </label>
            <label className="block">
              <span className={labelCls}>Fiscal year</span>
              <input name="fiscalYear" className={inputCls} placeholder="2026" />
            </label>
            <label className="block">
              <span className={labelCls}>Posting date from</span>
              <input type="date" name="postingDateFrom" className={inputCls} />
            </label>
            <label className="block">
              <span className={labelCls}>Posting date to</span>
              <input type="date" name="postingDateTo" className={inputCls} />
            </label>
            <label className="block">
              <span className={labelCls}>Document number</span>
              <input name="documentNumber" className={inputCls} placeholder="JE-000001" />
            </label>
            <label className="block">
              <span className={labelCls}>Document type</span>
              <input name="documentType" className={inputCls} placeholder="SA" />
            </label>
            <label className="block">
              <span className={labelCls}>Cost centre</span>
              <input name="costCenter" className={inputCls} />
            </label>
            <label className="block">
              <span className={labelCls}>Profit centre</span>
              <input name="profitCenter" className={inputCls} />
            </label>
            <label className="block">
              <span className={labelCls}>Reference contains</span>
              <input name="reference" className={inputCls} />
            </label>
            <label className="block">
              <span className={labelCls}>Maximum hits</span>
              <input name="maxHits" className={inputCls} placeholder="5000" />
            </label>
            <label className="block">
              <span className={labelCls}>Page</span>
              <input name="page" type="number" min={1} className={inputCls} placeholder="1" />
            </label>
            <label className="block">
              <span className={labelCls}>Page size</span>
              <input name="pageSize" type="number" min={1} className={inputCls} placeholder="100" />
            </label>
          </div>
          <fieldset className="mt-3">
            <legend className="text-xs font-medium uppercase tracking-wide text-ink-faint">Line item status</legend>
            <div className="mt-1 flex gap-4 text-sm">
              <label className="flex items-center gap-1"><input type="radio" name="status" value="ALL" defaultChecked /> All items</label>
              <label className="flex items-center gap-1"><input type="radio" name="status" value="OPEN" /> Open</label>
              <label className="flex items-center gap-1"><input type="radio" name="status" value="CLEARED" /> Cleared</label>
            </div>
            <p className="mt-1 text-sm text-ink-soft">
              Open and cleared judge only accounts standing open-item-managed; other accounts
              carry no status and fall away under those two choices.
            </p>
          </fieldset>
          <button type="submit" className="btn btn-primary mt-3 min-h-11 sm:min-h-8" disabled={!canList}>
            Execute
          </button>
          {!canList && (
            <p className="mt-2 text-sm text-ink-soft">You do not hold the line-item report capability.</p>
          )}
        </form>
      </section>

      <section aria-labelledby="ji-results" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ji-results" className="text-sm font-semibold">Line items</h2>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>
        ) : !result ? (
          <p className="mt-2 text-sm text-ink-soft">Enter a selection and execute to read the posted lines.</p>
        ) : result.rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No line items match this selection.</p>
        ) : (
          <>
            {result.truncated && (
              <p className="mt-2 text-sm text-red-700">
                The result exceeds the {result.cap} hit limit and stands truncated — narrow the selection.
              </p>
            )}
            <p className="mt-2 text-sm text-ink-soft">
              Page {result.page} · showing {result.rows.length} of {result.total} line items · page size {result.pageSize}.
              {' '}
              <a className="text-accent hover:underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(result.rows))}`} download="line-items.csv">
                Export CSV
              </a>
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">Company</th><th className="px-2 py-2">Document</th>
                    <th className="px-2 py-2">Line</th><th className="px-2 py-2">Posting date</th>
                    <th className="px-2 py-2">Document date</th>
                    <th className="px-2 py-2">Type</th><th className="px-2 py-2">Account</th>
                    <th className="px-2 py-2">D/C</th><th className="px-2 py-2">Amount</th>
                    <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Local amount</th>
                    <th className="px-2 py-2">Cost centre</th><th className="px-2 py-2">Profit centre</th>
                    <th className="px-2 py-2">Status</th><th className="px-2 py-2">Clearing</th>
                    <th className="px-2 py-2">Assignment</th><th className="px-2 py-2">Reference</th>
                    <th className="px-2 py-2">Text</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={`${row.documentNumber}-${row.fiscalYear}-${row.lineNumber}`} className="border-t border-line">
                      <td className="px-2 py-2">{row.companyCode}</td>
                      <td className="px-2 py-2">
                        <Link className="text-accent hover:underline"
                          href={`/finance/journal/document?document=${encodeURIComponent(row.documentNumber)}&company=${row.companyCode}&year=${row.fiscalYear}`}>
                          {row.documentNumber}
                        </Link>
                      </td>
                      <td className="px-2 py-2">{row.lineNumber}</td>
                      <td className="px-2 py-2">{row.postingDate}</td>
                      <td className="px-2 py-2">{row.documentDate}</td>
                      <td className="px-2 py-2">{row.documentType}</td>
                      <td className="px-2 py-2">{row.glAccount}</td>
                      <td className="px-2 py-2">{row.debitCredit}</td>
                      <td className="px-2 py-2">{row.amountDocument.toFixed(2)}</td>
                      <td className="px-2 py-2">{row.currency}</td>
                      <td className="px-2 py-2">{row.amountLocal.toFixed(2)}</td>
                      <td className="px-2 py-2">{row.costCenter ?? '—'}</td>
                      <td className="px-2 py-2">{row.profitCenter ?? '—'}</td>
                      <td className="px-2 py-2">{row.itemStatus ?? '—'}</td>
                      <td className="px-2 py-2">{row.clearingDocument ?? '—'}</td>
                      <td className="px-2 py-2">{row.assignment ?? '—'}</td>
                      <td className="px-2 py-2">{row.reference ?? '—'}</td>
                      <td className="px-2 py-2">{row.lineText ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.subtotals.length > 0 && (
              <div className="mt-3">
                <h3 className="text-sm font-semibold">Subtotals over the displayed lines</h3>
                <div className="mt-1 overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-ink-faint">
                        <th className="px-2 py-2">Company</th><th className="px-2 py-2">Account</th>
                        <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Debits</th>
                        <th className="px-2 py-2">Credits</th><th className="px-2 py-2">Local currency</th>
                        <th className="px-2 py-2">Local debits</th><th className="px-2 py-2">Local credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.subtotals.map((s) => (
                        <tr key={`${s.companyCode}-${s.glAccount}-${s.currency}`} className="border-t border-line">
                          <td className="px-2 py-2">{s.companyCode}</td>
                          <td className="px-2 py-2">{s.glAccount}</td>
                          <td className="px-2 py-2">{s.currency}</td>
                          <td className="px-2 py-2">{s.debitDocument.toFixed(2)}</td>
                          <td className="px-2 py-2">{s.creditDocument.toFixed(2)}</td>
                          <td className="px-2 py-2">{s.localCurrency}</td>
                          <td className="px-2 py-2">{s.debitLocal.toFixed(2)}</td>
                          <td className="px-2 py-2">{s.creditLocal.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

function toCsv(rows: JournalItemsResult['rows']): string {
  const head = 'Company,Document,Fiscal Year,Line,Posting Date,Document Date,Type,Account,D/C,Amount,Currency,Local Amount,Local Currency,Assignment,Reference,Clearing,Status';
  const lines = rows.map((r) => [
    r.companyCode, r.documentNumber, r.fiscalYear, r.lineNumber, r.postingDate, r.documentDate,
    r.documentType, r.glAccount, r.debitCredit, r.amountDocument, r.currency, r.amountLocal,
    r.localCurrency, r.assignment ?? '', r.reference ?? '', r.clearingDocument ?? '', r.itemStatus ?? '',
  ].join(','));
  return [head, ...lines].join('\n');
}
