import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import {
  PRODUCTION_ORDER_CHANGE_ALIAS,
  PRODUCTION_ORDER_CHANGE_CAPABILITY,
  PRODUCTION_ORDER_CHANGE_ROUTE,
  PRODUCTION_ORDER_LOCK,
} from '@/modules/production/production-order-change';
import {
  PRODUCTION_ORDER_DISPLAY_ROUTE,
  ProductionOrderDisplayError,
  getProductionOrderDisplay,
  listProductionOrders,
  productionOrderDisplayRefusal,
} from '@/modules/production/production-order-display';
import OrderChangeForm from './OrderChangeForm';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** CO02. Change quantity, dates, or components. This page does not release or post. */
export default async function ProductionOrderChangePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PRODUCTION_ORDER_CHANGE_ROUTE);
  if (!can(session, PRODUCTION_ORDER_CHANGE_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Change production order</h1>
        <p className="mt-2 text-sm">You do not hold production-order change ({PRODUCTION_ORDER_CHANGE_CAPABILITY}).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const refusal = productionOrderDisplayRefusal({
    orderType: one(raw.orderType),
    controllingArea: one(raw.controllingArea),
    scrap: one(raw.scrap),
    productionVersion: one(raw.productionVersion),
    operation: one(raw.operation),
    sequence: one(raw.sequence),
    teco: one(raw.teco),
  });
  const plant = one(raw.plant).toUpperCase();
  const materialNumber = one(raw.material).toUpperCase();
  const orderNumber = one(raw.order);
  let openError = refusal ?? '';
  let document = null;
  let listed = null;
  if (!refusal && orderNumber) {
    try {
      document = await getProductionOrderDisplay(session.user.client, orderNumber);
      if (!document) openError = `Production order ${orderNumber} does not stand.`;
    } catch (error) {
      openError = error instanceof ProductionOrderDisplayError ? error.message : 'The production order could not be opened.';
    }
  } else if (!refusal && (plant || materialNumber)) {
    try {
      listed = await listProductionOrders(session.user.client, { plant, materialNumber });
    } catch (error) {
      openError = error instanceof ProductionOrderDisplayError ? error.message : 'The production orders could not be listed.';
    }
  }
  const lock = document
    ? await openChangeForSession(session, {
      lockObject: PRODUCTION_ORDER_LOCK,
      argument: document.orderNumber,
      transactionCode: PRODUCTION_ORDER_CHANGE_ALIAS,
    })
    : null;
  const locked = lock?.mode === 'DISPLAY';

  return (
    <main className="mx-auto max-w-5xl p-6">
      <p className="text-sm text-ink-faint">PROD.ORDER.CHANGE · CO02</p>
      <h1 className="mt-1 text-xl font-semibold">Change production order</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-soft">
        Change the quantity, the dates, or the component snapshot. The number, material, plant, and status stay fixed.
        A goods movement freezes the order. This screen does not release it or post.
        <Link className="ml-2" href={PRODUCTION_ORDER_DISPLAY_ROUTE}>Display writes nothing.</Link>
      </p>
      {openError && <p role="status" className="mt-3 text-sm text-danger">{openError}</p>}
      {lock && displayOnlyMessage(lock) && <p className="mt-3 text-sm">{displayOnlyMessage(lock)}</p>}
      <form className="mt-4 grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="order" defaultValue={orderNumber} maxLength={12} placeholder="Production order" />
        <input className="input" name="plant" defaultValue={plant} maxLength={10} placeholder="Plant" />
        <input className="input" name="material" defaultValue={materialNumber} maxLength={40} placeholder="Material" />
        <button className="btn" type="submit">Open</button>
      </form>
      {listed && (
        <section className="mt-4 text-sm">
          <p>{listed.total} production order{listed.total === 1 ? '' : 's'}. The first was not opened.</p>
          <ul className="mt-2 space-y-1">
            {listed.rows.map((row) => (
              <li key={row.orderNumber}>
                <Link href={`${PRODUCTION_ORDER_CHANGE_ROUTE}?order=${encodeURIComponent(row.orderNumber)}`}>{row.orderNumber}</Link>
                {' · '}{row.materialNumber} · {row.status}
              </li>
            ))}
          </ul>
        </section>
      )}
      {document && !locked && <OrderChangeForm order={document} />}
      {document && locked && (
        <p className="mt-4 text-sm">{document.orderNumber} is open for display only. Nothing was saved.</p>
      )}
    </main>
  );
}
