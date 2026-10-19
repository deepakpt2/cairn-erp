import Link from 'next/link';

import type { GlBalanceReportSelection, GlBalanceReportView } from '@/modules/finance/gl-balances';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

/**
 * Balance report over ranges (SCR-108): companies and accounts
 * by range, opening / range turnover / closing per account with
 * account-group subtotals. The derivation lands in stage 3.
 */
export default function BalanceReportForm({ selection, report, reportError, canDisplay }: {
  selection: GlBalanceReportSelection;
  report: GlBalanceReportView | null;
  reportError: string | null;
  canDisplay: boolean;
}) {
  return (
    <section aria-labelledby="gbr-select" className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id="gbr-select" className="text-sm font-semibold">Balance report (ranges)</h2>
      <form method="get" className="mt-3">
        <input type="hidden" name="report" value="1" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className={labelCls}>Company codes (comma separated)</span>
            <input name="reportCompanies" className={inputCls} placeholder="1000" defaultValue={selection.companyCodes.join(',')} />
          </label>
          <label className="block">
            <span className={labelCls}>G/L account from</span>
            <input name="accountFrom" className={inputCls} placeholder="100000" defaultValue={selection.accountFrom} />
          </label>
          <label className="block">
            <span className={labelCls}>G/L account to</span>
            <input name="accountTo" className={inputCls} placeholder="999999" defaultValue={selection.accountTo} />
          </label>
          <label className="block">
            <span className={labelCls}>Fiscal year</span>
            <input name="reportFiscalYear" className={inputCls} placeholder="2026" defaultValue={selection.fiscalYear || ''} />
          </label>
          <label className="block">
            <span className={labelCls}>Period from</span>
            <input name="periodFrom" type="number" min={1} max={16} className={inputCls} defaultValue={selection.periodFrom} />
          </label>
          <label className="block">
            <span className={labelCls}>Period to</span>
            <input name="periodTo" type="number" min={1} max={16} className={inputCls} defaultValue={selection.periodTo} />
          </label>
          <label className="block">
            <span className={labelCls}>Ledger</span>
            <input name="ledger" className={inputCls} defaultValue={selection.ledger} readOnly />
          </label>
          <label className="block">
            <span className={labelCls}>Output currency</span>
            <input name="outputCurrency" className={inputCls} placeholder="Company currency" maxLength={5} defaultValue={selection.outputCurrency ?? ''} />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" name="reportSpecialPeriods" value="1" defaultChecked={selection.includeSpecialPeriods} />
          Include special periods 13–16
        </label>
        <button type="submit" className="btn btn-primary mt-3 min-h-11 sm:min-h-8" disabled={!canDisplay}>
          Execute report
        </button>
      </form>

      {reportError ? (
        <p role="alert" className="mt-2 text-sm text-red-700">{reportError}</p>
      ) : report ? (
        <>
          <p className="mt-2 text-sm text-ink-soft">
            Ledger {report.ledger} · Fiscal year {report.fiscalYear} · Periods {report.periodFrom}–{report.periodTo} ·
            calculated {report.calculatedAt.slice(0, 19).replace('T', ' ')}.{' '}
            <a className="text-accent hover:underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(report))}`} download="balance-report.csv">
              Export CSV
            </a>
          </p>
          {report.warnings.map((warning) => (
            <p key={warning} className="mt-2 border border-amber-300 bg-amber-50 p-2 text-sm">{warning}</p>
          ))}
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Company</th><th className="px-2 py-2">Ledger</th>
                  <th className="px-2 py-2">G/L Account</th><th className="px-2 py-2">Account Group</th>
                  <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Opening Balance</th>
                  <th className="px-2 py-2">Period Debit</th><th className="px-2 py-2">Period Credit</th>
                  <th className="px-2 py-2">Net Change</th><th className="px-2 py-2">Closing Balance</th>
                  <th className="px-2 py-2">Debit Balance</th><th className="px-2 py-2">Credit Balance</th>
                  <th className="px-2 py-2">Drill</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={`${row.companyCode}-${row.glAccount}`} className="border-t border-line">
                    <td className="px-2 py-2">{row.companyCode}</td>
                    <td className="px-2 py-2">{report.ledger}</td>
                    <td className="px-2 py-2">{row.glAccount} — {row.accountName}</td>
                    <td className="px-2 py-2">{row.accountGroup}</td>
                    <td className="px-2 py-2">{row.currency}</td>
                    <td className="px-2 py-2">{row.openingBalance.toFixed(2)}</td>
                    <td className="px-2 py-2">{row.debitTurnover.toFixed(2)}</td>
                    <td className="px-2 py-2">{row.creditTurnover.toFixed(2)}</td>
                    <td className="px-2 py-2">{row.netChange.toFixed(2)}</td>
                    <td className="px-2 py-2">{row.closingBalance.toFixed(2)}</td>
                    <td className="px-2 py-2">{row.debitBalance.toFixed(2)}</td>
                    <td className="px-2 py-2">{row.creditBalance.toFixed(2)}</td>
                    <td className="px-2 py-2">
                      <Link className="text-accent hover:underline"
                        href={`/finance/journal/items?accountFrom=${row.glAccount}&companyCodes=${row.companyCode}&fiscalYear=${report.fiscalYear}${report.periodFrom === report.periodTo ? `&postingPeriod=${report.periodFrom}` : ''}`}>
                        Line items
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.subtotals.length > 0 && (
            <div className="mt-3">
              <h3 className="text-sm font-semibold">Account group subtotals</h3>
              <div className="mt-1 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Company</th><th className="px-2 py-2">Account Group</th><th className="px-2 py-2">Currency</th>
                      <th className="px-2 py-2">Accounts</th><th className="px-2 py-2">Period Debit</th>
                      <th className="px-2 py-2">Period Credit</th><th className="px-2 py-2">Net Change</th>
                      <th className="px-2 py-2">Closing Balance</th><th className="px-2 py-2">Debit Balance</th>
                      <th className="px-2 py-2">Credit Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.subtotals.map((subtotal) => (
                      <tr key={`${subtotal.companyCode}-${subtotal.accountGroup}-${subtotal.currency}`} className="border-t border-line">
                        <td className="px-2 py-2">{subtotal.companyCode}</td>
                        <td className="px-2 py-2">{subtotal.accountGroup}</td>
                        <td className="px-2 py-2">{subtotal.currency}</td>
                        <td className="px-2 py-2">{subtotal.accountCount}</td>
                        <td className="px-2 py-2">{subtotal.debitTurnover.toFixed(2)}</td>
                        <td className="px-2 py-2">{subtotal.creditTurnover.toFixed(2)}</td>
                        <td className="px-2 py-2">{subtotal.netChange.toFixed(2)}</td>
                        <td className="px-2 py-2">{subtotal.closingBalance.toFixed(2)}</td>
                        <td className="px-2 py-2">{subtotal.debitBalance.toFixed(2)}</td>
                        <td className="px-2 py-2">{subtotal.creditBalance.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th className="px-2 py-2">Company</th><th className="px-2 py-2">Ledger</th>
                <th className="px-2 py-2">G/L Account</th><th className="px-2 py-2">Account Group</th>
                <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Opening Balance</th>
                <th className="px-2 py-2">Period Debit</th><th className="px-2 py-2">Period Credit</th>
                <th className="px-2 py-2">Net Change</th><th className="px-2 py-2">Closing Balance</th>
                <th className="px-2 py-2">Debit Balance</th><th className="px-2 py-2">Credit Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-line">
                <td colSpan={12} className="px-2 py-2 text-ink-soft">Enter a selection and execute to read balances across accounts.</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function toCsv(report: GlBalanceReportView): string {
  const head = 'Company,Ledger,G/L Account,Account Name,Account Group,Currency,Opening Balance,Period Debit,Period Credit,Net Change,Closing Balance,Debit Balance,Credit Balance';
  const lines = report.rows.map((r) => [
    r.companyCode, report.ledger, r.glAccount, r.accountName, r.accountGroup, r.currency,
    r.openingBalance, r.debitTurnover, r.creditTurnover, r.netChange, r.closingBalance,
    r.debitBalance, r.creditBalance,
  ].join(','));
  return [head, ...lines].join('\n');
}
