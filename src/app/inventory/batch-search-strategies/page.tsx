import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import {
  ACTIVITY,
  ALIAS,
  CHANGE_ALIAS,
  DISPLAY_ALIAS,
  listBatchSearchStrategies,
  listStrategyKeyCombinations,
  NOT_EXECUTED,
  ROUTE,
} from '@/modules/inventory/batch-search-strategy';
import { listSortSequences } from '@/modules/inventory/batch-sort-sequence';

import StrategyForm from './StrategyForm';

export const dynamic = 'force-dynamic';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Create, change, and display an Inventory Management batch search strategy. */
export default async function BatchSearchStrategyPage({
  searchParams,
}: {
  searchParams: Promise<{ record?: string; q?: string; history?: string; new?: string; type?: string; table?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listBatchSearchStrategies(session.user.client);
  const sorts = await listSortSequences(session.user.client);
  const releasedSorts = sorts.sequences.filter((row) => row.status === '1').map((row) => row.sortSequence);
  const combinations = await listStrategyKeyCombinations(session.user.client);
  const params = await searchParams;
  const query = params.q?.trim().toLowerCase() ?? '';
  const editing = current.find((row) => row.recordNumber === params.record?.trim()) ?? null;
  const combination = combinations.find((row) => row.strategyType === params.type?.trim().toUpperCase() && row.conditionTable === params.table?.trim()) ?? null;
  const creating = params.new === '1' && !editing && Boolean(combination);
  const rows = query
    ? current.filter((row) => row.recordNumber.includes(query) || row.strategyType.toLowerCase().includes(query) || row.keys.some((key) => key.value.toLowerCase().includes(query)))
    : current;
  const history = editing && params.history === '1'
    ? await withTenant(session.user.client, (tx) => changeHistory(tx, session.user.client, 'batch_search_strategy', editing.recordNumber))
    : [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIAS} / {CHANGE_ALIAS} / {DISPLAY_ALIAS}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Batch search strategy</h1>
          <Link href="/inventory/goods-issue" className="btn btn-default min-h-11 sm:min-h-8">Goods issue</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          MBC1 creates a search strategy, MBC2 changes its validity, and MBC3 displays it. The strategy type must already stand, and the key combination is a condition table named by its access sequence.
          A field is required only when that combination names it. Opening this screen does not create a record, select a batch, or post. A closed period does not block it.
          {' '}
          {releasedSorts.length > 0
            ? `Released sort sequences stand: ${releasedSorts.join(', ')}. They are not applied to this strategy.`
            : 'No released sort sequence stands. A sort is not applied to this strategy.'}
          {' '}
          <Link href="/inventory/batch-sort-sequences" className="underline">CU70</Link>
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
          Record, strategy type, or key
          <input name="q" defaultValue={params.q ?? ''} className="field-input mt-1" />
        </label>
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Find</button>
      </form>

      {canMaintain && (
        <form className="flex flex-wrap items-end gap-2 border border-line bg-white p-3" method="get">
          <input type="hidden" name="new" value="1" />
          <label className="text-sm">
            Strategy type
            <select name="type" defaultValue={params.type ?? ''} className="field-input mt-1" required>
              <option value="">Choose</option>
              {[...new Map(combinations.map((row) => [row.strategyType, row.description])).entries()].map(([type, description]) => (
                <option key={type} value={type}>{type} · {description}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Key combination
            <select name="table" defaultValue={params.table ?? ''} className="field-input mt-1" required>
              <option value="">Choose</option>
              {combinations.map((row) => (
                <option key={`${row.strategyType}-${row.conditionTable}`} value={row.conditionTable}>{row.strategyType} · {row.conditionTable} · {row.fields.map((field) => field.title).join(', ')}</option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">New</button>
        </form>
      )}

      <section className="overflow-x-auto border border-line bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="p-2">Record</th>
              <th className="p-2">Strategy type</th>
              <th className="p-2">Table</th>
              <th className="p-2">Key</th>
              <th className="p-2">Validity</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.recordNumber} className="border-b border-line">
                <td className="code p-2">{row.recordNumber}</td>
                <td className="code p-2">{row.strategyType}</td>
                <td className="code p-2">{row.conditionTable}</td>
                <td className="p-2">{row.keys.map((key) => `${key.title} ${key.value}`).join(', ')}</td>
                <td className="p-2">{row.validFrom} to {row.validTo}{row.validTo < today ? ' · expired' : ''}</td>
                <td className="p-2 text-end">
                  <Link href={`${ROUTE}?record=${encodeURIComponent(row.recordNumber)}&history=1`} className="underline">Display</Link>
                  {canMaintain && (
                    <>
                      {' '}
                      <Link href={`${ROUTE}?record=${encodeURIComponent(row.recordNumber)}`} className="underline">Change</Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-3 text-ink-soft">No search strategy stands. None is created by opening this screen.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <StrategyForm canMaintain={canMaintain} editing={editing} creating={creating} combination={combination} />

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
