
import { can, requireSession } from '@/platform/auth/current';
import { PROD_ORDER_SETTLEMENT_CAPABILITY, PROD_ORDER_SETTLEMENT_ROUTE } from '@/modules/production/order-settlement';
import SettlementForm from './SettlementForm';
import WipForm from './WipForm';
import { WIP_METHOD_STATEMENT } from '@/modules/production/order-wip';
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
      <Page
      title="Production order settlement" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold the production-order settlement capability (PROD.ORDER.SETTLE).</p>
      </Page>
    );
  }
  const orderNumber = last((await searchParams).order);

  return (
    <Page
      title="Production order settlement" code="PROD.ORDER.SETTLE · KO88" width="4xl"
      description="KO88 checks one production order. It does not select a range. An update posts only when a settlement rule is stored, and only through the journal. No receiver or percentage is entered here. The rule screen is /production/settlement-rules. Final settlement is for a technically completed order (it unwinds the order's WIP first); an unfinished order's balance is capitalised as work in process below. Variance categorization (DV-004) is deferred."
    >
      <SettlementForm orderNumber={orderNumber} />
      <hr className="my-6 border-line" />
      <WipForm orderNumber={orderNumber} method={WIP_METHOD_STATEMENT} />
    </Page>
  );
}
