'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';

import type { DeliveryView } from '@/modules/sales/delivery';
import type { SalesOrderView } from '@/modules/sales/sales-order';
import {
  createReturnsDeliveryAction,
  createReturnsOrderAction,
  receiveReturnsDeliveryAction,
  type ReturnsActionState,
} from './actions';

const EMPTY: ReturnsActionState = { ok: false };
const LINE_SLOTS = 10;

interface Props {
  orders: Awaited<ReturnType<typeof import('@/modules/sales/returns').listReturnsOrders>>;
  deliveries: Awaited<ReturnType<typeof import('@/modules/sales/returns').listReturnsDeliveries>>;
  invoices: Awaited<ReturnType<typeof import('@/modules/sales/billing').listBillings>>;
  selectedOrder: SalesOrderView | null;
  selectedDelivery: DeliveryView | null;
  canRaiseOrder: boolean;
  canRaiseDelivery: boolean;
  canReceive: boolean;
}

function quantity(value: string): string {
  return Number(value).toFixed(3);
}

function money(value: string, currency: string): string {
  return `${Number(value).toFixed(2)} ${currency.trim()}`;
}

function Notice({ state, label }: { state: ReturnsActionState; label?: string }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      {label ? <p className="text-xs text-ink-faint">{label}</p> : null}
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.orderNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/sales/returns?order=${state.orderNumber}`}>
            Open returns order {state.orderNumber}
          </Link>
        </p>
      ) : null}
      {state.ok && state.deliveryNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/sales/returns?delivery=${state.deliveryNumber}`}>
            Open returns delivery {state.deliveryNumber}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The complaint: what the customer says they are sending back, priced from the invoice.
 *
 * The only thing the form submits is which invoiced lines are coming back and how much of each. The
 * price, the tax and the unit are copied from the line the goods were billed on, because a return
 * settles what was billed and not what the price list says today.
 */
function RaiseReturnsOrder({
  invoices, allowed,
}: { invoices: Props['invoices']; allowed: boolean }) {
  const [state, action, pending] = useActionState(createReturnsOrderAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const posted = invoices.filter((invoice) => invoice.status === 'POSTED');
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Returns orders are read-only for this session: raising one needs SALES.RETURNS.ORDER.CREATE.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Raise a returns order">
      <p className="text-sm font-medium">Raise a returns order against an invoice</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-invoice`}>
          Invoice
          <select className="input mt-1" id={`${id}-invoice`} name="billingNumber" defaultValue="">
            <option value="">— choose an invoice —</option>
            {posted.map((invoice) => (
              <option key={invoice.billingNumber} value={invoice.billingNumber}>
                {invoice.billingNumber} · {invoice.customerNumber} · {invoice.billingDate} · {invoice.grossValue}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-date`}>
          Order date
          <input className="input mt-1" id={`${id}-date`} name="orderDate" defaultValue={today} autoComplete="off" />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-text`}>
          Reason / note
          <input className="input mt-1" id={`${id}-text`} name="headerText" placeholder="Damaged in transit" autoComplete="off" />
        </label>
      </div>
      <input type="hidden" name="requestKey" value={`RO-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <div className="space-y-1">
        <div className="grid grid-cols-3 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-4">
          <span>Invoice line</span><span className="text-right">Quantity coming back</span>
        </div>
        {Array.from({ length: LINE_SLOTS }, (_, index) => index + 1).map((slot) => (
          <div key={slot} className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            <input
              className="input" name={`line-${slot}-billingLine`} placeholder="10"
              aria-label={`Invoice line ${slot}`} autoComplete="off"
            />
            <input
              className="input text-right" name={`line-${slot}-quantity`} placeholder="0"
              aria-label={`Quantity of invoice line ${slot}`} autoComplete="off"
            />
          </div>
        ))}
      </div>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
        {pending ? 'Raising…' : 'Raise the returns order'}
      </button>
      <Notice state={state} label="Returns order" />
    </form>
  );
}

/**
 * The document the warehouse receives against.
 *
 * It is raised two ways, because a return reaches the warehouse two ways: from the outbound delivery
 * the goods left on, or from the returns order the complaint was recorded on. The service refuses a
 * document that names both, and one that names neither.
 */
function RaiseReturnsDelivery({ allowed }: { allowed: boolean }) {
  const [state, action, pending] = useActionState(createReturnsDeliveryAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Returns deliveries are read-only for this session: raising one needs SALES.RETURNS.DELIVERY.CREATE.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Raise a returns delivery">
      <p className="text-sm font-medium">Raise a returns delivery</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-against`}>
          Raised against
          <select className="input mt-1" id={`${id}-against`} name="raisedAgainst" defaultValue="order">
            <option value="order">A returns order</option>
            <option value="delivery">An outbound delivery</option>
          </select>
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-order`}>
          Returns order
          <input className="input mt-1" id={`${id}-order`} name="returnsOrderNumber" placeholder="RO-0000001" autoComplete="off" />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-delivery`}>
          Outbound delivery
          <input className="input mt-1" id={`${id}-delivery`} name="deliveryNumber" placeholder="DL-0000001" autoComplete="off" />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-date`}>
          Delivery date
          <input className="input mt-1" id={`${id}-date`} name="deliveryDate" defaultValue={today} autoComplete="off" />
        </label>
      </div>
      <input type="hidden" name="requestKey" value={`RT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <div className="space-y-1">
        <div className="grid grid-cols-3 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-4">
          <span>Line</span><span className="text-right">Quantity coming back</span>
        </div>
        {Array.from({ length: LINE_SLOTS }, (_, index) => index + 1).map((slot) => (
          <div key={slot} className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            <input
              className="input" name={`line-${slot}-line`} placeholder="10"
              aria-label={`Line ${slot}`} autoComplete="off"
            />
            <input
              className="input text-right" name={`line-${slot}-quantity`} placeholder="0"
              aria-label={`Quantity of line ${slot}`} autoComplete="off"
            />
          </div>
        ))}
      </div>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
        {pending ? 'Raising…' : 'Raise the returns delivery'}
      </button>
      <Notice state={state} label="Returns delivery" />
    </form>
  );
}

/**
 * The receipt: the 651, which is the only act here that moves stock.
 *
 * The version travels with the form, so a delivery somebody else has moved on since is refused rather
 * than received twice. The answer names no accounting document, and the screen says why: returns stock
 * is not valuated, so the movement carries no value.
 */
function ReceiveReturns({
  selected, allowed,
}: { selected: DeliveryView | null; allowed: boolean }) {
  const [state, action, pending] = useActionState(receiveReturnsDeliveryAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const isReturns = selected?.documentType === 'LR';
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Receiving is closed for this session: posting the goods receipt needs SALES.RETURNS.RECEIPT.POST.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Receive a returns delivery">
      <p className="text-sm font-medium">Receive the goods back</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-delivery`}>
          Returns delivery
          <input
            className="input mt-1" id={`${id}-delivery`} name="deliveryNumber"
            defaultValue={selected?.deliveryNumber ?? ''} placeholder="RT-0000001" autoComplete="off"
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-posting`}>
          Posting date
          <input className="input mt-1" id={`${id}-posting`} name="postingDate" defaultValue={today} autoComplete="off" />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-document`}>
          Document date
          <input className="input mt-1" id={`${id}-document`} name="documentDate" placeholder="YYYY-MM-DD" autoComplete="off" />
        </label>
      </div>
      <input type="hidden" name="expectedVersion" value={selected?.version ?? 0} />
      <input type="hidden" name="requestKey" value={`RT-GR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      {selected && !isReturns ? (
        <p className="text-xs text-ink-faint">
          {selected.deliveryNumber} is {selected.documentType}, and only a returns delivery receives goods back.
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
        {pending ? 'Receiving…' : 'Receive the goods'}
      </button>
      <Notice state={state} label="Goods receipt" />
    </form>
  );
}

export default function Returns({
  orders, deliveries, invoices, selectedOrder, selectedDelivery,
  canRaiseOrder, canRaiseDelivery, canReceive,
}: Props) {
  return (
    <div className="space-y-4">
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Returns orders — the complaint</h2>
          <span className="code text-ink-faint">{orders.length} standing</span>
        </div>
        <table className="grid-table mt-3 text-sm">
          <thead>
            <tr>
              <th>Order</th><th>Date</th><th>Customer</th><th>Invoice</th>
              <th className="text-right">Asked back</th><th className="text-right">On a delivery</th>
              <th className="text-right">Value</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.orderNumber}>
                <td><Link className="link" href={`/sales/returns?order=${order.orderNumber}`}>{order.orderNumber}</Link></td>
                <td>{order.orderDate}</td>
                <td>{order.customerNumber}</td>
                <td>{order.billingNumber ?? '—'}</td>
                <td className="text-right">{quantity(order.requestedQuantity)}</td>
                <td className="text-right">{quantity(order.committedQuantity)}</td>
                <td className="text-right">{money(order.grossValue, order.currency)}</td>
                <td>{order.status}</td>
              </tr>
            ))}
            {orders.length === 0 ? (
              <tr><td colSpan={8} className="text-ink-soft">No returns order stands. Raise one against the invoice the goods were billed on.</td></tr>
            ) : null}
          </tbody>
        </table>
        <RaiseReturnsOrder invoices={invoices} allowed={canRaiseOrder} />
      </section>

      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Returns deliveries — what the warehouse receives against</h2>
          <span className="code text-ink-faint">{deliveries.length} standing</span>
        </div>
        <table className="grid-table mt-3 text-sm">
          <thead>
            <tr>
              <th>Delivery</th><th>Date</th><th>Returns order</th><th>Left on</th>
              <th className="text-right">Quantity</th><th>Material document</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((delivery) => (
              <tr key={delivery.deliveryNumber}>
                <td><Link className="link" href={`/sales/returns?delivery=${delivery.deliveryNumber}`}>{delivery.deliveryNumber}</Link></td>
                <td>{delivery.deliveryDate}</td>
                <td>{delivery.orderNumber ?? '—'}</td>
                <td>{delivery.referenceDeliveryNumber ?? '—'}</td>
                <td className="text-right">{quantity(delivery.quantity)}</td>
                <td>{delivery.materialDocumentNumber ?? '—'}</td>
                <td>{delivery.status}</td>
              </tr>
            ))}
            {deliveries.length === 0 ? (
              <tr><td colSpan={7} className="text-ink-soft">No returns delivery stands. Raise one from a returns order, or from the delivery the goods left on.</td></tr>
            ) : null}
          </tbody>
        </table>
        <RaiseReturnsDelivery allowed={canRaiseDelivery} />
      </section>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold">Receive the goods back</h2>
        <p className="mt-1 text-sm text-ink-soft">
          The 651 puts the goods into returns stock, which is not valuated: the movement posts no accounting
          document. The value arrives when the inspected goods are transferred into valuated stock.
        </p>
        <ReceiveReturns selected={selectedDelivery} allowed={canReceive} />
      </section>

      {selectedOrder ? (
        <section className="panel p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Returns order {selectedOrder.orderNumber}</h2>
            <span className="code text-ink-faint">
              {selectedOrder.documentType} · {selectedOrder.status} · version {selectedOrder.version}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-soft">
            Raised against {selectedOrder.referenceDocumentType ?? '—'} {selectedOrder.referenceDocumentNumber ?? '—'}
            {selectedOrder.headerText ? ` · ${selectedOrder.headerText}` : ''}
          </p>
          <table className="grid-table mt-3 text-sm">
            <thead>
              <tr>
                <th>Item</th><th>Material</th><th>Plant</th>
                <th className="text-right">Quantity</th><th>Unit</th>
                <th className="text-right">Net price</th><th className="text-right">Net amount</th><th>Tax</th>
              </tr>
            </thead>
            <tbody>
              {selectedOrder.lines.map((line) => (
                <tr key={line.lineNumber}>
                  <td>{line.lineNumber}</td>
                  <td>{line.materialNumber}</td>
                  <td>{line.plant}</td>
                  <td className="text-right">{quantity(line.orderQuantity)}</td>
                  <td>{line.quantityUnit}</td>
                  <td className="text-right">{line.netPrice}</td>
                  <td className="text-right">{line.netAmount}</td>
                  <td>{line.taxCode ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {selectedDelivery ? (
        <section className="panel p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Returns delivery {selectedDelivery.deliveryNumber}</h2>
            <span className="code text-ink-faint">
              {selectedDelivery.documentType} · {selectedDelivery.status} · version {selectedDelivery.version}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-soft">
            Goods left on {selectedDelivery.referenceDeliveryNumber ?? '—'}
            {selectedDelivery.materialDocumentNumber ? ` · received as ${selectedDelivery.materialDocumentNumber}` : ' · not received yet'}
          </p>
          <table className="grid-table mt-3 text-sm">
            <thead>
              <tr>
                <th>Item</th><th>Material</th><th>Plant</th>
                <th className="text-right">Coming back</th><th>Unit</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {selectedDelivery.lines.map((line) => (
                <tr key={line.lineNumber}>
                  <td>{line.lineNumber}</td>
                  <td>{line.materialNumber}</td>
                  <td>{line.plant}</td>
                  <td className="text-right">{quantity(line.deliveryQuantity)}</td>
                  <td>{line.quantityUnit}</td>
                  <td>{line.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
