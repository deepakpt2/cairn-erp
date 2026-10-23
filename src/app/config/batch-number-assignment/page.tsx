import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  getInternalBatchAssignment,
  listAssignedReceiptSettings,
} from '@/modules/inventory/batch-number-assignment';

import BatchNumberAssignmentForm from './BatchNumberAssignmentForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/batch-number-assignment';

/** Internal batch number assignment. OMCZ is a search alias only. */
export default async function BatchNumberAssignmentPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const [current, plants] = await Promise.all([
    getInternalBatchAssignment(session.user.client),
    listAssignedReceiptSettings(session.user.client),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMCZ</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Activate internal batch number assignment</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Two settings, kept apart. The client flag is X or blank. The plant flag permits a number only for an
          account-assigned goods receipt. Neither setting creates BATCH_CLT interval 01, a batch, or a stock receipt.
          OMAD, OMCE, and OPKP are not this screen. A closed posting period does not block it.
        </p>
      </header>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink">
          Display only. Ask an administrator for {ACTIVITY}.
        </p>
      )}

      <BatchNumberAssignmentForm
        client={session.user.client}
        current={current}
        plants={plants}
        canMaintain={canMaintain}
      />
    </div>
  );
}
