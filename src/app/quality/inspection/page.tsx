import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock } from '@/ui/lock/ChangeLock';
import { USAGE_DECISION_CAPABILITY, INSPECTION_RESULT_CAPABILITY } from '@/modules/quality/inspection-results';
import { LOT_CAPABILITY } from '@/modules/quality/lot';
import { loadInspectionWorkbench } from './actions';
import InspectionWorkbench from './InspectionWorkbench';

export const dynamic = 'force-dynamic';

const ROUTE = '/quality/inspection';

export default async function InspectionPage({ searchParams }: { searchParams: Promise<{ lot?: string }> }) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const lotNumber = (params.lot ?? '').trim().toUpperCase();

  const canRecord = can(session, INSPECTION_RESULT_CAPABILITY);
  const canDecide = can(session, USAGE_DECISION_CAPABILITY);
  const canOpenLot = can(session, LOT_CAPABILITY);

  const workbench = lotNumber ? await loadInspectionWorkbench(client, lotNumber) : null;
  const selectedLot = workbench?.lot ?? null;
  const changeLock = selectedLot && canDecide
    ? await openChangeForSession(session, {
        lockObject: 'USAGE_DECISION',
        argument: selectedLot.lotNumber,
        transactionCode: 'QE51N',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">
          {canDecide ? USAGE_DECISION_CAPABILITY : canRecord ? INSPECTION_RESULT_CAPABILITY : LOT_CAPABILITY}
        </span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Inspection workbench</h1>
          <div className="flex gap-2">
            <Link href="/quality/lots" className="btn btn-default min-h-11 sm:min-h-8">
              Inspection lots
            </Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
              Launchpad
            </Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Record measured results against configured characteristics, then make the usage
          decision that accepts or rejects the goods. Stock follows the decision: accepted
          quality stock moves to unrestricted use; rejected quality stock moves to blocked.
        </p>
      </header>

      {!lotNumber && (
        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Open a lot</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Enter a lot number to work with it, or open one first at{' '}
            <Link className="link" href="/quality/lots">Inspection lots</Link>.
          </p>
          <form className="mt-3 flex gap-2" method="get">
            <input
              className="input w-56"
              name="lot"
              placeholder="QL-0000001"
              value={lotNumber}
              onChange={(e) => { }}
            />
            <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">
              Open workbench
            </button>
          </form>
        </section>
      )}

      {changeLock?.mode === 'CHANGE' && selectedLot && (
        <ChangeLock lockObject="USAGE_DECISION" argument={selectedLot.lotNumber} />
      )}

      {workbench && (
        <InspectionWorkbench
          workbench={workbench}
          canRecord={canRecord}
          canDecide={canDecide}
          canOpenLot={canOpenLot}
          viewOnly={changeLock?.mode === 'DISPLAY'}
          lockMessage={changeLock ? displayOnlyMessage(changeLock) : null}
        />
      )}
    </div>
  );
}

export async function generateMetadata() {
  return { title: 'Inspection workbench — QM' };
}
