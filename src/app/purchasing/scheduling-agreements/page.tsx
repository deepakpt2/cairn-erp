import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { RELEASE_CAPABILITIES, getDocumentRelease } from '@/modules/purchasing/release';
import {
  SCHEDULING_AGREEMENT_DISPLAY_CAPABILITY,
  SCHEDULING_AGREEMENT_LIST_CAPABILITY,
  SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY,
  SCHEDULING_AGREEMENT_ROUTE,
  getSchedulingAgreement,
  listSchedulingAgreements,
  schedulingAgreementChoices,
} from '@/modules/purchasing/scheduling-agreement';
import { ChangeLock } from '@/ui/lock/ChangeLock';
import Agreements from './Agreements';

export const dynamic = 'force-dynamic';

/**
 * ME31L create and ME32L change. ME33L is the display route and does not save.
 * ME38 and ME39 are not this screen.
 */
export default async function SchedulingAgreementsPage({ searchParams }: {
  searchParams: Promise<{ agreement?: string }>;
}) {
  const session = await requireSession(SCHEDULING_AGREEMENT_ROUTE);
  const allowed = can(session, SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY)
    || can(session, SCHEDULING_AGREEMENT_DISPLAY_CAPABILITY)
    || can(session, SCHEDULING_AGREEMENT_LIST_CAPABILITY)
    || can(session, RELEASE_CAPABILITIES.SCHED_AGREEMENT);
  if (!allowed) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Scheduling agreement</h1>
        <p className="mt-2 text-sm">You do not hold a scheduling-agreement capability.</p>
      </main>
    );
  }
  const params = await searchParams;
  const client = session.user.client;
  const agreementNumber = params.agreement?.trim() || '';
  const [documents, choices, selected] = await Promise.all([
    listSchedulingAgreements(client),
    schedulingAgreementChoices(client),
    agreementNumber ? getSchedulingAgreement(client, agreementNumber) : Promise.resolve(null),
  ]);
  const selectedRelease = selected
    ? await getDocumentRelease(client, 'SCHED_AGREEMENT', selected.agreementNumber)
    : null;
  const canChange = can(session, SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY);
  const changeLock = selected && canChange
    ? await openChangeForSession(session, {
        lockObject: 'SCHEDULING_AGREEMENT',
        argument: selected.agreementNumber,
        transactionCode: 'ME32L',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{agreementNumber ? 'PROC.SCHEDAGREE.MAINTAIN · ME32L' : 'PROC.SCHEDAGREE.MAINTAIN · ME31L'}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Scheduling agreement</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          ME31L creates a scheduling agreement. ME32L changes the open agreement. ME33L displays it and does not save. Saving does not create a delivery schedule line, a purchase order, a goods receipt, or accounting. ME38 and ME39 are not this screen. This is not ME31K.
        </p>
      </header>
      {changeLock?.mode === 'CHANGE' && selected && (
        <ChangeLock lockObject="SCHEDULING_AGREEMENT" argument={selected.agreementNumber} />
      )}
      <Agreements
        documents={documents}
        choices={choices}
        selected={selected}
        canCreate={canChange}
        canRelease={can(session, RELEASE_CAPABILITIES.SCHED_AGREEMENT)}
        selectedRelease={selectedRelease}
        viewOnly={changeLock?.mode === 'DISPLAY'}
        lockMessage={changeLock ? displayOnlyMessage(changeLock) : null}
      />
    </div>
  );
}
