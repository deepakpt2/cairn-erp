import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  PRODUCTION_ORDER_DISPLAY_CAPABILITY,
  PRODUCTION_ORDER_DISPLAY_ROUTE,
  ProductionOrderDisplayError,
  getProductionOrderDisplay,
  listProductionOrders,
  productionOrderDisplayRefusal,
} from '@/modules/production/production-order-display';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** CO03. Display a production order. This page writes nothing and takes no change lock. */
export default async function ProductionOrderDisplayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PRODUCTION_ORDER_DISPLAY_ROUTE);
  if (!can(session, PRODUCTION_ORDER_DISPLAY_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display production order</h1>
        <p className="mt-2 text-sm">You do not hold production-order display ({PRODUCTION_ORDER_DISPLAY_CAPABILITY}).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const refusal = productionOrderDisplayRefusal({
    orderType: one(raw.orderType),
    controllingArea: one(raw.controllingArea),
    scrap: one(raw.scrap),
    productionVersion: one(raw.productionVersion),
    schedulingType: one(raw.schedulingType),
    priority: one(raw.priority),
    operation: one(raw.operation),
    sequence: one(raw.sequence),
    availability: one(raw.availability),
    cost: one(raw.cost),
    confirmation: one(raw.confirmation),
    teco: one(raw.teco),
    closed: one(raw.closed),
    deletionIndicator: one(raw.deletionIndicator),
  });
  const plant = one(raw.plant).toUpperCase();
  const materialNumber = one(raw.material).toUpperCase();
  const status = one(raw.status).toUpperCase();
  const orderNumber = one(raw.order);
  let openError = refusal ?? '';
  let document = null;
  let listed = null;
  if (!refusal && orderNumber) {
    try {
      document = await getProductionOrderDisplay(session.user.client, orderNumber);
      if (!document) openError = `Production order ${orderNumber} does not stand.`;
    } catch (error) {
      openError = error instanceof ProductionOrderDisplayError ? error.message : 'The production order could not be read.';
    }
  } else if (!refusal && (plant || materialNumber)) {
    try {
      listed = await listProductionOrders(session.user.client, { plant, materialNumber, status });
    } catch (error) {
      openError = error instanceof ProductionOrderDisplayError ? error.message : 'The production orders could not be listed.';
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <p className="text-sm text-ink-faint">PROD.ORDER.DISPLAY · CO03</p>
      <h1 className="mt-1 text-xl font-semibold">Display production order</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink-soft">
        Display reads the order. It does not change, release, or post.
        <Link className="ml-2" href="/production/production-order-change">Change is a different screen.</Link>
      </p>
      {openError && <p role="status" data-co03-refused className="mt-3 text-sm text-danger">{openError}</p>}
      <form className="mt-4 grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="order" defaultValue={orderNumber} maxLength={12} placeholder="Production order" />
        <input className="input" name="plant" defaultValue={plant} maxLength={10} placeholder="Plant" />
        <input className="input" name="material" defaultValue={materialNumber} maxLength={40} placeholder="Material" />
        <button className="btn" type="submit">Find</button>
      </form>
      {listed && (
        <section className="mt-4 text-sm">
          <p>{listed.total} production order{listed.total === 1 ? '' : 's'}. The first was not opened.</p>
          <ul className="mt-2 space-y-1">
            {listed.rows.map((row) => (
              <li key={row.orderNumber}>
                <Link href={`${PRODUCTION_ORDER_DISPLAY_ROUTE}?order=${encodeURIComponent(row.orderNumber)}`}>{row.orderNumber}</Link>
                {' · '}{row.materialNumber} · {row.orderType ?? 'no type'} · {row.quantity} {row.unit} · {row.status}
              </li>
            ))}
          </ul>
        </section>
      )}
      {document && (
        <section className="mt-4 space-y-2 text-sm" data-co03-order={document.orderNumber}>
          <p>{document.orderNumber} · {document.materialNumber} {document.materialDescription}</p>
          <p>Plant {document.plant} {document.plantName}. Company code of the plant {document.companyCode || '—'}. It is not a key of the order.</p>
          <p data-order-type={document.orderType ?? ''}>Order type {document.orderType ?? 'not assigned'}. A missing type was not filled in. Display does not run an availability check.</p>
          <p>Quantity {document.quantity} {document.unit}. Received {document.receivedQuantity}, read from material documents.</p>
          <p data-header-confirmed-yield={document.headerConfirmedYield}>Header confirmed yield {document.headerConfirmedYield} {document.unit}. Scrap {document.headerConfirmedScrap}. Rework {document.headerConfirmedRework}. Active header confirmations are counted once. Operation confirmed yields are not added.</p>
          <p>Start {document.scheduledStart}. Finish {document.scheduledFinish}. Actual start and finish stand on a confirmation, not on the order.</p>
          <p>Status {document.status}. Display did not change it. {document.releasedBy ? `Released by ${document.releasedBy}.` : 'Not released.'} {document.technicallyCompletedBy ? `Technically completed by ${document.technicallyCompletedBy} at ${document.technicallyCompletedAt ?? '—'}. It is not an open order.` : 'Technical completion has not been recorded.'}</p>
          <p>Batch {document.batch || '—'}. Scheduling profile {document.schedulingProfile || '—'}. Those were snapshotted at creation.</p>
          <p>{document.plannedOrderNumber ? `Converted from planned order ${document.plannedOrderNumber}.` : 'No planned order is stored. None was inferred.'}</p>
          <p>Created by {document.createdBy} at {document.createdAt}. Changed by {document.changedBy ?? '—'} at {document.changedAt ?? '—'}. Record version {document.version}.</p>
          <p data-production-version={document.productionVersion ?? ''} data-bom-usage={document.bomUsage ?? ''} data-bom-alternative={document.bomAlternative ?? ''}>
            Production version {document.productionVersion ?? 'not recorded'}. BOM usage {document.bomUsage ?? 'not recorded'}. BOM alternative {document.bomAlternative ?? 'not recorded'}.
            These are the values stored with the snapshot. Display does not re-read the bill of material, and they are not proof that the current bill of material still matches these components.
          </p>
          {document.gaps.map((gap) => <p key={gap}>{gap}</p>)}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-faint">
                <th>Line</th>
                <th>BOM item</th>
                <th>Source material</th>
                <th>Component</th>
                <th>Required</th>
                <th>Requirement date</th>
                <th>Issued</th>
                <th>Remaining</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {document.components.map((component) => (
                <tr key={component.itemNumber} data-bom-item={component.bomItem ?? ''} data-source-material={component.sourceMaterial ?? ''}>
                  <td>{component.itemNumber}</td>
                  <td>{component.bomItem ?? 'not recorded'}</td>
                  <td>{component.sourceMaterial ?? 'not recorded'}</td>
                  <td>{component.materialNumber} {component.materialDescription}</td>
                  <td>{component.requiredQuantity} {component.unit}</td>
                  <td data-requirement-date={component.requirementDate ?? ''}>{component.requirementDate ?? 'not established'}</td>
                  <td>{component.issuedQuantity}</td>
                  <td>{component.remainingQuantity}</td>
                  <td>{component.storageLocation ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {document.operations.length > 0 ? (
            <table className="w-full text-sm" data-co03-operations>
              <thead>
                <tr className="text-left text-ink-faint">
                  <th>Operation</th>
                  <th>Execution order</th>
                  <th>Sequence</th>
                  <th>Description</th>
                  <th>Work center</th>
                  <th>Control key</th>
                  <th>Progress</th>
                  <th>Operation confirmed yield</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {document.operations.map((operation) => (
                  <tr key={operation.operationNumber} data-co03-operation={operation.operationNumber} data-operation-progress={operation.progress}>
                    <td>{operation.operationNumber}</td>
                    <td>{operation.executionOrder}</td>
                    <td>{operation.sequence}</td>
                    <td>{operation.shortText ?? '—'}</td>
                    <td>{operation.workCenter ?? '—'}</td>
                    <td>{operation.controlKey ?? '—'}</td>
                    <td>{operation.progress}</td>
                    <td>{operation.confirmedYield}</td>
                    <td>
                      <Link href={`/production/time-ticket?order=${encodeURIComponent(document.orderNumber)}&operation=${encodeURIComponent(operation.operationNumber)}`}>CO11N</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p data-co03-operations-missing>No operation snapshot is stored on this order. Operations were not read from a routing.</p>
          )}
          {document.confirmations.length > 0 && (
            <ul data-co03-confirmations>
              {document.confirmations.map((row) => (
                <li key={row.confirmationNumber} data-co03-confirmation={row.confirmationNumber}>
                  Confirmation {row.confirmationNumber} · {row.confirmationLevel === 'HEADER' ? 'header' : `operation ${row.operationNumber}`} · {row.confirmationType} · yield {row.yieldQuantity} {row.unit}
                  {row.cancelled ? ` · cancelled by ${row.cancellationNumber}` : ' · not cancelled'}
                  {' '}<Link href={`/production/confirmation-cancel?confirmation=${encodeURIComponent(row.confirmationNumber)}`}>CO13 is a different screen.</Link>
                </li>
              ))}
            </ul>
          )}
          <p>
            <Link href={`/production/time-ticket?order=${encodeURIComponent(document.orderNumber)}`}>Enter a time ticket</Link>
            {' '}and{' '}
            <Link href={`/production/order-confirmation?order=${encodeURIComponent(document.orderNumber)}`}>enter an order confirmation</Link>
            {' '}are different screens. This display does not confirm.
            {' '}<Link href={`/production/order-information?selection=PRODUCTION_ORDER:HEADERS&order=${encodeURIComponent(document.orderNumber)}&run=1`}>The order list</Link> is also a different screen.
          </p>
          {document.documents.length > 0 && (
            <ul>
              {document.documents.map((row) => (
                <li key={`${row.materialDocumentNumber}-${row.lineNumber}`}>
                  Material document {row.materialDocumentNumber} line {row.lineNumber} · {row.movementType} · {row.quantity} {row.materialNumber}
                </li>
              ))}
            </ul>
          )}
          {document.history.length > 0 && (
            <ul>
              {document.history.map((entry) => (
                <li key={`${entry.changedAt}-${entry.changeType}`}>{entry.changedAt} · {entry.transactionCode ?? entry.changeType} · {entry.reason ?? entry.changeType}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
