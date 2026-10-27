import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  CONDITION_CAPABILITY,
  CONDITION_ROUTE,
  listSalesConditions,
} from '@/modules/sales/conditions';
import { salesOrderChoices } from '@/modules/sales/sales-order';
import Conditions from './Conditions';

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
    salesOrderChoices(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CONDITION_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Sales condition records</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          The price one customer and material carry in a sales area. A record is never deleted: saving a
          price over an overlapping period closes the standing record the day before, and the orders that
          already read it keep the price they read.
        </p>
      </header>
      <Conditions
        records={records}
        salesAreas={choices.salesAreas}
        canMaintain={can(session, CONDITION_CAPABILITY)}
      />
    </div>
  );
}
