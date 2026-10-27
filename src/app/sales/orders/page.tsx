import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  SALES_ORDER_CAPABILITY,
  SALES_ORDER_RELEASE_CAPABILITY,
  SALES_ORDER_ROUTE,
  getSalesOrder,
  listSalesOrderDocuments,
  salesOrderChoices,
} from '@/modules/sales/sales-order';
import Orders from './Orders';

export const dynamic = 'force-dynamic';

/**
 * Sales order entry and display.
 *
 * One screen carries the three, as purchasing does for the purchase order: the list, the document
 * read by `?order=`, and the form that creates or changes it. The credit state shown here is the
 * determination that stands against the order, read from the credit engine — never a copy of it.
 */
export default async function SalesOrdersPage({ searchParams }: {
  searchParams: Promise<{ order?: string; customer?: string }>;
}) {
  const session = await requireSession(SALES_ORDER_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const [documents, choices, selected] = await Promise.all([
    listSalesOrderDocuments(client, params.customer ? { customerNumber: params.customer } : {}),
    salesOrderChoices(client),
    params.order ? getSalesOrder(client, params.order.trim()) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{SALES_ORDER_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Sales orders</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          An order states what the customer asked for and at what price, and it posts nothing. The price
          of every item is read from the standing condition record, and the save runs the credit check for
          the order value.
        </p>
      </header>
      <Orders
        documents={documents}
        choices={choices}
        selected={selected}
        canCreate={can(session, SALES_ORDER_CAPABILITY)}
        canRelease={can(session, SALES_ORDER_RELEASE_CAPABILITY)}
      />
    </div>
  );
}
