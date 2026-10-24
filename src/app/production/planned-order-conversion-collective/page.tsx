import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  PLANNED_ORDER_CONVERT_COLLECTIVE_CAPABILITY,
  PLANNED_ORDER_CONVERT_COLLECTIVE_ROUTE,
  PLANNED_ORDER_CONVERT_ROUTE,
  PlannedOrderConversionError,
  listConvertiblePlannedOrders,
  plannedOrderConversionRefusal,
} from '@/modules/production/planned-order-conversion';
import CollectiveForm from './CollectiveForm';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** CO41. Search writes nothing. Each selected order is converted on its own. */
export default async function CollectiveConversionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PLANNED_ORDER_CONVERT_COLLECTIVE_ROUTE);
  if (!can(session, PLANNED_ORDER_CONVERT_COLLECTIVE_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Collective conversion</h1>
        <p className="mt-2 text-sm">You do not hold collective planned-order conversion ({PLANNED_ORDER_CONVERT_COLLECTIVE_CAPABILITY}).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const refusal = plannedOrderConversionRefusal({
    mrpArea: one(raw.mrpArea),
    openingDate: one(raw.openingDate),
    productionVersion: one(raw.productionVersion),
    salesOrder: one(raw.salesOrder),
    wbs: one(raw.wbs),
    availability: one(raw.availability),
    orderType: one(raw.orderType),
    bomExplosionNumber: one(raw.bomExplosionNumber),
  });
  const plant = one(raw.plant).toUpperCase();
  const materialNumber = one(raw.material).toUpperCase();
  const orderFrom = one(raw.orderFrom);
  const orderTo = one(raw.orderTo);
  const mrpController = one(raw.mrpController).toUpperCase();
  let openError = refusal ?? '';
  let listed = null;
  if (!refusal && plant) {
    try {
      listed = await listConvertiblePlannedOrders(session.user.client, {
        plant, materialNumber, orderFrom, orderTo, mrpController,
      });
    } catch (error) {
      openError = error instanceof PlannedOrderConversionError ? error.message : 'The planned orders could not be listed.';
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <p className="text-sm text-ink-faint">PROD.PLANNEDORDER.CONVERT.COLLECTIVE · CO41</p>
      <h1 className="mt-1 text-xl font-semibold">Collective conversion</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-soft">
        Search does not convert. Select the orders, then confirm. Each order is converted in its own transaction.
        A failure on one order does not roll back another. The number range is textual.
        <Link className="ml-2" href={PLANNED_ORDER_CONVERT_ROUTE}>One order is a different screen.</Link>
      </p>
      {openError && <p role="status" data-co41-refused className="mt-3 text-sm text-danger">{openError}</p>}
      <form className="mt-4 grid gap-2 sm:grid-cols-3" method="get">
        <input className="input" name="plant" defaultValue={plant} maxLength={10} placeholder="Plant" required />
        <input className="input" name="material" defaultValue={materialNumber} maxLength={40} placeholder="Material" />
        <input className="input" name="mrpController" defaultValue={mrpController} maxLength={3} placeholder="MRP controller" />
        <input className="input" name="orderFrom" defaultValue={orderFrom} maxLength={12} placeholder="Order from" />
        <input className="input" name="orderTo" defaultValue={orderTo} maxLength={12} placeholder="Order to" />
        <button className="btn" type="submit">Search</button>
      </form>
      {listed && (
        <section className="mt-4 text-sm">
          <p>{listed.total} planned order{listed.total === 1 ? '' : 's'}. Search did not convert. The first was not opened.{listed.truncated ? ' The list is truncated at 25.' : ''}</p>
          {listed.rows.length > 0 && <CollectiveForm rows={listed.rows} />}
        </section>
      )}
    </main>
  );
}
