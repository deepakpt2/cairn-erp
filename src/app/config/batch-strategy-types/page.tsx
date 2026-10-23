import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { ACTIVITY, APPLICATION, listBatchStrategyTypes, NOT_EXECUTED, ROUTE, USAGE } from '@/modules/inventory/batch-strategy-type';

import StrategyTypeForm from './StrategyTypeForm';

export const dynamic = 'force-dynamic';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Inventory Management strategy types. OMCW is a search alias only. */
export default async function BatchStrategyTypePage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string; history?: string; new?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listBatchStrategyTypes(session.user.client);
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? '';
  const editing = current.find((row) => row.strategyType === params.type?.trim().toUpperCase()) ?? null;
  const creating = params.new === '1' && !editing;
  const rows = query
    ? current.filter((row) => row.strategyType.toLowerCase().includes(query) || row.description.toLowerCase().includes(query))
    : current;
  const history = editing && params.history === '1'
    ? await withTenant(session.user.client, (tx) => changeHistory(tx, session.user.client, 'batch_strategy_type', editing.strategyType))
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMCW</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Inventory Management strategy types</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OMCW defines a strategy type for Inventory Management. Usage is {USAGE}. Application is {APPLICATION}.
          The key is the condition type, one to four uppercase letters or digits. The description is at most 20 characters.
          An access sequence is optional and is maintained on OMCX. Naming one does not select a batch.
          Opening this screen does not create a strategy type, select a batch, or post.
          Production and sales strategy types are not this screen. A closed period does not block it.
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
          Strategy type or description
          <input name="q" defaultValue={params.q ?? ''} className="field-input mt-1" />
        </label>
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Find</button>
        {canMaintain && <Link href={`${ROUTE}?new=1`} className="btn btn-primary min-h-11 sm:min-h-8">New</Link>}
      </form>

      <section className="overflow-x-auto border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="p-2">Strategy type</th>
              <th className="p-2">Description</th>
              <th className="p-2">Access sequence</th>
              <th className="p-2">Usage</th>
              <th className="p-2">Application</th>
              <th className="p-2">Version</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.strategyType} className="border-b border-line">
                <td className="code p-2">{row.strategyType}</td>
                <td className="p-2">{row.description}</td>
                <td className="code p-2">{row.accessSequence || '—'}</td>
                <td className="code p-2">{row.usage}</td>
                <td className="code p-2">{row.application}</td>
                <td className="p-2">{row.version}</td>
                <td className="p-2 text-end">
                  <Link href={`${ROUTE}?type=${encodeURIComponent(row.strategyType)}&history=1`} className="underline">History</Link>
                  {canMaintain && (
                    <>
                      {' '}
                      <Link href={`${ROUTE}?type=${encodeURIComponent(row.strategyType)}`} className="underline">Change</Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-3 text-ink-soft">No strategy type matches. Opening this screen did not create one.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <StrategyTypeForm canMaintain={canMaintain} editing={editing} creating={creating} />

      {editing && params.history === '1' && (
        <section className="border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">Change history · {editing.strategyType}</h2>
          {history.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">No change document stands for this strategy type.</p>
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
