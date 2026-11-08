'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';

import type { SalesOrderView } from '@/modules/sales/sales-order';
import {
  createCreditMemoAction,
  createCreditMemoRequestAction,
  postCreditMemoAction,
  releaseBillingBlockAction,
  type CreditRequestActionState,
} from './actions';

const EMPTY: CreditRequestActionState = { ok: false };
const LINE_SLOTS = 10;

interface Props {
  requests: Awaited<ReturnType<typeof import('@/modules/sales/credit-memo').listCreditMemoRequests>>;
  invoices: Awaited<ReturnType<typeof import('@/modules/sales/billing').listBillings>>;
  selected: SalesOrderView | null;
  canRaiseRequest: boolean;
  canRelease: boolean;
  canCredit: boolean;
}

function quantity(value: string): string {
  return Number(value).toFixed(3);
}

function money(value: string, currency: string): string {
  return `${Number(value).toFixed(2)} ${currency.trim()}`;
}

function Notice({ state, label }: { state: CreditRequestActionState; label?: string }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      {label ? <p className="text-xs text-ink-faint">{label}</p> : null}
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.orderNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/sales/credit-memo-request?request=${state.orderNumber}`}>
            Open request {state.orderNumber}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The complaint: which invoiced lines the customer disputes, and why it is held.
 *
 * What is raised is held. The block reason is asked for here even though the service would supply a
 * default, because a block that says nothing is a block nobody can review — and the release is a
 * decision somebody else has to be able to see the grounds for.
 */
function RaiseRequest({ invoices, allowed }: { invoices: Props['invoices']; allowed: boolean }) {
  const [state, action, pending] = useActionState(createCreditMemoRequestAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const posted = invoices.filter((invoice) => invoice.status === 'POSTED');
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Credit memo requests are read-only for this session: raising one needs SALES.CREDIT.REQUEST.CREATE.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Raise a credit memo request">
      <p className="text-sm font-medium">Raise a credit memo request against an invoice</p>
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
          Request date
          <input className="input mt-1" id={`${id}-date`} name="orderDate" defaultValue={today} autoComplete="off" />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-reason`}>
          Why it is held
          <input
            className="input mt-1" id={`${id}-reason`} name="blockReason"
            placeholder="Awaiting the complaint desk" autoComplete="off"
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-text`}>
          Note
          <input className="input mt-1" id={`${id}-text`} name="headerText" placeholder="Short shipment" autoComplete="off" />
        </label>
      </div>
      <input type="hidden" name="requestKey" value={`CRQ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <div className="space-y-1">
        <div className="grid grid-cols-3 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-4">
          <span>Invoice line</span><span className="text-right">Quantity in dispute</span>
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
        {pending ? 'Raising…' : 'Raise the request'}
      </button>
      <Notice state={state} label="Credit memo request" />
    </form>
  );
}

/**
 * The release: the act that agrees to the complaint.
 *
 * It is the control, which is why it is not the same capability as raising the request and why the
 * version the screen read travels with the form. Who released it goes into the change history.
 */
function ReleaseBlock({ selected, allowed }: { selected: SalesOrderView | null; allowed: boolean }) {
  const [state, action, pending] = useActionState(releaseBillingBlockAction, EMPTY);
  const id = useId();
  const held = Boolean(selected?.billingBlock);
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Releasing is closed for this session: it needs SALES.CREDIT.RELEASE, which is held apart from raising
        the request on purpose.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Release a credit memo request">
      <p className="text-sm font-medium">Release the block</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-request`}>
          Credit memo request
          <input
            className="input mt-1" id={`${id}-request`} name="orderNumber"
            defaultValue={selected?.orderNumber ?? ''} placeholder="CR-0000001" autoComplete="off"
          />
        </label>
      </div>
      <input type="hidden" name="expectedVersion" value={selected?.version ?? 0} />
      {selected ? (
        <p className="text-xs text-ink-faint">
          {held
            ? `${selected.orderNumber} stands blocked for billing: ${selected.billingBlock}.`
            : `${selected.orderNumber} stands released — the block has already been lifted.`}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
        {pending ? 'Releasing…' : 'Release the block'}
      </button>
      <Notice state={state} label="Release" />
    </form>
  );
}

/**
 * The credit: what the customer is actually given.
 *
 * It is raised from the request, which bounds it line by line, and priced from the invoiced line — so
 * a price renegotiated since the invoice is no part of what is owed back. It stands open until it is
 * posted, and the two are separate here for the same reason they are on the billing screen: raising a
 * document is not the same act as moving the money.
 */
function Credit({
  selected, allowed,
}: { selected: SalesOrderView | null; allowed: boolean }) {
  const [creditState, creditAction, creditPending] = useActionState(createCreditMemoAction, EMPTY);
  const [postState, postAction, postPending] = useActionState(postCreditMemoAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Crediting is closed for this session: it needs SALES.CREDIT.MEMO.POST.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <form action={creditAction} className="panel space-y-3 p-4" aria-label="Raise a credit memo">
        <p className="text-sm font-medium">Raise the credit memo from a released request</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-request`}>
            Credit memo request
            <input
              className="input mt-1" id={`${id}-request`} name="creditMemoRequestNumber"
              defaultValue={selected?.orderNumber ?? ''} placeholder="CR-0000001" autoComplete="off"
            />
          </label>
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-invoice`}>
            Invoice being credited
            <input
              className="input mt-1" id={`${id}-invoice`} name="billingNumber"
              defaultValue={selected?.referenceDocumentNumber ?? ''} placeholder="INV-0000001" autoComplete="off"
            />
          </label>
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-date`}>
            Billing date
            <input className="input mt-1" id={`${id}-date`} name="billingDate" defaultValue={today} autoComplete="off" />
          </label>
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-text`}>
            Note
            <input className="input mt-1" id={`${id}-text`} name="headerText" placeholder="Credit note" autoComplete="off" />
          </label>
        </div>
        <input type="hidden" name="requestKey" value={`CM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
        <div className="space-y-1">
          <div className="grid grid-cols-3 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-4">
            <span>Invoice line</span><span className="text-right">Quantity credited</span>
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
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={creditPending}>
          {creditPending ? 'Raising…' : 'Raise the credit memo'}
        </button>
        <Notice state={creditState} label="Credit memo" />
      </form>

      <form action={postAction} className="panel space-y-3 p-4" aria-label="Post a credit memo">
        <p className="text-sm font-medium">Post a raised credit memo</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-memo`}>
            Credit memo
            <input
              className="input mt-1" id={`${id}-memo`} name="billingNumber"
              defaultValue={creditState.billingNumber ?? ''} placeholder="CM-0000001" autoComplete="off"
            />
          </label>
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-posting`}>
            Posting date
            <input className="input mt-1" id={`${id}-posting`} name="postingDate" defaultValue={today} autoComplete="off" />
          </label>
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-version`}>
            Version it stands at
            <input
              className="input mt-1" id={`${id}-version`} name="expectedVersion"
              defaultValue={creditState.version ?? 1} autoComplete="off"
            />
          </label>
        </div>
        <input type="hidden" name="requestKey" value={`CM-POST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={postPending}>
          {postPending ? 'Posting…' : 'Post the credit memo'}
        </button>
        <Notice state={postState} label="Posting" />
      </form>
    </div>
  );
}

export default function CreditMemoRequest({
  requests, invoices, selected, canRaiseRequest, canRelease, canCredit,
}: Props) {
  return (
    <div className="space-y-4">
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Credit memo requests — the complaint</h2>
          <span className="code text-ink-faint">{requests.length} standing</span>
        </div>
        <table className="grid-table mt-3 text-sm">
          <thead>
            <tr>
              <th>Request</th><th>Date</th><th>Customer</th><th>Invoice</th>
              <th className="text-right">In dispute</th><th className="text-right">Credited</th>
              <th className="text-right">Value</th><th>Status</th><th>Held for</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.orderNumber}>
                <td>
                  <Link className="link" href={`/sales/credit-memo-request?request=${request.orderNumber}`}>
                    {request.orderNumber}
                  </Link>
                </td>
                <td>{request.orderDate}</td>
                <td>{request.customerNumber}</td>
                <td>{request.billingNumber ?? '—'}</td>
                <td className="text-right">{quantity(request.requestedQuantity)}</td>
                <td className="text-right">{quantity(request.creditedQuantity)}</td>
                <td className="text-right">{money(request.grossValue, request.currency)}</td>
                <td>{request.status}</td>
                <td>{request.billingBlock ?? <span className="text-ink-faint">released</span>}</td>
              </tr>
            ))}
            {requests.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-ink-soft">
                  No credit memo request stands. Raise one against the invoice the customer is disputing.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="mt-2 text-sm text-ink-soft">
          A request is raised held, and stays held until somebody releases it. Nothing can be credited from a
          request that still stands blocked — that is the control, not a formality.
        </p>
        <RaiseRequest invoices={invoices} allowed={canRaiseRequest} />
      </section>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold">Release, then credit</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Releasing the block is the act that agrees to give the money away. That is why releasing is a separate capability from raising the complaint: whoever may ask for the money is not thereby the person who may agree to giving it. The credit is then bounded by the request, line by line, and priced from the line the goods were invoiced at.
        </p>
        <ReleaseBlock selected={selected} allowed={canRelease} />
        <Credit selected={selected} allowed={canCredit} />
      </section>

      {selected ? (
        <section className="panel p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">Credit memo request {selected.orderNumber}</h2>
            <span className="code text-ink-faint">
              {selected.documentType} · {selected.status} · version {selected.version}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-soft">
            {selected.billingBlock
              ? `Held for billing: ${selected.billingBlock}. Nothing can be credited from it until the block is released.`
              : 'Released: the block has been lifted, and a credit may be raised from it.'}
            {selected.headerText ? ` · ${selected.headerText}` : ''}
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
              {selected.lines.map((line) => (
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
    </div>
  );
}
