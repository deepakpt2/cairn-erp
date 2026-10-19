'use client';

import {
  SECTION_LABELS, STATEMENT_VIEWS, STATEMENT_VIEW_LABELS,
  type ConsolidatedStatementsResult, type ConsolidatedStatementsSelection,
  type StatementSection,
} from '@/modules/finance/consolidated-statements-vocabulary';

export interface ConsolidatedStatementsOptions {
  areas: Array<{ area: string; title: string; status: string }>;
  groups: Array<{ group: string; title: string }>;
  versions: Array<{ version: string; title: string }>;
  units: Array<{ unit: string; title: string }>;
}

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

const SECTION_ORDER: StatementSection[] = ['ASSETS', 'LIABILITIES', 'EQUITY', 'REVENUE', 'EXPENSES', 'UNCLASSIFIED'];

/**
 * Consolidated statements shell (SCR-118 stage 1): the SAP
 * global-parameter selection and the FS-item matrix over the
 * consolidation chart. Amounts arrive with the service in
 * stage 3.
 */
export default function ConsolidatedStatementsShell({ canUse, options, selection, result, reportError }: {
  canUse: boolean;
  options: ConsolidatedStatementsOptions;
  selection: ConsolidatedStatementsSelection;
  result: ConsolidatedStatementsResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        You do not hold the consolidated statements capability (FIN.RPT.CONSOLIDATE.STMT).
      </div>
    );
  }
  const units = result?.units ?? options.units.map((u) => ({ unit: u.unit, title: u.title, companyCode: '' }));

  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label="Consolidated statements selection">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Consolidation Area">
            <select name="area" className="field-input code w-52" defaultValue={selection.area}>
              {options.areas.map((a) => (
                <option key={a.area} value={a.area}>{a.area} — {a.title} ({a.status})</option>
              ))}
            </select>
          </Field>
          <Field label="Consolidation Group">
            <select name="group" className="field-input code w-52" defaultValue={selection.group}>
              {options.groups.map((g) => (
                <option key={g.group} value={g.group}>{g.group} — {g.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Version">
            <select name="version" className="field-input code w-44" defaultValue={selection.version}>
              {options.versions.map((v) => (
                <option key={v.version} value={v.version}>{v.version} — {v.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Fiscal Year">
            <input name="fiscalYear" type="number" className="field-input code w-28" defaultValue={selection.fiscalYear} required />
          </Field>
          <Field label="Period To">
            <input name="period" type="number" min={1} max={20} className="field-input code w-28" defaultValue={selection.period} required />
          </Field>
          <Field label="Statement">
            <select name="view" className="field-input w-56" defaultValue={selection.view}>
              {STATEMENT_VIEWS.map((view) => (
                <option key={view} value={view}>{STATEMENT_VIEW_LABELS[view]}</option>
              ))}
            </select>
          </Field>
          <Field label="Consolidation Unit">
            <select name="unit" className="field-input code w-48" defaultValue={selection.unit}>
              <option value="">All units in group</option>
              {options.units.map((u) => (
                <option key={u.unit} value={u.unit}>{u.unit} — {u.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Comparison">
            <span className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="comparative" value="1" defaultChecked={selection.comparative} />
              Previous year
            </span>
          </Field>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Display</button>
        </div>
        <p className="text-sm text-ink-soft">
          Amounts aggregate the reported journal data of the group units through the UCWB account mappings.
          Currency translation and intercompany eliminations are not yet executed, so totals stand pre-elimination.
        </p>
      </form>

      {reportError && (
        <div className="border border-signal-error/30 bg-signal-error-soft p-3" role="alert">
          <p className="text-sm font-semibold text-signal-error">{reportError}</p>
        </div>
      )}

      {result && result.warnings.length > 0 && (
        <section className="border border-amber-600/30 bg-amber-50 p-3" aria-label="Statement warnings">
          <h2 className="text-sm font-semibold text-amber-800">Warnings</h2>
          <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">
            {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </section>
      )}

      <section className="panel overflow-x-auto" aria-label="Consolidated statement">
        <div className="panel-header flex flex-wrap items-center justify-between gap-2">
          <h2 className="panel-title">{STATEMENT_VIEW_LABELS[selection.view]}</h2>
          <span className="text-sm text-ink-soft">
            {result ? `${result.areaTitle} · Chart ${result.consChart} · ${result.periodLabel}` : 'No statement scope selected'}
          </span>
        </div>
        <table className="grid-table min-w-[64rem]">
          <thead>
            <tr>
              <th>FS Item</th><th>Section</th>
              {units.map((u) => <th key={u.unit} className="text-end">{u.unit}</th>)}
              <th className="text-end">Group Total</th><th className="text-end">Period Movement</th>
              {selection.comparative && <th className="text-end">Previous Year</th>}
            </tr>
          </thead>
          <tbody>
            {SECTION_ORDER.map((section) => {
              const rows = (result?.rows ?? []).filter((row) => row.section === section);
              if (rows.length === 0) return null;
              const total = result?.sectionTotals.find((t) => t.section === section);
              return [
                ...rows.map((row) => (
                  <tr key={row.groupAccount}>
                    <td><span className="code">{row.groupAccount}</span><span className="block text-xs text-ink-faint">{row.title}</span></td>
                    <td>{SECTION_LABELS[row.section]}</td>
                    {units.map((u) => (
                      <td key={u.unit} className="tabular text-end">{amount(row.unitAmounts[u.unit])}</td>
                    ))}
                    <td className="tabular text-end font-medium">{amount(row.groupTotal)}</td>
                    <td className="tabular text-end">{amount(row.periodMovement)}</td>
                    {selection.comparative && <td className="tabular text-end">{amount(row.comparativeTotal)}</td>}
                  </tr>
                )),
                <tr key={`${section}-total`} className="font-medium">
                  <td colSpan={2}>Total {SECTION_LABELS[section]}</td>
                  {units.map((u) => <td key={u.unit} />)}
                  <td className="tabular text-end">{amount(total?.total)}</td>
                  <td /><td />
                </tr>,
              ];
            })}
            {(result?.rows ?? []).length === 0 && (
              <tr><td colSpan={5 + units.length} className="text-ink-soft">No FS-item amounts stand for this selection.</td></tr>
            )}
          </tbody>
        </table>
        {result && (
          <p className="border-t border-line px-4 py-2 text-xs text-ink-faint">
            Balance check (all mapped and unmapped lines): {amount(result.balanceCheck)} · Unmapped journal lines: {result.unmapped.lines} ({amount(result.unmapped.amount)})
          </p>
        )}
      </section>

      {result && result.monitorStanding.length > 0 && (
        <section className="panel p-4" aria-label="Monitor standing">
          <h2 className="panel-title">Consolidation Monitor Standing (CX20)</h2>
          <ul className="mt-2 space-y-1 text-sm text-ink-soft">
            {result.monitorStanding.map((row) => (
              <li key={`${row.unit}|${row.task}`}>
                <span className="code">{row.unit} · {row.task}</span> — {row.status} ({row.mode}) {row.executedAt}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
