import Link from 'next/link';

import type { SubledgerTieResult, SubledgerTieSelection } from '@/modules/finance/subledger-tie-out';

/**
 * Subledger tie-out (SCR-115): company, fiscal year, period
 * to, ledger and account range over the standing grid; the
 * tie-out service follows in stage 3.
 */
export default function SubledgerTieShell({ canUse, companies, selection, result, reportError }: {
  canUse: boolean;
  companies: Array<{ companyCode: string; currency: string }>;
  selection: SubledgerTieSelection;
  result: SubledgerTieResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        You do not hold the subledger tie-out capability (FIN.RPT.SUBLEDGER.TIE).
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label="Report selection">
        <div className="flex flex-wrap gap-3">
          <Field label="Company Code">
            <select name="companyCode" className="field-input code w-44" defaultValue={selection.companyCode}>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} ({c.currency})</option>)}
            </select>
          </Field>
          <Field label="Fiscal Year">
            <input name="fiscalYear" type="number" required defaultValue={selection.fiscalYear} className="field-input code w-28" />
          </Field>
          <Field label="Period To">
            <input name="periodTo" type="number" min={1} max={16} required defaultValue={selection.periodTo} className="field-input code w-24" />
          </Field>
          <Field label="Ledger">
            <input name="ledger" maxLength={2} required defaultValue={selection.ledger} className="field-input code w-24" />
          </Field>
          <Field label="Account From">
            <input name="accountFrom" className="field-input code w-36" defaultValue={selection.accountFrom ?? ''} placeholder="100000" />
          </Field>
          <Field label="Account To">
            <input name="accountTo" className="field-input code w-36" defaultValue={selection.accountTo ?? ''} placeholder="999999" />
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">
          Execute report
        </button>
      </form>

      {reportError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">{reportError}</div>
      ) : null}

      <section className="panel overflow-x-auto" aria-label="Subledger tie-out">
        <table className="grid-table min-w-[64rem]">
          <thead>
            <tr>
              <th>Account / Partner</th>
              <th>Type</th>
              <th className="text-end">G/L Total</th>
              <th className="text-end">Subledger Total</th>
              <th className="text-end">Difference</th>
              <th>Status</th>
              <th className="text-end">Lines</th>
              <th>Curr</th>
              <th>Drill</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !reportError ? (
              <tr>
                <td colSpan={9} className="text-ink-soft">Choose the selection and execute the report.</td>
              </tr>
            ) : (result?.rows ?? []).map((row) => (
              <tr key={row.key} className={row.kind === 'ACCOUNT' ? 'font-semibold' : undefined}>
                <td>
                  {row.kind === 'ACCOUNT' ? row.accountNumber : <span style={{ paddingInlineStart: '1.25rem' }}>{row.businessPartner}</span>}
                </td>
                <td>{row.kind === 'ACCOUNT' ? row.reconciliationType : ''}</td>
                <td className="text-end">{row.kind === 'ACCOUNT' ? row.glTotal.toFixed(2) : ''}</td>
                <td className="text-end">{row.subledgerTotal.toFixed(2)}</td>
                <td className="text-end">{row.difference === null ? '—' : row.difference.toFixed(2)}</td>
                <td>{row.status === null ? '' : row.status === 'TIED' ? 'Tied' : 'Exception'}</td>
                <td className="text-end">{row.lineCount}</td>
                <td>{result?.currency ?? ''}</td>
                <td>
                  <Link href={`/finance/journal/items?accountFrom=${encodeURIComponent(row.accountNumber)}&accountTo=${encodeURIComponent(row.accountNumber)}&companyCodes=${encodeURIComponent(row.companyCode)}&fiscalYear=${result?.fiscalYear ?? ''}`}>
                    Items
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

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
