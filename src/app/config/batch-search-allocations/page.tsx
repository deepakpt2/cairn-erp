import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { ACTIVITY, listBatchSearchAllocations, NOT_EXECUTED, ROUTE } from '@/modules/inventory/batch-search-allocation';
import { listBatchSearchProcedures } from '@/modules/inventory/batch-search-procedure';
import { movementType } from '@/modules/inventory/schema';

import AllocationForm from './AllocationForm';

export const dynamic = 'force-dynamic';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Allocate an Inventory Management search procedure. OMCG is a search alias only. */
export default async function BatchSearchAllocationPage({
  searchParams,
}: {
  searchParams: Promise<{ movement?: string; q?: string; history?: string; new?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listBatchSearchAllocations(session.user.client);
  const procedures = await listBatchSearchProcedures(session.user.client);
  const movements = await withTenant(session.user.client, (tx) => tx.select({
    movementType: movementType.movementType,
    description: movementType.description,
  }).from(movementType).where(eq(movementType.client, session.user.client)).orderBy(asc(movementType.movementType)));
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? '';
  const editing = current.find((row) => row.movementType === params.movement?.trim().toUpperCase()) ?? null;
  const creating = params.new === '1' && !editing;
  const rows = query
    ? current.filter((row) => row.movementType.toLowerCase().includes(query) || row.searchProcedure.toLowerCase().includes(query))
    : current;
  const history = editing && params.history === '1'
    ? await withTenant(session.user.client, (tx) => changeHistory(tx, session.user.client, 'batch_search_allocation', editing.movementType))
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMCG</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Allocate IM search procedure</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OMCG allocates a search procedure to a movement type for own stock. The procedure must already stand on OMCY.
          Blank special stock is own stock. It is not a plant and not a wildcard. A check indicator of X records the request and does not check a batch.
          Opening this screen does not create an allocation, select a batch, or post. A closed period does not block it.
          Production and sales allocations are not this screen.
        </p>
      </header>

      <section className="border border-line bg-white p-3 text-sm">
        <h2 className="font-semibold">Not executed</h2>
        <ul className="mt-2 space-y-2">
          {NOT_EXECUTED.map((item) => (
            <li key={item.field}>
              <span className="code">{item.field}</span> · {item.title}. {item.reason}
            </li>
          ))}
        </ul>
      </section>

      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="text-sm">
          Movement type or procedure
          <input name="q" defaultValue={params.q ?? ''} className="field-input mt-1" />
        </label>
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Find</button>
        {canMaintain && <Link href={`${ROUTE}?new=1`} className="btn btn-primary min-h-11 sm:min-h-8">New</Link>}
      </form>

      <section className="overflow-x-auto border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="p-2">Movement type</th>
              <th className="p-2">Special stock</th>
              <th className="p-2">Search procedure</th>
              <th className="p-2">Transfer procedure</th>
              <th className="p-2">Check</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.movementType} className="border-b border-line">
                <td className="code p-2">{row.movementType}</td>
                <td className="p-2">Own stock</td>
                <td className="code p-2">{row.searchProcedure}</td>
                <td className="code p-2">{row.transferProcedure || '—'}</td>
                <td className="code p-2">{row.checkBatch === 'X' ? 'X' : '—'}</td>
                <td className="p-2 text-end">
                  <Link href={`${ROUTE}?movement=${encodeURIComponent(row.movementType)}&history=1`} className="underline">History</Link>
                  {canMaintain && (
                    <>
                      {' '}
                      <Link href={`${ROUTE}?movement=${encodeURIComponent(row.movementType)}`} className="underline">Change</Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-3 text-ink-soft">No allocation stands. None is created by opening this screen.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <AllocationForm canMaintain={canMaintain} editing={editing} creating={creating} movements={movements} procedures={procedures} />

      {history.length > 0 && (
        <section className="border border-line bg-white p-3 text-sm">
          <h2 className="font-semibold">History</h2>
          <ul className="mt-2 space-y-1">
            {history.map((entry) => (
              <li key={entry.id}>{entry.changeType} · {entry.changedBy} · {when(entry.changedAt)} · {entry.reason}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
