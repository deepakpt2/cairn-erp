
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
import { LinkButton, Page } from '@/ui/kit';

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
    listReturnsOrders(client, customerNumber ? { customerNumber } : {}, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => []),
    listReturnsDeliveries(client, orderNumber ? { orderNumber } : {}, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => []),
    listBillings(client, {}, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => []),
    orderNumber ? getSalesOrder(client, orderNumber, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => null) : Promise.resolve(null),
    deliveryNumber ? getDelivery(client, deliveryNumber, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => null) : Promise.resolve(null),
  ]);

  return (
    <Page
      title="Returns from customers" code={<>
          {RETURNS_ORDER_CAPABILITY} · {RETURNS_DELIVERY_CAPABILITY} · {RETURNS_RECEIPT_CAPABILITY}
        </>}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">
              A return begins as a complaint against an invoice, is given a document goods can come back on, and
              ends with a receipt that puts those goods into returns stock. Returns stock is not valuated, so the
              receipt posts no accounting document: the goods are still the customer&apos;s until they are inspected
              and transferred into valuated stock.
            </p>
        </>
      }
      actions={
        <>
          <LinkButton href="/sales/billing">Billing</LinkButton>
          <LinkButton href="/sales/credit-memo">Credit memo</LinkButton>
        </>
      }
    >
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
    </Page>
  );
}
