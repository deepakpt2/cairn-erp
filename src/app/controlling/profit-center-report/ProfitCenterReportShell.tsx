import type { ProfitCenterReportResult, ProfitCenterReportSelection } from '@/modules/foundation/profit-center-report';

/**
 * Profit centre actual line items (SCR-113): controlling
 * area, profit centre range/group, fiscal year, periods,
 * ledger, account and document ranges, maximum hits; the
 * line-item grid follows in stage 3.
 */
export default function ProfitCenterReportShell({ canUse, areas, selection, result, reportError }: {
  canUse: boolean;
  areas: Array<{ controllingArea: string; currency: string }>;
  selection: ProfitCenterReportSelection;
  result: ProfitCenterReportResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        You do not hold the profit centre report capability (FIN.RPT.PROFITCENTER).
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label="Report selection">
        <div className="flex flex-wrap gap-3">
          <Field label="Controlling Area">
            <select name="controllingArea" className="field-input code w-44" defaultValue={selection.controllingArea}>
              {areas.map((a) => <option key={a.controllingArea} value={a.controllingArea}>{a.controllingArea} ({a.currency})</option>)}
            </select>
          </Field>
          <Field label="Fiscal Year">
            <input name="fiscalYear" type="number" required defaultValue={selection.fiscalYear} className="field-input code w-28" />
          </Field>
          <Field label="Period From">
            <input name="periodFrom" type="number" min={1} max={16} defaultValue={selection.periodFrom} className="field-input code w-24" />
          </Field>
          <Field label="Period To">
            <input name="periodTo" type="number" min={1} max={16} required defaultValue={selection.periodTo} className="field-input code w-24" />
          </Field>
          <Field label="Ledger">
            <input name="ledger" maxLength={2} required defaultValue={selection.ledger} className="field-input code w-24" />
          </Field>
          <Field label="Profit Center From">
            <input name="profitCenterFrom" className="field-input code w-36" defaultValue={selection.profitCenterFrom ?? ''} placeholder="PC100" />
          </Field>
          <Field label="Profit Center To">
            <input name="profitCenterTo" className="field-input code w-36" defaultValue={selection.profitCenterTo ?? ''} placeholder="PC999" />
          </Field>
          <Field label="Profit Center Group">
            <input name="profitCenterGroup" className="field-input code w-44" defaultValue={selection.profitCenterGroup ?? ''} placeholder="Group name" />
          </Field>
          <Field label="G/L Account From">
            <input name="glAccountFrom" className="field-input code w-36" defaultValue={selection.glAccountFrom ?? ''} placeholder="100000" />
          </Field>
          <Field label="G/L Account To">
            <input name="glAccountTo" className="field-input code w-36" defaultValue={selection.glAccountTo ?? ''} placeholder="999999" />
          </Field>
          <Field label="Document Number From">
            <input name="documentFrom" className="field-input code w-40" defaultValue={selection.documentFrom ?? ''} />
          </Field>
          <Field label="Document Number To">
            <input name="documentTo" className="field-input code w-40" defaultValue={selection.documentTo ?? ''} />
          </Field>
          <Field label="Maximum Number of Hits">
            <input name="maxHits" type="number" min={1} required defaultValue={selection.maxHits} className="field-input code w-32" />
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">
          Execute report
        </button>
      </form>

      {reportError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">{reportError}</div>
      ) : null}

      {result?.truncated ? (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          Results are incomplete: the maximum of {result.maxHits} hits was reached. Narrow the selection to see the remaining line items.
        </div>
      ) : null}

      <section className="panel overflow-x-auto" aria-label="Profit center actual line items">
        <table className="grid-table min-w-[96rem]">
          <thead>
            <tr>
              <th>Company</th>
              <th>Document</th>
              <th>Line</th>
              <th>Posting Date</th>
              <th>Document Date</th>
              <th>Type</th>
              <th>Profit Center</th>
              <th>G/L Account</th>
              <th>D/C</th>
              <th className="text-end">Amount</th>
              <th>Curr</th>
              <th className="text-end">Local Amount</th>
              <th>Curr</th>
              <th>Assignment</th>
              <th>Reference</th>
              <th>Line Text</th>
              <th>Cost Center</th>
              <th>Order</th>
              <th>Origin</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !reportError ? (
              <tr>
                <td colSpan={19} className="text-ink-soft">Choose the selection and execute the report.</td>
              </tr>
            ) : (result?.lines ?? []).map((line) => (
              <tr key={`${line.documentNumber}|${line.fiscalYear}|${line.lineNumber}`}>
                <td>{line.companyCode}</td>
                <td className="code">{line.displayNumber || line.documentNumber}</td>
                <td>{line.lineNumber}</td>
                <td>{line.postingDate}</td>
                <td>{line.documentDate}</td>
                <td>{line.documentType}</td>
                <td>{line.profitCenterName ? `${line.profitCenter} — ${line.profitCenterName}` : line.profitCenter}</td>
                <td className="code">{line.glAccount}</td>
                <td>{line.debitCredit}</td>
                <td className="text-end">{line.amountDocument.toFixed(2)}</td>
                <td>{line.documentCurrency}</td>
                <td className="text-end">{line.amountLocal.toFixed(2)}</td>
                <td>{line.localCurrency}</td>
                <td>{line.assignment}</td>
                <td>{line.reference}</td>
                <td>{line.lineText}</td>
                <td>{line.costCenter}</td>
                <td>{line.internalOrder || line.productionOrder}</td>
                <td>{line.originClass ? `${line.originClass} ${line.originKey}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {result && result.totals.length > 0 ? (
        <section className="panel overflow-x-auto" aria-label="Profit center totals">
          <table className="grid-table min-w-[48rem]">
            <thead>
              <tr>
                <th>Profit Center</th>
                <th>G/L Account</th>
                <th className="text-end">Amount</th>
                <th>Curr</th>
                <th className="text-end">Local Amount</th>
                <th>Curr</th>
              </tr>
            </thead>
            <tbody>
              {result.totals.map((total) => (
                <tr key={`${total.profitCenter}|${total.glAccount}|${total.documentCurrency}|${total.localCurrency}`}>
                  <td>{total.profitCenter}</td>
                  <td className="code">{total.glAccount}</td>
                  <td className="text-end">{total.amountDocument.toFixed(2)}</td>
                  <td>{total.documentCurrency}</td>
                  <td className="text-end">{total.amountLocal.toFixed(2)}</td>
                  <td>{total.localCurrency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {result && result.warnings.length > 0 ? (
        <section className="panel p-4" aria-label="Report warnings">
          <ul className="list-disc space-y-1 ps-5 text-sm text-ink-soft">
            {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </section>
      ) : null}
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
