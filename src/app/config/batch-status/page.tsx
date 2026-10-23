import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, getBatchStatusManagement } from '@/modules/inventory/batch-status';

import BatchStatusForm from './BatchStatusForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/batch-status';

/**
 * Batch status management. OMCS is a search alias only.
 * One indicator for the client. It does not post, and a closed period does not block it.
 */
export default async function BatchStatusPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const current = await getBatchStatusManagement(session.user.client);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMCS</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Activate batch status management</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          One indicator for this client. Active is the character 1. Not active is blank. The batch level is read from OMCE.
          This screen does not select a plant, set an initial status, create a batch, or post movement 341 or 342. Plant selection is OMCU.
          OMCU, OMAB, OMCZ, OMAD, MSC1N, MSC2N, and MSC3N are not this screen. A closed posting period does not block it.
        </p>
      </header>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink">
          Display only. Ask an administrator for {ACTIVITY}.
        </p>
      )}

      <BatchStatusForm client={session.user.client} current={current} canMaintain={canMaintain} />
    </div>
  );
}
