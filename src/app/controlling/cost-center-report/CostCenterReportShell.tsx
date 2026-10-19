import type { CostCenterReportResult, CostCenterReportSelection } from '@/modules/foundation/cost-center-report';

/**
 * Cost centre actual/plan/variance (SCR-112): controlling
 * area, fiscal year, periods, plan version, centre/element
 * ranges or a configured group; the grid follows in stage 3.
 */
export default function CostCenterReportShell({ canUse, areas, selection, result, reportError }: {
  canUse: boolean;
  areas: Array<{ controllingArea: string; currency: string }>;
  selection: CostCenterReportSelection;
  result: CostCenterReportResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        You do not hold the cost centre report capability (FIN.RPT.COSTCENTER.ACTUAL).
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
          <Field label="Plan Version">
            <input name="planVersion" maxLength={3} defaultValue={selection.planVersion} className="field-input code w-24" />
          </Field>
          <Field label="Cost Center From">
            <input name="costCenterFrom" className="field-input code w-36" defaultValue={selection.costCenterFrom ?? ''} placeholder="CC100" />
          </Field>
          <Field label="Cost Center To">
            <input name="costCenterTo" className="field-input code w-36" defaultValue={selection.costCenterTo ?? ''} placeholder="CC999" />
          </Field>
          <Field label="Cost Center Group">
            <input name="costCenterGroup" className="field-input code w-44" defaultValue={selection.costCenterGroup ?? ''} placeholder="Group name" />
          </Field>
          <Field label="Cost Element From">
            <input name="costElementFrom" className="field-input code w-36" defaultValue={selection.costElementFrom ?? ''} placeholder="400000" />
          </Field>
          <Field label="Cost Element To">
            <input name="costElementTo" className="field-input code w-36" defaultValue={selection.costElementTo ?? ''} placeholder="499999" />
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">
          Execute report
        </button>
      </form>

      <section className="panel overflow-x-auto" aria-label="Cost center actual plan variance">
        <table className="grid-table min-w-[64rem]">
          <thead>
            <tr>
              <th>Cost Center / Cost Element</th>
              <th className="text-end">Actual</th>
              <th className="text-end">Plan</th>
              <th className="text-end">Variance</th>
              <th className="text-end">Variance %</th>
              <th>Status</th>
              <th className="text-end">Actual YTD</th>
              <th className="text-end">Plan YTD</th>
              <th>Currency</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !reportError ? (
              <tr>
                <td colSpan={9} className="text-ink-soft">Choose the selection and execute the report.</td>
              </tr>
            ) : (result?.rows ?? []).map((row) => (
              <tr key={row.key} className={row.kind === 'GROUP' ? 'font-semibold' : undefined}>
                <td>
                  <span style={{ paddingInlineStart: `${row.depth * 1.25}rem` }}>{row.label}</span>
                </td>
                <td className="text-end">{row.actual.toFixed(2)}</td>
                <td className="text-end">{row.plan === null ? '—' : row.plan.toFixed(2)}</td>
                <td className="text-end">{row.variance === null ? '—' : row.variance.toFixed(2)}</td>
                <td className="text-end">{row.variancePercent === null ? '—' : `${row.variancePercent.toFixed(1)}%`}</td>
                <td>{row.status === null ? '—' : row.status === 'ON_PLAN' ? 'On plan' : row.status === 'FAVORABLE' ? 'Favorable' : 'Unfavorable'}</td>
                <td className="text-end">{row.actualYtd.toFixed(2)}</td>
                <td className="text-end">{row.planYtd === null ? '—' : row.planYtd.toFixed(2)}</td>
                <td>{result?.currency ?? ''}</td>
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

      {result && result.activities.length > 0 ? (
        <section className="panel overflow-x-auto" aria-label="Planned activity">
          <table className="grid-table min-w-[40rem]">
            <thead>
              <tr>
                <th>Cost Center</th>
                <th>Activity</th>
                <th className="text-end">Planned Quantity</th>
                <th className="text-end">Fixed Price</th>
                <th className="text-end">Variable Price</th>
                <th className="text-end">Per</th>
              </tr>
            </thead>
            <tbody>
              {result.activities.map((activity) => (
                <tr key={`${activity.costCenter}|${activity.activityType}`}>
                  <td>{activity.costCenter}</td>
                  <td>{activity.activityType}</td>
                  <td className="text-end">{activity.plannedQuantity}</td>
                  <td className="text-end">{activity.fixedPrice.toFixed(2)}</td>
                  <td className="text-end">{activity.variablePrice.toFixed(2)}</td>
                  <td className="text-end">{activity.priceUnit}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
