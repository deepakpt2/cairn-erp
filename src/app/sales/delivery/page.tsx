import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  DELIVERY_CAPABILITY,
  DELIVERY_GOODS_ISSUE_CAPABILITY,
  DELIVERY_PICK_CAPABILITY,
  DELIVERY_ROUTE,
  getDelivery,
  listDeliverableOrderLines,
  listDeliveries,
} from '@/modules/sales/delivery';
import { SALES_ORDER_RELEASE_CAPABILITY, salesOrderChoices } from '@/modules/sales/sales-order';
import Delivery from './Delivery';

export const dynamic = 'force-dynamic';

/**
 * The outbound delivery: what an order still owes, what the store has confirmed, and the movement that ships it.
 *
 * The page is the delivery's own — it is not a tab of the order. A delivery has its own number, its own plant,
 * its own status ladder and its own capability, and the goods issue that closes it is the inventory engine's
 * act rather than an order edit. `?order=` opens the items that order still has open; `?delivery=` reads one
 * document as it stands, with the pick history beside it.
 */
export default async function SalesDeliveryPage({ searchParams }: {
  searchParams: Promise<{ delivery?: string; order?: string }>;
}) {
  const session = await requireSession(DELIVERY_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const orderNumber = (params.order ?? '').trim().toUpperCase();
  const deliveryNumber = (params.delivery ?? '').trim().toUpperCase();
  const [documents, openLines, selected, choices] = await Promise.all([
    listDeliveries(client, orderNumber ? { orderNumber } : {}),
    orderNumber
      ? listDeliverableOrderLines(client, { orderNumber })
      : listDeliverableOrderLines(client, {}),
    deliveryNumber ? getDelivery(client, deliveryNumber) : Promise.resolve(null),
    salesOrderChoices(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{DELIVERY_CAPABILITY} · {DELIVERY_PICK_CAPABILITY} · {DELIVERY_GOODS_ISSUE_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Outbound deliveries</h1>
          <div className="flex gap-2">
            <Link href="/sales/orders" className="btn btn-default min-h-11 sm:min-h-8">Sales orders</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          A delivery is created from the quantity an order line still has open, picked in the store, and closed
          by a goods issue that posts stock, valuation and the journal together. A delivery on its own moves
          nothing, and an order that is credit-blocked does not get one.
        </p>
      </header>
      <Delivery
        documents={documents}
        openLines={openLines}
        selected={selected}
        plants={choices.plants}
        orderNumber={orderNumber}
        canCreate={can(session, DELIVERY_CAPABILITY)}
        canPick={can(session, DELIVERY_PICK_CAPABILITY)}
        canPost={can(session, DELIVERY_GOODS_ISSUE_CAPABILITY)}
        canRelease={can(session, SALES_ORDER_RELEASE_CAPABILITY)}
      />
    </div>
  );
}
