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
    <section aria-labelledby="gbr-select" className="border border-line bg-surface p-4">
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
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Company</th><th>Ledger</th>
                  <th>G/L Account</th><th>Account Group</th>
                  <th>Currency</th><th>Opening Balance</th>
                  <th>Period Debit</th><th>Period Credit</th>
                  <th>Net Change</th><th>Closing Balance</th>
                  <th>Debit Balance</th><th>Credit Balance</th>
                  <th>Drill</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={`${row.companyCode}-${row.glAccount}`}>
                    <td>{row.companyCode}</td>
                    <td>{report.ledger}</td>
                    <td>{row.glAccount} — {row.accountName}</td>
                    <td>{row.accountGroup}</td>
                    <td>{row.currency}</td>
                    <td className="num">{row.openingBalance.toFixed(2)}</td>
                    <td className="num">{row.debitTurnover.toFixed(2)}</td>
                    <td className="num">{row.creditTurnover.toFixed(2)}</td>
                    <td className="num">{row.netChange.toFixed(2)}</td>
                    <td className="num">{row.closingBalance.toFixed(2)}</td>
                    <td className="num">{row.debitBalance.toFixed(2)}</td>
                    <td className="num">{row.creditBalance.toFixed(2)}</td>
                    <td>
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
                <table className="grid-table text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th>Company</th><th>Account Group</th><th>Currency</th>
                      <th>Accounts</th><th>Period Debit</th>
                      <th>Period Credit</th><th>Net Change</th>
                      <th>Closing Balance</th><th>Debit Balance</th>
                      <th>Credit Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.subtotals.map((subtotal) => (
                      <tr key={`${subtotal.companyCode}-${subtotal.accountGroup}-${subtotal.currency}`}>
                        <td>{subtotal.companyCode}</td>
                        <td>{subtotal.accountGroup}</td>
                        <td>{subtotal.currency}</td>
                        <td>{subtotal.accountCount}</td>
                        <td className="num">{subtotal.debitTurnover.toFixed(2)}</td>
                        <td className="num">{subtotal.creditTurnover.toFixed(2)}</td>
                        <td className="num">{subtotal.netChange.toFixed(2)}</td>
                        <td className="num">{subtotal.closingBalance.toFixed(2)}</td>
                        <td className="num">{subtotal.debitBalance.toFixed(2)}</td>
                        <td className="num">{subtotal.creditBalance.toFixed(2)}</td>
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
          <table className="grid-table text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th>Company</th><th>Ledger</th>
                <th>G/L Account</th><th>Account Group</th>
                <th>Currency</th><th>Opening Balance</th>
                <th>Period Debit</th><th>Period Credit</th>
                <th>Net Change</th><th>Closing Balance</th>
                <th>Debit Balance</th><th>Credit Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={12} className="text-ink-soft">Enter a selection and execute to read balances across accounts.</td>
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
