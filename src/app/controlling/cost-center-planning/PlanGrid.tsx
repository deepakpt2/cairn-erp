'use client';

import { useActionState } from 'react';

import { savePlanAction, type PlanningActionState } from './actions';

export interface GridRow {
  element: string;
  name: string;
  cells: Record<number, string>;
  suggested?: boolean;
}

/**
 * The plan grid: one row per cost element, one column per period of the variant, plus an annual
 * total that — when filled — is spread over the regular periods on save and replaces the row's
 * period cells. Every cell is in the controlling-area currency.
 */
export function PlanGrid({
  selection,
  currency,
  decimals,
  periods,
  rows,
  requestKey,
}: {
  selection: { controllingArea: string; fiscalYear: number; planVersion: string; costCenter: string };
  currency: string;
  decimals: number;
  periods: Array<{ period: number; periodType: 'REGULAR' | 'SPECIAL' }>;
  rows: GridRow[];
  requestKey: string;
}) {
  const [state, action, pending] = useActionState<PlanningActionState, FormData>(savePlanAction, { ok: false });
  const step = decimals === 0 ? '1' : `0.${'0'.repeat(decimals - 1)}1`;
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Plan grid">
      <input type="hidden" name="controllingArea" value={selection.controllingArea} />
      <input type="hidden" name="fiscalYear" value={selection.fiscalYear} />
      <input type="hidden" name="planVersion" value={selection.planVersion} />
      <input type="hidden" name="costCenter" value={selection.costCenter} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <h2 className="panel-title">Planned primary costs — amounts in {currency}</h2>
      <p className="text-xs text-ink-soft">
        Enter amounts per period, or an annual total to spread over the {periods.filter((p) => p.periodType === 'REGULAR').length} regular
        periods (the remainder goes to the earliest). Saving replaces the plan for this selection: a blank cell removes its row,
        and an element whose cells are all blank loses its plan.
      </p>
      <div className="overflow-x-auto">
        <table className="grid-table text-xs">
          <thead>
            <tr>
              <th>Cost element</th>
              <th>Annual total ({currency})</th>
              {periods.map((p) => <th key={p.period}>{p.periodType === 'SPECIAL' ? `S${p.period}` : `P${p.period}`}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>
                  <input name={`element_${i}`} defaultValue={row.element} className="field-input code w-24" maxLength={10} aria-label={`Cost element row ${i + 1}`} />
                  {row.name ? <div className="text-ink-faint">{row.name}{row.suggested ? ' · posted last year' : ''}</div> : null}
                </td>
                <td><input name={`total_${i}`} inputMode="decimal" className="field-input w-24" aria-label={`Annual total row ${i + 1}`} /></td>
                {periods.map((p) => (
                  <td key={p.period}>
                    <input
                      name={`amount_${i}_${p.period}`}
                      defaultValue={row.cells[p.period] ?? ''}
                      inputMode="decimal"
                      step={step}
                      className="field-input w-24"
                      aria-label={`Row ${i + 1} period ${p.period}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="block">
        <span className="field-label">Reason</span>
        <input name="reason" required maxLength={500} className="field-input w-full" />
      </label>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Save plan</button>
      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
    </form>
  );
}
