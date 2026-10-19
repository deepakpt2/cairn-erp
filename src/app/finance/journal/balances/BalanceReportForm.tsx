import type { GlBalanceReportSelection, GlBalanceReportView } from '@/modules/finance/gl-balances';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

/**
 * Balance report over ranges (SCR-108): companies and accounts
 * by range, opening / range turnover / closing per account with
 * account-group subtotals. The derivation lands in stage 3.
 */
export default function BalanceReportForm({ selection, report, canDisplay }: {
  selection: GlBalanceReportSelection;
  report: GlBalanceReportView | null;
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
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" name="reportSpecialPeriods" value="1" defaultChecked={selection.includeSpecialPeriods} />
          Include special periods 13–16
        </label>
        <button type="submit" className="btn btn-primary mt-3 min-h-11 sm:min-h-8" disabled={!canDisplay}>
          Execute report
        </button>
      </form>

      {report ? (
        <p className="mt-2 text-sm text-ink-soft">The report is calculated in stage 3.</p>
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
