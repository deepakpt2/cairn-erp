import Link from 'next/link';

import AvailabilityCheckForm from './AvailabilityCheckForm';
import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, ALIASES, listAvailabilityCheck, ROUTE } from '@/modules/production/availability-check';

export const dynamic = 'force-dynamic';

/** Availability-check configuration. Opening this page writes nothing and calculates no ATP quantity. */
export default async function AvailabilityCheckPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await listAvailabilityCheck(session.user.client);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIASES.join(' · ')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Availability check configuration</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A checking group is assigned on the material plant view. A missing assignment stays unassigned.
          A checking rule is a separate key. It is not a checking group, and it does not decide whether a check runs.
          A scope of check is that pair. Checking control is not stored. Saving this screen does not calculate ATP, does not read the stock/requirements list, and does not post.
        </p>
      </header>
      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm">
          Display only. Ask an administrator for {ACTIVITY}.
        </p>
      )}
      <section className="border border-line bg-white p-4 text-sm">
        <h2 className="font-semibold">Not configured, and not inferred</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
          {current.gaps.map((gap) => <li key={gap}>{gap}</li>)}
        </ul>
      </section>
      <AvailabilityCheckForm current={current} canMaintain={canMaintain} />
    </div>
  );
}
