/**
 * Cost centre planning — CO.PLAN.COSTCENTER.MAINTAIN. SAP: KP06 (change) and KP07 (display).
 *
 * Primary-cost planning: planned amounts per cost centre, cost element and period, by plan version
 * and fiscal year, in the controlling-area currency. The actual/plan report reads what is saved
 * here. Activity quantities and prices are planned at /config/activity-rates. Plan is plan: nothing
 * here posts. Selection (GET): `controllingArea`, `fiscalYear`, `planVersion`, `costCenter`.
 */
import { randomUUID } from 'node:crypto';
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  COST_CENTER_PLANNING_CAPABILITY,
  COST_CENTER_PLANNING_ROUTE,
  CostCenterPlanningError,
  DEFAULT_PLAN_VERSION,
  listCostCentersFor,
  listPlanningAreas,
  planningGrid,
} from '@/modules/foundation/cost-center-planning';

import { PlanGrid, type GridRow } from './PlanGrid';
import type { ReactNode } from 'react';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const BLANK_ROWS = 3;

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

export default async function CostCenterPlanningPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(COST_CENTER_PLANNING_ROUTE);
  const Frame = ({ children, width }: { children: ReactNode; width?: '6xl' | '7xl' }) => (
    <Page
      title="Cost centre planning"
      code={<>{COST_CENTER_PLANNING_CAPABILITY} · KP06 / KP07</>}
      width={width}
      actions={<LinkButton href="/controlling/cost-center-report">Actual/plan report</LinkButton>}
      description={
        <p className="max-w-3xl text-sm text-ink-soft">
        Planned primary costs per cost centre, cost element and period. Plan is plan, actual is actual: nothing here posts.
        Activity quantities and prices are planned at <Link href="/config/activity-rates" className="underline">/config/activity-rates</Link>.
        </p>
      }
    >
      {children}
    </Page>
  );
  if (!can(session, COST_CENTER_PLANNING_CAPABILITY)) {
    return (
      <Frame>
        <p role="status" className="text-sm text-ink-soft">You do not hold the cost centre planning capability. Ask for {COST_CENTER_PLANNING_CAPABILITY}.</p>
      </Frame>
    );
  }

  const params = await searchParams;
  const client = session.user.client;
  const areas = await listPlanningAreas(client);
  const controllingArea = (last(params.controllingArea) || areas[0]?.controllingArea || '').toUpperCase();
  const fiscalYear = Number(last(params.fiscalYear)) || new Date().getUTCFullYear();
  const planVersion = (last(params.planVersion) || DEFAULT_PLAN_VERSION).toUpperCase();
  const centres = controllingArea ? await listCostCentersFor(client, controllingArea, fiscalYear) : [];
  const costCenter = (last(params.costCenter) || '').toUpperCase();

  let grid: Awaited<ReturnType<typeof planningGrid>> | null = null;
  let problem: string | null = null;
  if (controllingArea && costCenter) {
    try {
      grid = await planningGrid({ client, controllingArea, fiscalYear, planVersion, costCenter });
    } catch (error) {
      if (!(error instanceof CostCenterPlanningError)) throw error;
      problem = `${error.message}${error.remedy ? ` ${error.remedy}` : ''}`;
    }
  }
  const rows: GridRow[] = grid
    ? [
      ...grid.plannedElements.map((element) => ({
        element,
        name: grid!.elementNames.get(element) ?? '',
        cells: Object.fromEntries(grid!.context.periods.map((p) => [p.period, grid!.cells.get(`${element}|${p.period}`) ?? ''])),
      })),
      ...grid.suggestedElements.map((element) => ({ element, name: grid!.elementNames.get(element) ?? '', cells: {}, suggested: true })),
      ...Array.from({ length: BLANK_ROWS }, () => ({ element: '', name: '', cells: {} })),
    ]
    : [];

  return (
    <Frame width="7xl">

      <form method="get" className="panel flex flex-wrap items-end gap-3 p-3" aria-label="Selection">
        <label>
          <span className="field-label">Controlling area</span>
          <select name="controllingArea" defaultValue={controllingArea} className="field-input">
            {areas.map((a) => <option key={a.controllingArea} value={a.controllingArea}>{a.controllingArea} — {a.name} ({a.currency})</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">Fiscal year</span>
          <input type="number" name="fiscalYear" defaultValue={fiscalYear} min={1900} max={9999} className="field-input w-24" />
        </label>
        <label>
          <span className="field-label">Plan version</span>
          <input name="planVersion" defaultValue={planVersion} maxLength={3} className="field-input code w-16" />
        </label>
        <label>
          <span className="field-label">Cost centre</span>
          <select name="costCenter" defaultValue={costCenter} className="field-input">
            <option value="">Choose…</option>
            {centres.map((c) => (
              <option key={c.costCenter} value={c.costCenter}>{c.costCenter} — {c.name}{c.isPostingLocked ? ' (locked)' : ''}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Open</button>
      </form>

      {areas.length === 0 && <p role="status" className="panel p-4 text-sm text-ink-soft">No controlling area is defined, so nothing can be planned.</p>}
      {controllingArea && centres.length === 0 && (
        <p role="status" className="panel p-4 text-sm text-ink-soft">Controlling area {controllingArea} has no cost centre valid in {fiscalYear}.</p>
      )}
      {problem && <p role="status" className="panel p-4 text-sm text-signal-error">{problem}</p>}

      {grid && (
        <>
          <section className="panel space-y-1 p-4" aria-label="Plan">
            <h2 className="panel-title">
              {costCenter}{grid.costCenter ? ` — ${grid.costCenter.name}` : ''} · version {planVersion} · {fiscalYear} · {grid.context.controllingArea} ({grid.context.currency})
            </h2>
            <p className="text-xs text-ink-soft">
              Fiscal year variant {grid.context.fiscalYearVariant}: {grid.context.periods.length} periods.
              {grid.costCenter ? ` Cost centre valid ${grid.costCenter.validFrom} to ${grid.costCenter.validTo}${grid.costCenter.isPostingLocked ? ', locked for posting' : ''}.` : ''}
            </p>
            {grid.plannedElements.length === 0 ? (
              <p role="status" className="text-sm">No plan stands for version {planVersion} in year {fiscalYear} for this cost centre.</p>
            ) : (
              <p className="text-sm">{grid.plannedElements.length} cost element{grid.plannedElements.length === 1 ? '' : 's'} planned.</p>
            )}
          </section>
          <PlanGrid
            selection={{ controllingArea, fiscalYear, planVersion, costCenter }}
            currency={grid.context.currency}
            decimals={grid.decimals}
            periods={grid.context.periods.map((p) => ({ period: p.period, periodType: p.periodType }))}
            rows={rows}
            requestKey={randomUUID()}
          />
        </>
      )}
    </Frame>
  );
}
