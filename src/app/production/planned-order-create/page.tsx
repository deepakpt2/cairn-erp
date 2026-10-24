import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  PLANNED_ORDER_CREATE_CAPABILITY,
  PLANNED_ORDER_CREATE_ROUTE,
  plannedOrderCreateRefusal,
} from '@/modules/production/planned-order-create';
import {
  PLANNED_ORDER_DISPLAY_ROUTE,
  PlannedOrderDisplayError,
  getPlannedOrder,
  listPlannedOrders,
} from '@/modules/production/planned-order-display';
import PlannedOrderCreateForm from './PlannedOrderCreateForm';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** MD11. Create a planned order by hand. This page does not convert it. */
export default async function PlannedOrderCreatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PLANNED_ORDER_CREATE_ROUTE);
  if (!can(session, PLANNED_ORDER_CREATE_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Create planned order</h1>
        <p className="mt-2 text-sm">You do not hold the planned-order create capability ({PLANNED_ORDER_CREATE_CAPABILITY}).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const refusal = plannedOrderCreateRefusal({
    profile: one(raw.profile),
    mrpArea: one(raw.mrpArea),
    orderType: one(raw.orderType),
    orderNumber: one(raw.orderNumber),
    specialProcurement: one(raw.specialProcurement),
    openingDate: one(raw.openingDate),
    productionVersion: one(raw.productionVersion),
    bom: one(raw.bom),
    routing: one(raw.routing),
    companyCode: one(raw.companyCode),
  });
  const plant = one(raw.plant).toUpperCase();
  const materialNumber = one(raw.material).toUpperCase();
  const referenceOrder = one(raw.reference);
  let openError = refusal ?? '';
  let reference = null;
  let listed: Awaited<ReturnType<typeof listPlannedOrders>> | null = null;
  if (!refusal && referenceOrder) {
    try {
      reference = await getPlannedOrder(session.user.client, referenceOrder);
      if (!reference) openError = `Planned order ${referenceOrder} does not stand.`;
    } catch (error) {
      openError = error instanceof PlannedOrderDisplayError ? error.message : 'The reference order could not be read.';
    }
  } else if (!refusal && (plant || materialNumber)) {
    try {
      listed = await listPlannedOrders(session.user.client, { plant, materialNumber });
    } catch (error) {
      openError = error instanceof PlannedOrderDisplayError ? error.message : 'The planned orders could not be listed.';
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <p className="text-sm text-ink-faint">PROD.PLANNEDORDER.CREATE · MD11</p>
      <h1 className="mt-1 text-xl font-semibold">Create planned order</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-soft">
        Create one planned order for a material produced in the plant. A bought material is refused.
        A planned-order profile is not stored. Copying a reference creates a new number and does not change the original.
        <Link className="ml-2" href={PLANNED_ORDER_DISPLAY_ROUTE}>Display writes nothing.</Link>
      </p>
      {openError && <p role="status" data-md11-refused className="mt-3 text-sm text-danger">{openError}</p>}
      <form className="mt-4 grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="plant" defaultValue={plant} maxLength={10} placeholder="Plant" />
        <input className="input" name="material" defaultValue={materialNumber} maxLength={40} placeholder="Material" />
        <input className="input" name="reference" defaultValue={referenceOrder} maxLength={12} placeholder="Reference order" />
        <button className="btn" type="submit">Find</button>
      </form>
      {listed && (
        <section className="mt-4 text-sm">
          <p>{listed.total} planned order{listed.total === 1 ? '' : 's'}. The first was not opened.</p>
          <ul className="mt-2 space-y-1">
            {listed.rows.map((row) => (
              <li key={row.orderNumber}>
                <Link href={`${PLANNED_ORDER_CREATE_ROUTE}?reference=${encodeURIComponent(row.orderNumber)}`}>{row.orderNumber}</Link>
                {' '}{row.materialNumber} {row.plant} {row.quantity} {row.unit}
              </li>
            ))}
          </ul>
        </section>
      )}
      {reference && (
        <p className="mt-4 text-sm">
          Copying from {reference.orderNumber}. The original is not changed, and its number is not reused.
        </p>
      )}
      {!refusal && (
        <PlannedOrderCreateForm
          plant={reference?.plant ?? plant}
          materialNumber={reference?.materialNumber ?? materialNumber}
          quantity={reference?.quantity ?? one(raw.quantity)}
          unit={reference?.unit ?? ''}
          startDate={reference?.startDate ?? one(raw.start)}
          finishDate={reference?.finishDate ?? one(raw.finish)}
          referenceOrder={reference?.orderNumber ?? ''}
        />
      )}
    </main>
  );
}
