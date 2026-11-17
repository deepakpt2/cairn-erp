/**
 * Capacity load — CM01, guarded by PROD.CAPACITY.LOAD.DISPLAY. Read-only.
 *
 * GET: `plant`, `workCenterFrom`, `workCenterTo`, `capacityCategory`, `dateFrom`, `dateTo`, `period`,
 * `workingDaysPerWeek`, `includePlannedOrders`, `statuses` (repeatable), `limit`.
 * A grid of work center capacity × period. Every cell drills to the order list (COOIS) for its own period.
 * The figures are derived on every read and the page says how far to trust them: warnings sit above the grid.
 */
import { sql } from 'drizzle-orm';
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import {
  CAPACITY_LOAD_CAPABILITY, CAPACITY_LOAD_DEFAULT_LIMIT, CAPACITY_LOAD_LIMIT_CEILING, CAPACITY_LOAD_ROUTE,
  CAPACITY_ORDER_STATUSES, CAPACITY_PERIODS, CapacityLoadError, DEFAULT_WORKING_DAYS_PER_WEEK,
  drillDownFor, loadCapacityReport, type CapacityLoadReport, type CapacityPeriod,
} from '@/modules/production/capacity-load';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}
function all(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).map((v) => v.trim()).filter(Boolean);
}
function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });

/** Never colour alone: an overload carries a marker and the figure. */
function Load({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-faint" title="No available capacity, so no percentage">n/a</span>;
  return value > 100
    ? <strong className="text-signal-error">▲ {value}%</strong>
    : <span>{value}%</span>;
}

export default async function CapacityLoadPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(CAPACITY_LOAD_ROUTE);
  const params = await searchParams;
  const allowed = can(session, CAPACITY_LOAD_CAPABILITY);
  const client = session.user.client;
  const today = new Date().toISOString().slice(0, 10);
  const plants = allowed
    ? ((await withTenant(client, (tx) => tx.execute(sql`select plant, name from plant where client = ${client} order by plant`))) as unknown as Array<{ plant: string; name: string }>)
    : [];
  const submitted = Boolean(last(params.plant));
  const plant = (last(params.plant) || plants[0]?.plant || '').toUpperCase();
  const dateFrom = last(params.dateFrom) || today;
  const dateTo = last(params.dateTo) || addDays(today, 13 * 7);
  const periodRaw = last(params.period);
  const period: CapacityPeriod = (CAPACITY_PERIODS as readonly string[]).includes(periodRaw) ? (periodRaw as CapacityPeriod) : 'WEEK';
  const wdpwRaw = last(params.workingDaysPerWeek);
  const wdpw = wdpwRaw ? Number(wdpwRaw) : DEFAULT_WORKING_DAYS_PER_WEEK;
  const includePlanned = submitted ? last(params.includePlannedOrders) === '1' : true;
  const statuses = submitted ? all(params.statuses) : [...CAPACITY_ORDER_STATUSES];
  const limitRaw = last(params.limit);
  const limit = limitRaw ? Number(limitRaw) : CAPACITY_LOAD_DEFAULT_LIMIT;

  let report: CapacityLoadReport | null = null;
  let problem: string | null = null;
  if (allowed && plant && submitted) {
    try {
      report = await loadCapacityReport({
        client, plant, workCenterFrom: last(params.workCenterFrom), workCenterTo: last(params.workCenterTo),
        capacityCategory: last(params.capacityCategory), dateFrom, dateTo, period, workingDaysPerWeek: wdpw,
        includePlannedOrders: includePlanned, statuses, limit,
      }, session.user.capabilities);
    } catch (error) {
      if (!(error instanceof CapacityLoadError)) throw error;
      problem = `${error.message} ${error.remedy}`;
    }
  }
  const header = report?.warnings.filter((w) => w.scope === 'HEADER') ?? [];

  return (
    <main className="mx-auto max-w-[96rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CAPACITY_LOAD_CAPABILITY} · CM01</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Capacity load</h1>
          <div className="flex gap-2">
            <Link href="/production/work-centers" className="btn btn-default min-h-11 sm:min-h-8">Work centers</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Available capacity of a plant&apos;s work centers against the load derived from production and planned orders. This is
          calculated on every run from the standard values on the orders; no capacity requirement is stored. Nothing is scheduled or written here.
        </p>
      </header>

      {!allowed ? (
        <p role="status" className="text-sm text-ink-soft">You do not hold {CAPACITY_LOAD_CAPABILITY}. Ask for it to display capacity load.</p>
      ) : (
        <form method="get" className="panel flex flex-wrap items-end gap-3 p-3" aria-label="Selection">
          <label>
            <span className="field-label">Plant</span>
            <select name="plant" defaultValue={plant} className="field-input">
              {plants.map((p) => <option key={p.plant} value={p.plant}>{p.plant} — {p.name}</option>)}
            </select>
          </label>
          <label><span className="field-label">Work center from</span><input name="workCenterFrom" defaultValue={last(params.workCenterFrom)} maxLength={8} className="field-input code w-28" /></label>
          <label><span className="field-label">Work center to</span><input name="workCenterTo" defaultValue={last(params.workCenterTo)} maxLength={8} className="field-input code w-28" /></label>
          <label><span className="field-label">Capacity category</span><input name="capacityCategory" defaultValue={last(params.capacityCategory)} maxLength={3} placeholder="All" className="field-input code w-20" /></label>
          <label><span className="field-label">From</span><input type="date" name="dateFrom" defaultValue={dateFrom} className="field-input" /></label>
          <label><span className="field-label">To</span><input type="date" name="dateTo" defaultValue={dateTo} className="field-input" /></label>
          <label>
            <span className="field-label">Period</span>
            <select name="period" defaultValue={period} className="field-input">
              {CAPACITY_PERIODS.map((p) => <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>)}
            </select>
          </label>
          <label><span className="field-label">Working days per week (fallback)</span><input type="number" min={1} max={7} name="workingDaysPerWeek" defaultValue={wdpw} className="field-input w-24" /></label>
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="includePlannedOrders" value="1" defaultChecked={includePlanned} /> Planned orders</label>
          <fieldset className="flex items-center gap-3">
            <legend className="field-label">Order status</legend>
            {CAPACITY_ORDER_STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-1 text-sm"><input type="checkbox" name="statuses" value={s} defaultChecked={statuses.includes(s)} /> {s}</label>
            ))}
          </fieldset>
          <label><span className="field-label">Work centers (max {CAPACITY_LOAD_LIMIT_CEILING})</span><input name="limit" defaultValue={limitRaw || String(CAPACITY_LOAD_DEFAULT_LIMIT)} inputMode="numeric" className="field-input w-24" /></label>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Display load</button>
        </form>
      )}

      {problem && <p role="alert" className="panel p-4 text-sm text-signal-error">{problem}</p>}

      {report && (
        <>
          <section className="panel space-y-2 p-4" aria-label="Header">
            <h2 className="panel-title">Plant {report.plant}, {report.dateFrom} to {report.dateTo}, by {report.period.toLowerCase()}</h2>
            <p className="text-sm">
              {report.calendarFallbackCount > 0
                ? <>Declared <strong>{report.workingDaysPerWeek} working days per week</strong> used for <strong>{report.calendarFallbackCount}</strong> capacit{report.calendarFallbackCount === 1 ? 'y' : 'ies'} without calendar rules. </>
                : null}
              Scanned <strong>{report.scanned.workCenters}</strong> work center{report.scanned.workCenters === 1 ? '' : 's'},{' '}
              <strong>{report.scanned.orders}</strong> production order{report.scanned.orders === 1 ? '' : 's'} and <strong>{report.scanned.plannedOrders}</strong> planned order{report.scanned.plannedOrders === 1 ? '' : 's'}.
              {' '}Overall: available {fmt(report.totals.available)}, required {fmt(report.totals.required)}, load <Load value={report.totals.loadPercent} />.
            </p>
            {report.truncated && (
              <p role="alert" className="text-sm font-medium text-signal-warn">
                {report.notScanned} work center{report.notScanned === 1 ? ' was' : 's were'} not scanned: the limit was reached, so this report is not complete.
              </p>
            )}
          </section>

          <ul role="alert" className="panel space-y-1 p-3 text-sm text-signal-warn" aria-label="Warnings">
            {header.map((w) => <li key={w.code}>{w.message}</li>)}
          </ul>

          <section className="panel overflow-x-auto" aria-label="Capacity load">
            {report.rows.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">No work center with a capacity matches this selection in plant {report.plant}.</p>
            ) : (
              <table className="grid-table text-xs">
                <thead>
                  <tr>
                    <th>Work center</th><th>Capacity</th><th>Unit</th>
                    {report.periods.map((p) => <th key={p} className="code">{p}</th>)}
                    <th>Available</th><th>Required</th><th>Load</th><th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={`${row.workCenter}|${row.capacityCategory}`} className={row.unassigned ? 'text-ink-soft' : undefined}>
                      <td><span className="code">{row.workCenter}</span> {row.workCenterDescription}</td>
                      <td>
                        {row.unassigned ? <em>Unassigned</em> : <span className="code">{row.capacityCategory}</span>}
                        {row.availableUnknown && <span className="chip chip-warn ml-1" title="No operating times are maintained">capacity unknown</span>}
                      </td>
                      <td className="code">{row.unit ?? '—'}</td>
                      {row.cells.map((c) => (
                        <td key={c.period} className="code">
                          <Link href={drillDownFor(report.plant, report.periodRanges[c.period])} className="block underline" aria-label={`Orders of ${row.workCenter} in ${c.period}`}>
                            {fmt(c.required)} / {row.availableUnknown ? '?' : fmt(c.available)}<br /><Load value={c.loadPercent} />
                          </Link>
                        </td>
                      ))}
                      <td className="code">{row.availableUnknown ? 'unknown' : fmt(row.total.available)}</td>
                      <td className="code">{fmt(row.total.required)}</td>
                      <td className="code"><Load value={row.total.loadPercent} /></td>
                      <td>
                        {row.warnings.length > 0 && (
                          <details open><summary>{row.warnings.length} warning{row.warnings.length === 1 ? '' : 's'}</summary>
                            <ul className="max-w-sm">{row.warnings.map((w, i) => <li key={i} className="text-ink-soft">{w.message}</li>)}</ul>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  );
}
