'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';

import type { BillingView } from '@/modules/sales/billing';
import type { listBillableDeliveries, listBillings, salesDocumentFlow } from '@/modules/sales/billing';
import { cancelBillingAction, createBillingAction, type BillingActionState } from './actions';

const EMPTY: BillingActionState = { ok: false };

interface Props {
  billable: Awaited<ReturnType<typeof listBillableDeliveries>>;
  documents: Awaited<ReturnType<typeof listBillings>>;
  selected: BillingView | null;
  flow: Awaited<ReturnType<typeof salesDocumentFlow>>;
  deliveryNumber: string;
  canCreate: boolean;
  canCancel: boolean;
}

function money(value: string): string {
  return Number(value).toFixed(2);
}

function Notice({ state, label }: { state: BillingActionState; label?: string }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      {label ? <p className="text-xs text-ink-faint">{label}</p> : null}
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.billingNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/sales/billing?billing=${state.billingNumber}`}>
            Open billing document {state.billingNumber}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function CreateBilling({
  billable, deliveryNumber, allowed,
}: { billable: Props['billable']; deliveryNumber: string; allowed: boolean }) {
  const [state, action, pending] = useActionState(createBillingAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Billing is read-only for this session: posting and cancelling a receivable each need their own capability.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Create billing document">
      <p className="text-sm font-medium">Bill a goods-issued delivery</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-delivery`}>
          Delivery
          <input
            className="input mt-1" id={`${id}-delivery`} name="deliveryNumber"
            defaultValue={deliveryNumber || billable[0]?.deliveryNumber || ''}
            placeholder="DL-0000001" autoComplete="off"
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-date`}>
          Billing date
          <input className="input mt-1" id={`${id}-date`} name="billingDate" defaultValue={today} autoComplete="off" />
        </label>
      </div>
      <input type="hidden" name="requestKey" value={`BL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
          {pending ? 'Billing…' : 'Create and post'}
        </button>
        <span className="text-xs text-ink-faint">
          {billable.length === 0
            ? 'Nothing is goods-issued and unbilled right now.'
            : billable.length === 1
              ? '1 delivery is issued and not yet billed.'
              : `${billable.length} deliveries are issued and not yet billed.`}
        </span>
      </div>
      <Notice state={state} />
    </form>
  );
}

function SelectedBilling({
  selected, flow, canCancel,
}: { selected: BillingView; flow: Props['flow']; canCancel: boolean }) {
  const [state, action, pending] = useActionState(cancelBillingAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const held = selected.credit?.status === 'BLOCKED';
  return (
    <section className="panel p-4" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold" id={`${id}-heading`}>Billing document {selected.billingNumber}</h2>
        <span className="code text-ink-faint">{selected.status} · version {selected.version}</span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        Delivery <Link className="link" href={`/sales/delivery?delivery=${selected.deliveryNumber}`}>{selected.deliveryNumber}</Link>
        {' · '}order <Link className="link" href={`/sales/orders?order=${selected.orderNumber}`}>{selected.orderNumber}</Link>
        {' · '}customer {selected.customerNumber}
        {' · '}company {selected.companyCode}
        {selected.customerInvoiceNumber
          ? <> · receivable <Link className="link" href={`/finance/customer-invoice?invoice=${selected.customerInvoiceNumber}`}>{selected.customerInvoiceNumber}</Link></>
          : null}
      </p>
      <p className="mt-2 text-sm">
        <span className="text-ink-soft">Net</span> {money(selected.netValue)}{' · '}
        <span className="text-ink-soft">Tax</span> {money(selected.taxValue)}{' · '}
        <span className="text-ink-soft">Gross</span> {money(selected.grossValue)} {selected.currency.trim()}
      </p>
      {held ? (
        <div className="panel panel-danger mt-3 p-3 text-sm" role="status">
          <p className="font-medium">
            The document stands, but the credit block on its delivery holds the invoice: {selected.credit?.blockReason}.
          </p>
          <p className="mt-1 text-ink-soft">
            Release the blocked document at /finance/credit-release; billing it again from here then posts this same
            document rather than a second one.
          </p>
        </div>
      ) : null}

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-faint">
            <th className="py-1">Item</th><th>Delivery item</th><th>Order item</th><th>Material</th>
            <th className="text-right">Quantity</th><th className="text-right">Price</th>
            <th className="text-right">Net</th><th>Tax</th><th className="text-right">Tax amount</th><th>Priced from</th>
          </tr>
        </thead>
        <tbody>
          {selected.lines.map((line) => (
            <tr key={line.lineNumber} className="border-t border-line">
              <td className="py-1">{line.lineNumber}</td>
              <td>{line.deliveryLineNumber}</td>
              <td>{line.orderLineNumber}</td>
              <td>{line.materialNumber}</td>
              <td className="text-right">{Number(line.billingQuantity).toFixed(3)}</td>
              <td className="text-right">{Number(line.netPrice).toFixed(4)} / {line.priceUnit}</td>
              <td className="text-right">{money(line.netAmount)}</td>
              <td>{line.taxCode ?? '—'}</td>
              <td className="text-right">{money(line.taxAmount)}</td>
              <td>{line.conditionNumber}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {flow.length ? (
        <details className="mt-3" open>
          <summary className="text-sm text-ink-soft">Document flow</summary>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="py-1">Order</th><th>Delivery</th><th>Material document</th>
                <th>Billing</th><th>Invoice</th><th>Delivery status</th><th>Issue stands</th>
              </tr>
            </thead>
            <tbody>
              {flow.map((row) => (
                <tr key={row.deliveryNumber ?? row.orderNumber} className="border-t border-line">
                  <td className="py-1">{row.orderNumber}</td>
                  <td>{row.deliveryNumber ?? '—'}</td>
                  <td>{row.materialDocumentNumber ?? '—'}</td>
                  <td>{row.billingNumber ?? '—'}</td>
                  <td>{row.customerInvoiceNumber ?? '—'}</td>
                  <td>{row.status}</td>
                  <td>{row.issuedStands ? 'yes' : 'reversed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}

      {canCancel && selected.status !== 'CANCELLED' ? (
        <form action={action} className="mt-4 space-y-2" aria-label="Cancel billing document">
          <input type="hidden" name="billingNumber" value={selected.billingNumber} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="block text-xs text-ink-soft" htmlFor={`${id}-cancellation-date`}>
              Cancellation posting date
              <input className="input mt-1" id={`${id}-cancellation-date`} name="cancellationDate" defaultValue={today} autoComplete="off" />
            </label>
            <label className="block text-xs text-ink-soft" htmlFor={`${id}-reason`}>
              Reason
              <input className="input mt-1" id={`${id}-reason`} name="cancelReason" placeholder="Reason" autoComplete="off" />
            </label>
          </div>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-9" disabled={pending}>
            {pending ? 'Cancelling…' : 'Cancel billing document'}
          </button>
          <p className="text-xs text-ink-faint">
            The receivable leaves the customer account through the invoice&apos;s own cancellation, which mirrors
            the posted journal. The billing row stays behind so the chain remembers it.
          </p>
          <Notice state={state} label="Cancellation" />
        </form>
      ) : null}
    </section>
  );
}

export default function Billing(props: Props) {
  return (
    <div className="space-y-4">
      <CreateBilling billable={props.billable} deliveryNumber={props.deliveryNumber} allowed={props.canCreate} />
      <section className="panel p-4" aria-label="Billing documents">
        <p className="text-sm font-medium">Billing documents</p>
        {props.documents.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No billing document stands for this filter yet.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="py-1">Billing</th><th>Delivery</th><th>Order</th><th>Customer</th>
                <th>Date</th><th className="text-right">Gross</th><th>Invoice</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {props.documents.map((row) => (
                <tr key={row.billingNumber} className="border-t border-line">
                  <td className="py-1">
                    <Link className="link" href={`/sales/billing?billing=${row.billingNumber}`}>{row.billingNumber}</Link>
                  </td>
                  <td><Link className="link" href={`/sales/delivery?delivery=${row.deliveryNumber}`}>{row.deliveryNumber}</Link></td>
                  <td><Link className="link" href={`/sales/orders?order=${row.orderNumber}`}>{row.orderNumber}</Link></td>
                  <td>{row.customerNumber}</td>
                  <td>{row.billingDate}</td>
                  <td className="text-right">{money(row.grossValue)}</td>
                  <td>{row.customerInvoiceNumber ?? '—'}</td>
                  <td>{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {props.selected ? (
        <SelectedBilling
          selected={props.selected}
          flow={props.flow}
          canCancel={props.canCancel}
        />
      ) : null}
    </div>
  );
}
