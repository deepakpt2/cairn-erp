import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { listControllingAreas } from '@/modules/foundation/controlling-area-maintenance';
import {
  ORDER_SETTLEMENT_COLLECTIVE_CAPABILITY,
  ORDER_SETTLEMENT_COLLECTIVE_ROUTE,
} from '@/modules/foundation/order-settlement';
import CollectiveForm from './CollectiveForm';

export const dynamic = 'force-dynamic';

/** KO8G. A selection of internal orders. It calls the same check as KO88 and does not post. */
export default async function CollectiveOrderSettlementPage() {
  const session = await requireSession(ORDER_SETTLEMENT_COLLECTIVE_ROUTE);
  if (!can(session, ORDER_SETTLEMENT_COLLECTIVE_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Collective actual settlement</h1>
        <p className="mt-2 text-sm">You do not hold the collective settlement capability (CO.SETTLE.COLLECTIVE).</p>
      </main>
    );
  }
  const areas = await listControllingAreas(session.user.client);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">CO.SETTLE.COLLECTIVE · KO8G</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Collective actual settlement</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          KO8G selects internal orders and uses the same settlement check as KO88. It does not post. Maintenance orders are not configured. Production orders are not selected. CO88 is not this screen.
        </p>
      </header>
      <CollectiveForm
        areas={areas.map((row) => ({ controllingArea: row.controllingArea, name: row.name }))}
      />
    </main>
  );
}
