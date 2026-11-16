/**
 * MRP exception monitor — MD06, guarded by PROD.MRP.EXCEPTION. Read-only.
 *
 * GET: `plant`, `materialFrom`, `materialTo`, `mrpType`, `horizonEnd`, `exceptions` (repeatable), `limit`.
 * For one plant it lists the materials MRP plans that carry an exception, most urgent first, each drilling to
 * the stock/requirements list (MD04) with the material and plant filled in. The counts are MD04's own; the
 * scan is bounded and says how many materials it did not reach. Nothing is planned or written.
 */
import { sql } from 'drizzle-orm';
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import {
  EXCEPTION_CODES,
  MRP_EXCEPTION_CAPABILITY,
  MRP_EXCEPTION_DEFAULT_LIMIT,
  MRP_EXCEPTION_LIMIT_CEILING,
  MRP_EXCEPTION_ROUTE,
  MrpExceptionError,
  mrpExceptionMonitor,
  type MrpExceptionResult,
} from '@/modules/production/mrp-exception-monitor';
import type { ExceptionCode } from '@/modules/production/stock-requirements';

export const dynamic = 'force-dynamic';

const LABEL: Record<ExceptionCode, string> = { SHORTAGE: 'Shortage', SAFETY_BREACH: 'Safety stock breach', PAST_DUE: 'Past due' };

function all(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}
function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

export default async function MrpExceptionMonitorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(MRP_EXCEPTION_ROUTE);
  const params = await searchParams;
  const allowed = can(session, MRP_EXCEPTION_CAPABILITY);
  const client = session.user.client;
  const plants = allowed
    ? ((await withTenant(client, (tx) => tx.execute(sql`select plant, name from plant where client = ${client} order by plant`))) as unknown as Array<{ plant: string; name: string }>)
    : [];
  const plant = (last(params.plant) || plants[0]?.plant || '').toUpperCase();
  const exceptions = all(params.exceptions).filter((c): c is ExceptionCode => (EXCEPTION_CODES as readonly string[]).includes(c));
  const mrpTypeRaw = last(params.mrpType);
  const requested = last(params.limit);
  const limit = requested ? Number(requested) : MRP_EXCEPTION_DEFAULT_LIMIT;
  const submitted = Boolean(last(params.plant));

  let result: MrpExceptionResult | null = null;
  let problem: string | null = null;
  if (allowed && plant && submitted) {
    try {
      result = await mrpExceptionMonitor({
        client, today: new Date().toISOString().slice(0, 10), plant, limit,
        selection: {
          materialFrom: last(params.materialFrom), materialTo: last(params.materialTo),
          mrpType: mrpTypeRaw === 'REQUIREMENTS' || mrpTypeRaw === 'REORDER' ? mrpTypeRaw : undefined,
          horizonEnd: last(params.horizonEnd), exceptions, mrpArea: last(params.mrpArea),
        },
      }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } });
    } catch (error) {
      if (!(error instanceof MrpExceptionError)) throw error;
      problem = `${error.message}${error.remedy ? ` ${error.remedy}` : ''}`;
    }
  }

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{MRP_EXCEPTION_CAPABILITY} · MD06</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">MRP exception monitor</h1>
          <div className="flex gap-2">
            <Link href="/production/stock-requirements" className="btn btn-default min-h-11 sm:min-h-8">Stock/requirements list</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Every material of a plant that MRP plans (type REQUIREMENTS or REORDER) and that carries a shortage, a safety stock
          breach or a past-due element, most urgent first. The counts are the stock/requirements list&apos;s own, recomputed on every
          execution; open any row to see the material&apos;s list. Nothing is planned, proposed or written here.
        </p>
      </header>

      {!allowed ? (
        <p role="status" className="text-sm text-ink-soft">You do not hold {MRP_EXCEPTION_CAPABILITY}. Ask for it to read the exception monitor.</p>
      ) : (
        <form method="get" className="panel flex flex-wrap items-end gap-3 p-3" aria-label="Selection">
          <label>
            <span className="field-label">Plant</span>
            <select name="plant" defaultValue={plant} className="field-input">
              {plants.map((p) => <option key={p.plant} value={p.plant}>{p.plant} — {p.name}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">Material from</span>
            <input name="materialFrom" defaultValue={last(params.materialFrom)} maxLength={40} className="field-input code w-36" />
          </label>
          <label>
            <span className="field-label">Material to</span>
            <input name="materialTo" defaultValue={last(params.materialTo)} maxLength={40} className="field-input code w-36" />
          </label>
          <label>
            <span className="field-label">MRP type</span>
            <select name="mrpType" defaultValue={mrpTypeRaw} className="field-input">
              <option value="">Both planned types</option>
              <option value="REQUIREMENTS">REQUIREMENTS</option>
              <option value="REORDER">REORDER</option>
            </select>
          </label>
          <label>
            <span className="field-label">Horizon end</span>
            <input type="date" name="horizonEnd" defaultValue={last(params.horizonEnd)} className="field-input" />
          </label>
          <label>
            <span className="field-label">Materials to scan (max {MRP_EXCEPTION_LIMIT_CEILING})</span>
            <input name="limit" defaultValue={requested || String(MRP_EXCEPTION_DEFAULT_LIMIT)} inputMode="numeric" className="field-input w-24" />
          </label>
          <fieldset className="flex items-center gap-3">
            <legend className="field-label">Exceptions</legend>
            {EXCEPTION_CODES.map((code) => (
              <label key={code} className="flex items-center gap-1 text-sm">
                <input type="checkbox" name="exceptions" value={code} defaultChecked={exceptions.includes(code)} />
                {LABEL[code]}
              </label>
            ))}
          </fieldset>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Run monitor</button>
        </form>
      )}

      {problem && <p role="alert" className="panel p-4 text-sm text-signal-error">{problem}</p>}

      {result && (
        <>
          <section className="panel space-y-2 p-4" aria-label="Population">
            <h2 className="panel-title">Plant {result.plant} on {result.today}</h2>
            <p className="text-sm">
              Scanned <strong>{result.population.scanned}</strong> planned material{result.population.scanned === 1 ? '' : 's'}; <strong>{result.population.matched}</strong>{' '}
              carr{result.population.matched === 1 ? 'ies' : 'y'} an exception.{' '}
              {result.population.excludedNoMrpType} not planned and not scanned ({result.population.excludedNone} with MRP type NONE, {result.population.excludedBlank} with none maintained).
              {result.population.failed > 0 ? ` ${result.population.failed} could not be listed.` : ''} Took {result.elapsedMs} ms.
            </p>
            {result.truncated && (
              <p role="alert" className="text-sm font-medium text-signal-warn">
                The scan stopped at its limit of {result.population.limit}: {result.population.notScanned} material{result.population.notScanned === 1 ? ' was' : 's were'} not scanned,
                so this worklist is not complete. Raise the limit (up to {MRP_EXCEPTION_LIMIT_CEILING}) or narrow the material range.
              </p>
            )}
            <dl className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
              {EXCEPTION_CODES.map((code) => (
                <div key={code}><dt className="field-label">{LABEL[code]}</dt><dd className="code">{result.totals[code]}</dd></div>
              ))}
            </dl>
          </section>

          {result.warnings.length > 0 && (
            <ul role="alert" className="panel space-y-1 p-3 text-sm text-signal-warn">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          <section className="panel overflow-x-auto" aria-label="Worklist">
            {result.materials.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">
                Nothing in plant {result.plant} carries an exception among the {result.population.scanned} planned material{result.population.scanned === 1 ? '' : 's'} scanned.
              </p>
            ) : (
              <table className="grid-table text-xs">
                <thead>
                  <tr>
                    <th>Material</th><th>MRP type</th><th>First exception</th><th>Lowest balance</th><th>Closing balance</th>
                    <th>Shortage</th><th>Safety breach</th><th>Past due</th><th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {result.materials.map((m) => (
                    <tr key={m.materialNumber}>
                      <td>
                        <Link href={result.drillDown(m.materialNumber)} className="underline"><span className="code">{m.materialNumber}</span></Link>{' '}
                        {m.materialDescription}
                      </td>
                      <td className="code">{m.mrpType}</td>
                      <td className="code">{m.firstExceptionDate ?? '—'} <span className="font-sans text-ink-faint">{LABEL[m.worst].toLowerCase()}</span></td>
                      <td className="code">{m.lowestBalance === null ? '—' : m.lowestBalance.toFixed(3)} {m.baseUnit}</td>
                      <td className="code">{m.closingBalance.toFixed(3)} {m.baseUnit}</td>
                      <td className="code">{m.counts.SHORTAGE}</td>
                      <td className="code">{m.counts.SAFETY_BREACH}</td>
                      <td className="code">{m.counts.PAST_DUE}</td>
                      <td>
                        {m.listTruncated ? <span className="chip chip-warn">list truncated</span> : null}
                        {m.warnings.length > 0 ? (
                          <details className="text-ink-soft"><summary>{m.warnings.length} warning{m.warnings.length === 1 ? '' : 's'}</summary>
                            <ul>{m.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                          </details>
                        ) : null}
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
