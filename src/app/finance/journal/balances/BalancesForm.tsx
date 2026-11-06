import Link from 'next/link';

import type { GlBalanceView } from '@/modules/finance/gl-balances';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

export default function BalancesForm({ view, error, canDisplay }: {
  view: GlBalanceView | null;
  error: string | null;
  canDisplay: boolean;
}) {
  return (
    <>
      <section aria-labelledby="gb-select" className="border border-line bg-surface p-4">
        <h2 id="gb-select" className="text-sm font-semibold">Selection</h2>
        <form method="get" className="mt-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className={labelCls}>G/L account</span>
              <input name="account" className={inputCls} placeholder="400000" required />
            </label>
            <label className="block">
              <span className={labelCls}>Company code</span>
              <input name="companyCode" className={inputCls} placeholder="1000" required />
            </label>
            <label className="block">
              <span className={labelCls}>Fiscal year</span>
              <input name="fiscalYear" className={inputCls} placeholder="2026" required />
            </label>
            <label className="block">
              <span className={labelCls}>Currency</span>
              <input name="currency" className={inputCls} placeholder="Company currency" />
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" name="specialPeriods" value="1" />
            Include special periods, where the fiscal year variant configures them
          </label>
          <button type="submit" className="btn btn-primary mt-3 min-h-11 sm:min-h-8" disabled={!canDisplay}>
            Execute
          </button>
          {!canDisplay && (
            <p className="mt-2 text-sm text-ink-soft">You do not hold the account balance capability.</p>
          )}
        </form>
      </section>

      <section aria-labelledby="gb-results" className="border border-line bg-surface p-4">
        <h2 id="gb-results" className="text-sm font-semibold">Balances</h2>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>
        ) : !view ? (
          <p className="mt-2 text-sm text-ink-soft">Enter a selection and execute to read the account's balances.</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-soft">
              Account {view.glAccount} · Company {view.companyCode} · Fiscal year {view.fiscalYear} · {view.currency}.
              Opening balance {view.openingBalance.toFixed(2)} — the sum of every earlier year, never period 1 turnover.
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="grid-table text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th>Period</th><th>Opening</th>
                    <th>Debit turnover</th><th>Credit turnover</th>
                    <th>Net change</th><th>Closing balance</th>
                    <th>Items</th><th>Drill</th>
                  </tr>
                </thead>
                <tbody>
                  {view.periods.map((row) => (
                    <tr key={row.period}>
                      <td>{row.special ? `Special ${row.period}` : `Period ${row.period}`}</td>
                      <td className="num">{row.opening.toFixed(2)}</td>
                      <td className="num">{row.debitTurnover.toFixed(2)}</td>
                      <td className="num">{row.creditTurnover.toFixed(2)}</td>
                      <td className="num">{row.netChange.toFixed(2)}</td>
                      <td className="num">{row.closing.toFixed(2)}</td>
                      <td>{row.itemCount}</td>
                      <td>
                        <Link className="text-accent hover:underline"
                          href={`/finance/journal/items?accountFrom=${view.glAccount}&companyCodes=${view.companyCode}&fiscalYear=${view.fiscalYear}&postingPeriod=${row.period}`}>
                          Line items
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-ink-soft">
              Year: debits {view.yearDebit.toFixed(2)}, credits {view.yearCredit.toFixed(2)},
              closing {view.yearClosing.toFixed(2)}.
            </p>
          </>
        )}
      </section>
    </>
  );
}
