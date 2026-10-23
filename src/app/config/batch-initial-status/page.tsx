import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { ACTIVITY, listInitialBatchStatus, ROUTE } from '@/modules/inventory/initial-batch-status';

import InitialStatusForm from './InitialStatusForm';

export const dynamic = 'force-dynamic';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Initial status of a new batch. OMAB is a search alias only. */
export default async function InitialBatchStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string; history?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listInitialBatchStatus(session.user.client);
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? '';
  const editing = current.types.find((row) => row.materialType === params.type) ?? null;
  const types = query
    ? current.types.filter((row) => row.materialType.toLowerCase().includes(query) || row.name.toLowerCase().includes(query))
    : current.types;
  const history = editing && params.history === '1'
    ? await withTenant(session.user.client, (tx) => changeHistory(tx, session.user.client, 'material_type', editing.materialType))
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMAB</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Initial status of a new batch</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OMAB sets the initial status by material type. Checked is the character X, stored for a new batch as restricted.
          Blank is unrestricted. Opening this screen does not change a type and does not rewrite a batch.
          It does not create a material type, select a plant, change OMCS, or post. Restricted use is not blocked stock
          and not inspection stock. The description is read from the material type. A closed period does not block it.
        </p>
      </header>

      <dl className="grid gap-3 border border-line bg-white p-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-ink-faint">Status management applicability</dt>
          <dd>{current.context.explanation}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">Selected plants</dt>
          <dd className="code">{current.context.batchLevel === '0' ? (current.context.selectedPlants.join(', ') || 'none') : 'not used at this level'}</dd>
        </div>
      </dl>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Display only. Ask an administrator for {ACTIVITY}.</p>
      )}

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          Material type or description
          <input name="q" defaultValue={params.q ?? ''} className="field-input mt-1" />
        </label>
        {editing && <input type="hidden" name="type" value={editing.materialType} />}
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Find</button>
      </form>

      <section className="overflow-x-auto border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="p-2">Type</th>
              <th className="p-2">Description</th>
              <th className="p-2">Initial status</th>
              <th className="p-2">Changed by</th>
              <th className="p-2">Changed at</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {types.map((row) => (
              <tr key={row.materialType} className="border-b border-line">
                <td className="code p-2">{row.materialType}</td>
                <td className="p-2">{row.name}{row.active ? '' : ' · inactive'}</td>
                <td className="code p-2">{row.initialStatus ?? 'blank'}</td>
                <td className="p-2">{row.changedBy ?? '—'}</td>
                <td className="p-2">{when(row.changedAt)}</td>
                <td className="p-2 text-end">
                  <Link href={`${ROUTE}?type=${encodeURIComponent(row.materialType)}&history=1`} className="underline">History</Link>
                  {canMaintain && (
                    <>
                      {' '}
                      <Link href={`${ROUTE}?type=${encodeURIComponent(row.materialType)}`} className="underline">Change</Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {types.length === 0 && (
              <tr><td colSpan={6} className="p-3 text-ink-soft">No material type matches. Opening this screen did not create one.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <InitialStatusForm canMaintain={canMaintain} editing={editing} />

      {editing && params.history === '1' && (
        <section className="border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Change history · {editing.materialType}</h2>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">No change document stands for this material type.</p>
          ) : history.map((entry) => (
            <article key={entry.id} className="mt-2 border-t border-line pt-2 text-sm">
              <p>{when(entry.changedAt)} · {entry.changedBy} · {entry.changeType}{entry.transactionCode ? ` · ${entry.transactionCode}` : ''}</p>
              {entry.reason && <p className="text-ink-soft">{entry.reason}</p>}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
