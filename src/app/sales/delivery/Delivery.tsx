'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';

import type { DeliveryView } from '@/modules/sales/delivery';
import {
  cancelDeliveryAction,
  confirmPicksAction,
  createDeliveryAction,
  postGoodsIssueAction,
  type DeliveryActionState,
} from './actions';

const EMPTY: DeliveryActionState = { ok: false };
const LINE_SLOTS = 10;

interface Props {
  documents: Awaited<ReturnType<typeof import('@/modules/sales/delivery').listDeliveries>>;
  openLines: Awaited<ReturnType<typeof import('@/modules/sales/delivery').listDeliverableOrderLines>>;
  selected: DeliveryView | null;
  plants: Array<{ plant: string; name: string }>;
  orderNumber: string;
  canCreate: boolean;
  canPick: boolean;
  canPost: boolean;
}

function quantity(value: string): string {
  return Number(value).toFixed(3);
}

function Notice({ state, label }: { state: DeliveryActionState; label?: string }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      {label ? <p className="text-xs text-ink-faint">{label}</p> : null}
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.deliveryNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/sales/delivery?delivery=${state.deliveryNumber}`}>
            Open delivery {state.deliveryNumber}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** The three acts on a delivery, each behind its own capability, each reporting its own refusal. */
function CreateDelivery({
  openLines, orderNumber, allowed,
}: { openLines: Props['openLines']; orderNumber: string; allowed: boolean }) {
  const [state, action, pending] = useActionState(createDeliveryAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const lines = openLines.slice(0, LINE_SLOTS);
  const orders = [...new Set(openLines.map((line) => line.orderNumber))];
  if (!allowed) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Deliveries are read-only for this session: the create, picking and goods-issue acts each need their own
        capability.
      </p>
    );
  }
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Create delivery">
      <p className="text-sm font-medium">Create a delivery from an order</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-order`}>
          Sales order
          <input
            className="input mt-1" id={`${id}-order`} name="orderNumber" defaultValue={orderNumber || orders[0] || ''}
            placeholder="SO-0000001" autoComplete="off"
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-date`}>
          Delivery date
          <input className="input mt-1" id={`${id}-date`} name="deliveryDate" defaultValue={today} autoComplete="off" />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-movement`}>
          Planned goods issue
          <input
            className="input mt-1" id={`${id}-movement`} name="goodsMovementDate" placeholder="YYYY-MM-DD" autoComplete="off"
          />
        </label>
        <label className="block text-xs text-ink-soft" htmlFor={`${id}-text`}>
          Delivery note
          <input className="input mt-1" id={`${id}-text`} name="headerText" placeholder="Note" autoComplete="off" />
        </label>
      </div>
      <input type="hidden" name="requestKey" value={`DL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
      <div className="space-y-1">
        <div className="grid grid-cols-2 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-6">
          <span>Item</span><span>Material</span><span>Plant</span><span className="text-right">Open</span>
          <span className="text-right">Quantity this time</span><span>Unit</span>
        </div>
        {lines.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No order line is open for delivery. Name an order whose items still have quantity left.
          </p>
        ) : null}
        {lines.map((line, index) => (
          <div key={`${line.orderNumber}-${line.lineNumber}`} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-6">
            <span className="text-sm">{line.orderNumber} / {line.lineNumber}</span>
            <span className="truncate text-sm">{line.materialNumber}</span>
            <span className="text-sm">{line.plant}</span>
            <span className="text-right text-sm">{quantity(line.remainingQuantity)}</span>
            <input
              className="input" name={`line-${index + 1}-quantity`} inputMode="decimal"
              defaultValue={line.remainingQuantity} aria-label={`Delivery quantity for order item ${line.lineNumber}`}
            />
            <span className="text-sm">{line.quantityUnit.trim()}</span>
            <input type="hidden" name={`line-${index + 1}-orderLine`} value={String(line.lineNumber)} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending || !lines.length}>
          {pending ? 'Creating…' : 'Create delivery'}
        </button>
        <span className="text-xs text-ink-faint">
          A smaller quantity than the line has open is a partial delivery; more than it is refused.
        </span>
      </div>
      <Notice state={state} />
    </form>
  );
}

function SelectedDelivery({
  selected, plants, canPick, canPost,
}: { selected: DeliveryView; plants: Props['plants']; canPick: boolean; canPost: boolean }) {
  const [pickState, pickAction, pickPending] = useActionState(confirmPicksAction, EMPTY);
  const [issueState, issueAction, issuePending] = useActionState(postGoodsIssueAction, EMPTY);
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelDeliveryAction, EMPTY);
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const blocked = selected.credit?.status === 'BLOCKED';
  const allPicked = selected.lines.every((line) => Number(line.pickedQuantity) >= Number(line.deliveryQuantity));
  return (
    <section className="panel p-4" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold" id={`${id}-heading`}>Delivery {selected.deliveryNumber}</h2>
        <span className="code text-ink-faint">{selected.status} · version {selected.version}</span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        Order <Link className="link" href={`/sales/orders?order=${selected.orderNumber}`}>{selected.orderNumber}</Link>
        {' · '}customer {selected.customerNumber}
        {' · '}plant {selected.plant}
        {' · '}sales area {selected.salesOrg}/{selected.distributionChannel}/{selected.division}
        {selected.materialDocumentNumber ? (
          <>
            {' · '}material document{' '}
            <Link
              className="link"
              href={`/inventory/material-documents?document=${selected.materialDocumentNumber}&fiscalYear=${selected.materialDocumentYear}`}
            >
              {selected.materialDocumentNumber}
            </Link>
          </>
        ) : null}
      </p>
      {blocked ? (
        <div className="panel panel-danger mt-3 p-3 text-sm" role="status">
          <p className="font-medium">The credit check blocked this delivery: {selected.credit?.reason}.</p>
          <p className="mt-1 text-ink-soft">
            The goods issue is refused until a release stands. Release it at /finance/credit-release, where the
            release records the user, the reason and the amount.
          </p>
        </div>
      ) : null}

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-faint">
            <th className="py-1">Item</th><th>Material</th><th className="text-right">Ordered</th>
            <th className="text-right">Delivered before</th><th className="text-right">This delivery</th>
            <th className="text-right">Still open</th><th className="text-right">Picked</th>
            <th className="text-right">Issued</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {selected.lines.map((line) => (
            <tr key={line.lineNumber} className="border-t border-line align-top">
              <td className="py-1">{line.lineNumber}<span className="text-ink-faint"> / {line.orderLineNumber}</span></td>
              <td>{line.materialNumber}</td>
              <td className="text-right">{quantity(line.orderedQuantity)}</td>
              <td className="text-right">{quantity(line.deliveredBefore)}</td>
              <td className="text-right">{quantity(line.deliveryQuantity)}</td>
              <td className="text-right">{quantity(line.remainingQuantity)}</td>
              <td className="text-right">{quantity(line.pickedQuantity)}</td>
              <td className="text-right">{quantity(line.goodsIssueQuantity)}</td>
              <td>{line.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected.lines.some((line) => line.picks.length) ? (
        <details className="mt-3">
          <summary className="text-sm text-ink-soft">Pick history ({selected.lines.reduce((n, l) => n + l.picks.length, 0)} rows)</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {selected.lines.flatMap((line) => line.picks.map((pick) => (
              <li key={`${line.lineNumber}-${pick.pickNumber}`} className="text-ink-soft">
                Item {line.lineNumber} · pick {pick.pickNumber} · {pick.quantityDelta.startsWith('-') ? '' : '+'}{quantity(pick.quantityDelta)} {line.quantityUnit.trim()}
                {' · '}{pick.storageLocation}{pick.batchNumber ? ` · batch ${pick.batchNumber}` : ''}
                {pick.reason ? ` · ${pick.reason}` : ''} · {pick.createdBy}
              </li>
            )))}
          </ul>
        </details>
      ) : null}

      {canPick && selected.status !== 'GOODS_ISSUED' && selected.status !== 'CANCELLED' ? (
        <form action={pickAction} className="mt-4 space-y-2" aria-label="Confirm picking">
          <input type="hidden" name="deliveryNumber" value={selected.deliveryNumber} />
          <input type="hidden" name="expectedVersion" value={String(selected.version)} />
          <input type="hidden" name="pickRequestKey" value={`PK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
          <p className="text-sm font-medium">Confirm picking</p>
          <div className="grid grid-cols-2 gap-2 text-xs font-medium text-ink-soft sm:grid-cols-6">
            <span>Item</span><span className="text-right">To pick</span><span>Quantity</span>
            <span>Storage location</span><span>Batch</span><span>Reason</span>
          </div>
          {selected.lines.map((line, index) => (
            <div key={line.lineNumber} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-6">
              <span className="text-sm">{line.lineNumber}<span className="text-ink-faint"> · {line.materialNumber}</span></span>
              <span className="text-right text-sm">{quantity(String(Number(line.deliveryQuantity) - Number(line.pickedQuantity)))}</span>
              <input
                className="input" name={`pick-${index + 1}-quantity`} inputMode="decimal"
                defaultValue={line.status === 'GOODS_ISSUED' ? '' : String(Number(line.deliveryQuantity) - Number(line.pickedQuantity))}
                aria-label={`Picked quantity for delivery item ${line.lineNumber}`}
              />
              <input
                className="input" name={`pick-${index + 1}-location`} placeholder="Storage location"
                defaultValue="" autoComplete="off" aria-label={`Storage location for delivery item ${line.lineNumber}`}
              />
              <input
                className="input" name={`pick-${index + 1}-batch`} placeholder="Batch"
                autoComplete="off" aria-label={`Batch for delivery item ${line.lineNumber}`}
              />
              <input
                className="input" name={`pick-${index + 1}-reason`} placeholder="Correction reason"
                autoComplete="off" aria-label={`Reason for delivery item ${line.lineNumber}`}
              />
              <input type="hidden" name={`pick-${index + 1}-line`} value={String(line.lineNumber)} />
            </div>
          ))}
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pickPending}>
              {pickPending ? 'Confirming…' : 'Confirm pick'}
            </button>
            <span className="text-xs text-ink-faint">
              A negative quantity corrects a pick that was wrong, and it has to say why. Plants maintained for
              this tenant: {plants.length ? plants.map((plant) => plant.plant).join(', ') : 'none'}.
            </span>
          </div>
          <Notice state={pickState} label="Picking" />
        </form>
      ) : null}

      {canPost && selected.status !== 'GOODS_ISSUED' && selected.status !== 'CANCELLED' ? (
        <form action={issueAction} className="mt-4 space-y-2" aria-label="Post goods issue">
          <input type="hidden" name="deliveryNumber" value={selected.deliveryNumber} />
          <input type="hidden" name="expectedVersion" value={String(selected.version)} />
          <p className="text-sm font-medium">Post the goods issue</p>
          <p className="text-xs text-ink-soft">
            The movement leaves the plant at the picked quantities, values itself at the material&apos;s own
            price, and posts the journal in the same transaction as this delivery&apos;s status.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="block text-xs text-ink-soft" htmlFor={`${id}-posting`}>
              Posting date
              <input className="input mt-1" id={`${id}-posting`} name="postingDate" defaultValue={today} autoComplete="off" />
            </label>
          </div>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={issuePending || !allPicked}>
            {issuePending ? 'Posting…' : 'Post goods issue'}
          </button>
          {!allPicked ? (
            <p className="text-xs text-ink-soft">
              Every item has to be picked in full first — the movement posts what the store confirmed.
            </p>
          ) : null}
          <Notice state={issueState} label="Goods issue" />
        </form>
      ) : null}

      {canPost || canPick ? (
        <form action={cancelAction} className="mt-4 space-y-2" aria-label="Cancel delivery">
          <input type="hidden" name="deliveryNumber" value={selected.deliveryNumber} />
          <input type="hidden" name="expectedVersion" value={String(selected.version)} />
          <label className="block text-xs text-ink-soft" htmlFor={`${id}-cancel`}>
            Cancel the delivery (only while nothing has gone out)
            <input className="input mt-1" id={`${id}-cancel`} name="cancelReason" placeholder="Reason" autoComplete="off" />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-9" disabled={cancelPending}>
            {cancelPending ? 'Cancelling…' : 'Cancel delivery'}
          </button>
          <Notice state={cancelState} label="Cancellation" />
        </form>
      ) : null}
    </section>
  );
}

export default function Delivery(props: Props) {
  return (
    <div className="space-y-4">
      <CreateDelivery openLines={props.openLines} orderNumber={props.orderNumber} allowed={props.canCreate} />
      <section className="panel p-4" aria-label="Deliveries">
        <p className="text-sm font-medium">Deliveries</p>
        {props.documents.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No delivery stands for this filter yet.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th className="py-1">Delivery</th><th>Order</th><th>Customer</th><th>Plant</th>
                <th>Date</th><th className="text-right">Value</th><th>Material document</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {props.documents.map((row) => (
                <tr key={row.deliveryNumber} className="border-t border-line">
                  <td className="py-1">
                    <Link className="link" href={`/sales/delivery?delivery=${row.deliveryNumber}`}>{row.deliveryNumber}</Link>
                  </td>
                  <td><Link className="link" href={`/sales/orders?order=${row.orderNumber}`}>{row.orderNumber}</Link></td>
                  <td>{row.customerNumber}</td>
                  <td>{row.plant}</td>
                  <td>{row.deliveryDate}</td>
                  <td className="text-right">{Number(row.value).toFixed(2)}</td>
                  <td>{row.materialDocumentNumber ?? '—'}</td>
                  <td>{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {props.selected ? (
        <SelectedDelivery
          selected={props.selected}
          plants={props.plants}
          canPick={props.canPick}
          canPost={props.canPost}
        />
      ) : null}
    </div>
  );
}
