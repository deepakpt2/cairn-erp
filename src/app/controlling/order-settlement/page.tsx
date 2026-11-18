
import { can, requireSession } from '@/platform/auth/current';
import { ORDER_SETTLEMENT_CAPABILITY, ORDER_SETTLEMENT_ROUTE } from '@/modules/foundation/order-settlement';
import SettlementForm from './SettlementForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** KO88. One internal order. It does not post. */
export default async function OrderSettlementPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ORDER_SETTLEMENT_ROUTE);
  if (!can(session, ORDER_SETTLEMENT_CAPABILITY)) {
    return (
      <Page
      title="Actual settlement" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold the individual settlement capability (CO.SETTLE.ORDER).</p>
      </Page>
    );
  }
  const orderNumber = last((await searchParams).order);

  return (
    <Page
      title="Actual settlement" code="CO.SETTLE.ORDER · KO88" width="4xl"
      description="KO88 checks one internal order. It does not select a range. An update posts only when a settlement rule is stored, and only through the journal. No receiver or percentage is entered here. KO8G is a different screen."
    >
      <SettlementForm orderNumber={orderNumber} />
    </Page>
  );
}
