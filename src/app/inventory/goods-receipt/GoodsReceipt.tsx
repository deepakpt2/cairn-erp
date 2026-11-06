'use client';

import { useActionState, useState } from 'react';

import type {
  MaterialDocumentView, ReceiptOrderView,
} from '@/modules/inventory/goods-receipt';
import {
  postGoodsReceiptAction, reverseGoodsReceiptAction,
  type GoodsReceiptActionState,
} from './actions';

const INITIAL: GoodsReceiptActionState = { ok: false, message: '' };

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function GoodsReceipt({ order, document, canPost, today }: {
  order: ReceiptOrderView | null;
  document: MaterialDocumentView | null;
  canPost: boolean;
  today: string;
}) {
  const [postState, postAction, posting] = useActionState(postGoodsReceiptAction, INITIAL);
  const [reverseState, reverseAction, reversing] = useActionState(reverseGoodsReceiptAction, INITIAL);
  const [postKey] = useState(newRequestKey);
  const [reverseKey] = useState(newRequestKey);

  return (
    <>
      <section aria-labelledby="gr-operation" className="border border-line bg-surface p-4">
        <h2 id="gr-operation" className="text-sm font-semibold">Operation and reference</h2>
        <form method="get" action="/inventory/goods-receipt" className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Business action</span>
            <select name="action" className="input w-full" defaultValue={document ? 'REVERSAL' : 'GOODS_RECEIPT'}>
              <option value="GOODS_RECEIPT">Goods receipt</option>
              <option value="REVERSAL">Reversal</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference category</span>
            <select className="input w-full" disabled defaultValue={document ? 'MATERIAL_DOCUMENT' : 'PURCHASE_ORDER'}>
              <option value="PURCHASE_ORDER">Purchase order</option>
              <option value="MATERIAL_DOCUMENT">Material document</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Purchase order</span>
            <input name="order" className="input w-full" placeholder="Order number" defaultValue={order?.orderNumber ?? ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Material document</span>
            <input name="doc" className="input w-full" placeholder="Document number" defaultValue={document?.materialDocumentNumber ?? ''} />
          </label>
          <div>
            <button type="submit" className="btn btn-default mt-5 min-h-11 sm:min-h-8">Load reference</button>
          </div>
        </form>
        <p className="mt-2 text-sm text-ink-soft">
          Movement type: {document ? 'RECEIPT_REVERSAL' : 'GOODS_RECEIPT_PO'} — resolved from the action and reference, never typed.
        </p>
      </section>

      {order && (
        <section aria-labelledby="gr-items" className="border border-line bg-surface p-4">
          <h2 id="gr-items" className="text-sm font-semibold">Goods receipt for order {order.orderNumber}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Supplier {order.supplierNumber} · company {order.companyCode} · currency {order.currency}
            {order.releaseRequired && (order.released ? ' · released' : ' · not yet released')}
          </p>
          {postState.message && (
            <p role="status" className={`mt-2 text-sm ${postState.ok ? 'text-ink' : 'text-red-700'}`}>
              {postState.message}{postState.remedy ? ` ${postState.remedy}` : ''}
            </p>
          )}
          <form action={postAction}>
            <input type="hidden" name="orderNumber" value={order.orderNumber} />
            <input type="hidden" name="requestKey" value={postKey} />
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
                <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
                <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Header text</span>
                <input name="headerText" className="input w-full" maxLength={25} placeholder="Header text" />
              </label>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="grid-table text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th>Item</th><th>Material</th>
                    <th>Plant</th><th>Ordered</th>
                    <th>Received</th><th>Remaining</th>
                    <th>Overdelivery</th>
                    <th>Receipt quantity</th><th>Storage location</th><th>Batch</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item) => (
                    <tr key={item.itemNumber}>
                      <td>{item.itemNumber}</td>
                      <td>{item.materialNumber ?? item.shortText}</td>
                      <td>{item.plant}</td>
                      <td>{item.ordered} {item.unit}</td>
                      <td>{item.received}</td>
                      <td>{item.remaining}</td>
                      <td className="text-ink-soft">
                        {item.unlimitedOverdelivery ? 'Unlimited' : `${item.overdeliveryTolerance}%`}
                      </td>
                      <td>
                        {item.eligible ? (
                          <input
                            type="number" step="0.001" min="0" name={`qty-${item.itemNumber}`}
                            className="input w-28" defaultValue={item.remaining > 0 ? item.remaining : undefined}
                            placeholder="0"
                          />
                        ) : (
                          <span className="text-ink-faint">{item.refusal}</span>
                        )}
                      </td>
                      <td>
                        {item.eligible && (
                          <input name={`sloc-${item.itemNumber}`} className="input w-24" defaultValue={item.proposedStorageLocation ?? item.storageLocation ?? ''} />
                        )}
                      </td>
                      <td>
                        {item.eligible && (
                          <input name={`batch-${item.itemNumber}`} maxLength={10} className="input w-28" placeholder="Batch" defaultValue={item.batch} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || posting}>
                Post goods receipt
              </button>
            </div>
          </form>
        </section>
      )}

      {document && (
        <section aria-labelledby="gr-document" className="border border-line bg-surface p-4">
          <h2 id="gr-document" className="text-sm font-semibold">Material document {document.materialDocumentNumber}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Posting date {document.postingDate} · status {document.status}
            {document.journalDocumentNumber ? ` · journal ${document.journalDocumentNumber}` : ''}
            {document.reversedBy ? ` · reversed by ${document.reversedBy}` : ''}
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Line</th><th>Movement</th>
                  <th>Material</th><th>Plant</th>
                  <th>Quantity</th><th>Value</th>
                  <th>Order item</th>
                </tr>
              </thead>
              <tbody>
                {document.lines.map((line) => (
                  <tr key={line.lineNumber}>
                    <td>{line.lineNumber}</td>
                    <td>{line.movementType}</td>
                    <td>{line.materialNumber}</td>
                    <td>{line.plant}</td>
                    <td>{line.quantity} {line.unit}</td>
                    <td>{line.value}</td>
                    <td>{line.purchaseOrderNumber} / {line.purchaseOrderItem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reverseState.message && (
            <p role="status" className={`mt-2 text-sm ${reverseState.ok ? 'text-ink' : 'text-red-700'}`}>
              {reverseState.message}{reverseState.remedy ? ` ${reverseState.remedy}` : ''}
            </p>
          )}
          {document.status === 'POSTED' && !document.reversalOf && (
            <>
              <form action={reverseAction} className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="materialDocumentNumber" value={document.materialDocumentNumber} />
                <input type="hidden" name="requestKey" value={reverseKey} />
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
                  <input type="date" name="documentDate" className="input" defaultValue={today} required />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
                  <input type="date" name="postingDate" className="input" defaultValue={today} required />
                </label>
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canPost || reversing}>
                  Reverse document
                </button>
              </form>
            </>
          )}
        </section>
      )}
    </>
  );
}
