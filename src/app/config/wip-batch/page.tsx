import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  ALIAS,
  getWipBatchActivation,
  NOT_EXECUTED,
  ROUTE,
} from '@/modules/production/wip-batch';

import WipForm from './WipForm';

export const dynamic = 'force-dynamic';

/** Activate WIP batch. This screen does not create a WIP batch. */
export default async function WipBatchPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await getWipBatchActivation(session.user.client);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIAS}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Activate WIP batch</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OMCWB is the client indicator. It is not an inventory batch, a documentary batch, or a where-used list.
          Opening this screen writes nothing. A closed posting period does not block it.
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

      <WipForm client={session.user.client} current={current} canMaintain={canMaintain} />
    </div>
  );
}
