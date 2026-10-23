import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, BATCH_LEVELS, getBatchLevel, latestConversion } from '@/modules/inventory/batch-level';
import { listConversionChecks } from '@/modules/inventory/batch-conversion';

import BatchLevelForm from './BatchLevelForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/batch-level';

/**
 * Batch level. OMCE is a search alias only.
 * One setting for the client. It does not post, and a closed period does not block it.
 */
export default async function BatchLevelPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const [current, conversion, omct] = await Promise.all([
    getBatchLevel(session.user.client),
    latestConversion(session.user.client),
    listConversionChecks(session.user.client),
  ]);
  const finding = omct.checks[0] ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMCE</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Define batch level</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          One batch level for this client. The stored code is 0, 1, or 2. This screen does not create a batch,
          turn on batch status, or turn on internal numbering. Goods movements still do not carry a batch.
          OMCS, OMCZ, OMAD, MSC1N, MSC2N, and MSC3N are not this screen. A closed posting period does not block it.
        </p>
      </header>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink">
          Display only. Ask an administrator for {ACTIVITY}.
        </p>
      )}

      <BatchLevelForm
        client={session.user.client}
        levels={Object.values(BATCH_LEVELS)}
        current={current}
        conversion={conversion}
        canMaintain={canMaintain}
      />
      <section className="border border-line bg-white p-4 text-sm">
        <h2 className="font-medium">OMCT finding</h2>
        <p className="mt-2 text-ink-soft">
          {finding
            ? `The last check is ${finding.result}. ${finding.summary} The batch level was not changed.`
            : 'No OMCT finding stands. The batch level was not changed.'}
          {' '}
          <Link href="/config/batch-conversion" className="underline">Open OMCT</Link>
        </p>
      </section>
    </div>
  );
}
