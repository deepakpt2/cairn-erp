import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { ACTIVITY, listBatchClassification, NOT_EXECUTED, ROUTE } from '@/modules/inventory/batch-classification';

import ClassificationForm from './ClassificationForm';

export const dynamic = 'force-dynamic';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Batch classification for goods movements. OMCV is a search alias only. */
export default async function BatchClassificationPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string; history?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listBatchClassification(session.user.client);
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? '';
  const editing = current.find((row) => row.movementType === params.type) ?? null;
  const rows = query
    ? current.filter((row) => row.movementType.toLowerCase().includes(query) || row.description.toLowerCase().includes(query))
    : current;
  const history = editing && params.history === '1'
    ? await withTenant(session.user.client, (tx) => changeHistory(tx, session.user.client, 'movement_type', editing.movementType))
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMCV</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Batch classification for goods movements</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OMCV sets KZCLA on the standing movement type. Blank is no branching. 1 is background for all batches.
          2 is foreground for mandatory characteristics. 3 is always foreground. 4 is foreground for new batches only.
          Opening this screen does not change a movement and does not rewrite a posted document.
          It does not create a movement type, change its posting rules, or post. The catalogue key is the standing
          movement type. A three-character alias is not stored beside it. A closed period does not block it.
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

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Display only. Ask an administrator for {ACTIVITY}.</p>
      )}

      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          Movement type or description
          <input name="q" defaultValue={params.q ?? ''} className="field-input mt-1" />
        </label>
        {editing && <input type="hidden" name="type" value={editing.movementType} />}
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Find</button>
      </form>

      <section className="overflow-x-auto border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="p-2">Movement type</th>
              <th className="p-2">Description</th>
              <th className="p-2">Classification</th>
              <th className="p-2">Changed by</th>
              <th className="p-2">Changed at</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.movementType} className="border-b border-line">
                <td className="code p-2">{row.movementType}</td>
                <td className="p-2">{row.description}</td>
                <td className="code p-2">{row.classification === ' ' ? 'blank' : row.classification}</td>
                <td className="p-2">{row.changedBy ?? '—'}</td>
                <td className="p-2">{when(row.changedAt)}</td>
                <td className="p-2 text-end">
                  <Link href={`${ROUTE}?type=${encodeURIComponent(row.movementType)}&history=1`} className="underline">History</Link>
                  {canMaintain && (
                    <>
                      {' '}
                      <Link href={`${ROUTE}?type=${encodeURIComponent(row.movementType)}`} className="underline">Change</Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-3 text-ink-soft">No movement type matches. Opening this screen did not create one.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <ClassificationForm canMaintain={canMaintain} editing={editing} />

      {editing && params.history === '1' && (
        <section className="border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Change history · {editing.movementType}</h2>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">No change document stands for this movement type.</p>
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
