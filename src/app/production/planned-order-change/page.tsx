import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import {
  PLANNED_ORDER_CHANGE_ALIAS,
  PLANNED_ORDER_CHANGE_CAPABILITY,
  PLANNED_ORDER_CHANGE_ROUTE,
  PLANNED_ORDER_LOCK,
} from '@/modules/production/planned-order-change';
import {
  PLANNED_ORDER_DISPLAY_ROUTE,
  PlannedOrderDisplayError,
  getPlannedOrder,
  listPlannedOrders,
} from '@/modules/production/planned-order-display';
import PlannedOrderForm from './PlannedOrderForm';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** MD12. Change a planned order. The number, material, and plant stay fixed. */
export default async function PlannedOrderChangePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PLANNED_ORDER_CHANGE_ROUTE);
  if (!can(session, PLANNED_ORDER_CHANGE_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Change planned order</h1>
        <p className="mt-2 text-sm">You do not hold the planned-order change capability ({PLANNED_ORDER_CHANGE_CAPABILITY}).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const orderNumber = one(raw.order);
  const plant = one(raw.plant).toUpperCase();
  const materialNumber = one(raw.material).toUpperCase();
  let openError = '';
  let document = null;
  let listed: Awaited<ReturnType<typeof listPlannedOrders>> | null = null;
  if (orderNumber) {
    try {
      document = await getPlannedOrder(session.user.client, orderNumber);
      if (!document) openError = `Planned order ${orderNumber} does not stand.`;
    } catch (error) {
      openError = error instanceof PlannedOrderDisplayError ? error.message : 'The planned order could not be opened.';
    }
  } else if (plant || materialNumber) {
    try {
      listed = await listPlannedOrders(session.user.client, { plant, materialNumber });
    } catch (error) {
      openError = error instanceof PlannedOrderDisplayError ? error.message : 'The planned orders could not be listed.';
    }
  }
  const lock = document
    ? await openChangeForSession(session, {
      lockObject: PLANNED_ORDER_LOCK,
      argument: document.orderNumber,
      transactionCode: PLANNED_ORDER_CHANGE_ALIAS,
    })
    : null;
  const locked = lock?.mode === 'DISPLAY';

  return (
    <main className="mx-auto max-w-5xl p-6">
      <p className="text-sm text-ink-faint">PROD.PLANNEDORDER.CHANGE · MD12</p>
      <h1 className="mt-1 text-xl font-semibold">Change planned order</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-soft">
        Change the quantity, the dates, or the firming indicator. The number, material, and plant stay fixed.
        This screen does not convert the order, explode a bill of material, or post.
        <Link className="ml-2" href={PLANNED_ORDER_DISPLAY_ROUTE}>Display writes nothing.</Link>
        <Link className="ml-2" href="/production/planned-order-create">Create is a different screen.</Link>
      </p>
      {openError && <p role="status" className="mt-3 text-sm text-danger">{openError}</p>}
      {lock && displayOnlyMessage(lock) && <p className="mt-3 text-sm">{displayOnlyMessage(lock)}</p>}
      <form className="mt-4 grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="order" defaultValue={orderNumber} maxLength={12} placeholder="Planned order" />
        <input className="input" name="plant" defaultValue={plant} maxLength={10} placeholder="Plant" />
        <input className="input" name="material" defaultValue={materialNumber} maxLength={40} placeholder="Material" />
        <button className="btn" type="submit">Open</button>
      </form>
      {listed && (
        <section className="mt-4 text-sm">
          <p>{listed.total} planned order{listed.total === 1 ? '' : 's'}. The first was not opened.</p>
          <ul className="mt-2 space-y-1">
            {listed.rows.map((row) => (
              <li key={row.orderNumber}>
                <Link href={`${PLANNED_ORDER_CHANGE_ROUTE}?order=${encodeURIComponent(row.orderNumber)}`}>{row.orderNumber}</Link>
                {' '}{row.materialNumber} {row.plant} {row.quantity} {row.unit} finish {row.finishDate}
              </li>
            ))}
          </ul>
        </section>
      )}
      {document && (
        <section className="mt-4 space-y-2 text-sm" data-md12-order={document.orderNumber}>
          <p>{document.orderNumber} · {document.materialNumber} {document.materialDescription}</p>
          <p>Plant {document.plant} {document.plantName}. Origin {document.origin === 'MANUAL' ? 'created by hand' : document.origin === 'MRP' ? 'proposed by planning' : document.origin}. Record version {document.version}.</p>
          <p>Not converted. No follow-on document is stored, and this screen does not create one.</p>
          {document.dependents.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-faint"><th>Component</th><th>Quantity</th><th>Date</th><th>Status</th></tr>
              </thead>
              <tbody>
                {document.dependents.map((row) => (
                  <tr key={`${row.itemNumber}/${row.componentMaterial}`}>
                    <td className="py-1">{row.componentMaterial} {row.componentDescription}</td>
                    <td>{row.quantity} {row.unit}</td>
                    <td>{row.requirementDate}</td>
                    <td>{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-ink-soft">
            This order does not store an MRP area, a production version, a bill of material, a routing, a scheduler, a storage location, or a deletion flag. Those fields are not on this screen.
          </p>
          {locked
            ? <p>This opening is display only. The save is refused while another session holds the order.</p>
            : <PlannedOrderForm document={document} />}
        </section>
      )}
    </main>
  );
}
