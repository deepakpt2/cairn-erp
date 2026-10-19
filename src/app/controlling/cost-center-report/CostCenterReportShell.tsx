import type { CostCenterReportResult, CostCenterReportSelection } from '@/modules/foundation/cost-center-report';

/**
 * Cost centre actual/plan/variance (SCR-112): controlling
 * area, fiscal year, periods, plan version, centre/element
 * ranges or a configured group; the grid follows in stage 3.
 */
export default function CostCenterReportShell({ canUse, areas, selection, result }: {
  canUse: boolean;
  areas: Array<{ controllingArea: string; currency: string }>;
  selection: CostCenterReportSelection;
  result: CostCenterReportResult | null;
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
            <tr>
              <td colSpan={9} className="text-ink-soft">{result ? '' : 'Choose the selection and execute the report.'}</td>
            </tr>
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
