import type { GlAccountTransferResult, GlAccountTransferSelection } from '@/modules/finance/gl-account-transfer';

/**
 * FS15 transfer shell (SCR-110): source/target companies on a
 * shared chart, optional account range, test-run / company-data
 * / overwrite policy, and the per-account protocol. The
 * transfer executes in stage 3.
 */
export default function TransferShell({ canUse, companies, charts, selection, result }: {
  canUse: boolean;
  companies: Array<{ companyCode: string; name: string }>;
  charts: Array<{ chartOfAccounts: string; name: string }>;
  selection: GlAccountTransferSelection;
  result: GlAccountTransferResult | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        You do not hold the G/L account transfer capability (CFG.FIN.GLACCOUNT.TRANSFER).
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label="Transfer selection">
        <div className="flex flex-wrap gap-3">
          <Field label="Source Company Code">
            <select name="sourceCompanyCode" className="field-input code w-52" defaultValue={selection.sourceCompanyCode}>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}
            </select>
          </Field>
          <Field label="Target Company Code">
            <select name="targetCompanyCode" className="field-input code w-52" defaultValue={selection.targetCompanyCode}>
              <option value="">Select…</option>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}
            </select>
          </Field>
          <Field label="Chart of Accounts">
            <select name="chartOfAccounts" className="field-input code w-52" defaultValue={selection.chartOfAccounts}>
              {charts.map((c) => <option key={c.chartOfAccounts} value={c.chartOfAccounts}>{c.chartOfAccounts} · {c.name}</option>)}
            </select>
          </Field>
          <Field label="G/L Account From">
            <input name="accountFrom" className="field-input code w-36" defaultValue={selection.accountFrom ?? ''} placeholder="100000" />
          </Field>
          <Field label="G/L Account To">
            <input name="accountTo" className="field-input code w-36" defaultValue={selection.accountTo ?? ''} placeholder="999999" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-ink-soft">
          <label className="flex items-center gap-1">
            <input type="checkbox" name="testRun" value="1" defaultChecked={selection.testRun} />
            <input type="hidden" name="testRun" value="0" /> Test run (default — copies nothing)
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" name="withCompanyData" value="1" defaultChecked={selection.withCompanyData} />
            <input type="hidden" name="withCompanyData" value="0" /> With company code data
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" name="overwriteExisting" value="1" defaultChecked={selection.overwriteExisting} />
            <input type="hidden" name="overwriteExisting" value="0" /> Overwrite existing accounts
          </label>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">
          Execute transfer
        </button>
      </form>

      <section className="panel overflow-x-auto" aria-label="Transfer protocol">
        <table className="grid-table min-w-[48rem]">
          <thead>
            <tr>
              <th>G/L Account</th>
              <th>Action</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {result ? (
              result.lines.map((line) => (
                <tr key={line.glAccount}>
                  <td className="code">{line.glAccount}</td>
                  <td>{line.action}</td>
                  <td>{line.reason}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={3} className="text-ink-soft">Choose the selection and execute — test run first. The protocol appears here.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
