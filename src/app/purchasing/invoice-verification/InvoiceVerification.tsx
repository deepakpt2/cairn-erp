'use client';

import { useActionState, useState } from 'react';

import type {
  InvoiceOrderView, SupplierInvoiceView, TaxCodeChoice,
} from '@/modules/purchasing/invoice-verification';
import {
  cancelInvoiceAction, postInvoiceAction, type InvoiceActionState,
} from './actions';

const INITIAL: InvoiceActionState = { ok: false, message: '' };

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const money = (n: number) => Math.round(n * 100) / 100;

export default function InvoiceVerification({ order, invoice, taxCodes, canPost, today }: {
  order: InvoiceOrderView | null;
  invoice: SupplierInvoiceView | null;
  taxCodes: TaxCodeChoice[];
  canPost: boolean;
  today: string;
}) {
  const [postState, postAction, posting] = useActionState(postInvoiceAction, INITIAL);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelInvoiceAction, INITIAL);
  const [postKey] = useState(newRequestKey);
  const [cancelKey] = useState(newRequestKey);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [taxes, setTaxes] = useState<Record<number, string>>({});

  const rateOf = (code: string) => {
    const row = taxCodes.find((t) => t.code === code);
    return row ? Number(row.ratePercent) : 0;
  };
  let netTotal = 0;
  let taxTotal = 0;
  for (const item of order?.items ?? []) {
    const qty = Number(quantities[item.itemNumber] ?? item.invoiceable);
    const amount = Number(amounts[item.itemNumber] ?? (Math.round(((item.invoiceable * Number(item.netPrice)) / Number(item.priceUnit)) * 100) / 100));
    if (qty > 0 && amount >= 0) {
      netTotal += amount;
      taxTotal += (amount * rateOf(taxes[item.itemNumber] ?? item.taxCode)) / 100;
    }
  }
  netTotal = money(netTotal);
  taxTotal = money(taxTotal);

  return (
    <>
      <section aria-labelledby="iv-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="iv-header" className="text-sm font-semibold">Invoice header</h2>
        <form method="get" action="/purchasing/invoice-verification" className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Invoice category</span>
            <select className="input w-full" disabled defaultValue="INVOICE">
              <option value="INVOICE">Invoice</option>
              <option value="CREDIT_MEMO">Credit memo</option>
              <option value="SUBSEQUENT_DEBIT">Subsequent debit</option>
              <option value="SUBSEQUENT_CREDIT">Subsequent credit</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Purchase order</span>
            <input name="order" className="input w-full" placeholder="Order number" defaultValue={order?.orderNumber ?? ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Invoice document</span>
            <input name="invoice" className="input w-full" placeholder="Document number" defaultValue={invoice?.invoiceNumber ?? ''} />
          </label>
          <div>
            <button type="submit" className="btn btn-default mt-5 min-h-11 sm:min-h-8">Load reference</button>
          </div>
        </form>
      </section>

      {order && (
        <section aria-labelledby="iv-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="iv-items" className="text-sm font-semibold">Invoice for order {order.orderNumber}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Supplier {order.supplierNumber} · company {order.companyCode} · currency {order.currency}.
            Item amounts are net of tax.
          </p>
          {postState.message && (
            <p role="status" className={`mt-2 text-sm ${postState.ok ? 'text-ink' : 'text-red-700'}`}>
              {postState.message}{postState.remedy ? ` ${postState.remedy}` : ''}
            </p>
          )}
          <form action={postAction}>
            <input type="hidden" name="orderNumber" value={order.orderNumber} />
            <input type="hidden" name="requestKey" value={postKey} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier reference</span>
                <input name="supplierReference" className="input w-full" maxLength={16} placeholder="Supplier invoice number" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Gross amount</span>
                <input name="grossAmount" type="number" step="0.01" min="0" className="input w-full" placeholder="0.00" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Invoice date</span>
                <input type="date" name="invoiceDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
                <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
              </label>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">Item</th><th className="px-2 py-2">Material</th>
                    <th className="px-2 py-2">Ordered</th><th className="px-2 py-2">Received</th>
                    <th className="px-2 py-2">Invoiced</th><th className="px-2 py-2">Invoiceable</th>
                    <th className="px-2 py-2">Quantity</th><th className="px-2 py-2">Net amount (excl. tax)</th>
                    <th className="px-2 py-2">Tax code</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item) => {
                    const expected = money((item.invoiceable * Number(item.netPrice)) / Number(item.priceUnit));
                    return (
                      <tr key={item.itemNumber} className="border-t border-line">
                        <td className="px-2 py-2">{item.itemNumber}</td>
                        <td className="px-2 py-2">{item.materialNumber ?? item.shortText}</td>
                        <td className="px-2 py-2">{item.ordered} {item.unit}</td>
                        <td className="px-2 py-2">{item.received}</td>
                        <td className="px-2 py-2">{item.invoiced}</td>
                        <td className="px-2 py-2">{item.invoiceable}</td>
                        <td className="px-2 py-2">
                          {item.eligible ? (
                            <input
                              type="number" step="0.001" min="0" name={`qty-${item.itemNumber}`} className="input w-24"
                              value={quantities[item.itemNumber] ?? String(item.invoiceable)}
                              onChange={(e) => setQuantities((q) => ({ ...q, [item.itemNumber]: e.target.value }))}
                            />
                          ) : (
                            <span className="text-ink-faint">{item.refusal}</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {item.eligible && (
                            <input
                              type="number" step="0.01" min="0" name={`amt-${item.itemNumber}`} className="input w-28"
                              value={amounts[item.itemNumber] ?? String(expected)}
                              onChange={(e) => setAmounts((a) => ({ ...a, [item.itemNumber]: e.target.value }))}
                            />
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {item.eligible && (
                            <select
                              name={`tax-${item.itemNumber}`} className="input w-24"
                              value={taxes[item.itemNumber] ?? item.taxCode}
                              onChange={(e) => setTaxes((t) => ({ ...t, [item.itemNumber]: e.target.value }))}
                            >
                              <option value="">—</option>
                              {taxCodes.map((code) => (
                                <option key={code.code} value={code.code}>{code.code} ({code.ratePercent}%)</option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm text-ink-soft">
              Balance: items net {netTotal.toFixed(2)} + tax {taxTotal.toFixed(2)} = {(netTotal + taxTotal).toFixed(2)} {order.currency}.
              The gross amount entered must reconcile with this balance; a price variance against the order price posts separately and is named here.
            </p>
            <div className="mt-3">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || posting}>
                Post invoice
              </button>
            </div>
          </form>
        </section>
      )}

      {invoice && (
        <section aria-labelledby="iv-document" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="iv-document" className="text-sm font-semibold">Invoice {invoice.invoiceNumber}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Supplier {invoice.supplierNumber} · reference {invoice.supplierReference} · gross {invoice.grossAmount} {invoice.currency}
            {' '}· tax {invoice.taxAmount} · status {invoice.status}
            {invoice.dueDate ? ` · due ${invoice.dueDate}` : ''}
            {invoice.journalDocumentNumber ? ` · journal ${invoice.journalDocumentNumber}` : ''}
            {invoice.cancelledBy ? ` · cancelled by ${invoice.cancelledBy}` : ''}
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Line</th><th className="px-2 py-2">Order item</th>
                  <th className="px-2 py-2">Material</th><th className="px-2 py-2">Quantity</th>
                  <th className="px-2 py-2">Net</th><th className="px-2 py-2">Expected</th>
                  <th className="px-2 py-2">Variance</th><th className="px-2 py-2">Tax</th>
                </tr>
              </thead>
              <tbody>
                {invoice.items.map((item) => (
                  <tr key={item.lineNumber} className="border-t border-line">
                    <td className="px-2 py-2">{item.lineNumber}</td>
                    <td className="px-2 py-2">{item.purchaseOrderItem}</td>
                    <td className="px-2 py-2">{item.materialNumber}</td>
                    <td className="px-2 py-2">{item.quantity}</td>
                    <td className="px-2 py-2">{item.netAmount}</td>
                    <td className="px-2 py-2">{item.expectedAmount}</td>
                    <td className="px-2 py-2">{item.varianceAmount}</td>
                    <td className="px-2 py-2">{item.taxCode} · {item.taxAmount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cancelState.message && (
            <p role="status" className={`mt-2 text-sm ${cancelState.ok ? 'text-ink' : 'text-red-700'}`}>
              {cancelState.message}{cancelState.remedy ? ` ${cancelState.remedy}` : ''}
            </p>
          )}
          {invoice.status === 'POSTED' && !invoice.cancellationOf && (
            <form action={cancelAction} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="invoiceNumber" value={invoice.invoiceNumber} />
              <input type="hidden" name="requestKey" value={cancelKey} />
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Cancellation posting date</span>
                <input type="date" name="postingDate" className="input" defaultValue={today} required />
              </label>
              <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canPost || cancelling}>
                Cancel invoice
              </button>
            </form>
          )}
        </section>
      )}
    </>
  );
}
