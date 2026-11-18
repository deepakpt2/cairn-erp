/**
 * Cost allocation cycles — CFG.COST.ALLOCATION.DEFINE (KSU1/KSU2/KSU3, KSV1/KSV2/KSV3) with the run
 * panel: CO.ASSESSMENT.EXECUTE (KSU5) and CO.DISTRIBUTION.EXECUTE (KSV5). GET: `area`, `cycle`.
 *
 * A cycle's segments relieve sender cost centres of their net posted cost and charge receiver cost
 * centres by fixed percentages, portions or amounts, through the account named on posting event
 * CO_ASSESSMENT; a distribution keeps each cost on its original G/L account. Receivers are cost centres or groups.
 */
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { planningContext } from '@/modules/foundation/activity-rate-definition';
import { listPlanningAreas } from '@/modules/foundation/cost-center-planning';
import {
  ALLOCATION_CYCLE_ROUTE,
  ALLOCATION_DEFINE_CAPABILITY,
  ALLOCATION_EXECUTE_CAPABILITY,
  DISTRIBUTION_EXECUTE_CAPABILITY,
  getCycle,
  listCycles,
  listRuns,
} from '@/modules/foundation/cost-allocation-cycle';

import { CancelRunForm, CycleForm, DeleteForm, ExecutePanel, NodeForm, SegmentForm } from './CycleForms';
import type { ReactNode } from 'react';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

export default async function AllocationCyclesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ALLOCATION_CYCLE_ROUTE);
  const canDefine = can(session, ALLOCATION_DEFINE_CAPABILITY);
  const canAssess = can(session, ALLOCATION_EXECUTE_CAPABILITY);
  const canDistribute = can(session, DISTRIBUTION_EXECUTE_CAPABILITY);
  const canExecute = canAssess || canDistribute;
  const Frame = ({ children, width }: { children: ReactNode; width?: '6xl' | '7xl' }) => (
    <Page
      title="Cost allocation cycles"
      code={<>{ALLOCATION_DEFINE_CAPABILITY} · KSU1 / KSU2 / KSU3 · KSV1 / KSV2 / KSV3 · {ALLOCATION_EXECUTE_CAPABILITY} · KSU5 · {DISTRIBUTION_EXECUTE_CAPABILITY} · KSV5</>}
      width={width}
      actions={<LinkButton href="/controlling/cost-center-report">Actual/plan report</LinkButton>}
      description={
        <p className="max-w-3xl text-sm text-ink-soft">
        Assessment moves the actual cost of service cost centres to the centres that consumed their services, bundled through one
        assessment account; distribution does the same but keeps each cost on the account it was posted to. Receivers are cost centres or
        cost centre groups; a group&apos;s weight applies to each of its centres.
        </p>
      }
    >
      {children}
    </Page>
  );
  if (!canDefine && !canExecute) {
    return (
      <Frame>
        <p role="status" className="text-sm text-ink-soft">You do not hold the cycle capabilities. Ask for {ALLOCATION_DEFINE_CAPABILITY}, {ALLOCATION_EXECUTE_CAPABILITY} or {DISTRIBUTION_EXECUTE_CAPABILITY}.</p>
      </Frame>
    );
  }

  const params = await searchParams;
  const client = session.user.client;
  const areas = await listPlanningAreas(client);
  const area = (last(params.area) || areas[0]?.controllingArea || '').toUpperCase();
  const cycles = area ? await listCycles(client, area) : [];
  const selectedCode = last(params.cycle).toUpperCase();
  const selected = area && selectedCode ? await getCycle(client, area, selectedCode) : null;
  const runs = area ? await listRuns(client, area) : [];
  const today = new Date().toISOString().slice(0, 10);
  const fiscalYear = Number(today.slice(0, 4));
  const context = area ? await planningContext(client, area, fiscalYear) : null;
  const regular = context?.periods.filter((p) => p.periodType === 'REGULAR') ?? [];
  const current = regular.find((p) => p.start <= today && today <= p.end)?.period ?? regular[0]?.period ?? 1;

  return (
    <Frame width="7xl">

      <form method="get" className="panel flex flex-wrap items-end gap-3 p-3" aria-label="Controlling area">
        <label>
          <span className="field-label">Controlling area</span>
          <select name="area" defaultValue={area} className="field-input">
            {areas.map((a) => <option key={a.controllingArea} value={a.controllingArea}>{a.controllingArea} — {a.name} ({a.currency})</option>)}
          </select>
        </label>
        <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Open</button>
      </form>

      {last(params.deleted) && (
        <p role="status" className="panel p-3 text-sm">Cycle {last(params.deleted).toUpperCase()} deleted.</p>
      )}

      <section className="panel overflow-x-auto" aria-label="Cycles">
        <h2 className="panel-title px-4 pt-4">Cycles of {area}</h2>
        {cycles.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">No cycle is defined in this controlling area.</p>
        ) : (
          <table className="grid-table">
            <thead><tr><th>Cycle</th><th>Name</th><th>Category</th><th>Valid</th><th>Segments</th><th>Status</th></tr></thead>
            <tbody>
              {cycles.map((c) => (
                <tr key={c.cycleCode}>
                  <td className="code"><Link href={`${ALLOCATION_CYCLE_ROUTE}?area=${area}&cycle=${c.cycleCode}`} className="underline">{c.cycleCode}</Link></td>
                  <td>{c.name}</td>
                  <td className="text-xs">{c.category.toLowerCase()}</td>
                  <td className="text-xs">{c.validFrom} to {c.validTo}</td>
                  <td>{c.segments}</td>
                  <td><span className={c.isActive ? 'chip' : 'chip chip-warn'}>{c.isActive ? 'active' : 'inactive'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected && (
        <section className="panel space-y-4 p-4" aria-label={`Cycle ${selected.cycleCode}`}>
          <h2 className="panel-title">{selected.cycleCode} — {selected.name} · {selected.category.toLowerCase()} · {selected.validFrom} to {selected.validTo}</h2>
          {selected.segments.length === 0 && <p className="text-sm text-ink-soft">This cycle has no segment yet.</p>}
          {selected.segments.map((s) => (
            <div key={s.segmentNumber} className="space-y-2 border-t border-line pt-3">
              <h3 className="text-sm font-semibold">
                Segment {s.segmentNumber} — {s.name} · sender rule posted amounts · receiver rule {s.receiverRule.toLowerCase().replace('_', ' ')}
                {s.costElementFrom ? ` · cost elements ${s.costElementFrom}–${s.costElementTo}` : ' · all cost elements'}
              </h3>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-1">
                  <h4 className="field-label">Senders</h4>
                  {s.senders.map((n) => (
                    <p key={n.itemNumber} className="code text-xs">{n.itemNumber}. {n.costCenter ?? `group ${n.groupName}`}</p>
                  ))}
                  {canDefine && [...s.senders, null].map((n, i) => (
                    <NodeForm key={`s${i}`} area={area} cycleCode={selected.cycleCode} segmentNumber={s.segmentNumber} kind="sender"
                      item={n ?? undefined} itemNumber={n?.itemNumber ?? Math.max(0, ...s.senders.map((x) => x.itemNumber)) + 1} />
                  ))}
                </div>
                <div className="space-y-1">
                  <h4 className="field-label">Receivers</h4>
                  {s.receivers.map((n) => (
                    <p key={n.itemNumber} className="code text-xs">{n.itemNumber}. {n.costCenter ?? `group ${n.groupName}`} · weight {n.weight}</p>
                  ))}
                  {canDefine && [...s.receivers, null].map((n, i) => (
                    <NodeForm key={`r${i}`} area={area} cycleCode={selected.cycleCode} segmentNumber={s.segmentNumber} kind="receiver"
                      item={n ?? undefined} itemNumber={n?.itemNumber ?? Math.max(0, ...s.receivers.map((x) => x.itemNumber)) + 1} />
                  ))}
                </div>
              </div>
              {canDefine && (
                <>
                  <SegmentForm area={area} cycleCode={selected.cycleCode} segment={s} nextNumber={s.segmentNumber} />
                  <DeleteForm area={area} cycleCode={selected.cycleCode} segmentNumber={s.segmentNumber} label={`Remove segment ${s.segmentNumber}`} />
                </>
              )}
            </div>
          ))}
          {canDefine && (
            <div className="border-t border-line pt-3">
              <SegmentForm area={area} cycleCode={selected.cycleCode} nextNumber={Math.max(0, ...selected.segments.map((s) => s.segmentNumber)) + 1} />
            </div>
          )}
        </section>
      )}

      {canDefine && area && <CycleForm key={selected?.cycleCode ?? 'new'} area={area} cycle={selected} />}
      {canDefine && selected && <DeleteForm area={area} cycleCode={selected.cycleCode} label={`Delete cycle ${selected.cycleCode}`} />}

      {canExecute && area && cycles.some((c) => (c.category === 'DISTRIBUTION' ? canDistribute : canAssess)) && (
        <ExecutePanel area={area} cycles={cycles.filter((c) => (c.category === 'DISTRIBUTION' ? canDistribute : canAssess))} fiscalYear={fiscalYear} periods={regular.map((p) => p.period)} defaultPeriod={current} />
      )}

      <section className="panel overflow-x-auto" aria-label="Runs">
        <h2 className="panel-title px-4 pt-4">Runs</h2>
        {runs.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">No cycle of this controlling area has run yet.</p>
        ) : (
          <table className="grid-table">
            <thead><tr><th>Cycle</th><th>Category</th><th>Period</th><th>Status</th><th>Amount</th><th>Document</th><th>Iterations</th><th>By</th><th></th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId}>
                  <td className="code">{r.cycleCode}</td>
                  <td className="text-xs">{r.category.toLowerCase()}</td>
                  <td>{r.period}/{r.fiscalYear}</td>
                  <td><span className={r.status === 'EXECUTED' ? 'chip chip-ok' : 'chip chip-warn'}>{r.status.toLowerCase()}</span>{r.cancelReason ? <span className="text-xs text-ink-soft"> {r.cancelReason}</span> : null}</td>
                  <td className="code">{r.assessedTotal} {r.currency}</td>
                  <td className="code"><Link href={`/finance/journal/document?document=${r.documentNumber}`} className="underline">{r.displayNumber}</Link></td>
                  <td>{r.iterations}</td>
                  <td className="text-xs">{r.executedBy}</td>
                  <td>{(r.category === 'DISTRIBUTION' ? canDistribute : canAssess) && r.status === 'EXECUTED' ? <CancelRunForm area={area} runId={r.runId} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Frame>
  );
}
