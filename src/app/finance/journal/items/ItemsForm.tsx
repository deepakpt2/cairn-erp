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
      <section aria-labelledby="ji-select" className="border border-line bg-surface p-4">
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

      <section aria-labelledby="ji-results" className="border border-line bg-surface p-4">
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
              <table className="grid-table text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th>Company</th><th>Document</th>
                    <th>Line</th><th>Posting date</th>
                    <th>Document date</th>
                    <th>Type</th><th>Account</th>
                    <th>D/C</th><th>Amount</th>
                    <th>Currency</th><th>Local amount</th>
                    <th>Cost centre</th><th>Profit centre</th>
                    <th>Status</th><th>Clearing</th>
                    <th>Assignment</th><th>Reference</th>
                    <th>Text</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={`${row.documentNumber}-${row.fiscalYear}-${row.lineNumber}`}>
                      <td>{row.companyCode}</td>
                      <td>
                        <Link className="text-accent hover:underline"
                          href={`/finance/journal/document?document=${encodeURIComponent(row.documentNumber)}&company=${row.companyCode}&year=${row.fiscalYear}`}>
                          {row.documentNumber}
                        </Link>
                      </td>
                      <td>{row.lineNumber}</td>
                      <td>{row.postingDate}</td>
                      <td>{row.documentDate}</td>
                      <td>{row.documentType}</td>
                      <td>{row.glAccount}</td>
                      <td>{row.debitCredit}</td>
                      <td className="num">{row.amountDocument.toFixed(2)}</td>
                      <td>{row.currency}</td>
                      <td className="num">{row.amountLocal.toFixed(2)}</td>
                      <td>{row.costCenter ?? '—'}</td>
                      <td>{row.profitCenter ?? '—'}</td>
                      <td>{row.itemStatus ?? '—'}</td>
                      <td>{row.clearingDocument ?? '—'}</td>
                      <td>{row.assignment ?? '—'}</td>
                      <td>{row.reference ?? '—'}</td>
                      <td>{row.lineText ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.subtotals.length > 0 && (
              <div className="mt-3">
                <h3 className="text-sm font-semibold">Subtotals over the displayed lines</h3>
                <div className="mt-1 overflow-x-auto">
                  <table className="grid-table text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-ink-faint">
                        <th>Company</th><th>Account</th>
                        <th>Currency</th><th>Debits</th>
                        <th>Credits</th><th>Local currency</th>
                        <th>Local debits</th><th>Local credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.subtotals.map((s) => (
                        <tr key={`${s.companyCode}-${s.glAccount}-${s.currency}`}>
                          <td>{s.companyCode}</td>
                          <td>{s.glAccount}</td>
                          <td>{s.currency}</td>
                          <td className="num">{s.debitDocument.toFixed(2)}</td>
                          <td className="num">{s.creditDocument.toFixed(2)}</td>
                          <td>{s.localCurrency}</td>
                          <td className="num">{s.debitLocal.toFixed(2)}</td>
                          <td className="num">{s.creditLocal.toFixed(2)}</td>
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
