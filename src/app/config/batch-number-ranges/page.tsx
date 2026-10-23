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
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="p-2">Interval</th>
              <th className="p-2">From</th>
              <th className="p-2">To</th>
              <th className="p-2">Current status</th>
              <th className="p-2">Next, not reserved</th>
              <th className="p-2">External</th>
              <th className="p-2">Status</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {current.intervals.map((row) => (
              <tr key={row.interval} className="border-b border-line">
                <td className="code p-2">{row.interval}</td>
                <td className="code p-2">{row.fromNumber}</td>
                <td className="code p-2">{row.toNumber}</td>
                <td className="code p-2">{row.currentDisplay ?? 'nothing issued'}</td>
                <td className="code p-2">{row.external ? 'not allocated' : (row.nextDisplay ?? 'exhausted')}</td>
                <td className="code p-2">{row.external ? 'X' : 'blank'}</td>
                <td className="p-2">{row.status}{row.exhausted ? ', exhausted' : ''}</td>
                <td className="p-2 text-end">
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
              <tr><td colSpan={8} className="p-3 text-ink-soft">No interval stands. Opening this screen did not create 01.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <BatchNumberRangeForms client={session.user.client} canMaintain={canMaintain} editing={editing} adjusting={adjusting} />
    </div>
  );
}
