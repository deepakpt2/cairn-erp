'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { OrderInformationLayout, OrderInformationResult } from '@/modules/production/order-information';
import { saveOrderInformationLayoutAction, type OrderInformationLayoutState } from './actions';

const INITIAL: OrderInformationLayoutState = { ok: false, message: '' };

function csvCell(value: string | null): string {
  const text = value ?? '';
  return `"${text.replace(/"/g, '""')}"`;
}

function ChildTable({ title, rows }: { title: string; rows: Array<Record<string, string | null>> }) {
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mt-2 font-medium">{title}</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-ink-faint">{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => <td key={column} className="py-1">{row[column] ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OrderInformationResultView({
  result,
  layouts,
  layoutQuery,
  canChange,
  canConfirm,
  canConfirmOrder,
  canDisplayPlanned,
  canDisplayDocument,
}: {
  result: OrderInformationResult;
  layouts: OrderInformationLayout[];
  layoutQuery: string;
  canChange: boolean;
  canConfirm: boolean;
  canConfirmOrder: boolean;
  canDisplayPlanned: boolean;
  canDisplayDocument: boolean;
}) {
  const [state, action, pending] = useActionState(saveOrderInformationLayoutAction, INITIAL);
  const csv = [result.columns.map((column) => csvCell(column.label)).join(',')]
    .concat(result.rows.map((row) => result.columns.map((column) => csvCell(row[column.id] ?? null)).join(',')))
    .join('\n');

  function download() {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'order-information.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm" data-coois-count>
        {result.returned} of {result.total} row{result.total === 1 ? '' : 's'}.
        {result.truncated ? ' The result is limited. This is not the whole history.' : ''}
        {' '}The export is these returned rows, not a second query.
      </p>
      {result.rows.length > 0 && (
        <table className="w-full text-sm" data-coois-rows>
          <thead>
            <tr className="text-left text-ink-faint">
              {result.columns.map((column) => <th key={column.id}>{column.label}</th>)}
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              <tr key={`${row.orderNumber ?? row.confirmationNumber ?? row.materialDocumentNumber ?? index}-${index}`}>
                {result.columns.map((column) => <td key={column.id} className="py-1">{row[column.id] ?? '—'}</td>)}
                <td className="py-1">
                  {row.orderNumber && result.object === 'PRODUCTION_ORDER' && (
                    <Link href={`/production/production-order-display?order=${encodeURIComponent(row.orderNumber)}`}>CO03</Link>
                  )}
                  {row.orderNumber && result.object === 'PLANNED_ORDER' && canDisplayPlanned && (
                    <Link href={`/production/planned-order-display?order=${encodeURIComponent(row.orderNumber)}`}>MD13</Link>
                  )}
                  {row.materialDocumentNumber && canDisplayDocument && (
                    <Link href={`/inventory/material-documents?document=${encodeURIComponent(row.materialDocumentNumber)}`}>Document</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.rows.length === 0 && !result.overview && <p className="text-sm">No row stands for that selection.</p>}
      {result.overview && (
        <section className="space-y-2 text-sm" data-coois-overview={result.overview.orderNumber}>
          <p>Order {result.overview.orderNumber}. {result.overview.reduced ? 'Children were not loaded.' : 'Children are listed once.'}</p>
          <p>
            {result.object === 'PRODUCTION_ORDER' && (
              <Link href={`/production/production-order-display?order=${encodeURIComponent(result.overview.orderNumber)}`}>CO03</Link>
            )}
            {result.object === 'PLANNED_ORDER' && canDisplayPlanned && (
              <Link href={`/production/planned-order-display?order=${encodeURIComponent(result.overview.orderNumber)}`}>MD13</Link>
            )}
            {result.object === 'PRODUCTION_ORDER' && canChange && <> · <Link href={`/production/production-order-change?order=${encodeURIComponent(result.overview.orderNumber)}`}>CO02</Link></>}
            {result.object === 'PRODUCTION_ORDER' && canConfirm && <> · <Link href={`/production/time-ticket?order=${encodeURIComponent(result.overview.orderNumber)}`}>CO11N</Link></>}
            {result.object === 'PRODUCTION_ORDER' && canConfirmOrder && <> · <Link href={`/production/order-confirmation?order=${encodeURIComponent(result.overview.orderNumber)}`}>CO15</Link></>}
          </p>
          <p>Components {result.overview.components.length}. Confirmations {result.overview.confirmations.length}. Goods movements {result.overview.movements.length}. Dependent requirements {result.overview.dependents.length}.</p>
          <ChildTable title="Components" rows={result.overview.components} />
          <ChildTable title="Confirmations" rows={result.overview.confirmations} />
          <ChildTable title="Goods movements" rows={result.overview.movements} />
          <ChildTable title="Dependent requirements" rows={result.overview.dependents} />
          {result.overview.confirmations.map((row) => (
            <p key={String(row.confirmationNumber)}>Confirmation {row.confirmationNumber} · {row.confirmationLevel} · yield {row.yieldQuantity}. CO14 is not implemented.</p>
          ))}
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={download} data-coois-export>Export returned rows</button>
      </div>
      {result.notes.map((note) => <p key={note} className="text-sm text-ink-soft">{note}</p>)}
      <form action={action} className="rounded-card border border-line bg-surface p-4 text-sm shadow-card">
        <p>Save the current columns as a private layout. A layout does not store rows, and it does not change an order.</p>
        {result.columns.map((column) => <input key={column.id} type="hidden" name="field" value={column.id} />)}
        <input type="hidden" name="object" value={result.object} />
        <input type="hidden" name="listType" value={result.listType} />
        <input type="hidden" name="sortField" value={result.columns[0]?.id ?? ''} />
        <input type="hidden" name="sortDirection" value="ASC" />
        <div className="mt-2 flex flex-wrap gap-2">
          <input className="input" name="layoutName" maxLength={40} placeholder="Layout name" required />
          <label className="flex items-center gap-2"><input type="checkbox" name="isDefault" /> Default for this list</label>
          <button className="btn btn-default min-h-11 sm:min-h-8" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save layout'}</button>
        </div>
        {state.message && <p className={`mt-2 ${state.ok ? '' : 'text-red-700'}`}>{state.message}</p>}
        {layouts.length > 0 && (
          <ul className="mt-2" data-coois-layouts>
            {layouts.map((layout) => (
              <li key={layout.layoutId}>
                <Link href={`/production/order-information?${layoutQuery}&layout=${encodeURIComponent(layout.layoutId)}`}>{layout.name}</Link>
                {layout.isDefault ? ' (default)' : ''}
              </li>
            ))}
          </ul>
        )}
      </form>
    </div>
  );
}
