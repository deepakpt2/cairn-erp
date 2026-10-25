import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  PLANNED_ORDER_CONVERT_CAPABILITY,
  PLANNED_ORDER_CONVERT_COLLECTIVE_ROUTE,
  PLANNED_ORDER_CONVERT_ROUTE,
  PlannedOrderConversionError,
  listConversionLog,
  listConvertiblePlannedOrders,
  plannedOrderConversionRefusal,
  previewPlannedOrderConversion,
} from '@/modules/production/planned-order-conversion';
import ConvertForm from './ConvertForm';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** CO40. Review one planned order, then convert it. Search writes nothing. */
export default async function PlannedOrderConversionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PLANNED_ORDER_CONVERT_ROUTE);
  if (!can(session, PLANNED_ORDER_CONVERT_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Convert planned order</h1>
        <p className="mt-2 text-sm">You do not hold planned-order conversion ({PLANNED_ORDER_CONVERT_CAPABILITY}).</p>
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
  const orderNumber = one(raw.order);
  let openError = refusal ?? '';
  let preview = null;
  let listed = null;
  let log: Awaited<ReturnType<typeof listConversionLog>> = [];
  if (!refusal && orderNumber) {
    try {
      preview = await previewPlannedOrderConversion(session.user.client, orderNumber);
      if (!preview) openError = `Planned order ${orderNumber} does not stand.`;
      else log = await listConversionLog(session.user.client, orderNumber);
    } catch (error) {
      openError = error instanceof PlannedOrderConversionError ? error.message : 'The planned order could not be read.';
    }
  } else if (!refusal && plant) {
    try {
      listed = await listConvertiblePlannedOrders(session.user.client, { plant, materialNumber });
    } catch (error) {
      openError = error instanceof PlannedOrderConversionError ? error.message : 'The planned orders could not be listed.';
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <p className="text-sm text-ink-faint">PROD.PLANNEDORDER.CONVERT · CO40</p>
      <h1 className="mt-1 text-xl font-semibold">Convert planned order</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-soft">
        Convert one planned order into a production order. The whole quantity is converted. The planned order is not deleted.
        Availability is not checked. Operations are not copied onto the production order.
        <Link className="ml-2" href={PLANNED_ORDER_CONVERT_COLLECTIVE_ROUTE}>Collective conversion is a different screen.</Link>
      </p>
      {openError && <p role="status" data-co40-refused className="mt-3 text-sm text-danger">{openError}</p>}
      <form className="mt-4 grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="plant" defaultValue={plant} maxLength={10} placeholder="Plant" />
        <input className="input" name="material" defaultValue={materialNumber} maxLength={40} placeholder="Material" />
        <input className="input" name="order" defaultValue={orderNumber} maxLength={12} placeholder="Planned order" />
        <button className="btn" type="submit">Find</button>
      </form>
      {listed && (
        <section className="mt-4 text-sm">
          <p>{listed.total} planned order{listed.total === 1 ? '' : 's'}. The first was not opened.</p>
          <ul className="mt-2 space-y-1">
            {listed.rows.map((row) => (
              <li key={row.orderNumber}>
                <Link href={`${PLANNED_ORDER_CONVERT_ROUTE}?order=${encodeURIComponent(row.orderNumber)}&plant=${encodeURIComponent(row.plant)}`}>
                  {row.orderNumber}
                </Link>
                {' · '}{row.materialNumber} · {row.quantity} {row.unit} · {row.eligible ? 'eligible' : row.blockedReason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {preview && (
        <section className="mt-4 space-y-2 text-sm" data-co40-order={preview.orderNumber}>
          <p>{preview.orderNumber} · {preview.materialNumber} · plant {preview.plant}</p>
          <p>Quantity {preview.quantity} {preview.unit}. Start {preview.startDate}. Finish {preview.finishDate}.</p>
          <p>Firming {preview.firmingStatus}. Procurement {preview.procurementType ?? 'not maintained'}.</p>
          <p>
            Production version {preview.productionVersion ?? 'not selected'}.
            Bill of material {preview.bomUsage ?? '—'} / {preview.bomAlternative ?? '—'}.
            Routing {preview.routingGroup ?? '—'} / {preview.groupCounter ?? '—'}.
            {preview.operationCount > 0
              ? ` ${preview.operationCount} operation(s) in effect will be copied when the order is saved. A later routing change does not rewrite them.`
              : ' No operation snapshot was prepared.'}
          </p>
          {preview.productionOrderNumber && (
            <p>Already converted to production order {preview.productionOrderNumber}. No second order will be created.</p>
          )}
          {preview.blockedReason && <p className="text-danger">{preview.blockedReason}</p>}
          {preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          {preview.components.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-faint">
                  <th>Item</th>
                  <th>Component</th>
                  <th>Quantity</th>
                </tr>
              </thead>
              <tbody>
                {preview.components.map((component) => (
                  <tr key={component.itemNumber}>
                    <td>{component.itemNumber}</td>
                    <td>{component.materialNumber}</td>
                    <td>{component.requiredQuantity} {component.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.eligible && (
            <ConvertForm orderNumber={preview.orderNumber} expectedVersion={preview.version} />
          )}
          {log.length > 0 && (
            <ul className="mt-3 space-y-1">
              {log.map((entry) => (
                <li key={`${entry.changedAt}-${entry.objectClass}-${entry.changeType}`}>
                  {entry.changedAt} · {entry.transactionCode ?? entry.changeType} · {entry.reason ?? entry.changeType}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
