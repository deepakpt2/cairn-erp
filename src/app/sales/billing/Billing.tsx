'use client';

import Link from 'next/link';
import { useActionState, useId, useState } from 'react';

import type { BillingView } from '@/modules/sales/billing';
import type { listBillableDeliveries, listBillings, salesDocumentFlow } from '@/modules/sales/billing';
import {
  billPlanDateAction, cancelBillingAction, cancelDownPaymentAction, createBillingAction,
  rebillDeliveryAction, requestDownPaymentAction, type BillingActionState,
} from './actions';

const EMPTY: BillingActionState = { ok: false };

interface Props {
  billable: Awaited<ReturnType<typeof listBillableDeliveries>>;
  planDates: Awaited<ReturnType<typeof import('@/modules/sales/billing-plan').listBillablePlanDates>>;
  documents: Awaited<ReturnType<typeof listBillings>>;
  selected: BillingView | null;
  flow: Awaited<ReturnType<typeof salesDocumentFlow>>;
  /** The advances of the selected document's order: what was asked, what arrived, what was cleared. */
  advances: Awaited<ReturnType<typeof import('@/modules/sales/down-payment').orderDownPayments>>;
  /** What this document earned against the rebate agreements it fell inside. */
  rebates: Awaited<ReturnType<typeof import('@/modules/sales/rebate').rebateAccrualsForBilling>>;
  /** What was sent from this document, and the state each issue reached. */
  outputs: Awaited<ReturnType<typeof import('@/modules/sales/output').listSalesOutput>>['rows'];
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

/**
 * The dates that have come due: the second half of the billing due list.
 *
 * The first half offers deliveries whose goods have gone out. This one offers shares of items that
 * are never delivered at all, and the two never name the same item — an item with a plan is billed by
 * its dates, and the delivery that carries it is refused by name. The value shown is the share the
 * date bills, of what the order says the item is worth; nothing is priced again here.
 */
function PlanDatesDue({ planDates, allowed }: { planDates: Props['planDates']; allowed: boolean }) {
  const [state, action, pending] = useActionState(billPlanDateAction, EMPTY);
  const [advanceState, advanceAction, advancePending] = useActionState(requestDownPaymentAction, EMPTY);
  const [slot, setSlot] = useState(0);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const chosen = planDates[Math.min(slot, planDates.length - 1)] ?? null;
  // A date says what it is for. One that invoices is billed; one that asks for an advance raises a
  // request instead, and the two are different acts with different consequences for the customer's
  // account, so the button says which one it is about to do.
  const advance = chosen?.billingRule === 'DOWN_PAYMENT';
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Billing a plan date is closed for this session: it needs SALES.BILLING.CREATE.
      </p>
    );
  }
  return (
    <form
      action={advance ? advanceAction : action}
      className="panel space-y-3 p-4"
      aria-label={advance ? 'Ask for the advance a plan date carries' : 'Bill a billing plan date'}
    >
      <p className="text-sm font-medium">
        {advance ? 'Ask for an advance a date carries' : 'Bill a date that has come due'}
      </p>
      {planDates.length === 0 ? (
        <p className="text-sm text-ink-soft">
          No plan date has come due. A date is offered on the day it names and every day after it, and only
          while it stands open.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="block text-xs text-ink-soft" htmlFor={`${id}-date`}>
              Plan date
              <select
                className="input mt-1" id={`${id}-date`}
                value={Math.min(slot, planDates.length - 1)}
                onChange={(event) => setSlot(Number(event.target.value))}
              >
                {planDates.map((row, index) => (
                  <option key={`${row.orderNumber}-${row.orderLineNumber}-${row.dateNumber}`} value={index}>
                    {row.orderNumber} / {row.orderLineNumber} date {row.dateNumber} · {row.billingDate}
                    {' · '}{row.percentage}% · {row.value} {row.currency.trim()}
                    {row.billingRule === 'DOWN_PAYMENT' ? ' · advance' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-ink-soft" htmlFor={`${id}-billing-date`}>
              Billing date
              <input
                className="input mt-1" id={`${id}-billing-date`} name="billingDate"
                defaultValue={today} autoComplete="off"
              />
            </label>
          </div>
          <input type="hidden" name="orderNumber" value={chosen?.orderNumber ?? ''} />
          <input type="hidden" name="orderLineNumber" value={chosen?.orderLineNumber ?? ''} />
          <input type="hidden" name="dateNumber" value={chosen?.dateNumber ?? ''} />
          <input type="hidden" name="requestKey" value={`BL-PD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
          {advance ? (
            <label className="block text-xs text-ink-soft" htmlFor={`${id}-due`}>
              Day the advance is expected
              <input
                className="input mt-1" id={`${id}-due`} name="dueDate" defaultValue={chosen?.billingDate ?? today}
                autoComplete="off"
              />
            </label>
          ) : null}
          {chosen ? (
            <p className="text-xs text-ink-faint">
              {chosen.materialNumber} · {chosen.quantity} {chosen.quantityUnit} · customer {chosen.customerNumber}
              {' · '}value {chosen.value} {chosen.currency.trim()}
            </p>
          ) : null}
          <button
            type="submit" className="btn btn-primary min-h-11 sm:min-h-9"
            disabled={(advance ? advancePending : pending) || !chosen}
          >
            {advance
              ? (advancePending ? 'Asking…' : 'Ask for the advance')
              : (pending ? 'Billing…' : 'Create and post')}
          </button>
          {advance ? (
            <p className="text-xs text-ink-faint">
              Nothing is posted by this: the request stands behind a noted item in accounting, and the money
              arrives through the receipt. The advance is settled when the invoice that earns it is raised.
            </p>
          ) : null}
        </>
      )}
      <Notice state={advance ? advanceState : state} label={advance ? 'Down payment request' : 'Billing plan date'} />
    </form>
  );
}

function SelectedBilling({
  selected, flow, advances, rebates, outputs, canCancel, canCreate,
}: {
  selected: BillingView; flow: Props['flow']; advances: Props['advances'];
  rebates: Props['rebates']; outputs: Props['outputs'];
  canCancel: boolean; canCreate: boolean;
}) {
  const [state, action, pending] = useActionState(cancelBillingAction, EMPTY);
  const [rebillState, rebillAction, rebillPending] = useActionState(rebillDeliveryAction, EMPTY);
  const [withdrawState, withdrawAction, withdrawPending] = useActionState(cancelDownPaymentAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const held = selected.credit?.status === 'BLOCKED';
  const cancelled = selected.status === 'CANCELLED';
  // A request asks for money and posts nothing. An invoice bills and, where an advance stood against
  // its order, consumes it: what is still to pay is the billed value less the advance cleared.
  const isRequest = selected.documentType === 'DP';
  const cleared = Number(selected.downPaymentClearedAmount);
  return (
    <section className="panel p-4" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold" id={`${id}-heading`}>Billing document {selected.billingNumber}</h2>
        <span className="code text-ink-faint">{selected.status} · version {selected.version}</span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        {/* A document raised against a plan date names no delivery: nothing was shipped, and a link to a
            delivery that never stood is a lie the screen need not tell. */}
        {selected.deliveryNumber ? (
          <>Delivery <Link className="link" href={`/sales/delivery?delivery=${selected.deliveryNumber}`}>{selected.deliveryNumber}</Link>{' · '}</>
        ) : (
          <>Billing plan date{' · '}</>
        )}
        order <Link className="link" href={`/sales/orders?order=${selected.orderNumber}`}>{selected.orderNumber}</Link>
        {' · '}customer {selected.customerNumber}
        {' · '}company {selected.companyCode}
        {selected.customerInvoiceNumber
          ? <> · receivable <Link className="link" href={`/finance/customer-invoice?invoice=${selected.customerInvoiceNumber}`}>{selected.customerInvoiceNumber}</Link></>
          : null}
      </p>
      <p className="mt-2 text-sm">
        <span className="text-ink-soft">{isRequest ? 'Asked for · net' : 'Net'}</span> {money(selected.netValue)}{' · '}
        <span className="text-ink-soft">Tax</span> {money(selected.taxValue)}{' · '}
        <span className="text-ink-soft">{isRequest ? 'Total' : 'Gross'}</span> {money(selected.grossValue)} {selected.currency.trim()}
        {cleared > 0 ? (
          <>
            {' · '}<span className="text-ink-soft">advance cleared</span> {money(selected.downPaymentClearedAmount)}
            {' · '}<span className="text-ink-soft">still to pay</span>{' '}
            {money(String(Number(selected.grossValue) - cleared))}
          </>
        ) : null}
      </p>
      {isRequest ? (
        <p className="mt-1 text-sm text-ink-soft">
          This is a request for an advance and not an invoice: nothing was posted, no receivable stands and no
          revenue was recognised. The money arrives through the receipt, and the invoice that earns it clears
          the advance — what is then still to pay is the billed value less it.
        </p>
      ) : null}
      {advances.length ? (
        <details className="mt-3" open>
          <summary className="text-sm text-ink-soft">Advances of order {selected.orderNumber}</summary>
          <table className="grid-table mt-2 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Request</th><th>Date</th><th>Accounting request</th>
                <th className="text-right">Asked</th><th className="text-right">Received</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {advances.map((row) => (
                <tr key={row.billingNumber}>
                  <td>
                    <Link className="link" href={`/sales/billing?billing=${row.billingNumber}`}>{row.billingNumber}</Link>
                  </td>
                  <td>{row.dateNumber}</td>
                  <td>{row.requestNumber}</td>
                  <td className="text-right">{money(row.amount)} {row.currency.trim()}</td>
                  <td className="text-right">{money(row.received)} {row.currency.trim()}</td>
                  <td>{row.status.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-faint">
            An advance is asked for before anything is delivered, arrives through the receipt, and is cleared
            against the invoice that earns it — so what the customer then pays is the billed value less it.
          </p>
        </details>
      ) : null}

      {rebates.length ? (
        <details className="mt-3" open>
          <summary className="text-sm text-ink-soft">
            Rebate this document accrued · {money(String(rebates.reduce(
              (sum, row) => sum + Number(row.rebateAmount), 0,
            )))} {rebates[0].currency.trim()}
          </summary>
          <table className="grid-table mt-2 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Agreement</th><th>Item</th><th>Material</th>
                <th className="text-right">Basis</th><th className="text-right">Provided for</th>
                <th className="text-right">Paid out</th><th>Status</th><th>Settled by</th>
              </tr>
            </thead>
            <tbody>
              {rebates.map((row) => (
                <tr key={`${row.agreementNumber}-${row.lineNumber}`}>
                  <td>
                    <Link className="link" href={`/sales/rebate-agreements?agreement=${row.agreementNumber}`}>
                      {row.agreementNumber}
                    </Link>
                  </td>
                  <td>{row.lineNumber}</td>
                  <td>{row.materialNumber}</td>
                  <td className="text-right">{money(row.basisAmount)}</td>
                  <td className="text-right">{money(row.rebateAmount)}</td>
                  <td className="text-right">{money(row.settledAmount)}</td>
                  <td>{row.status.toLowerCase()}</td>
                  <td>
                    {row.settlementNumber
                      ? <Link className="link" href={`/sales/billing?billing=${row.settlementNumber}`}>{row.settlementNumber}</Link>
                      : <span className="text-ink-faint">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-faint">
            The rebate is a provision: the customer was charged the whole of this invoice, and what the sale
            earned against its agreements is given back on a credit memo raised by the settlement. A line that
            stands reversed is one whose document was cancelled — the provision went with it.
          </p>
        </details>
      ) : null}

      {outputs.length ? (
        <details className="mt-3" open>
          <summary className="text-sm text-ink-soft">
            Sent to the customer · {outputs.length === 1
              ? `one output, ${outputs[0].status.toLowerCase()}`
              : `${outputs.length} issues, ${outputs.filter((row) => row.status === 'PROCESSED').length} processed`}
          </summary>
          <table className="grid-table mt-2 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Output</th><th>Medium</th><th>Dispatch</th><th>Issue</th>
                <th>Status</th><th className="text-right">Sends</th><th>Recipient</th><th>Last processed</th>
              </tr>
            </thead>
            <tbody>
              {outputs.map((row) => (
                <tr key={`${row.outputType}/${row.transmissionMedium}/${row.issueNumber}`}>
                  <td>{row.outputType} <span className="text-ink-soft">{row.outputTypeDescription}</span></td>
                  <td>{row.transmissionMedium}</td>
                  <td>{row.dispatchTime.toLowerCase()}</td>
                  <td>
                    {row.issueNumber}
                    {row.reissueReason ? <div className="text-xs text-ink-faint">{row.reissueReason}</div> : null}
                  </td>
                  <td>
                    {row.status.toLowerCase()}
                    {row.errorText ? <div className="text-xs text-red-700">{row.errorText}</div> : null}
                  </td>
                  <td className="text-right">{row.sendCount}</td>
                  <td>{row.recipient ?? '—'}</td>
                  <td className="code text-xs">{row.lastProcessedAt ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-faint">
            Determined from the output condition records that stood for this document’s sales area, type and
            customer on the day it bears — no record, no output. Each issue keeps the document as it was
            rendered and sent, and a copy is issued beside the first rather than over it.
            {' '}
            <Link className="link" href={`/sales/output?documentCategory=BILLING&documentNumber=${selected.billingNumber}`}>
              Open the queue
            </Link>
          </p>
        </details>
      ) : null}

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

      <table className="grid-table mt-3 text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-faint">
            <th>Item</th><th>Delivery item</th><th>Order item</th><th>Material</th>
            <th className="text-right">Quantity</th><th className="text-right">Price</th>
            <th className="text-right">Net</th><th>Tax</th><th className="text-right">Tax amount</th><th>Priced from</th>
          </tr>
        </thead>
        <tbody>
          {selected.lines.map((line) => (
            <tr key={line.lineNumber}>
              <td>{line.lineNumber}</td>
              <td>{line.deliveryLineNumber}</td>
              <td>{line.orderLineNumber}</td>
              <td>{line.materialNumber}</td>
              <td className="text-right num">{Number(line.billingQuantity).toFixed(3)}</td>
              <td className="text-right num">{Number(line.netPrice).toFixed(4)} / {line.priceUnit}</td>
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
          <table className="grid-table mt-2 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Order</th><th>Delivery</th><th>Material document</th>
                <th>Billing</th><th>What it is</th><th>Stands</th><th>Cancels</th>
                <th>Invoice</th><th>Delivery status</th><th>Issue stands</th>
              </tr>
            </thead>
            <tbody>
              {flow.map((row) => (
                <tr key={row.deliveryNumber ?? row.orderNumber}>
                  <td>{row.orderNumber}</td>
                  <td>{row.deliveryNumber ?? '—'}</td>
                  <td>{row.materialDocumentNumber ?? '—'}</td>
                  <td>{row.billingNumber ?? '—'}</td>
                  <td>{row.billingDocumentType ?? '—'}</td>
                  <td>{row.billingStatus ?? '—'}</td>
                  <td>{row.billingCancels ?? '—'}</td>
                  <td>{row.customerInvoiceNumber ?? '—'}</td>
                  <td>{row.status}</td>
                  <td>{row.issuedStands ? 'yes' : 'reversed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}

      {cancelled && selected.deliveryNumber ? (
        <div className="panel mt-4 space-y-3 p-4" aria-label="Bill this delivery again">
          <p className="text-sm font-medium">This document is cancelled</p>
          <p className="text-sm text-ink-soft">
            The receivable has left the customer account, and delivery{' '}
            <Link className="link" href={`/sales/delivery?delivery=${selected.deliveryNumber}`}>{selected.deliveryNumber}</Link>{' '}
            is billable again: a cancelled document stops occupying the delivery&apos;s slot, so the corrected
            value can be billed without ever allowing two live documents at once. The cancelled row stays
            behind so the chain remembers what was sent.
          </p>
          {canCreate ? (
            <form action={rebillAction} className="space-y-2">
              <input type="hidden" name="deliveryNumber" value={selected.deliveryNumber} />
              <input type="hidden" name="replacesBillingNumber" value={selected.billingNumber} />
              <input type="hidden" name="requestKey" value={`BL-RE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <label className="block text-xs text-ink-soft" htmlFor={`${id}-rebill-date`}>
                  Billing date
                  <input className="input mt-1" id={`${id}-rebill-date`} name="billingDate" defaultValue={today} autoComplete="off" />
                </label>
              </div>
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={rebillPending}>
                {rebillPending ? 'Billing…' : 'Bill this delivery again'}
              </button>
              <Notice state={rebillState} label="Corrected billing" />
            </form>
          ) : (
            <p className="text-sm text-ink-soft">
              Billing it again is closed for this session: it needs SALES.BILLING.CREATE.
            </p>
          )}
        </div>
      ) : null}

      {isRequest && canCancel && selected.status !== 'CANCELLED' ? (
        <form action={withdrawAction} className="mt-4 space-y-2" aria-label="Withdraw this down payment request">
          <input type="hidden" name="billingNumber" value={selected.billingNumber} />
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-withdraw-reason`}>
            Reason
            <input
              className="input mt-1" id={`${id}-withdraw-reason`} name="cancelReason"
              placeholder="The advance is no longer being asked for" autoComplete="off"
            />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-9" disabled={withdrawPending}>
            {withdrawPending ? 'Withdrawing…' : 'Withdraw the request'}
          </button>
          <p className="text-xs text-ink-faint">
            Withdrawing is refused once money has arrived: a paid advance is settled by clearing it against the
            invoice that earns it. An unpaid one stops answering, and the date stands open again.
          </p>
          <Notice state={withdrawState} label="Withdrawal" />
        </form>
      ) : null}

      {!isRequest && canCancel && selected.status !== 'CANCELLED' ? (
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
      <section className="panel p-4" aria-label="Billing plan dates due">
        <p className="text-sm font-medium">Billing plan dates due</p>
        {props.planDates.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No plan date stands due. An item that carries a billing plan is billed by its dates and not by a
            delivery, so it appears here rather than above.
          </p>
        ) : (
          <table className="grid-table mt-3 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Order</th><th>Item</th><th>Date</th><th>Day it falls on</th><th>Material</th>
                <th className="text-right">Share</th><th className="text-right">Quantity</th>
                <th className="text-right">Value</th><th>Customer</th><th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {props.planDates.map((row) => (
                <tr key={`${row.orderNumber}-${row.orderLineNumber}-${row.dateNumber}`}>
                  <td>
                    <Link className="link" href={`/sales/orders?order=${row.orderNumber}`}>{row.orderNumber}</Link>
                  </td>
                  <td>
                    <Link className="link" href={`/sales/billing-plans?order=${row.orderNumber}&item=${row.orderLineNumber}`}>
                      {row.orderLineNumber}
                    </Link>
                  </td>
                  <td>{row.dateNumber}</td>
                  <td>{row.billingDate}</td>
                  <td>{row.materialNumber}</td>
                  <td className="text-right">{row.percentage}%</td>
                  <td className="text-right">{row.quantity} {row.quantityUnit}</td>
                  <td className="text-right">{row.value} {row.currency.trim()}</td>
                  <td>{row.customerNumber}</td>
                  <td>{row.billingRule === 'DOWN_PAYMENT' ? 'asks in advance' : 'invoices'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PlanDatesDue planDates={props.planDates} allowed={props.canCreate} />
      </section>
      <section className="panel p-4" aria-label="Billing documents">
        <p className="text-sm font-medium">Billing documents</p>
        {props.documents.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No billing document stands for this filter yet.</p>
        ) : (
          <table className="grid-table mt-3 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Billing</th><th>Delivery</th><th>Order</th><th>Customer</th>
                <th>Date</th><th className="text-right">Gross</th><th>Invoice</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {props.documents.map((row) => (
                <tr key={row.billingNumber}>
                  <td>
                    <Link className="link" href={`/sales/billing?billing=${row.billingNumber}`}>{row.billingNumber}</Link>
                  </td>
                  <td>
                    {row.deliveryNumber
                      ? <Link className="link" href={`/sales/delivery?delivery=${row.deliveryNumber}`}>{row.deliveryNumber}</Link>
                      : <span className="text-ink-faint">plan date</span>}
                  </td>
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
          advances={props.advances}
          rebates={props.rebates}
          outputs={props.outputs}
          canCancel={props.canCancel}
          canCreate={props.canCreate}
        />
      ) : null}
    </div>
  );
}
