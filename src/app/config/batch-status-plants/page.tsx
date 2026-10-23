import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import {
  ACTIVITY,
  listPlantBatchStatus,
  listPlantStatusConversions,
} from '@/modules/inventory/batch-status-plant';

import PlantBatchStatusForm from './PlantBatchStatusForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/batch-status-plants';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Batch status management in plant. OMCU is a search alias only. */
export default async function PlantBatchStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ plant?: string; q?: string; history?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listPlantBatchStatus(session.user.client);
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? '';
  const editing = current.plants.find((row) => row.plant === params.plant) ?? null;
  const plants = query
    ? current.plants.filter((row) =>
      row.plant.toLowerCase().includes(query) || row.plantName.toLowerCase().includes(query))
    : current.plants;
  const conversions = editing
    ? await listPlantStatusConversions(session.user.client, editing.plant)
    : [];
  const history = editing && params.history === '1'
    ? await withTenant(session.user.client, (tx) => changeHistory(tx, session.user.client, 'batch_status_plant', editing.plant))
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMCU</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Batch status management in plant</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          {current.context.explanation} Selected is the character X. Not selected is blank. The plant name comes from the plant master.
          This screen does not create a plant, change OMCS, set an initial status, or post movement 341 or 342.
          Restricted use is not blocked stock. OMCE, OMCS, OMAB, and MSC1N are not this screen.
        </p>
      </header>

      <dl className="grid gap-3 border border-line bg-white p-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-ink-faint">Batch level</dt>
          <dd className="code">{current.context.batchLevel ?? 'unset'}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">Plant selection applies</dt>
          <dd>{current.context.applicable ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">OMCS indicator</dt>
          <dd>{current.context.clientStatusActive ? 'active' : 'not active'}</dd>
        </div>
      </dl>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Display only. Ask an administrator for {ACTIVITY}.</p>
      )}

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          Plant or name
          <input name="q" defaultValue={params.q ?? ''} className="field-input mt-1" />
        </label>
        {editing && <input type="hidden" name="plant" value={editing.plant} />}
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Find</button>
      </form>

      <section className="overflow-x-auto border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="p-2">Plant</th>
              <th className="p-2">Name</th>
              <th className="p-2">Selected</th>
              <th className="p-2">Effective</th>
              <th className="p-2">Changed by</th>
              <th className="p-2">Changed at</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {plants.map((row) => (
              <tr key={row.plant} className="border-b border-line">
                <td className="code p-2">{row.plant}</td>
                <td className="p-2">{row.plantName}</td>
                <td className="code p-2">{row.statusActive ?? 'blank'}</td>
                <td className="p-2">{row.effective ? 'yes' : 'no'}</td>
                <td className="p-2">{row.changedBy ?? '—'}</td>
                <td className="p-2">{when(row.changedAt)}</td>
                <td className="p-2 text-end">
                  <Link href={`${ROUTE}?plant=${encodeURIComponent(row.plant)}&history=1`} className="underline">History</Link>
                  {canMaintain && current.context.applicable && (
                    <>
                      {' '}
                      <Link href={`${ROUTE}?plant=${encodeURIComponent(row.plant)}`} className="underline">Change</Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {plants.length === 0 && (
              <tr><td colSpan={7} className="p-3 text-ink-soft">No plant matches. Opening this screen did not create one and did not select one.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <PlantBatchStatusForm client={session.user.client} canMaintain={canMaintain && current.context.applicable} editing={editing} />

      {editing && (
        <section className="border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Conversion for {editing.plant}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            A blocked row is a refused change. Stock was not rewritten, and movement 341 or 342 was not posted.
          </p>
          {conversions.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">No conversion attempt stands for this plant.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {conversions.map((row) => (
                <li key={row.conversionRunId} className="border-t border-line pt-2">
                  <p>{when(row.startedAt)} · {row.startedBy} · {row.status}</p>
                  <p className="text-ink-soft">{row.errorSummary}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {editing && params.history === '1' && (
        <section className="border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Change history · {editing.plant}</h2>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">No change document stands for this plant.</p>
          ) : history.map((entry) => (
            <article key={entry.id} className="mt-2 border-t border-line pt-2 text-sm">
              <p>{when(entry.changedAt)} · {entry.changedBy} · {entry.changeType}</p>
              {entry.reason && <p className="text-ink-soft">{entry.reason}</p>}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
