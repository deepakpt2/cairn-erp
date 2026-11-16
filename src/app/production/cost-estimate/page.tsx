/**
 * Standard cost estimate — CK11N (create) and CK13N (display), guarded by PROD.COST.ESTIMATE.CREATE.
 *
 * GET: `materialNumber`, `plant`, `costingDate`, `costingVersion` (blank: the SAVED estimate of that date),
 * `costingLotSize`, `planVersion`. Create runs through `actions.ts`; both read through the service.
 * The estimate is saved and nothing is released: no price is written here.
 *
 * Rules shown on screen (no costing variant exists to configure them): a bought component costs its
 * price by price control (standard or moving average) per price unit; a made component is costed from its
 * own components and operations; an operation costs its quantity at the plan activity price of its work
 * centre's cost centre and activity type; no overhead is applied (no costing sheet).
 */
import { sql } from 'drizzle-orm';
import Link from 'next/link';
import { randomUUID } from 'node:crypto';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import {
  COST_ESTIMATE_CAPABILITY,
  COST_ESTIMATE_ROUTE,
  CostEstimateError,
  DEFAULT_PLAN_VERSION,
  getCostEstimate,
  listCostEstimates,
  type CostEstimateSummary,
  type CostEstimateView,
} from '@/modules/production/cost-estimate';

import { CostEstimateForm } from './CostEstimateForm';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

const SOURCE: Record<string, string> = {
  STANDARD: 'standard price', MOVING_AVERAGE: 'moving average price', COSTED: 'costed from its own structure',
  ACTIVITY_PLAN: 'plan activity price', NOT_COSTED: 'not costed',
};

export default async function CostEstimatePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(COST_ESTIMATE_ROUTE);
  const allowed = can(session, COST_ESTIMATE_CAPABILITY);
  const params = await searchParams;
  const client = session.user.client;
  const materialNumber = last(params.materialNumber).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const costingDate = last(params.costingDate) || today;
  const plants = allowed
    ? ((await withTenant(client, (tx) => tx.execute(sql`select plant, name from plant where client = ${client} order by plant`))) as unknown as Array<{ plant: string; name: string }>)
    : [];
  const plant = (last(params.plant) || plants[0]?.plant || '').toUpperCase();
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };

  let estimate: CostEstimateView | null = null;
  let standing: CostEstimateSummary[] = [];
  let problem: string | null = null;
  if (allowed && materialNumber && plant) {
    try {
      standing = await listCostEstimates({ client, materialNumber, plant }, { authorization });
      if (last(params.costingVersion) || standing.some((e) => e.costingDate === costingDate && e.status === 'SAVED')) {
        estimate = await getCostEstimate({ client, materialNumber, plant, costingDate, costingVersion: last(params.costingVersion) || undefined }, { authorization });
      }
    } catch (error) {
      if (!(error instanceof CostEstimateError)) throw error;
      problem = `${error.message}${error.remedy ? ` ${error.remedy}` : ''}`;
    }
  }

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{COST_ESTIMATE_CAPABILITY} · CK11N / CK13N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Standard cost estimate</h1>
          <div className="flex gap-2">
            <Link href="/production/bom-explosion" className="btn btn-default min-h-11 sm:min-h-8">BOM explosion</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Costs one made material in one plant on a costing date: the multi-level BOM costed bottom-up (a made component from its own
          components and operations, never from its standard price), plus the routing operations at plan activity prices. The estimate is
          saved with its itemization; a newer one for the same date supersedes it and the old one stays on record. Nothing is released:
          no price is changed.
        </p>
        <ul className="mt-2 max-w-3xl list-disc space-y-0.5 pl-5 text-xs text-ink-soft">
          <li>Bought component: standard or moving average price (by its price control) divided by its price unit; a zero price is refused.</li>
          <li>Operation: its quantity against its base quantity, at the plan activity price (fixed + variable per price unit) of its work centre&apos;s cost centre and activity type, plan version {DEFAULT_PLAN_VERSION} unless another is entered.</li>
          <li>Overhead is zero: no costing sheet or overhead rate exists, so none is applied or approximated.</li>
          <li>Not costed: co-products, special procurement, external processing, subcontracting. These are refused by name, not estimated.</li>
        </ul>
      </header>

      {!allowed ? (
        <p role="status" className="text-sm text-ink-soft">You do not hold {COST_ESTIMATE_CAPABILITY}. Ask for it to create or display cost estimates.</p>
      ) : (
        <>
          <CostEstimateForm
            plants={plants} plant={plant} materialNumber={materialNumber} costingDate={costingDate}
            costingLotSize={last(params.costingLotSize)} planVersion={last(params.planVersion) || DEFAULT_PLAN_VERSION} requestKey={randomUUID()}
          />

          <form method="get" className="panel flex flex-wrap items-end gap-3 p-3" aria-label="Display a cost estimate">
            <label>
              <span className="field-label">Material</span>
              <input name="materialNumber" defaultValue={materialNumber} required maxLength={40} className="field-input code w-36" />
            </label>
            <label>
              <span className="field-label">Plant</span>
              <select name="plant" defaultValue={plant} className="field-input">
                {plants.map((p) => <option key={p.plant} value={p.plant}>{p.plant} — {p.name}</option>)}
              </select>
            </label>
            <label>
              <span className="field-label">Costing date</span>
              <input type="date" name="costingDate" defaultValue={costingDate} className="field-input" />
            </label>
            <label>
              <span className="field-label">Costing version</span>
              <input name="costingVersion" defaultValue={last(params.costingVersion)} maxLength={2} className="field-input code w-16" placeholder="current" />
            </label>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Display (CK13N)</button>
          </form>
        </>
      )}

      {problem && <p role="alert" className="panel p-4 text-sm text-signal-error">{problem}</p>}

      {standing.length > 0 && (
        <section className="panel overflow-x-auto" aria-label="Estimates that stand">
          <h2 className="panel-title px-4 pt-4">Estimates of {materialNumber} in plant {plant}</h2>
          <table className="grid-table text-xs">
            <thead><tr><th>Costing date</th><th>Version</th><th>Status</th><th>Lot size</th><th>Total</th><th>Unit cost</th><th>Costed</th></tr></thead>
            <tbody>
              {standing.map((e) => {
                const query = new URLSearchParams({ materialNumber: e.materialNumber, plant: e.plant, costingDate: e.costingDate, costingVersion: e.costingVersion });
                return (
                  <tr key={`${e.costingDate}/${e.costingVersion}`}>
                    <td className="code"><Link href={`${COST_ESTIMATE_ROUTE}?${query.toString()}`} className="underline">{e.costingDate}</Link></td>
                    <td className="code">{e.costingVersion}</td>
                    <td><span className={e.status === 'SAVED' ? 'chip chip-ok' : 'chip chip-warn'}>{e.status === 'SAVED' ? 'saved' : 'superseded'}</span></td>
                    <td className="code">{e.costingLotSize}</td>
                    <td className="code">{e.totalCost} {e.currency}</td>
                    <td className="code">{e.unitCost} {e.currency}</td>
                    <td>{e.costedBy}, {e.costedAt.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {estimate && (
        <section className="panel space-y-3 p-4" aria-label="Cost estimate">
          <h2 className="panel-title">
            {estimate.materialNumber}{estimate.materialName ? ` — ${estimate.materialName}` : ''} · plant {estimate.plant} · costing date {estimate.costingDate} · version {estimate.costingVersion}{' '}
            <span className={estimate.status === 'SAVED' ? 'chip chip-ok' : 'chip chip-warn'}>{estimate.status === 'SAVED' ? 'saved' : 'superseded'}</span>
            {estimate.replayed ? <span className="chip ml-1">already saved</span> : null}
          </h2>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="field-label">Costing lot size</dt><dd className="code">{estimate.costingLotSize} {estimate.unit}</dd></div>
            <div><dt className="field-label">Total at the lot size</dt><dd className="code font-semibold">{estimate.totalCost} {estimate.currency}</dd></div>
            <div><dt className="field-label">Unit cost (total ÷ lot size)</dt><dd className="code font-semibold">{estimate.unitCost} {estimate.currency}</dd></div>
            <div><dt className="field-label">Resolved</dt><dd>production version <span className="code">{estimate.productionVersion}</span>, controlling area <span className="code">{estimate.controllingArea}</span>, plan version <span className="code">{estimate.planVersion}</span></dd></div>
          </dl>
          <table className="grid-table text-xs" aria-label="Cost component split">
            <thead><tr><th>Cost component</th><th>Amount ({estimate.currency})</th></tr></thead>
            <tbody>
              <tr><td>Material (every bought component, at every level)</td><td className="code">{estimate.materialCost}</td></tr>
              <tr><td>Internal activity (every operation, at every level)</td><td className="code">{estimate.activityCost}</td></tr>
              <tr><td>Overhead</td><td className="code">{estimate.overheadCost} <span className="font-sans text-ink-soft">— {estimate.overheadNote}</span></td></tr>
              <tr className="font-semibold"><td>Total</td><td className="code">{estimate.totalCost}</td></tr>
            </tbody>
          </table>

          <div className="overflow-x-auto">
            <table className="grid-table text-xs" aria-label="Itemization">
              <thead>
                <tr><th>#</th><th>Item</th><th>Quantity</th><th>Price</th><th>Per</th><th>Price source</th><th>Amount ({estimate.currency})</th></tr>
              </thead>
              <tbody>
                {estimate.items.map((i) => (
                  <tr key={i.lineNumber} className={i.inTotal ? '' : 'text-ink-soft'}>
                    <td className="code">{i.lineNumber}</td>
                    <td style={{ paddingLeft: `${i.level * 1.25}rem` }}>
                      {i.itemType === 'MATERIAL' ? (
                        <><span className="code">{i.componentMaterial}</span> <span className="text-ink-faint">level {i.level}</span>{i.itemText ? <div className="text-ink-faint">{i.itemText}</div> : null}</>
                      ) : (
                        <>
                          <span className="code">op {i.operationNumber}</span> work centre <span className="code">{i.workCenter}</span>
                          {i.costCenter ? <> · cost centre <span className="code">{i.costCenter}</span> · activity <span className="code">{i.activityType}</span></> : null}
                          {i.itemText ? <div className="text-ink-faint">{i.itemText}</div> : null}
                        </>
                      )}
                    </td>
                    <td className="code">{i.quantity} {i.unit ?? ''}</td>
                    <td className="code">{i.price}</td>
                    <td className="code">{i.priceUnit}</td>
                    <td>{SOURCE[i.priceSource] ?? i.priceSource}</td>
                    <td className="code">{i.amount}{i.inTotal ? '' : ' (in the line above)'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-soft">
            Lines in grey explain a rolled-up line above them and are not added again. Costed by {estimate.costedBy} on {estimate.costedAt.slice(0, 16).replace('T', ' ')}.
            This estimate is not released: the material price is unchanged.
          </p>
        </section>
      )}
    </main>
  );
}
