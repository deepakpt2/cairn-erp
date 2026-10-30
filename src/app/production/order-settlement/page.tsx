import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { PROD_ORDER_SETTLEMENT_CAPABILITY, PROD_ORDER_SETTLEMENT_ROUTE } from '@/modules/production/order-settlement';
import SettlementForm from './SettlementForm';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** PROD.ORDER.SETTLE. One production order. It does not post until a settlement rule is stored. */
export default async function ProductionOrderSettlementPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PROD_ORDER_SETTLEMENT_ROUTE);
  if (!can(session, PROD_ORDER_SETTLEMENT_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Production order settlement</h1>
        <p className="mt-2 text-sm">You do not hold the production-order settlement capability (PROD.ORDER.SETTLE).</p>
      </main>
    );
  }
  const orderNumber = last((await searchParams).order);

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.ORDER.SETTLE · KO88</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Production order settlement</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          KO88 checks one production order. It does not select a range. An update posts only when a settlement rule is stored,
          and only through the journal. No receiver or percentage is entered here. The rule screen is /production/settlement-rules.
          WIP calculation (DV-003) and variance categorization (DV-004) are deferred.
        </p>
      </header>
      <SettlementForm orderNumber={orderNumber} />
    </main>
  );
}
