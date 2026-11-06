import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, getBatchNumberRanges } from '@/modules/inventory/batch-number-range';

import BatchNumberRangeForms from './BatchNumberRangeForms';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/batch-number-ranges';

/** Batch number ranges. OMAD is a search alias only. */
export default async function BatchNumberRangesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; adjust?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await getBatchNumberRanges(session.user.client);
  const params = await searchParams;
  const editing = current.intervals.find((row) => row.interval === params.edit) ?? null;
  const adjusting = current.intervals.find((row) => row.interval === params.adjust) ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMAD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Number ranges for batch numbers</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Object {current.objectCode}. {current.description}. This screen maintains intervals only.
          It does not create an interval by being opened, and it does not create a batch.
          Interval 01 is internal. Interval 02, when it stands, checks a typed number and does not allocate.
          The next number is not reserved by being shown. A gap is left as it stands, and an exhausted interval does not wrap.
          OMCZ, OMCE, and MSC1N are not this screen.
        </p>
      </header>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Display only. Ask an administrator for {ACTIVITY}.</p>
      )}

      <section className="overflow-x-auto border border-line bg-white">
        <table className="grid-table text-sm">
          <thead>
            <tr className="text-left">
              <th>Interval</th>
              <th>From</th>
              <th>To</th>
              <th>Current status</th>
              <th>Next, not reserved</th>
              <th>External</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {current.intervals.map((row) => (
              <tr key={row.interval}>
                <td className="code">{row.interval}</td>
                <td className="code">{row.fromNumber}</td>
                <td className="code">{row.toNumber}</td>
                <td className="code">{row.currentDisplay ?? 'nothing issued'}</td>
                <td className="code">{row.external ? 'not allocated' : (row.nextDisplay ?? 'exhausted')}</td>
                <td className="code">{row.external ? 'X' : 'blank'}</td>
                <td>{row.status}{row.exhausted ? ', exhausted' : ''}</td>
                <td className="text-end">
                  {canMaintain && (
                    <>
                      <Link href={`${ROUTE}?edit=${row.interval}`} className="me-3 underline">Change</Link>
                      <Link href={`${ROUTE}?adjust=${row.interval}`} className="underline">Status</Link>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {current.intervals.length === 0 && (
              <tr><td colSpan={8} className="text-ink-soft">No interval stands. Opening this screen did not create 01.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <BatchNumberRangeForms client={session.user.client} canMaintain={canMaintain} editing={editing} adjusting={adjusting} />
    </div>
  );
}
