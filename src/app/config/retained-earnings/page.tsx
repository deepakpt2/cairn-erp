import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { listCompanyCodes } from '@/modules/foundation/services';
import {
  RETAINED_EARNINGS_ACTIVITY,
} from '@/modules/foundation/retained-earnings-vocabulary';
import { listRetainedEarnings } from '@/modules/foundation/retained-earnings';
import { RetainedEarnings } from './RetainedEarnings';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/retained-earnings';

/**
 * Retained earnings account definition (SCR-121; OB53 as a
 * search alias only).
 */
export default async function RetainedEarningsPage() {
  const session = await requireSession(ROUTE);
  const rows = await listRetainedEarnings(session.user.client);
  const companies = await listCompanyCodes(session.user.client);
  const charts = [...new Map(
    companies.filter((c) => c.chartOfAccounts)
      .map((c) => [c.chartOfAccounts as string, { chartOfAccounts: c.chartOfAccounts as string, name: c.chartOfAccounts as string }]),
  ).values()];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{RETAINED_EARNINGS_ACTIVITY} · OB53</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Retained Earnings Account</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Configuration workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Per chart of accounts, the retained earnings account each indicator closes to: the P&amp;L accounts carrying an
          indicator transfer their balance to its retained earnings account at balance carryforward.
        </p>
      </header>

      <RetainedEarnings rows={rows} charts={charts} canMaintain={can(session, RETAINED_EARNINGS_ACTIVITY)} />
    </div>
  );
}
