import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { ACTIVITY, ALLOWED_FIELDS, APPLICATION, listBatchConditionTables, NOT_EXECUTED, ROUTE, USAGE } from '@/modules/inventory/batch-condition-table';

import ConditionTableForm from './ConditionTableForm';

export const dynamic = 'force-dynamic';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Inventory Management condition tables. OMA1 is a search alias only. */
export default async function BatchConditionTablePage({
  searchParams,
}: {
  searchParams: Promise<{ table?: string; q?: string; history?: string; new?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listBatchConditionTables(session.user.client);
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? '';
  const editing = current.find((row) => row.conditionTable === params.table?.trim().padStart(3, '0')) ?? null;
  const creating = params.new === '1' && !editing;
  const rows = query
    ? current.filter((row) => row.conditionTable.includes(query) || row.fields.join(' ').toLowerCase().includes(query))
    : current;
  const history = editing && params.history === '1'
    ? await withTenant(session.user.client, (tx) => changeHistory(tx, session.user.client, 'batch_condition_table', editing.conditionTable))
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMA1</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Inventory Management condition tables</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OMA1 defines a condition table for Inventory Management. Usage is {USAGE}. Application is {APPLICATION}.
          The number is 501 to 999. The SAP key area is not created here.
          Opening this screen does not create a table, generate a physical table, or post.
          Production and sales condition tables are not this screen. A closed period does not block it.
        </p>
      </header>

      <section className="border border-line bg-white p-3 text-sm">
        <h2 className="font-semibold">Allowed key fields</h2>
        <ul className="mt-2 space-y-1">
          {ALLOWED_FIELDS.map((item) => (
            <li key={item.field}><span className="code">{item.field}</span> · {item.title}</li>
          ))}
        </ul>
        <p className="mt-2 text-ink-soft">A field cannot be added here. OMA0 is not this screen.</p>
      </section>

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
          Condition table or field
          <input name="q" defaultValue={params.q ?? ''} className="field-input mt-1" />
        </label>
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Find</button>
        {canMaintain && <Link href={`${ROUTE}?new=1`} className="btn btn-primary min-h-11 sm:min-h-8">New</Link>}
      </form>

      <section className="overflow-x-auto border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="p-2">Condition table</th>
              <th className="p-2">Key fields</th>
              <th className="p-2">Usage</th>
              <th className="p-2">Application</th>
              <th className="p-2">Version</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.conditionTable} className="border-b border-line">
                <td className="code p-2">{row.conditionTable}</td>
                <td className="code p-2">{row.fields.join(' / ')}</td>
                <td className="code p-2">{row.usage}</td>
                <td className="code p-2">{row.application}</td>
                <td className="p-2">{row.version}</td>
                <td className="p-2 text-end">
                  <Link href={`${ROUTE}?table=${encodeURIComponent(row.conditionTable)}&history=1`} className="underline">History</Link>
                  {canMaintain && (
                    <>
                      {' '}
                      <Link href={`${ROUTE}?table=${encodeURIComponent(row.conditionTable)}`} className="underline">Change</Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-3 text-ink-soft">No condition table stands. None is created by opening this screen.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <ConditionTableForm canMaintain={canMaintain} editing={editing} creating={creating} />

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
