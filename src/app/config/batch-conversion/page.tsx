
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  ALIAS,
  listConversionChecks,
  NOT_EXECUTED,
  ROUTE,
} from '@/modules/inventory/batch-conversion';

import ConversionForm from './ConversionForm';
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title="Batch level and status conversion" code={<>{ACTIVITY} · {ALIAS}</>} width="4xl" back={null}
      description="OMCT checks a proposed level or status change. It is not OMCE and not OMCS. Opening this screen writes nothing. A closed period does not block it."
      actions={
        <>
          <LinkButton href="/config/batch-level">Batch level</LinkButton>
        </>
      }
    >

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

      <table className="grid-table border border-line bg-white text-sm">
        <thead>
          <tr className="text-left">
            <th>When</th>
            <th>Proposal</th>
            <th>Result</th>
            <th>Conflicts</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.checks.map((row) => (
            <tr key={row.checkId}>
              <td>{when(row.startedAt)}</td>
              <td className="code">{row.sourceLevel} to {row.targetLevel} · status {row.sourceStatus.trim() || 'blank'} to {row.targetStatus.trim() || 'blank'}</td>
              <td>{row.result}</td>
              <td>{row.conflictCount}. {row.summary}</td>
            </tr>
          ))}
          {snapshot.checks.length === 0 && (
            <tr><td className="text-ink-soft" colSpan={4}>No conversion check stands. Opening this screen did not create one.</td></tr>
          )}
        </tbody>
      </table>
    </Page>
  );
}
