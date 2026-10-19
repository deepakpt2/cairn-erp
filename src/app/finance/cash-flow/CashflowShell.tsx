'use client';

import {
  CASHFLOW_LEDGER, CASHFLOW_METHODS, CASHFLOW_METHOD_LABELS,
  type CashflowResult, type CashflowSelection,
} from '@/modules/finance/cash-flow-vocabulary';

export interface CashflowCompanyOption { companyCode: string; name: string; currency: string }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function amount(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : value;
}

/**
 * Cash flow statement shell (SCR-119 stage 1): selection and
 * the three-section statement matrix. Amounts arrive with
 * the derivation service in stage 3.
 */
export default function CashflowShell({ canUse, companies, selection, result, reportError }: {
  canUse: boolean;
  companies: CashflowCompanyOption[];
  selection: CashflowSelection;
  result: CashflowResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        You do not hold the cash flow statement capability (FIN.RPT.CASHFLOW).
      </div>
    );
  }
  const resultCompanies = result?.companies ?? companies.filter((c) => selection.companyCodes.includes(c.companyCode));

  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label="Cash flow selection">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Company Codes (comma-separated)">
            <input name="companies" className="field-input code w-56" defaultValue={selection.companyCodes.join(', ')} required />
          </Field>
          <Field label="Fiscal Year">
            <input name="fiscalYear" type="number" className="field-input code w-28" defaultValue={selection.fiscalYear} required />
          </Field>
          <Field label="Period From">
            <input name="periodFrom" type="number" min={1} max={16} className="field-input code w-24" defaultValue={selection.periodFrom} required />
          </Field>
          <Field label="Period To">
            <input name="periodTo" type="number" min={1} max={16} className="field-input code w-24" defaultValue={selection.periodTo} required />
          </Field>
          <Field label="Method">
            <select name="method" className="field-input w-44" defaultValue={selection.method}>
              {CASHFLOW_METHODS.map((method) => (
                <option key={method} value={method}>{CASHFLOW_METHOD_LABELS[method]}</option>
              ))}
            </select>
          </Field>
          <Field label="Ledger">
            <input className="field-input code w-20 bg-sunken" defaultValue={CASHFLOW_LEDGER} readOnly />
          </Field>
          <Field label="Comparison">
            <span className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="comparative" value="1" defaultChecked={selection.comparative} /> Previous year
            </span>
          </Field>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Display</button>
        </div>
        <p className="text-sm text-ink-soft">
          Cash is the house-bank G/L accounts; every other account classifies from standing configuration, and unclassified lines stand named.
        </p>
      </form>

      {reportError && (
        <div className="border border-signal-error/30 bg-signal-error-soft p-3" role="alert">
          <p className="text-sm font-semibold text-signal-error">{reportError}</p>
        </div>
      )}

      {result && result.warnings.length > 0 && (
        <section className="border border-amber-600/30 bg-amber-50 p-3" aria-label="Cash flow warnings">
          <h2 className="text-sm font-semibold text-amber-800">Warnings</h2>
          <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">
            {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </section>
      )}

      <section className="panel overflow-x-auto" aria-label="Cash flow statement">
        <div className="panel-header flex flex-wrap items-center justify-between gap-2">
          <h2 className="panel-title">Cash Flow Statement · {CASHFLOW_METHOD_LABELS[selection.method]}</h2>
          <span className="text-sm text-ink-soft">
            {resultCompanies.map((c) => `${c.companyCode} (${c.currency})`).join(' · ') || 'No company selected'}
          </span>
        </div>
        <table className="grid-table min-w-[56rem]">
          <thead>
            <tr>
              <th>Line</th>
              {resultCompanies.map((c) => <th key={c.companyCode} className="text-end">{c.companyCode}</th>)}
              {result?.totalsComparable && resultCompanies.length > 1 && <th className="text-end">Total</th>}
              {selection.comparative && <th className="text-end">Previous Year</th>}
            </tr>
          </thead>
          <tbody>
            {(result?.sections ?? []).map((section) => [
              <tr key={`${section.key}-head`}><td colSpan={2 + resultCompanies.length} className="font-semibold">{section.title}</td></tr>,
              ...section.lines.map((line) => (
                <tr key={line.key} className={line.kind !== 'DETAIL' ? 'font-medium' : ''}>
                  <td className={line.kind === 'DETAIL' ? 'pl-6' : ''}>{line.label}</td>
                  {resultCompanies.map((c) => (
                    <td key={c.companyCode} className="tabular text-end">{amount(line.amountsByCompany[c.companyCode])}</td>
                  ))}
                  {result?.totalsComparable && resultCompanies.length > 1 && (
                    <td className="tabular text-end">{amount(line.total)}</td>
                  )}
                  {selection.comparative && <td className="tabular text-end">{amount(line.comparativeTotal)}</td>}
                </tr>
              )),
            ])}
            {(!result || result.sections.length === 0) && (
              <tr><td colSpan={2 + resultCompanies.length} className="text-ink-soft">No cash flow amounts stand for this selection.</td></tr>
            )}
          </tbody>
        </table>
        {result && (
          <div className="space-y-1 border-t border-line px-4 py-3 text-sm">
            <p>Opening cash: <strong>{amount(result.openingCash)}</strong> · Closing cash: <strong>{amount(result.closingCash)}</strong> · Net change: <strong>{amount(result.netCashChange)}</strong></p>
            <p className="text-xs text-ink-faint">
              Reconciliation difference (sections vs cash movement): {amount(result.reconciliationDifference)} — explained by the unclassified lines below, never forced to zero.
            </p>
          </div>
        )}
      </section>

      {result && result.unclassified.length > 0 && (
        <section className="panel overflow-x-auto" aria-label="Unclassified lines">
          <div className="panel-header"><h2 className="panel-title">Unclassified Accounts</h2></div>
          <table className="grid-table">
            <thead><tr><th>Company</th><th>Account</th><th className="text-end">Movement</th><th className="text-end">Lines</th></tr></thead>
            <tbody>
              {result.unclassified.map((row) => (
                <tr key={`${row.companyCode}|${row.account}`}>
                  <td className="code">{row.companyCode}</td><td className="code">{row.account}</td>
                  <td className="tabular text-end">{amount(row.amount)}</td><td className="tabular text-end">{row.lines}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
