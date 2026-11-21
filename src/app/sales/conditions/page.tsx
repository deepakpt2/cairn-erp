
import { can, requireSession } from '@/platform/auth/current';
import {
  CONDITION_CAPABILITY,
  CONDITION_ROUTE,
  listSalesConditions,
} from '@/modules/sales/conditions';
import { NO_SALES_CHOICES, salesOrderChoices } from '@/modules/sales/sales-order';
import Conditions from './Conditions';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * Sales condition records.
 *
 * The price a customer is charged for a material in a sales area, for a period. A sales order takes its
 * prices from these records and nowhere else, which is why this screen closes a span instead of
 * overwriting one: an order priced last month still reads the price it was priced at.
 */
export default async function SalesConditionsPage({ searchParams }: {
  searchParams: Promise<{ customer?: string; material?: string }>;
}) {
  const session = await requireSession(CONDITION_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const [records, choices] = await Promise.all([
    listSalesConditions(client, {
      ...(params.customer ? { customerNumber: params.customer } : {}),
      ...(params.material ? { materialNumber: params.material } : {}),
    }),
    salesOrderChoices(client, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => NO_SALES_CHOICES),
  ]);

  return (
    <Page
      title="Sales condition records" code={CONDITION_CAPABILITY}
      description="The price one customer and material carry in a sales area. A record is never deleted: saving a price over an overlapping period closes the standing record the day before, and the orders that already read it keep the price they read."
    >
      <Conditions
        records={records}
        salesAreas={choices.salesAreas}
        canMaintain={can(session, CONDITION_CAPABILITY)}
      />
    </Page>
  );
}
