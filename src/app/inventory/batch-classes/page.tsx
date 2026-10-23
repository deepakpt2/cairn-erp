import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import {
  ACTIVITY,
  ALIAS,
  CHANGE_ALIAS,
  DISPLAY_ALIAS,
  listBatchClasses,
  NOT_EXECUTED,
  ROUTE,
} from '@/modules/inventory/batch-class';

import ClassForm from './ClassForm';

export const dynamic = 'force-dynamic';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Create, change, and display a batch class. This is not CL01. */
export default async function BatchClassPage({
  searchParams,
}: {
  searchParams: Promise<{ class?: string; type?: string; q?: string; history?: string; new?: string; mode?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const choices = await listBatchClasses(session.user.client);
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? '';
  const editing = choices.classes.find((row) => row.className === params.class?.trim().toUpperCase() && row.classType === params.type?.trim()) ?? null;
  const creating = params.new === '1' && !editing && !choices.blocked;
  const displayOnly = params.mode === 'display';
  const rows = query
    ? choices.classes.filter((row) => row.className.toLowerCase().includes(query) || row.description.toLowerCase().includes(query) || row.assignments.some((item) => item.characteristicName.toLowerCase().includes(query)))
    : choices.classes;
  const history = editing && params.history === '1'
    ? await withTenant(session.user.client, (tx) => changeHistory(tx, session.user.client, 'classification_class', `${editing.classType}/${editing.className}`))
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIAS} / {CHANGE_ALIAS} / {DISPLAY_ALIAS}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Batch class</h1>
          <Link href="/config/characteristics" className="btn btn-default min-h-11 sm:min-h-8">Characteristics</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          BMC1 creates a batch class, BMC2 changes its description and assignments, and BMC3 displays it. This is not CL01.
          The class type is {choices.classType || 'not yet named'}: 022 when the batch level is plant, 023 when it is material or client. It is not hard-coded.
          Opening this screen does not create a class, assign it, or post.
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

      {choices.blocked && <p role="status" className="border border-line bg-white p-3 text-sm">{choices.blocked}</p>}

      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="text-sm">
          Class or characteristic
          <input name="q" defaultValue={params.q ?? ''} className="field-input mt-1" />
        </label>
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Find</button>
        {canMaintain && !choices.blocked && (
          <Link href="/inventory/batch-classes?new=1" className="btn btn-primary min-h-11 sm:min-h-8">New class</Link>
        )}
      </form>

      <ClassForm canMaintain={canMaintain} editing={editing} creating={creating} displayOnly={displayOnly} choices={choices} />

      <table className="w-full border border-line bg-white text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="p-2">Type</th>
            <th className="p-2">Class</th>
            <th className="p-2">Description</th>
            <th className="p-2">Characteristics</th>
            <th className="p-2"> </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.classType}/${row.className}`} className="border-b border-line">
              <td className="code p-2">{row.classType}{row.currentType ? '' : ' · other level'}</td>
              <td className="code p-2">{row.className}</td>
              <td className="p-2">{row.description}</td>
              <td className="code p-2">{row.assignments.map((item) => `${item.position} ${item.characteristicName}`).join(', ') || '—'}</td>
              <td className="p-2">
                <Link href={`/inventory/batch-classes?type=${row.classType}&class=${row.className}&mode=display`} className="underline">Display</Link>
                {canMaintain && row.currentType && (
                  <>
                    {' · '}
                    <Link href={`/inventory/batch-classes?type=${row.classType}&class=${row.className}`} className="underline">Change</Link>
                  </>
                )}
                {' · '}
                <Link href={`/inventory/batch-classes?type=${row.classType}&class=${row.className}&mode=display&history=1`} className="underline">History</Link>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td className="p-2 text-ink-soft" colSpan={5}>No batch class stands. Opening this screen did not create one.</td></tr>
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
