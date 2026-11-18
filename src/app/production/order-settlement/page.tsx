
import { can, requireSession } from '@/platform/auth/current';
import { PROD_ORDER_SETTLEMENT_CAPABILITY, PROD_ORDER_SETTLEMENT_ROUTE } from '@/modules/production/order-settlement';
import SettlementForm from './SettlementForm';
import { Page } from '@/ui/kit';

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
    <Page
      title="Production order settlement" code="PROD.ORDER.SETTLE · KO88" width="4xl"
      description="KO88 checks one production order. It does not select a range. An update posts only when a settlement rule is stored, and only through the journal. No receiver or percentage is entered here. The rule screen is /production/settlement-rules. WIP calculation (DV-003) and variance categorization (DV-004) are deferred."
    >
      <SettlementForm orderNumber={orderNumber} />
    </Page>
  );
}
