import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  getProductionCogiFailure,
  listProductionCogiFailures,
  ProductionCogiError,
  PRODUCTION_COGI_CAPABILITY,
  PRODUCTION_COGI_ROUTE,
  type ProductionCogiSelection,
  type ProductionCogiStatusFilter,
} from '@/modules/production/production-cogi';
import ProductionCogiWorkbench from './ProductionCogiWorkbench';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function status(value: string): ProductionCogiStatusFilter {
  const values: ProductionCogiStatusFilter[] = ['OPEN', 'ALL', 'PENDING', 'PROCESSING', 'FAILED', 'BLOCKED', 'POSTED', 'DISCARDED'];
  return values.includes(value as ProductionCogiStatusFilter) ? value as ProductionCogiStatusFilter : 'OPEN';
}

export default async function ProductionCogiPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PRODUCTION_COGI_ROUTE);
  const params = await searchParams;
  const allowed = can(session, PRODUCTION_COGI_CAPABILITY);
  const filter: ProductionCogiSelection = {
    status: status(one(params.status)),
    orderNumber: one(params.order).toUpperCase(),
    operationNumber: one(params.operation).toUpperCase(),
    plant: one(params.plant).toUpperCase(),
    materialNumber: one(params.material).toUpperCase(),
    movementKind: ['ISSUE', 'RECEIPT'].includes(one(params.movement).toUpperCase())
      ? one(params.movement).toUpperCase() as 'ISSUE' | 'RECEIPT'
      : undefined,
    limit: 50,
  };
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };
  let rows: Awaited<ReturnType<typeof listProductionCogiFailures>> = [];
  let detail: Awaited<ReturnType<typeof getProductionCogiFailure>> = null;
  let openError = '';
  if (allowed) {
    try {
      rows = await listProductionCogiFailures({ client: session.user.client, authorization, selection: filter });
      const failureId = one(params.id);
      if (failureId) detail = await getProductionCogiFailure({ client: session.user.client, failureId, authorization });
    } catch (error) {
      openError = error instanceof ProductionCogiError ? error.message : 'COGI could not load the movement records.';
    }
  }
  const listHref = (id: string) => {
    const query = new URLSearchParams();
    if (filter.status) query.set('status', filter.status);
    if (filter.orderNumber) query.set('order', filter.orderNumber);
    if (filter.operationNumber) query.set('operation', filter.operationNumber);
    if (filter.plant) query.set('plant', filter.plant);
    if (filter.materialNumber) query.set('material', filter.materialNumber);
    if (filter.movementKind) query.set('movement', filter.movementKind);
    query.set('id', id);
    return `${PRODUCTION_COGI_ROUTE}?${query.toString()}`;
  };

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{PRODUCTION_COGI_CAPABILITY} · COGI</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Failed production goods movements</h1>
          <Link href="/production/time-ticket" className="btn btn-default min-h-11 sm:min-h-8">CO11N · time ticket</Link>
        </div>
        <p className="mt-1 max-w-4xl text-sm text-ink-soft">
          Review movements created automatically by CO11N, inspect the last posting error, correct supported movement details, and retry the same movement request. The original confirmation and source payload remain unchanged.
        </p>
        <p className="mt-2 max-w-4xl text-sm text-ink-soft" data-cogi-scope>
          Scope is CO11N only. CO15 header confirmations and manual MIGO postings do not create this queue. Discard retains the failure record; it does not post or adjust reservations.
        </p>
      </header>
      {openError && <p role="status" data-cogi-error className="text-sm text-red-700">{openError}</p>}
      {!allowed && <p className="text-sm">You do not hold the authority {PRODUCTION_COGI_CAPABILITY}.</p>}
      <form className="grid gap-2 rounded border border-line bg-surface p-3 sm:grid-cols-3 lg:grid-cols-6" method="get">
        <label className="text-xs text-ink-soft">Status
          <select className="input mt-1" name="status" defaultValue={filter.status}>
            <option value="OPEN">Open · pending, processing, failed</option>
            <option value="ALL">All statuses</option>
            <option value="FAILED">Failed</option>
            <option value="PENDING">Pending</option>
            <option value="PROCESSING">Processing</option>
            <option value="BLOCKED">Blocked</option>
            <option value="POSTED">Posted</option>
            <option value="DISCARDED">Discarded</option>
          </select>
        </label>
        <label className="text-xs text-ink-soft">Order
          <input className="input mt-1" name="order" defaultValue={filter.orderNumber} maxLength={12} />
        </label>
        <label className="text-xs text-ink-soft">Operation
          <input className="input mt-1" name="operation" defaultValue={filter.operationNumber} maxLength={4} />
        </label>
        <label className="text-xs text-ink-soft">Plant
          <input className="input mt-1" name="plant" defaultValue={filter.plant} maxLength={10} />
        </label>
        <label className="text-xs text-ink-soft">Material
          <input className="input mt-1" name="material" defaultValue={filter.materialNumber} maxLength={40} />
        </label>
        <label className="text-xs text-ink-soft">Movement
          <select className="input mt-1" name="movement" defaultValue={filter.movementKind ?? ''}>
            <option value="">All movement kinds</option>
            <option value="ISSUE">Goods issue</option>
            <option value="RECEIPT">Goods receipt</option>
          </select>
        </label>
        <div className="sm:col-span-3 lg:col-span-6">
          <button className="btn" type="submit">Filter movements</button>
          <span className="ml-3 text-xs text-ink-faint">Newest first · first 50 matches · tenant and Company Code/Plant scoped</span>
        </div>
      </form>
      {allowed && (
        <section className="overflow-x-auto rounded border border-line" aria-label="COGI goods movement queue">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="bg-surface text-xs uppercase text-ink-faint">
              <tr><th className="p-2">Status</th><th className="p-2">Confirmation / order</th><th className="p-2">Movement</th><th className="p-2">Material</th><th className="p-2">Error / attempts</th><th className="p-2">Created</th><th className="p-2">Record</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-line align-top">
                  <td className="p-2 font-medium">{row.status}</td>
                  <td className="p-2">{row.confirmationNumber}<br />Order {row.orderNumber} · operation {row.operationNumber}<br />Plant {row.plant}</td>
                  <td className="p-2">{row.movementKind}<br />SAP {row.sapMovementType}<br /><span className="code">{row.movementType}</span><br />Posting {row.postingDate}</td>
                  <td className="p-2">{row.firstLine ? <>{row.firstLine.materialNumber}<br />{row.firstLine.quantity} {row.firstLine.unit}{row.firstLine.storageLocation ? ` · SLoc ${row.firstLine.storageLocation}` : ''}{row.firstLine.batchNumber ? ` · Batch ${row.firstLine.batchNumber}` : ''}{row.lineCount > 1 ? <><br />+ {row.lineCount - 1} more line(s)</> : null}</> : 'No normalized lines'}</td>
                  <td className="p-2"><span className="line-clamp-3">{row.errorText ?? row.failureCode ?? 'No error recorded yet'}</span><br />{row.attemptCount} attempt(s)</td>
                  <td className="p-2">{row.createdAt.toLocaleString()}</td>
                  <td className="p-2"><Link className="btn btn-default min-h-9" href={listHref(row.id)}>Inspect</Link></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td className="p-4 text-ink-soft" colSpan={7}>No movement records match these filters in your authorized scope.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
      {detail && <ProductionCogiWorkbench detail={detail} />}
      {one(params.id) && !detail && allowed && !openError && <p role="status" className="text-sm">This movement is not available in your tenant or organizational scope.</p>}
    </main>
  );
}
