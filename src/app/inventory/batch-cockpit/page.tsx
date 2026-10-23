import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  ALIAS,
  BatchCockpitError,
  NOT_STORED,
  readBatchCockpit,
  ROUTE,
  searchBatches,
  type CockpitDetail,
  type CockpitResult,
} from '@/modules/inventory/batch-cockpit';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Batch Information Cockpit. BMBC is a search alias only. This screen does not write. */
export default async function BatchCockpitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const canRead = can(session, ACTIVITY);
  const selection = {
    material: one(params.material),
    plant: one(params.plant),
    batch: one(params.batch),
    vendorBatch: one(params.vendorBatch),
    expirationFrom: one(params.expirationFrom),
    expirationTo: one(params.expirationTo),
    stockType: one(params.stockType),
    restrictedUse: one(params.restrictedUse),
    productionOrder: one(params.productionOrder),
    purchaseOrder: one(params.purchaseOrder),
    supplier: one(params.supplier),
    inspectionLot: one(params.inspectionLot),
    className: one(params.className),
    characteristic: one(params.characteristic),
    salesOrder: one(params.salesOrder),
    delivery: one(params.delivery),
    billingDocument: one(params.billingDocument),
    schedulingAgreement: one(params.schedulingAgreement),
    genealogy: one(params.genealogy) === '1' || one(params.genealogy).toUpperCase() === 'X' ? true : undefined,
    limit: one(params.limit) ? Number(one(params.limit)) : undefined,
  };
  const asked = Object.values(selection).some((value) => value !== undefined && value !== '' && value !== false);
  let result: CockpitResult | null = null;
  let detail: CockpitDetail | null = null;
  let reportError: string | null = null;
  if (asked && canRead) {
    try {
      result = await searchBatches(session.user.client, selection);
      if (one(params.focusMaterial) && one(params.focusBatch)) {
        detail = await readBatchCockpit(session.user.client, {
          materialNumber: one(params.focusMaterial),
          batchNumber: one(params.focusBatch),
          plant: one(params.focusPlant) || undefined,
        });
      }
    } catch (error) {
      if (error instanceof BatchCockpitError) reportError = `${error.message} ${error.remedy}`;
      else throw error;
    }
  }
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(selection)) {
    if (typeof value === 'string' && value) query.set(name, value);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIAS}</span>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Batch information cockpit</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Read a batch that already stands. Stock is the stock master. A material document is a direct movement, not a genealogy explosion.
          Opening this screen writes nothing. A closed posting period does not block it.
        </p>
      </header>
      {!canRead && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Display is not granted. Ask an administrator for {ACTIVITY}.</p>
      )}
      <section className="border border-line bg-white p-3 text-sm">
        <h2 className="font-semibold">Not stored</h2>
        <ul className="mt-2 space-y-2">
          {NOT_STORED.map((item) => (
            <li key={item.field}><span className="code">{item.field}</span> · {item.title}. {item.reason}</li>
          ))}
        </ul>
      </section>
      <form method="get" action={ROUTE} className="grid gap-3 border border-line bg-white p-4 sm:grid-cols-2">
        <label className="text-sm">Material<input name="material" defaultValue={selection.material} maxLength={40} className="mt-1 w-full border border-line px-2 py-1" /></label>
        <label className="text-sm">Plant<input name="plant" defaultValue={selection.plant} maxLength={10} className="mt-1 w-full border border-line px-2 py-1" /></label>
        <label className="text-sm">Batch<input name="batch" defaultValue={selection.batch} maxLength={40} className="mt-1 w-full border border-line px-2 py-1" /></label>
        <label className="text-sm">Supplier batch<input name="vendorBatch" defaultValue={selection.vendorBatch} maxLength={15} className="mt-1 w-full border border-line px-2 py-1" /></label>
        <label className="text-sm">Expiration from<input name="expirationFrom" type="date" defaultValue={selection.expirationFrom} className="mt-1 w-full border border-line px-2 py-1" /></label>
        <label className="text-sm">Expiration to<input name="expirationTo" type="date" defaultValue={selection.expirationTo} className="mt-1 w-full border border-line px-2 py-1" /></label>
        <label className="text-sm">Stock category
          <select name="stockType" defaultValue={selection.stockType} className="mt-1 w-full border border-line px-2 py-1">
            <option value="">Any</option>
            <option value="UNRESTRICTED">Unrestricted-use</option>
            <option value="QUALITY">Quality inspection</option>
            <option value="BLOCKED">Blocked</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <label className="text-sm">Restricted-use indicator
          <select name="restrictedUse" defaultValue={selection.restrictedUse} className="mt-1 w-full border border-line px-2 py-1">
            <option value="">Any</option>
            <option value="X">X · Restricted</option>
            <option value="BLANK">Blank · Unrestricted</option>
          </select>
        </label>
        <label className="text-sm">Production order<input name="productionOrder" defaultValue={selection.productionOrder} maxLength={12} className="mt-1 w-full border border-line px-2 py-1" /></label>
        <label className="text-sm">Purchase order<input name="purchaseOrder" defaultValue={selection.purchaseOrder} maxLength={20} className="mt-1 w-full border border-line px-2 py-1" /></label>
        <label className="text-sm">Supplier on the purchase order<input name="supplier" defaultValue={selection.supplier} maxLength={40} className="mt-1 w-full border border-line px-2 py-1" /></label>
        <label className="text-sm">Maximum results<input name="limit" defaultValue={selection.limit ?? 50} inputMode="numeric" className="mt-1 w-full border border-line px-2 py-1" /></label>
        <div className="sm:col-span-2">
          <button type="submit" className="btn btn-primary min-h-11" disabled={!canRead}>Select</button>
        </div>
      </form>
      {reportError && <p role="alert" className="border border-line bg-white p-3 text-sm">{reportError}</p>}
      {result && (
        <section className="space-y-2">
          <p className="text-sm text-ink-soft">
            {result.rows.length} batch{result.rows.length === 1 ? '' : 'es'} read. As of {result.asOf}.
            {result.truncated ? ` The limit is ${result.limit}. Further matches may stand.` : ' The list is complete for this selection.'}
            {' '}Genealogy is not stored.
          </p>
          <table className="w-full border border-line bg-white text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="p-2">Material</th>
                <th className="p-2">Batch</th>
                <th className="p-2">Plant</th>
                <th className="p-2">Status</th>
                <th className="p-2">Expiration</th>
                <th className="p-2">Unrestricted</th>
                <th className="p-2">Quality</th>
                <th className="p-2">Blocked</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => {
                const next = new URLSearchParams(query);
                next.set('focusMaterial', row.materialNumber);
                next.set('focusBatch', row.batchNumber);
                if (row.plant) next.set('focusPlant', row.plant);
                return (
                  <tr key={`${row.materialNumber}-${row.batchNumber}-${row.plant ?? ''}`} className="border-b border-line">
                    <td className="p-2">{row.materialNumber}<br /><span className="text-ink-soft">{row.materialDescription}</span></td>
                    <td className="p-2"><Link className="code underline" href={`${ROUTE}?${next.toString()}`}>{row.batchNumber}</Link></td>
                    <td className="code p-2">{row.plant ?? '—'}</td>
                    <td className="p-2">{row.restrictedUse === 'X' ? 'Restricted' : row.restrictedUse === ' ' ? 'Unrestricted' : 'Not stored'}</td>
                    <td className="p-2">{row.shelfLifeExpirationDate ?? '—'}</td>
                    <td className="p-2">{row.stock.unrestricted} {row.stock.unit}</td>
                    <td className="p-2">{row.stock.quality} {row.stock.unit}</td>
                    <td className="p-2">{row.stock.blocked} {row.stock.unit}</td>
                  </tr>
                );
              })}
              {result.rows.length === 0 && (
                <tr><td className="p-2 text-ink-soft" colSpan={8}>No batch matches. Opening this screen did not create one.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}
      {detail && (
        <section className="space-y-3 border border-line bg-white p-4 text-sm">
          <h2 className="font-semibold">Batch {detail.row.batchNumber}</h2>
          <p>
            Material <span className="code">{detail.row.materialNumber}</span>
            {detail.row.plant ? <> · Plant <span className="code">{detail.row.plant}</span></> : null}
            · Supplier batch {detail.row.vendorBatch ?? 'not stored'}
            · Manufacture {detail.row.manufactureDate ?? 'not stored'}
          </p>
          <p className="text-ink-soft">
            Restricted use is {detail.row.restrictedUse === 'X' ? 'X' : detail.row.restrictedUse === ' ' ? 'blank' : 'not stored'}.
            That is not the stock category. Direct document quantities are not current stock.
          </p>
          <p>
            {can(session, 'INV.BATCH.DISPLAY') && <Link className="underline" href={`/inventory/batches/display?material=${encodeURIComponent(detail.row.materialNumber)}&batch=${encodeURIComponent(detail.row.batchNumber)}${detail.row.plant ? `&plant=${encodeURIComponent(detail.row.plant)}` : ''}`}>Display batch</Link>}
            {can(session, 'INV.BATCH.CHANGE') && <>{' · '}<Link className="underline" href={`/inventory/batches/change?material=${encodeURIComponent(detail.row.materialNumber)}&batch=${encodeURIComponent(detail.row.batchNumber)}${detail.row.plant ? `&plant=${encodeURIComponent(detail.row.plant)}` : ''}`}>Change batch</Link></>}
            {can(session, 'INV.BATCH.PICKUP') && <>{' · '}<Link className="underline" href={`/inventory/batch-pickup?material=${encodeURIComponent(detail.row.materialNumber)}&batch=${encodeURIComponent(detail.row.batchNumber)}${detail.row.plant ? `&plant=${encodeURIComponent(detail.row.plant)}` : ''}`}>Pick-up list</Link></>}
            {can(session, 'INV.STOCK.VIEW') && <>{' · '}<Link className="underline" href={`/inventory/stock-overview?material=${encodeURIComponent(detail.row.materialNumber)}&batch=${encodeURIComponent(detail.row.batchNumber)}`}>Stock overview</Link></>}
          </p>
          <h3 className="font-medium">Stock</h3>
          <ul>
            {detail.stockLines.map((line) => (
              <li key={`${line.plant}-${line.storageLocation}-${line.stockType}`}>{line.plant} / {line.storageLocation || '—'} · {line.stockType} · {line.quantity} {line.unit}</li>
            ))}
            {detail.stockLines.length === 0 && <li>No stock row stands for this batch.</li>}
          </ul>
          <h3 className="font-medium">Direct material documents</h3>
          <p className="text-ink-soft">Not a top-down or bottom-up explosion. A reversal is named when the line stores one.</p>
          <ul>
            {detail.documents.map((line) => (
              <li key={`${line.materialDocumentNumber}-${line.lineNumber}`}>
                {can(session, 'INV.DISPLAY')
                  ? <Link className="code underline" href={`/inventory/material-documents?document=${encodeURIComponent(line.materialDocumentNumber)}`}>{line.materialDocumentNumber}</Link>
                  : <span className="code">{line.materialDocumentNumber}</span>}
                {' '}line {line.lineNumber} · {line.postingDate} · {line.movementType} · {line.direction} · {line.quantity} {line.unit}
                {line.productionOrderNumber ? <> · order {can(session, 'PROD.ORDER.CREATE')
                  ? <Link className="code underline" href={`/production/orders?order=${encodeURIComponent(line.productionOrderNumber)}`}>{line.productionOrderNumber}</Link>
                  : <span className="code">{line.productionOrderNumber}</span>}</> : null}
                {line.purchaseOrderNumber ? <> · purchase order {can(session, 'PROC.PO.DISPLAY')
                  ? <Link className="code underline" href={`/purchasing/purchase-order-display?order=${encodeURIComponent(line.purchaseOrderNumber)}`}>{line.purchaseOrderNumber}</Link>
                  : <span className="code">{line.purchaseOrderNumber}</span>}{line.supplierNumber ? ` · supplier ${line.supplierNumber}` : ''}</> : null}
                {line.reversalOfDocument ? ` · reversal of ${line.reversalOfDocument}` : ''}
              </li>
            ))}
            {detail.documents.length === 0 && <li>No material-document line carries this batch.</li>}
          </ul>
          {detail.documentsTruncated && <p>Further document lines may stand. The list stopped at 40.</p>}
        </section>
      )}
    </div>
  );
}
