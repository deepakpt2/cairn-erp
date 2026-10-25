import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  PLANNED_ORDER_DISPLAY_CAPABILITY,
  PLANNED_ORDER_DISPLAY_ROUTE,
  PlannedOrderDisplayError,
  getPlannedOrder,
  listPlannedOrders,
  plannedOrderDisplayRefusal,
} from '@/modules/production/planned-order-display';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** MD13. Display a planned order. This page writes nothing and takes no change lock. */
export default async function PlannedOrderDisplayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PLANNED_ORDER_DISPLAY_ROUTE);
  if (!can(session, PLANNED_ORDER_DISPLAY_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display planned order</h1>
        <p className="mt-2 text-sm">You do not hold the planned-order display capability ({PLANNED_ORDER_DISPLAY_CAPABILITY}).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const refusal = plannedOrderDisplayRefusal({
    mrpArea: one(raw.mrpArea),
    orderType: one(raw.orderType),
    specialProcurement: one(raw.specialProcurement),
    openingDate: one(raw.openingDate),
    productionVersion: one(raw.productionVersion),
    bom: one(raw.bom),
    routing: one(raw.routing),
    scheduler: one(raw.scheduler),
    storageLocation: one(raw.storageLocation),
    salesOrder: one(raw.salesOrder),
    wbs: one(raw.wbs),
    deletionIndicator: one(raw.deletionIndicator),
    firming: one(raw.firming),
    change: one(raw.change),
    convert: one(raw.convert),
    companyCode: one(raw.companyCode),
  });
  const orderNumber = one(raw.order);
  const plant = one(raw.plant).toUpperCase();
  const materialNumber = one(raw.material).toUpperCase();
  let openError = refusal ?? '';
  let document = null;
  let listed: Awaited<ReturnType<typeof listPlannedOrders>> | null = null;
  if (!refusal && orderNumber) {
    try {
      document = await getPlannedOrder(session.user.client, orderNumber);
      if (!document) openError = `Planned order ${orderNumber} does not stand.`;
    } catch (error) {
      openError = error instanceof PlannedOrderDisplayError ? error.message : 'The planned order could not be displayed.';
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
      <p className="text-sm text-ink-faint">PROD.PLANNEDORDER.DISPLAY · MD13</p>
      <h1 className="mt-1 text-xl font-semibold">Display planned order</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-soft">
        Display writes nothing. It does not firm, change, convert, or delete the order, and it does not take a change lock.
      </p>
      {openError && <p role="status" data-md13-refused className="mt-3 text-sm text-danger">{openError}</p>}
      <form className="mt-4 grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="order" defaultValue={orderNumber} maxLength={12} placeholder="Planned order" />
        <input className="input" name="plant" defaultValue={plant} maxLength={10} placeholder="Plant" />
        <input className="input" name="material" defaultValue={materialNumber} maxLength={40} placeholder="Material" />
        <button className="btn" type="submit">Display</button>
      </form>
      {listed && (
        <section className="mt-4 text-sm">
          <p>{listed.total} planned order{listed.total === 1 ? '' : 's'}. The first was not opened.</p>
          <ul className="mt-2 space-y-1">
            {listed.rows.map((row) => (
              <li key={row.orderNumber}>
                <Link href={`${PLANNED_ORDER_DISPLAY_ROUTE}?order=${encodeURIComponent(row.orderNumber)}`}>
                  {row.orderNumber}
                </Link>
                {' '}{row.materialNumber} {row.materialDescription} {row.plant} {row.quantity} {row.unit} finish {row.finishDate} {row.firmingStatus === 'FIRMED' ? 'firmed' : 'not firmed'}
              </li>
            ))}
          </ul>
        </section>
      )}
      {document && (
        <section className="mt-4 space-y-2 text-sm" data-md13-order={document.orderNumber}>
          <p>{document.orderNumber} · {document.materialNumber} {document.materialDescription}</p>
          <p>Plant {document.plant} {document.plantName}. Company code of the plant {document.companyCode || '—'}. It is not a key of the order.</p>
          {plant && plant !== document.plant && <p>The order stands in plant {document.plant}, not {plant}.</p>}
          {materialNumber && materialNumber !== document.materialNumber && <p>The order is for {document.materialNumber}, not {materialNumber}.</p>}
          <p>Quantity {document.quantity} {document.unit}. The unit was not substituted.</p>
          <p>Start {document.startDate}. Finish {document.finishDate}. An opening date is not stored.</p>
          <p>Firming {document.firmingStatus === 'FIRMED' ? 'firmed' : 'not firmed'}. Display did not change it.</p>
          <p>Origin {document.origin === 'MANUAL' ? 'created by hand' : document.origin === 'MRP' ? 'proposed by planning' : document.origin}. A planned-order type is not stored.</p>
          <p>Material procurement {document.procurementType ?? 'not maintained'}. MRP controller {document.mrpController ?? '—'} {document.mrpControllerName ?? ''}. Those stand on the material, not on the order.</p>
          {document.productionOrderNumber
            ? <p>Converted to production order {document.productionOrderNumber}. The planned order was not deleted. Conversion was not inferred.</p>
            : <p>Not converted. No follow-on document is stored, and none was inferred.</p>}
          <p>Created by {document.createdBy} at {document.createdAt}. Changed by {document.changedBy ?? '—'} at {document.changedAt ?? '—'}. Record version {document.version}.</p>
          <p>
            <Link href={`/production/stock-requirements?material=${encodeURIComponent(document.materialNumber)}&plant=${encodeURIComponent(document.plant)}`}>
              Stock/requirements list
            </Link>
            {' · '}
            <Link href={`/production/planned-order-change?order=${encodeURIComponent(document.orderNumber)}`}>Change</Link>
            {' · '}
            <Link href="/production/planned-order-create">Create</Link>
            {' · '}
            <Link href={`/production/planned-order-conversion?order=${encodeURIComponent(document.orderNumber)}&plant=${encodeURIComponent(document.plant)}`}>Convert</Link>
          </p>
          {document.dependents.some((row) => row.status === 'OPEN') && (
            <p data-md13-demand="active" data-md13-reconciliation={document.productionOrderNumber ? 'incomplete' : 'open'}>
              An open dependent requirement is active planning demand. It has not been reconciled to a dated production-order component. This display does not close it.
            </p>
          )}
          {document.dependents.some((row) => row.status === 'CLOSED') && (
            <p data-md13-demand="replaced">
              A closed dependent requirement is not planning demand. The dated production-order component is the replacement. This display does not reopen it. The closed row is not counted again.
            </p>
          )}
          {document.dependents.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-faint">
                  <th>Component</th>
                  <th>Quantity</th>
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {document.dependents.map((row) => (
                  <tr key={`${row.itemNumber}/${row.componentMaterial}`}>
                    <td className="py-1">{row.componentMaterial} {row.componentDescription}</td>
                    <td>{row.quantity} {row.unit}</td>
                    <td>{row.requirementDate}</td>
                    <td data-md13-requirement={row.status}>{row.status === 'OPEN' ? 'OPEN · active demand, not reconciled' : row.status === 'CLOSED' ? 'CLOSED · not demand' : row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-ink-soft">
            This order does not store an MRP area, a special procurement key, a production version, a BOM, a routing, a scheduler, a storage location, a sales order, a WBS element, or a deletion flag.
          </p>
        </section>
      )}
    </main>
  );
}
