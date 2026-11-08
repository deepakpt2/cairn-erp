import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { listBillings } from '@/modules/sales/billing';
import { getDelivery } from '@/modules/sales/delivery';
import {
  RETURNS_DELIVERY_CAPABILITY,
  RETURNS_ORDER_CAPABILITY,
  RETURNS_RECEIPT_CAPABILITY,
  RETURNS_ROUTE,
  listReturnsDeliveries,
  listReturnsOrders,
} from '@/modules/sales/returns';
import { getSalesOrder } from '@/modules/sales/sales-order';
import Returns from './Returns';

export const dynamic = 'force-dynamic';

/**
 * Returns from customers: the complaint, the document the goods come back on, and the receipt.
 *
 * The chain is worked on one screen because it is one story — the customer says what they are sending
 * back, the warehouse is told to expect it, and the goods arrive — and because each act is bound by the
 * one before it: a returns order by what the invoice billed, a returns delivery by what the order has
 * not already promised, a receipt by what the delivery has not already received. Three screens would
 * each have to re-derive where the chain stands; here it is read once, in the order it happened.
 *
 * Each act carries its own capability, because they are not three permissions on one thing: raising the
 * complaint is a commercial act that posts nothing, raising the delivery is a warehouse instruction, and
 * receiving the goods moves stock. `?order=` opens a returns order as it stands, `?delivery=` a returns
 * delivery.
 */
export default async function SalesReturnsPage({ searchParams }: {
  searchParams: Promise<{ order?: string; delivery?: string; customer?: string }>;
}) {
  const session = await requireSession(RETURNS_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const orderNumber = (params.order ?? '').trim().toUpperCase();
  const deliveryNumber = (params.delivery ?? '').trim().toUpperCase();
  const customerNumber = (params.customer ?? '').trim().toUpperCase();
  const [orders, deliveries, invoices, selectedOrder, selectedDelivery] = await Promise.all([
    listReturnsOrders(client, customerNumber ? { customerNumber } : {}),
    listReturnsDeliveries(client, orderNumber ? { orderNumber } : {}),
    listBillings(client, {}),
    orderNumber ? getSalesOrder(client, orderNumber) : Promise.resolve(null),
    deliveryNumber ? getDelivery(client, deliveryNumber) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">
          {RETURNS_ORDER_CAPABILITY} · {RETURNS_DELIVERY_CAPABILITY} · {RETURNS_RECEIPT_CAPABILITY}
        </span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Returns from customers</h1>
          <div className="flex gap-2">
            <Link href="/sales/billing" className="btn btn-default min-h-11 sm:min-h-8">Billing</Link>
            <Link href="/sales/credit-memo" className="btn btn-default min-h-11 sm:min-h-8">Credit memo</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          A return begins as a complaint against an invoice, is given a document goods can come back on, and
          ends with a receipt that puts those goods into returns stock. Returns stock is not valuated, so the
          receipt posts no accounting document: the goods are still the customer&apos;s until they are inspected
          and transferred into valuated stock.
        </p>
      </header>
      <Returns
        orders={orders}
        deliveries={deliveries}
        invoices={invoices}
        selectedOrder={selectedOrder}
        selectedDelivery={selectedDelivery}
        canRaiseOrder={can(session, RETURNS_ORDER_CAPABILITY)}
        canRaiseDelivery={can(session, RETURNS_DELIVERY_CAPABILITY)}
        canReceive={can(session, RETURNS_RECEIPT_CAPABILITY)}
      />
    </div>
  );
}
