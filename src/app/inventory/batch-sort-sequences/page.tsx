import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import {
  ACTIVITY,
  ALIAS,
  CHANGE_ALIAS,
  DISPLAY_ALIAS,
  listSortSequences,
  NOT_EXECUTED,
  ROUTE,
} from '@/modules/inventory/batch-sort-sequence';

import SortForm from './SortForm';

export const dynamic = 'force-dynamic';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Create, change, and display a batch sort sequence. */
export default async function BatchSortSequencePage({
  searchParams,
}: {
  searchParams: Promise<{ sequence?: string; q?: string; history?: string; new?: string; mode?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const choices = await listSortSequences(session.user.client);
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? '';
  const editing = choices.sequences.find((row) => row.sortSequence === params.sequence?.trim().toUpperCase()) ?? null;
  const creating = params.new === '1' && !editing;
  const displayOnly = params.mode === 'display';
  const rows = query
    ? choices.sequences.filter((row) => row.sortSequence.toLowerCase().includes(query) || row.description.toLowerCase().includes(query) || row.criteria.some((item) => item.characteristicName.toLowerCase().includes(query)))
    : choices.sequences;
  const history = editing && params.history === '1'
    ? await withTenant(session.user.client, (tx) => changeHistory(tx, session.user.client, 'batch_sort_sequence', editing.sortSequence))
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIAS} / {CHANGE_ALIAS} / {DISPLAY_ALIAS}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Batch sort sequence</h1>
          <Link href="/inventory/batch-classes" className="btn btn-default min-h-11 sm:min-h-8">Batch class</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          CU70 creates a sort sequence, CU71 changes it, and CU72 displays it. The name is at most 18 characters. Status 0 is in preparation, 1 is released, and 2 is locked.
          Opening this screen does not create a sequence, select a batch, or post. A closed period does not block it.
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
          Sequence or characteristic
          <input name="q" defaultValue={params.q ?? ''} className="field-input mt-1" />
        </label>
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Find</button>
        {canMaintain && <Link href="/inventory/batch-sort-sequences?new=1" className="btn btn-primary min-h-11 sm:min-h-8">New sequence</Link>}
      </form>

      <SortForm canMaintain={canMaintain} editing={editing} creating={creating} displayOnly={displayOnly} choices={choices} />

      <table className="w-full border border-line bg-white text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="p-2">Sequence</th>
            <th className="p-2">Description</th>
            <th className="p-2">Status</th>
            <th className="p-2">Criteria</th>
            <th className="p-2"> </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sortSequence} className="border-b border-line">
              <td className="code p-2">{row.sortSequence}</td>
              <td className="p-2">{row.description}</td>
              <td className="p-2">{row.status} · {row.statusTitle}</td>
              <td className="code p-2">{row.criteria.map((item) => `${item.position} ${item.characteristicName} ${item.direction}`).join(', ') || '—'}</td>
              <td className="p-2">
                <Link href={`/inventory/batch-sort-sequences?sequence=${row.sortSequence}&mode=display`} className="underline">Display</Link>
                {canMaintain && (
                  <>
                    {' · '}
                    <Link href={`/inventory/batch-sort-sequences?sequence=${row.sortSequence}`} className="underline">Change</Link>
                  </>
                )}
                {' · '}
                <Link href={`/inventory/batch-sort-sequences?sequence=${row.sortSequence}&mode=display&history=1`} className="underline">History</Link>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td className="p-2 text-ink-soft" colSpan={5}>No sort sequence stands. Opening this screen did not create one.</td></tr>
          )}
        </tbody>
      </table>

      {history.length > 0 && (
        <section className="border border-line bg-white p-3 text-sm">
          <h2 className="font-semibold">Change history</h2>
          <ul className="mt-2 space-y-1">
            {history.map((item) => (
              <li key={item.id}>{when(item.changedAt)} · {item.changeType} · {item.changedBy} · {item.reason}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
