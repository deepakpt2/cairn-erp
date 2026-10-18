'use client';

import { useActionState, useState } from 'react';

import type { TaxCodeChoice, VendorInvoiceView } from '@/modules/finance/vendor-invoice';
import {
  cancelInvoiceAction, postInvoiceAction, type VendorInvoiceActionState,
} from './actions';

const INITIAL: VendorInvoiceActionState = { ok: false, message: '' };

function Message({ state }: { state: VendorInvoiceActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

interface LineState { gl: string; net: string; tax: string; cc: string; pc: string; text: string }
const EMPTY: LineState = { gl: '', net: '', tax: '', cc: '', pc: '', text: '' };

export default function VendorInvoice({ invoice, taxes, canPost, today }: {
  invoice: VendorInvoiceView | null;
  taxes: TaxCodeChoice[];
  canPost: boolean;
  today: string;
}) {
  const [postState, postAction, posting] = useActionState(postInvoiceAction, INITIAL);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelInvoiceAction, INITIAL);
  const [lines, setLines] = useState<LineState[]>([{ ...EMPTY }]);

  const rateOf = (code: string) => Number(taxes.find((t) => t.code === code)?.ratePercent ?? 0);
  const netTotal = lines.reduce((s, l) => s + (Number(l.net) || 0), 0);
  const taxTotal = lines.reduce((s, l) => s + ((Number(l.net) || 0) * rateOf(l.tax)) / 100, 0);

  const setLine = (i: number, patch: Partial<LineState>) =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <>
      <section aria-labelledby="vi-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vi-header" className="text-sm font-semibold">Header</h2>
        <form method="get" action="/finance/vendor-invoice" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Load invoice</span>
            <input name="invoice" className="input" placeholder="Invoice number" defaultValue={invoice?.invoiceNumber ?? ''} />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load invoice</button>
        </form>
        <Message state={cancelState} />
      </section>

      <section aria-labelledby="vi-lines" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vi-lines" className="text-sm font-semibold">Invoice</h2>
        <Message state={postState} />
        <form action={postAction}>
          <input type="hidden" name="lineCount" value={lines.length} />
          <input type="hidden" name="requestKey" value="" />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Vendor</span>
              <input name="vendor" className="input w-full" placeholder="V10000" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
              <input name="companyCode" className="input w-full" placeholder="1000" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
              <input name="currency" className="input w-full" placeholder="USD" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
              <input name="reference" className="input w-full" placeholder="INV-2026-999" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Invoice date</span>
              <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
              <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Payment terms</span>
              <input name="paymentTerms" className="input w-full" placeholder="From vendor" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Gross amount (tax included)</span>
              <input name="grossAmount" className="input w-full" placeholder="0.00" required />
            </label>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">G/L account</th><th className="px-2 py-2">Net amount (tax excluded)</th>
                  <th className="px-2 py-2">Tax code</th><th className="px-2 py-2">Cost centre</th>
                  <th className="px-2 py-2">Profit centre</th><th className="px-2 py-2">Text</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-2 py-2">
                      <input name={`gl-${i + 1}`} className="input w-full" placeholder="400000"
                        value={line.gl} onChange={(e) => setLine(i, { gl: e.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <input name={`net-${i + 1}`} className="input w-full" placeholder="0.00"
                        value={line.net} onChange={(e) => setLine(i, { net: e.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <select name={`tax-${i + 1}`} className="input w-full"
                        value={line.tax} onChange={(e) => setLine(i, { tax: e.target.value })}>
                        <option value="">No tax</option>
                        {taxes.map((t) => (
                          <option key={t.code} value={t.code}>{t.code} · {t.ratePercent}%</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-2">
                      <input name={`cc-${i + 1}`} className="input w-full"
                        value={line.cc} onChange={(e) => setLine(i, { cc: e.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <input name={`pc-${i + 1}`} className="input w-full"
                        value={line.pc} onChange={(e) => setLine(i, { pc: e.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <input name={`text-${i + 1}`} className="input w-full"
                        value={line.text} onChange={(e) => setLine(i, { text: e.target.value })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            Balance: lines net {netTotal.toFixed(2)} + tax {taxTotal.toFixed(2)} = {(netTotal + taxTotal).toFixed(2)}.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
              onClick={() => setLines((prev) => [...prev, { ...EMPTY }])}>
              Add line
            </button>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || posting}>
              Post invoice
            </button>
          </div>
        </form>
      </section>

      {invoice && (
        <section aria-labelledby="vi-document" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="vi-document" className="text-sm font-semibold">Posted document</h2>
          <Message state={cancelState} />
          <p className="mt-2 text-sm">
            Invoice <strong>{invoice.invoiceNumber}</strong> for vendor {invoice.vendorNumber} stands{' '}
            <strong>{invoice.status}</strong>: gross {invoice.grossAmount} {invoice.currency},
            tax {invoice.taxAmount}, journal {invoice.journalDocumentNumber}
            {invoice.dueDate ? `, due ${invoice.dueDate}` : ''}
            {invoice.cancelledBy ? `, cancelled by ${invoice.cancelledBy}` : ''}
            {invoice.cancellationOf ? `, cancelling ${invoice.cancellationOf}` : ''}.
          </p>
          {invoice.status === 'POSTED' && !invoice.cancellationOf && (
            <form action={cancelAction} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="invoice" value={invoice.invoiceNumber} />
              <input type="hidden" name="requestKey" value="" />
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Cancellation posting date</span>
                <input type="date" name="cancelDate" className="input" defaultValue={today} required />
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
