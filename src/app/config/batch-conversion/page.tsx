import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  ALIAS,
  listConversionChecks,
  NOT_EXECUTED,
  ROUTE,
} from '@/modules/inventory/batch-conversion';

import ConversionForm from './ConversionForm';

export const dynamic = 'force-dynamic';

function when(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

/** Check a batch-level or status conversion. This screen does not convert. */
export default async function BatchConversionPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const snapshot = await listConversionChecks(session.user.client);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIAS}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Batch level and status conversion</h1>
          <Link href="/config/batch-level" className="btn btn-default min-h-11 sm:min-h-8">Batch level</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OMCT checks a proposed level or status change. It is not OMCE and not OMCS.
          Opening this screen writes nothing. A closed period does not block it.
        </p>
      </header>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink">
          Display only. Ask an administrator for {ACTIVITY}.
        </p>
      )}

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

      <ConversionForm canMaintain={canMaintain} snapshot={snapshot} />

      <table className="w-full border border-line bg-white text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="p-2">When</th>
            <th className="p-2">Proposal</th>
            <th className="p-2">Result</th>
            <th className="p-2">Conflicts</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.checks.map((row) => (
            <tr key={row.checkId} className="border-b border-line">
              <td className="p-2">{when(row.startedAt)}</td>
              <td className="code p-2">{row.sourceLevel} to {row.targetLevel} · status {row.sourceStatus.trim() || 'blank'} to {row.targetStatus.trim() || 'blank'}</td>
              <td className="p-2">{row.result}</td>
              <td className="p-2">{row.conflictCount}. {row.summary}</td>
            </tr>
          ))}
          {snapshot.checks.length === 0 && (
            <tr><td className="p-2 text-ink-soft" colSpan={4}>No conversion check stands. Opening this screen did not create one.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
