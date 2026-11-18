
import { can, requireSession } from '@/platform/auth/current';
import { listControllingAreas } from '@/modules/foundation/controlling-area-maintenance';
import {
  ORDER_SETTLEMENT_COLLECTIVE_CAPABILITY,
  ORDER_SETTLEMENT_COLLECTIVE_ROUTE,
} from '@/modules/foundation/order-settlement';
import CollectiveForm from './CollectiveForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/** KO8G. A selection of internal orders. It calls the same check as KO88 and does not post. */
export default async function CollectiveOrderSettlementPage() {
  const session = await requireSession(ORDER_SETTLEMENT_COLLECTIVE_ROUTE);
  if (!can(session, ORDER_SETTLEMENT_COLLECTIVE_CAPABILITY)) {
    return (
      <Page
      title="Collective actual settlement" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold the collective settlement capability (CO.SETTLE.COLLECTIVE).</p>
      </Page>
    );
  }
  const areas = await listControllingAreas(session.user.client);

  return (
    <Page
      title="Collective actual settlement" code="CO.SETTLE.COLLECTIVE · KO8G" width="4xl"
      description="KO8G selects internal orders and uses the same settlement check as KO88. It does not post. Maintenance orders are not configured. Production orders are not selected. CO88 is not this screen."
    >
      <CollectiveForm
        areas={areas.map((row) => ({ controllingArea: row.controllingArea, name: row.name }))}
      />
    </Page>
  );
}
