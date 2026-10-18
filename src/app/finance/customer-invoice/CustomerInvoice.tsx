'use client';

import { useActionState, useState } from 'react';

import type { CustomerInvoiceView, TaxCodeChoice } from '@/modules/finance/customer-invoice';
import {
  cancelInvoiceAction, postInvoiceAction, type CustomerInvoiceActionState,
} from './actions';

const INITIAL: CustomerInvoiceActionState = { ok: false, message: '' };

function Message({ state }: { state: CustomerInvoiceActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

interface LineState { gl: string; net: string; tax: string; pc: string; text: string }

export default function CustomerInvoice({ invoice, taxes, canPost, today }: {
  invoice: CustomerInvoiceView | null;
  taxes: TaxCodeChoice[];
  canPost: boolean;
  today: string;
}) {
  const [postState, postAction, posting] = useActionState(postInvoiceAction, INITIAL);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelInvoiceAction, INITIAL);
  const [lines, setLines] = useState<LineState[]>([{ gl: '', net: '', tax: '', pc: '', text: '' }]);

  const rateOf = (code: string) => Number(taxes.find((t) => t.code === code)?.ratePercent ?? 0);
  const netTotal = lines.reduce((s, l) => s + (Number(l.net) || 0), 0);
  const taxTotal = lines.reduce((s, l) => s + ((Number(l.net) || 0) * rateOf(l.tax)) / 100, 0);
  const shownInvoice = invoice && invoice.status !== 'CANCELLED' || postState.invoiceNumber ? invoice : invoice;

  const setLine = (i: number, patch: Partial<LineState>) =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <>
      <section aria-labelledby="ci-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ci-header" className="text-sm font-semibold">Header</h2>
        <form method="get" action="/finance/customer-invoice" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Load invoice</span>
            <input name="invoice" className="input" placeholder="Invoice number" defaultValue={invoice?.invoiceNumber ?? ''} />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load invoice</button>
        </form>
        <Message state={cancelState} />
      </section>

      <section aria-labelledby="ci-lines" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ci-lines" className="text-sm font-semibold">Invoice</h2>
        <Message state={postState} />
        <form action={postAction}>
          <input type="hidden" name="lineCount" value={lines.length} />
          <input type="hidden" name="requestKey" value="" />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer</span>
              <input name="customer" className="input w-full" placeholder="C10000" required />
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
              <input name="reference" className="input w-full" placeholder="INV-2026-001" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
              <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
              <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Payment terms</span>
              <input name="paymentTerms" className="input w-full" placeholder="From customer" />
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
                  <th className="px-2 py-2">Tax code</th><th className="px-2 py-2">Profit centre</th>
                  <th className="px-2 py-2">Text</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-2 py-2">
                      <input name={`gl-${i + 1}`} className="input w-full" placeholder="800000"
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
              onClick={() => setLines((prev) => [...prev, { gl: '', net: '', tax: '', pc: '', text: '' }])}>
              Add line
            </button>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canPost || posting}>
              Post invoice
            </button>
          </div>
        </form>
      </section>

      {shownInvoice && (
        <section aria-labelledby="ci-document" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="ci-document" className="text-sm font-semibold">Posted document</h2>
          <p className="mt-2 text-sm">
            Invoice <strong>{shownInvoice.invoiceNumber}</strong> for customer {shownInvoice.customerNumber} stands{' '}
            <strong>{shownInvoice.status}</strong>: gross {shownInvoice.grossAmount} {shownInvoice.currency},
            tax {shownInvoice.taxAmount}, journal {shownInvoice.journalDocumentNumber}
            {shownInvoice.dueDate ? `, due ${shownInvoice.dueDate}` : ''}
            {shownInvoice.cancelledBy ? `, cancelled by ${shownInvoice.cancelledBy}` : ''}
            {shownInvoice.cancellationOf ? `, cancelling ${shownInvoice.cancellationOf}` : ''}.
          </p>
          {shownInvoice.status === 'POSTED' && !shownInvoice.cancellationOf && (
            <form action={cancelAction} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="invoice" value={shownInvoice.invoiceNumber} />
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
