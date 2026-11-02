import Link from 'next/link';
import type { ReactNode } from 'react';

import { can, requireSession } from '@/platform/auth/current';
import {
  PRODUCTION_ORDER_DISPLAY_CAPABILITY,
} from '@/modules/production/production-order-display';
import {
  CONFIRMATION_DISPLAY_PAGE_SIZE,
  CONFIRMATION_DISPLAY_ROUTE,
  ConfirmationDisplayError,
  getProductionConfirmationDisplay,
  searchProductionConfirmations,
  type ConfirmationDisplayDetail,
  type ConfirmationDisplayDirection,
  type ConfirmationDisplayPage as ConfirmationDisplayResult,
  type ConfirmationDisplaySelection,
  type ConfirmationDisplaySort,
} from '@/modules/production/confirmation-display';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function filtersFrom(params: SearchParams) {
  return {
    confirmationNumber: one(params.confirmation),
    productionOrder: one(params.order),
    operation: one(params.operation),
    plant: one(params.plant),
    recordedFrom: one(params.recordedFrom),
    recordedTo: one(params.recordedTo),
    postingFrom: one(params.postingFrom),
    postingTo: one(params.postingTo),
  };
}

function selectionParams(selection: Partial<ConfirmationDisplaySelection>, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  params.set('run', '1');
  if (selection.confirmationNumber) params.set('confirmation', selection.confirmationNumber);
  if (selection.productionOrder) params.set('order', selection.productionOrder);
  if (selection.operation) params.set('operation', selection.operation);
  if (selection.plant) params.set('plant', selection.plant);
  if (selection.recordedFrom) params.set('recordedFrom', selection.recordedFrom);
  if (selection.recordedTo) params.set('recordedTo', selection.recordedTo);
  if (selection.postingFrom) params.set('postingFrom', selection.postingFrom);
  if (selection.postingTo) params.set('postingTo', selection.postingTo);
  if (selection.sort) params.set('sort', selection.sort);
  if (selection.direction) params.set('direction', selection.direction);
  if (selection.page) params.set('page', String(selection.page));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `?${params.toString()}`;
}

function sortHref(page: ConfirmationDisplayResult, field: ConfirmationDisplaySort): string {
  const direction: ConfirmationDisplayDirection = page.sort === field && page.direction === 'asc' ? 'desc' : 'asc';
  return selectionParams({ ...page.selection, sort: field, direction, page: 1 });
}

function SortHeading({ page, field, children }: {
  page: ConfirmationDisplayResult;
  field: ConfirmationDisplaySort;
  children: ReactNode;
}) {
  const active = page.sort === field;
  return (
    <Link href={sortHref(page, field)} className="inline-flex items-center gap-1 hover:text-accent">
      {children}<span aria-hidden="true">{active ? (page.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
    </Link>
  );
}

function detailHref(number: string, page: ConfirmationDisplayResult): string {
  return selectionParams(page.selection, { detail: number });
}

function ResultTable({ page }: { page: ConfirmationDisplayResult }) {
  const start = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const end = Math.min(page.total, page.page * page.pageSize);
  return (
    <section className="panel overflow-hidden" aria-labelledby="co14-results-heading">
      <div className="panel-header flex flex-wrap items-center justify-between gap-2">
        <h2 id="co14-results-heading" className="panel-title">Confirmations</h2>
        <span className="text-2xs text-ink-faint" aria-live="polite">
          {page.total === 0 ? '0 results' : `${start}–${end} of ${page.total}`}
        </span>
      </div>
      {page.rows.length === 0 ? (
        <p className="p-5 text-sm text-ink-soft" data-co14-empty>No confirmations match these criteria.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[980px]" data-co14-results>
            <thead>
              <tr>
                <th><SortHeading page={page} field="confirmation">Confirmation / counter</SortHeading></th>
                <th><SortHeading page={page} field="order">Production order</SortHeading></th>
                <th><SortHeading page={page} field="operation">Operation</SortHeading></th>
                <th>Material</th>
                <th><SortHeading page={page} field="plant">Plant</SortHeading></th>
                <th>Work center</th>
                <th>Type / status</th>
                <th className="text-end"><SortHeading page={page} field="yield">Yield · scrap · rework</SortHeading></th>
                <th><SortHeading page={page} field="posting">Posting date</SortHeading></th>
                <th><SortHeading page={page} field="recorded">Recorded</SortHeading></th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.confirmationNumber} data-co14-confirmation={row.confirmationNumber}>
                  <td>
                    <Link href={detailHref(row.confirmationNumber, page)} className="code font-semibold text-accent hover:underline">
                      {row.confirmationNumber}
                    </Link>
                    <div className="text-2xs text-ink-faint">Counter {row.counter || '—'}</div>
                  </td>
                  <td><Link href={`/production/production-order-display?order=${encodeURIComponent(row.productionOrder)}`} className="hover:underline">{row.productionOrder}</Link></td>
                  <td>{row.confirmationLevel === 'HEADER' ? `Header${row.operationCount ? ` · ${row.operationCount} effects` : ''}` : row.operationNumber}</td>
                  <td><span className="code">{row.materialNumber}</span><div className="text-2xs text-ink-faint">{row.materialDescription}</div></td>
                  <td>{row.plant}</td>
                  <td>{row.workCenter ?? '—'}{row.workCenterDescription ? <div className="text-2xs text-ink-faint">{row.workCenterDescription}</div> : null}</td>
                  <td>
                    <span>{row.confirmationType}</span>
                    {row.cancelled
                      ? <div className="text-2xs text-danger">Cancelled · {row.cancellationNumber}</div>
                      : <div className="text-2xs text-ink-faint">{row.confirmationLevel === 'HEADER' ? 'Header' : 'Operation'}</div>}
                  </td>
                  <td className="text-end whitespace-nowrap">{row.yieldQuantity} · {row.scrapQuantity} · {row.reworkQuantity} {row.unit}</td>
                  <td>{row.postingDate}</td>
                  <td>{row.recordedAt.replace('T', ' ').slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between border-t border-line px-3 py-2 text-sm">
        {page.page > 1
          ? <Link href={selectionParams({ ...page.selection, page: page.page - 1 })} className="text-accent hover:underline">Previous</Link>
          : <span className="text-ink-faint">Previous</span>}
        <span className="text-2xs text-ink-faint">Page {page.page} of {page.pages} · {CONFIRMATION_DISPLAY_PAGE_SIZE} per page</span>
        {page.page < page.pages
          ? <Link href={selectionParams({ ...page.selection, page: page.page + 1 })} className="text-accent hover:underline">Next</Link>
          : <span className="text-ink-faint">Next</span>}
      </div>
    </section>
  );
}

function ConfirmationDetail({ detail }: { detail: NonNullable<Awaited<ReturnType<typeof getProductionConfirmationDisplay>>> }) {
  return (
    <section className="panel overflow-hidden" data-co14-detail aria-labelledby="co14-detail-heading">
      <div className="panel-header flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="code text-2xs text-ink-faint">PROD.ORDER.DISPLAY · CO14</p>
          <h2 id="co14-detail-heading" className="panel-title mt-1">Confirmation {detail.confirmationNumber}</h2>
        </div>
        <span className={`chip ${detail.cancelled ? 'chip-error' : 'chip-ok'}`} data-co14-status={detail.cancelled ? 'CANCELLED' : 'ACTIVE'}>
          {detail.cancelled ? 'Cancelled' : 'Active'}
        </span>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <Link href={`/production/production-order-display?order=${encodeURIComponent(detail.productionOrder)}`} className="btn btn-default min-h-11 sm:min-h-8">
            Production order {detail.productionOrder}
          </Link>
          <Link href={`/production/confirmation-cancel?confirmation=${encodeURIComponent(detail.confirmationNumber)}`} className="btn btn-default min-h-11 sm:min-h-8">
            Open CO13 (separate transaction)
          </Link>
        </div>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Confirmation number" value={detail.confirmationNumber} />
          <Field label="Counter / sequence" value={detail.counter || '—'} />
          <Field label="Level and type" value={`${detail.confirmationLevel} · ${detail.confirmationType}`} />
          <Field label="Production order" value={detail.productionOrder} />
          <Field label="Material" value={`${detail.materialNumber}${detail.materialDescription ? ` · ${detail.materialDescription}` : ''}`} />
          <Field label="Plant" value={`${detail.plant}${detail.plantName ? ` · ${detail.plantName}` : ''}`} />
          <Field label="Company code" value={detail.companyCode || '—'} />
          <Field label="Operation" value={detail.operationNumber ?? 'Header confirmation'} />
          <Field label="Work center" value={detail.workCenter ? `${detail.workCenter}${detail.workCenterDescription ? ` · ${detail.workCenterDescription}` : ''}` : 'Not recorded on the header'} />
          <Field label="Control key" value={detail.controlKey ?? '—'} />
          <Field label="Confirmed yield" value={`${detail.yieldQuantity} ${detail.unit}`} />
          <Field label="Scrap" value={`${detail.scrapQuantity} ${detail.unit}`} />
          <Field label="Rework" value={`${detail.reworkQuantity} ${detail.unit}`} />
          <Field label="Posting date" value={detail.postingDate} />
          <Field label="Recorded at" value={detail.recordedAt.replace('T', ' ').slice(0, 19)} />
          <Field label="Execution start (recorded actual)" value={detail.executionStart ?? 'Not recorded'} />
          <Field label="Execution finish (recorded actual)" value={detail.executionFinish ?? 'Not recorded'} />
          <Field label="Recorded by" value={detail.recordedBy} />
        </dl>
        <p className="text-xs text-ink-soft" data-co14-personnel-note>
          No personnel or operator is stored on this confirmation. “Recorded by” identifies the user who entered the record, not the person who performed the work.
        </p>
        {detail.note && <p className="border-l-2 border-line-strong pl-3 text-ink-soft">Confirmation note: {detail.note}</p>}
        {detail.cancelled && (
          <div className="border border-signal-error/30 bg-signal-error-soft p-3" data-co14-cancellation>
            <h3 className="font-semibold text-danger">Cancellation record (CO13)</h3>
            <p>Cancellation {detail.cancellationNumber} · {detail.cancelledAt?.replace('T', ' ').slice(0, 19) ?? 'time not recorded'} · recorded by {detail.cancelledBy ?? '—'}</p>
            <p>Reason: {detail.cancellationReason ?? 'No reason recorded'}</p>
            <p>The original confirmation quantities remain unchanged; this cancellation does not reverse linked material documents.</p>
          </div>
        )}
        {detail.confirmationLevel === 'OPERATION' && detail.effects.length > 0 && (
          <EffectTable title="Operation confirmation" effects={detail.effects} />
        )}
        {detail.confirmationLevel === 'HEADER' && <EffectTable title="CO15 operation effects (not separate confirmations)" effects={detail.effects} />}
        <section aria-labelledby="co14-activities-heading">
          <h3 id="co14-activities-heading" className="font-semibold">Actual activity quantities and times</h3>
          {detail.activities.length === 0 ? (
            <p className="mt-1 text-ink-soft">No activity quantities are recorded. Execution start/finish appear above when present.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="grid-table min-w-[520px]">
                <thead><tr><th>Activity</th><th className="text-end">Actual quantity</th><th>Unit</th><th className="text-end">Suggested quantity</th></tr></thead>
                <tbody>{detail.activities.map((activity) => (
                  <tr key={activity.parameter}>
                    <td>{activity.description} <span className="code text-2xs text-ink-faint">{activity.parameter}</span></td>
                    <td className="text-end">{activity.quantity}</td><td>{activity.unit}</td>
                    <td className="text-end">{activity.suggestedQuantity ?? '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
        <section aria-labelledby="co14-material-documents-heading">
          <h3 id="co14-material-documents-heading" className="font-semibold">Associated goods movements and material documents</h3>
          {detail.materialDocuments.length === 0 ? (
            <p className="mt-1 text-ink-soft">No material document is linked to this confirmation.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="grid-table min-w-[860px]">
                <thead><tr><th>Material document / year</th><th>Movement</th><th>Material</th><th>Plant / location</th><th className="text-end">Quantity</th><th>Posting date</th><th>Status / reversal</th></tr></thead>
                <tbody>{detail.materialDocuments.map((document) => (
                  <tr key={`${document.materialDocumentNumber}-${document.lineNumber}`}>
                    <td className="code">{document.materialDocumentNumber} / {document.documentYear} · line {document.lineNumber}</td>
                    <td>{document.movementType}<div className="text-2xs text-ink-faint">{document.movementTypeDescription}</div></td><td>{document.materialNumber}</td>
                    <td>{document.plant}{document.storageLocation ? ` / ${document.storageLocation}` : ''}</td>
                    <td className="text-end">{document.entryQuantity} {document.entryUnit} <span className="text-2xs text-ink-faint">({document.baseQuantity} {document.baseUnit})</span></td>
                    <td>{document.postingDate}</td>
                    <td>{document.status}{document.reversalOf ? ` · reversal of ${document.reversalOf}` : ''}{document.reversedBy ? ` · reversed by ${document.reversedBy}${document.reversalYear ? ` / ${document.reversalYear}` : ''}` : ''}{document.reversalOfDocument ? ` · line reversal of ${document.reversalOfDocument}${document.reversalOfLine ? ` line ${document.reversalOfLine}` : ''}` : ''}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-2xs uppercase tracking-wide text-ink-faint">{label}</dt><dd className="mt-0.5 break-words font-medium">{value}</dd></div>;
}

function EffectTable({ title, effects }: { title: string; effects: ConfirmationDisplayDetail['effects'] }) {
  return (
    <section aria-label={title}>
      <h3 className="font-semibold">{title}</h3>
      {effects.length === 0 ? <p className="mt-1 text-ink-soft">No operation effects are recorded.</p> : (
        <div className="mt-2 overflow-x-auto">
          <table className="grid-table min-w-[720px]">
            <thead><tr><th>Operation</th><th>Text</th><th>Work center</th><th>Control key</th><th>Confirmation type</th><th className="text-end">Yield · scrap · rework</th><th>Quantity basis</th></tr></thead>
            <tbody>{effects.map((effect) => (
              <tr key={effect.operationNumber}>
                <td>{effect.operationNumber}</td><td>{effect.shortText ?? '—'}</td>
                <td>{effect.workCenter ?? '—'}{effect.workCenterDescription ? ` · ${effect.workCenterDescription}` : ''}</td>
                <td>{effect.controlKey ?? '—'}</td><td>{effect.confirmationType}</td>
                <td className="text-end whitespace-nowrap">{effect.yieldQuantity} · {effect.scrapQuantity} · {effect.reworkQuantity} {effect.unit}</td>
                <td>{effect.quantityBasis}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function ConfirmationDisplayPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireSession(CONFIRMATION_DISPLAY_ROUTE);
  if (!can(session, PRODUCTION_ORDER_DISPLAY_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <h1 className="text-xl font-semibold">Display production order confirmation</h1>
        <p className="mt-2 text-sm" role="alert">You do not hold production-order display ({PRODUCTION_ORDER_DISPLAY_CAPABILITY}).</p>
      </main>
    );
  }

  const params = await searchParams;
  const filters = filtersFrom(params);
  const run = one(params.run) === '1';
  const detailNumber = one(params.detail);
  let result: ConfirmationDisplayResult | null = null;
  let detail: Awaited<ReturnType<typeof getProductionConfirmationDisplay>> = null;
  let errorMessage = '';

  if (run) {
    try {
      result = await searchProductionConfirmations(session.user.client, {
        ...filters,
        page: Number(one(params.page) || '1'),
        sort: one(params.sort) as ConfirmationDisplaySort,
        direction: one(params.direction) as ConfirmationDisplayDirection,
      });
    } catch (error) {
      errorMessage = error instanceof ConfirmationDisplayError ? error.message : 'Confirmation selection could not be read.';
    }
  }
  if (detailNumber) {
    try {
      detail = await getProductionConfirmationDisplay(session.user.client, detailNumber);
      if (!detail && !errorMessage) errorMessage = `Confirmation ${detailNumber} does not stand.`;
    } catch (error) {
      errorMessage = error instanceof ConfirmationDisplayError ? error.message : 'Confirmation detail could not be read.';
    }
  }

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6" data-co14-page>
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.ORDER.DISPLAY · CO14</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Display production order confirmation</h1>
          <nav aria-label="Production transactions" className="flex flex-wrap gap-2 text-sm">
            <Link href="/production/production-order-display" className="btn btn-default min-h-11 sm:min-h-8">CO03 order display</Link>
            <Link href="/production/time-ticket" className="btn btn-default min-h-11 sm:min-h-8">CO11N</Link>
            <Link href="/production/order-confirmation" className="btn btn-default min-h-11 sm:min-h-8">CO15</Link>
            <Link href="/production/confirmation-cancel" className="btn btn-default min-h-11 sm:min-h-8">CO13</Link>
            <Link href="/production/order-information" className="btn btn-default min-h-11 sm:min-h-8">COOIS</Link>
          </nav>
        </div>
        <p className="mt-2 max-w-4xl text-sm text-ink-soft">
          CO14 reads posted operation confirmations and CO15 header confirmations. It never creates, changes, cancels, or posts. The recorded date below is the row’s creation date; the posting date and recorded execution times are shown separately.
        </p>
      </header>

      {errorMessage && <p className="border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-danger" role="alert" data-co14-error>{errorMessage}</p>}
      {detailNumber && !detail && !errorMessage && <p className="text-sm text-ink-soft" role="status">No confirmation was found.</p>}

      <section className="panel" aria-labelledby="co14-selection-heading">
        <div className="panel-header"><h2 id="co14-selection-heading" className="panel-title">Selection</h2></div>
        <form method="get" className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4" data-co14-selection>
          <input type="hidden" name="run" value="1" />
          <label className="text-sm"><span className="mb-1 block text-ink-soft">Confirmation number (exact or prefix)</span><input className="input w-full" name="confirmation" defaultValue={filters.confirmationNumber} maxLength={12} autoComplete="off" /></label>
          <label className="text-sm"><span className="mb-1 block text-ink-soft">Production order (exact or prefix)</span><input className="input w-full" name="order" defaultValue={filters.productionOrder} maxLength={12} autoComplete="off" /></label>
          <label className="text-sm"><span className="mb-1 block text-ink-soft">Operation</span><input className="input w-full" name="operation" defaultValue={filters.operation} maxLength={4} placeholder="Four-character number" autoComplete="off" /></label>
          <label className="text-sm"><span className="mb-1 block text-ink-soft">Plant</span><input className="input w-full" name="plant" defaultValue={filters.plant} maxLength={10} autoComplete="off" /></label>
          <label className="text-sm"><span className="mb-1 block text-ink-soft">Confirmation recorded date from</span><input className="input w-full" type="date" name="recordedFrom" defaultValue={filters.recordedFrom} /></label>
          <label className="text-sm"><span className="mb-1 block text-ink-soft">Confirmation recorded date to</span><input className="input w-full" type="date" name="recordedTo" defaultValue={filters.recordedTo} /></label>
          <label className="text-sm"><span className="mb-1 block text-ink-soft">Posting date from</span><input className="input w-full" type="date" name="postingFrom" defaultValue={filters.postingFrom} /></label>
          <label className="text-sm"><span className="mb-1 block text-ink-soft">Posting date to</span><input className="input w-full" type="date" name="postingTo" defaultValue={filters.postingTo} /></label>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Search confirmations</button>
            <Link href={CONFIRMATION_DISPLAY_ROUTE} className="btn btn-default min-h-11 sm:min-h-8">Clear</Link>
          </div>
        </form>
      </section>

      {detail && <ConfirmationDetail detail={detail} />}
      {result && <ResultTable page={result} />}
    </main>
  );
}
