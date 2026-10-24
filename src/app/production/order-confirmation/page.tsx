import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ORDER_CONFIRMATION_CAPABILITY,
  ORDER_CONFIRMATION_ROUTE,
  OrderConfirmationError,
  loadOrderConfirmation,
  orderConfirmationRefusal,
} from '@/modules/production/order-confirmation';
import { ProductionOrderDisplayError, listProductionOrders } from '@/modules/production/production-order-display';
import OrderConfirmationWorkbench from './OrderConfirmationWorkbench';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default async function OrderConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ORDER_CONFIRMATION_ROUTE);
  const params = await searchParams;
  const refusal = orderConfirmationRefusal({
    confirmationProfile: one(params.confirmationProfile),
    automatic: one(params.automatic),
    automaticFinal: one(params.automaticFinal),
    sequence: one(params.sequence),
    personnel: one(params.personnel),
    backflush: one(params.backflush),
    automaticGoodsReceipt: one(params.automaticGoodsReceipt),
    operation: one(params.operation),
    co11n: one(params.co11n),
    co13: one(params.co13),
    cost: one(params.cost),
    orderType: one(params.orderType),
    referenceConfirmation: one(params.referenceConfirmation),
    longText: one(params.longText),
    varianceReason: one(params.varianceReason),
    quality: one(params.quality),
    serial: one(params.serial),
    capacity: one(params.capacity),
  });
  const orderNumber = one(params.order);
  const plant = one(params.plant).toUpperCase();
  const materialNumber = one(params.material).toUpperCase();
  let loaded = null;
  let listed = null;
  let openError = refusal ?? '';
  if (!refusal && can(session, ORDER_CONFIRMATION_CAPABILITY)) {
    if (orderNumber) {
      try {
        loaded = await loadOrderConfirmation(session.user.client, {
          orderNumber,
          productionVersion: one(params.version),
          postingDate: one(params.postingDate),
        });
      } catch (error) {
        openError = error instanceof OrderConfirmationError ? error.message : 'The order could not be read.';
      }
    } else if (plant || materialNumber) {
      try {
        listed = await listProductionOrders(session.user.client, {
          plant,
          materialNumber,
          status: one(params.status) || null,
        });
      } catch (error) {
        openError = error instanceof ProductionOrderDisplayError ? error.message : 'The production orders could not be listed.';
      }
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.CONFIRM.ORDER · CO15</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Enter order confirmation</h1>
          <Link href="/production/production-order-display" className="btn btn-default min-h-11 sm:min-h-8">CO03</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Confirm a released production order at header level. A check writes nothing.
          A posted confirmation is not edited here. The order status is not changed.
          No goods movement is posted.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft" data-co15-gaps>
          A confirmation profile, automatic final confirmation, backflush, automatic goods receipt, personnel, and cancellation are not this screen. CO11N confirms one operation. CO13 and CO14 are not implemented.
        </p>
      </header>
      {openError && <p role="status" data-co15-refused className="text-sm text-red-700">{openError}</p>}
      {!can(session, ORDER_CONFIRMATION_CAPABILITY) && (
        <p className="text-sm">You do not hold the confirmation capability ({ORDER_CONFIRMATION_CAPABILITY}).</p>
      )}
      <form className="grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="order" defaultValue={orderNumber} maxLength={12} placeholder="Production order" />
        <input className="input" name="plant" defaultValue={plant} maxLength={10} placeholder="Plant" />
        <input className="input" name="material" defaultValue={materialNumber} maxLength={40} placeholder="Material" />
        <input className="input" name="version" defaultValue={one(params.version)} maxLength={4} placeholder="Production version" />
        <button className="btn" type="submit">Open</button>
      </form>
      {listed && (
        <table className="w-full text-sm" data-co15-orders>
          <thead>
            <tr className="text-left text-ink-faint">
              <th>Order</th>
              <th>Material</th>
              <th>Quantity</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {listed.rows.map((row) => (
              <tr key={row.orderNumber}>
                <td className="py-1">
                  <Link href={`/production/order-confirmation?order=${encodeURIComponent(row.orderNumber)}`}>{row.orderNumber}</Link>
                </td>
                <td>{row.materialNumber} {row.materialDescription}</td>
                <td>{row.quantity} {row.unit}</td>
                <td>{row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {listed && listed.rows.length === 0 && <p className="text-sm">No production order stands for that selection.</p>}
      {loaded && (
        <OrderConfirmationWorkbench
          canConfirm={can(session, ORDER_CONFIRMATION_CAPABILITY)}
          loaded={loaded}
        />
      )}
    </div>
  );
}
