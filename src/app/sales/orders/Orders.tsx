'use client';

import Link from 'next/link';
import { useActionState, useId, useRef, useState } from 'react';

import type { SalesOrderView } from '@/modules/sales/sales-order';
import {
  cancelOrderAction,
  changeOrderAction,
  createOrderAction,
  releaseCreditAction,
  type OrderActionState,
} from './actions';

const EMPTY: OrderActionState = { ok: false };
/** How many blank rows a new grid opens with. Not a cap: the grid grows as it is filled. */
const OPENING_ROWS = 5;
/** How many spare rows sit under the ones in use, so adding an item is one click and not two. */
const SPARE_ROWS = 2;

interface Props {
  documents: Array<{
    orderNumber: string; customerNumber: string; orderDate: string; status: string;
    currency: string; grossValue: string; blockedForCredit: boolean;
  }>;
  choices: Awaited<ReturnType<typeof import('@/modules/sales/sales-order').salesOrderChoices>>;
  selected: SalesOrderView | null;
  canCreate: boolean;
  canRelease: boolean;
}

function money(value: string, currency: string): string {
  return `${Number(value).toFixed(2)} ${currency.trim()}`;
}

function Notice({ state }: { state: OrderActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.orderNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/sales/orders?order=${state.orderNumber}`}>
            Open sales order {state.orderNumber}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

interface GridRow {
  id: number;
  /** The item this row addresses, or null on a row that has never been saved. */
  lineNumber: number | null;
  materialNumber: string;
  plant: string;
  quantity: string;
  unit: string;
  tax: string;
  needed: string;
}

const blankRow = (id: number, lineNumber: number | null = null): GridRow => ({
  id, lineNumber, materialNumber: '', plant: '', quantity: '', unit: '', tax: '', needed: '',
});

/**
 * The item grid.
 *
 * It grows. An order is not limited to ten items and the grid is not either: a clerk adds a row and
 * types into it, and the form posts however many rows stand. This used to be five rows on the screen
 * and ten in the action, which is the worse of both — a large order could not be entered at all, and
 * the two numbers disagreed about how large a large order was.
 *
 * Rows are numbered in tens, as the service numbers items. A row carrying a number changes that
 * item; a row carrying none is new, and is given the next free number — which is why a change can
 * add an item to an order that already has some.
 *
 * A blank row is not an item. The grid submits everything it has and the service ignores a row that
 * names no material, so a clerk can leave rows they decided not to use.
 */
function ItemGrid({ initialRows, numbered }: { initialRows?: GridRow[]; numbered: boolean }) {
  const [rows, setRows] = useState<GridRow[]>(() => {
    const start = initialRows && initialRows.length > 0
      ? [...initialRows, ...Array.from({ length: SPARE_ROWS }, (_, n) => blankRow(-(n + 1)))]
      : Array.from({ length: OPENING_ROWS }, (_, n) => blankRow(n + 1));
    return start;
  });
  const nextId = useRef(0);
  // The number a new item takes: ten past the highest item that stands, which is the numbering the
  // service uses and the reason a new row never lands on an item that is already there.
  const nextNumber = useRef(
    Math.max(0, ...rows.map((row) => row.lineNumber ?? 0)) + 10,
  );

  const add = () => {
    nextId.current -= 1;
    setRows((standing) => [...standing, blankRow(nextId.current, numbered ? nextNumber.current : null)]);
    nextNumber.current += 10;
  };
  const remove = (id: number) => setRows((standing) => (
    standing.length > 1 ? standing.filter((row) => row.id !== id) : standing
  ));
  const set = (id: number, field: keyof Omit<GridRow, 'id' | 'lineNumber'>, value: string) => (
    setRows((standing) => standing.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  );

  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-6">
        <span>Material</span><span>Plant</span><span>Quantity</span><span>Unit</span><span>Tax code</span><span>Needed by</span>
      </div>
      {rows.map((row, index) => {
        const slot = index + 1;
        const name = (field: string) => `line-${slot}-${field}`;
        return (
          <div key={row.id} className="grid grid-cols-2 gap-2 sm:grid-cols-6">
            <input className="input" name={name('material')} placeholder="Material" autoComplete="off"
              value={row.materialNumber} onChange={(e) => set(row.id, 'materialNumber', e.target.value)} />
            <input className="input" name={name('plant')} placeholder="Plant" autoComplete="off"
              value={row.plant} onChange={(e) => set(row.id, 'plant', e.target.value)} />
            <input className="input" name={name('quantity')} placeholder="Quantity" inputMode="decimal" autoComplete="off"
              value={row.quantity} onChange={(e) => set(row.id, 'quantity', e.target.value)} />
            <input className="input" name={name('unit')} placeholder="Unit" autoComplete="off"
              value={row.unit} onChange={(e) => set(row.id, 'unit', e.target.value)} />
            <input className="input" name={name('tax')} placeholder="Tax" autoComplete="off"
              value={row.tax} onChange={(e) => set(row.id, 'tax', e.target.value)} />
            <div className="flex gap-2">
              <input className="input min-w-0 flex-1" name={name('needed')} placeholder="YYYY-MM-DD" autoComplete="off"
                value={row.needed} onChange={(e) => set(row.id, 'needed', e.target.value)} />
              <button type="button" className="btn btn-default min-h-11 shrink-0 px-3 sm:min-h-8"
                onClick={() => remove(row.id)} disabled={rows.length === 1}
                aria-label={`Remove item row ${slot}`} title="Remove this row">×</button>
            </div>
            {numbered && row.lineNumber !== null
              ? <input type="hidden" name={name('lineNumber')} value={row.lineNumber} />
              : null}
          </div>
        );
      })}
      <input type="hidden" name="lineCount" value={String(rows.length)} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={add}>
          Add another item
        </button>
        <span className="text-xs text-ink-faint">
          {rows.length} row{rows.length === 1 ? '' : 's'}. A row that names no material is not an item.
        </span>
      </div>
    </div>
  );
}

/**
 * The rows a change starts from: the items that stand, so a change does not mean retyping the order.
 * A rejected item is left out, because a rejected item number is not reused — the service refuses it,
 * and a grid that offered it would be offering a refusal.
 */
function rowsOf(selected: SalesOrderView): GridRow[] {
  return selected.lines
    .filter((line) => line.status !== 'REJECTED')
    .map((line, index) => ({
      id: index + 1,
      lineNumber: line.lineNumber,
      materialNumber: line.materialNumber,
      plant: line.plant,
      quantity: String(Number(line.orderQuantity)),
      unit: line.quantityUnit.trim(),
      tax: line.taxCode ?? '',
      needed: line.requestedDeliveryDate ?? '',
    }));
}

function HeaderFields({ choices, selected }: { choices: Props['choices']; selected: SalesOrderView | null }) {
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const field = (name: string, label: string, value: string, placeholder: string) => (
    <label className="block text-xs text-ink-soft" htmlFor={`${id}-${name}`}>
      {label}
      <input
        className="input mt-1"
        id={`${id}-${name}`}
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        autoComplete="off"
      />
    </label>
  );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {field('customerNumber', 'Customer', selected?.customerNumber ?? '', 'Customer number')}
      {field('salesOrg', 'Sales organization', selected?.salesOrg ?? '', '1000')}
      {field('distributionChannel', 'Distribution channel', selected?.distributionChannel ?? '', '10')}
      {field('division', 'Division', selected?.division ?? '', '01')}
      {field('companyCode', 'Company code', selected?.companyCode ?? '1000', '1000')}
      {field('currency', 'Currency', selected?.currency ?? 'KWD', 'KWD')}
      {field('orderDate', 'Order date', selected?.orderDate ?? today, 'YYYY-MM-DD')}
      {field('requestedDate', 'Requested date', selected?.requestedDate ?? '', 'YYYY-MM-DD')}
      {field('purchaseOrderReference', 'Customer reference', selected?.purchaseOrderReference ?? '', 'Purchase order number')}
      {field('headerText', 'Order note', selected?.headerText ?? '', 'Note on the order')}
      {field('creditControlArea', 'Credit control area', selected?.credit?.creditControlArea ?? '', 'Only if the customer has several')}
    </div>
  );
}

export default function Orders({ documents, choices, selected, canCreate, canRelease }: Props) {
  const [createState, createAction] = useActionState(createOrderAction, EMPTY);
  const [changeState, changeAction] = useActionState(changeOrderAction, EMPTY);
  const [cancelState, cancelAction] = useActionState(cancelOrderAction, EMPTY);
  const [releaseState, releaseAction] = useActionState(releaseCreditAction, EMPTY);
  const notice = selected ? changeState.message ? changeState : cancelState : createState;

  return (
    <div className="space-y-4">
      {selected ? (
        <section className="panel p-4" data-order={selected.orderNumber} aria-label={`Sales order ${selected.orderNumber}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Sales order {selected.orderNumber}</h2>
            <span className="code text-ink-faint">
              {selected.status}{selected.credit?.status === 'BLOCKED' ? ' · CREDIT BLOCK' : ''}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <div><dt className="text-ink-faint">Customer</dt><dd>{selected.customerNumber}</dd></div>
            <div><dt className="text-ink-faint">Sales area</dt>
              <dd>{selected.salesOrg}/{selected.distributionChannel}/{selected.division}</dd></div>
            <div><dt className="text-ink-faint">Company code</dt><dd>{selected.companyCode}</dd></div>
            <div><dt className="text-ink-faint">Order date</dt><dd>{selected.orderDate}</dd></div>
            <div><dt className="text-ink-faint">Net value</dt><dd>{money(selected.netValue, selected.currency)}</dd></div>
            <div><dt className="text-ink-faint">Tax</dt><dd>{money(selected.taxValue, selected.currency)}</dd></div>
            <div><dt className="text-ink-faint">Gross value</dt><dd>{money(selected.grossValue, selected.currency)}</dd></div>
            <div><dt className="text-ink-faint">Customer reference</dt><dd>{selected.purchaseOrderReference ?? '—'}</dd></div>
          </dl>

          <table className="grid-table mt-3 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Item</th><th>Material</th><th>Plant</th><th className="text-right">Quantity</th>
                <th className="text-right">Confirmed</th><th className="text-right">Delivered</th>
                <th className="text-right">Billed</th><th className="text-right">Open</th>
                <th>Unit</th><th className="text-right">Price</th><th className="text-right">Net</th>
                <th className="text-right">Tax</th><th>Priced from</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {selected.lines.map((line) => (
                <tr key={line.lineNumber}>
                  <td>{line.lineNumber}</td>
                  <td>{line.materialNumber}</td>
                  <td>{line.plant}</td>
                  <td className="text-right num">{Number(line.orderQuantity).toFixed(3)}</td>
                  <td className="text-right num">{line.confirmedQuantity === null ? '—' : Number(line.confirmedQuantity).toFixed(3)}</td>
                  <td className="text-right num">{Number(line.deliveredQuantity).toFixed(3)}</td>
                  <td className="text-right num">{Number(line.billedQuantity).toFixed(3)}</td>
                  <td className="text-right num">{Number(line.openQuantity).toFixed(3)}</td>
                  <td>{line.quantityUnit.trim()}</td>
                  <td className="text-right num">{Number(line.netPrice).toFixed(4)} / {line.priceUnit}</td>
                  <td className="text-right num">{Number(line.netAmount).toFixed(2)}</td>
                  <td className="text-right num">{Number(line.taxAmount).toFixed(2)}</td>
                  <td className="code">{line.conditionNumber}</td>
                  <td>{line.status}{line.rejectionReason ? ` (${line.rejectionReason})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {selected.credit ? (
            <div className={selected.credit.status === 'BLOCKED' ? 'panel panel-danger mt-3 p-3 text-sm' : 'panel mt-3 p-3 text-sm'}>
              <p className="font-medium">
                Credit determination: {selected.credit.status} — {selected.credit.reason}
              </p>
              <p className="mt-1 text-ink-soft">
                Order value {money(String(selected.credit.orderValue), selected.credit.orderCurrency)}, exposure at check{' '}
                {Number(selected.credit.exposureAtCheck).toFixed(2)}
                {selected.credit.limitAtCheck === null ? ', no limit on record' : `, limit ${Number(selected.credit.limitAtCheck).toFixed(2)}`}.
              </p>
              {selected.credit.status === 'BLOCKED' && canRelease ? (
                <form action={releaseAction} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input type="hidden" name="orderNumber" value={selected.orderNumber} />
                  <input type="hidden" name="expectedVersion" value={String(selected.version)} />
                  <input className="input" name="releaseJustification" placeholder="Why the block is released" />
                  <input className="input" name="releaseApprovalRef" placeholder="Approval reference" />
                  <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Release for credit</button>
                </form>
              ) : null}
              {selected.credit.status === 'BLOCKED' && !canRelease ? (
                <p className="mt-2 text-ink-soft">
                  A blocked order is released by SALES.ORDER.RELEASE or at{' '}
                  <Link className="link" href="/finance/credit-release">credit release</Link>.
                </p>
              ) : null}
              <Notice state={releaseState} />
            </div>
          ) : null}

          {canCreate ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <form action={changeAction} className="space-y-2">
                <h3 className="text-sm font-semibold">Change the order</h3>
                <Notice state={changeState.message ? changeState : { ok: false }} />
                <input type="hidden" name="orderNumber" value={selected.orderNumber} />
                <input type="hidden" name="expectedVersion" value={String(selected.version)} />
                <HeaderFields choices={choices} selected={selected} />
                <ItemGrid numbered initialRows={rowsOf(selected)} />
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Save changes</button>
              </form>
              <form action={cancelAction} className="space-y-2">
                <h3 className="text-sm font-semibold">Cancel the order</h3>
                <p className="text-xs text-ink-soft">
                  Cancellation refuses a second time, and once a delivery has read the order it refuses
                  there too. Version {selected.version}.
                </p>
                <Notice state={cancelState.message ? cancelState : { ok: false }} />
                <input type="hidden" name="orderNumber" value={selected.orderNumber} />
                <input type="hidden" name="expectedVersion" value={String(selected.version)} />
                <input className="input" name="cancelReason" placeholder="Reason for the cancellation" />
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Cancel order</button>
              </form>
            </div>
          ) : null}
        </section>
      ) : null}

      {canCreate && !selected ? (
        <form action={createAction} className="panel space-y-3 p-4" aria-label="Create sales order">
          <h2 className="text-lg font-semibold">Create sales order</h2>
          <Notice state={notice} />
          <HeaderFields choices={choices} selected={null} />
          <ItemGrid numbered={false} />
          <input type="hidden" name="requestKey" value={`SO-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Create order</button>
        </form>
      ) : null}

      <section className="panel p-4" aria-label="Sales orders">
        <h2 className="text-lg font-semibold">Sales orders</h2>
        <table className="grid-table mt-2 text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-faint">
              <th>Order</th><th>Customer</th><th>Date</th><th>Status</th>
              <th className="text-right">Gross value</th><th>Credit</th>
            </tr>
          </thead>
          <tbody>
            {documents.length === 0 ? (
              <tr><td colSpan={6} className="text-ink-soft">No sales order stands in this tenant yet.</td></tr>
            ) : documents.map((row) => (
              <tr key={row.orderNumber}>
                <td>
                  <Link className="link" href={`/sales/orders?order=${row.orderNumber}`}>{row.orderNumber}</Link>
                </td>
                <td>{row.customerNumber}</td>
                <td>{row.orderDate}</td>
                <td>{row.status}</td>
                <td className="text-right">{money(row.grossValue, row.currency)}</td>
                <td>{row.blockedForCredit ? 'blocked' : 'clear'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
