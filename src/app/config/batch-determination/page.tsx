import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  BATCH_DETERMINATION_CAPABILITY, BATCH_DETERMINATION_ROUTE, listBatchDeterminationRules,
} from '@/modules/sales/batch-determination';
import BatchDetermination from './BatchDetermination';

export const dynamic = 'force-dynamic';

const ROUTE = BATCH_DETERMINATION_ROUTE;

/**
 * Batch determination for sales — §5.5a.
 *
 * The question this screen maintains is asked at the dock: a delivery item is asking for forty of a
 * material, there are five batches of it in the store, and somebody has to take the boxes off a
 * shelf. Which ones?
 *
 * This is deliberately not the batch search strategy stack. That one answers "which batches match
 * this characteristic" and hands an operator a list to choose from. A picker does not choose — the
 * delivery has already committed to a quantity and the goods have to come from somewhere. So what
 * stands here is simpler by design: an order to take them in, and what it answers for.
 */
export default async function BatchDeterminationPage() {
  const session = await requireSession(ROUTE);
  const rules = await listBatchDeterminationRules(session.user.client);
  const canMaintain = can(session, BATCH_DETERMINATION_CAPABILITY);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{BATCH_DETERMINATION_CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Batch determination</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Which batch a delivery item is picked from, and in what order the batches are taken. The rule
          is read when a pick is confirmed <em>without</em> a batch: a picker who names one keeps it,
          because a clerk who knows better than the rule is not overruled by it. Where no rule
          answers, nothing is determined and the pick stands as it always did.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft">
          A batch in restricted use is never proposed, and a determination that cannot cover the
          quantity says how short it is rather than quietly claiming stock the store does not hold.
        </p>
        {!canMaintain && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Maintenance requires an explicit exact-code role grant for{' '}
            {BATCH_DETERMINATION_CAPABILITY}; broad wildcard role patterns do not grant it.
          </p>
        )}
      </header>

      <BatchDetermination rules={rules} canMaintain={canMaintain} />
    </main>
  );
}
