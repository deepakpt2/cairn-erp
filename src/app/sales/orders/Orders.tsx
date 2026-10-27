'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';

import type { SalesOrderView } from '@/modules/sales/sales-order';
import {
  cancelOrderAction,
  changeOrderAction,
  createOrderAction,
  releaseCreditAction,
  type OrderActionState,
} from './actions';

const EMPTY: OrderActionState = { ok: false };
const LINE_SLOTS = 5;

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

function LineSlots({ numbered }: { numbered: boolean }) {
  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-6">
        <span>Material</span><span>Plant</span><span>Quantity</span><span>Unit</span><span>Tax code</span><span>Needed by</span>
      </div>
      {Array.from({ length: LINE_SLOTS }, (_, index) => index + 1).map((slot) => (
        <div key={slot} className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          <input className="input" name={`line-${slot}-material`} placeholder="Material" autoComplete="off" />
          <input className="input" name={`line-${slot}-plant`} placeholder="Plant" autoComplete="off" />
          <input className="input" name={`line-${slot}-quantity`} placeholder="Quantity" inputMode="decimal" autoComplete="off" />
          <input className="input" name={`line-${slot}-unit`} placeholder="Unit" autoComplete="off" />
          <input className="input" name={`line-${slot}-tax`} placeholder="Tax" autoComplete="off" />
          <input className="input" name={`line-${slot}-needed`} placeholder="YYYY-MM-DD" autoComplete="off" />
          {numbered ? <input type="hidden" name={`line-${slot}-lineNumber`} value={slot * 10} /> : null}
        </div>
      ))}
    </div>
  );
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

          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="py-1">Item</th><th>Material</th><th>Plant</th><th className="text-right">Quantity</th>
                <th>Unit</th><th className="text-right">Price</th><th className="text-right">Net</th>
                <th className="text-right">Tax</th><th>Priced from</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {selected.lines.map((line) => (
                <tr key={line.lineNumber} className="border-t border-line">
                  <td className="py-1">{line.lineNumber}</td>
                  <td>{line.materialNumber}</td>
                  <td>{line.plant}</td>
                  <td className="text-right">{Number(line.orderQuantity).toFixed(3)}</td>
                  <td>{line.quantityUnit.trim()}</td>
                  <td className="text-right">{Number(line.netPrice).toFixed(4)} / {line.priceUnit}</td>
                  <td className="text-right">{Number(line.netAmount).toFixed(2)}</td>
                  <td className="text-right">{Number(line.taxAmount).toFixed(2)}</td>
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
                <LineSlots numbered />
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
          <LineSlots numbered={false} />
          <input type="hidden" name="requestKey" value={`SO-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Create order</button>
        </form>
      ) : null}

      <section className="panel p-4" aria-label="Sales orders">
        <h2 className="text-lg font-semibold">Sales orders</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-faint">
              <th className="py-1">Order</th><th>Customer</th><th>Date</th><th>Status</th>
              <th className="text-right">Gross value</th><th>Credit</th>
            </tr>
          </thead>
          <tbody>
            {documents.length === 0 ? (
              <tr><td colSpan={6} className="py-3 text-ink-soft">No sales order stands in this tenant yet.</td></tr>
            ) : documents.map((row) => (
              <tr key={row.orderNumber} className="border-t border-line">
                <td className="py-1">
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
