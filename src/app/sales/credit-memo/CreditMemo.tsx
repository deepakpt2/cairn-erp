'use client';

import { useActionState, useState } from 'react';

import type { CustomerCreditMemoView } from '@/modules/finance/customer-credit-memo';
import { cancelCreditMemoAction, postCreditMemoAction, type CreditMemoActionState } from './actions';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';

const INITIAL: CreditMemoActionState = { ok: false, message: '' };

function Message({ state }: { state: CreditMemoActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

interface LineState { gl: string; net: string; tax: string; pc: string; text: string }
const EMPTY: LineState = { gl: '', net: '', tax: '', pc: '', text: '' };

export default function CreditMemo({
  invoice, billings, taxes, billingNumber, canPost, today,
}: {
  invoice: CustomerCreditMemoView | null;
  billings: Array<{ billingNumber: string; deliveryNumber: string; orderNumber: string; customerNumber: string; billingDate: string; grossValue: string; customerInvoiceNumber: string | null; status: string }>;
  taxes: Array<{ code: string; ratePercent: string; name: string }>;
  billingNumber: string;
  canPost: boolean;
  today: string;
}) {
  const [postState, postAction, posting] = useActionState(postCreditMemoAction, INITIAL);
  const [cancelState, cancelAction, cancelling] = useActionState(cancelCreditMemoAction, INITIAL);
  const [companyCode, setCompanyCode] = useState('');
  const [lines, setLines] = useState<LineState[]>([{ ...EMPTY }]);
  const [taxRows, setTaxRows] = useState<{ code: string; meta: string }[]>([]);

  const rateOf = (code: string) => Number(taxRows.find((row) => row.code === code)?.meta ?? taxes.find((row) => row.code === code)?.ratePercent ?? 0);
  const netTotal = lines.reduce((s, l) => s + (Number(l.net) || 0), 0);
  const taxTotal = lines.reduce((s, l) => s + ((Number(l.net) || 0) * rateOf(l.tax)) / 100, 0);

  const setLine = (i: number, patch: Partial<LineState>) =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const selectedBilling = billings.find((b) => b.billingNumber === billingNumber);

  return (
    <>
      <section aria-labelledby="cm-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cm-header" className="text-sm font-semibold">Header</h2>
        <form method="get" action="/sales/credit-memo" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Load credit memo</span>
            <input name="invoice" className="input" placeholder="Credit memo number" defaultValue={invoice?.invoiceNumber ?? ''} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Or billing document</span>
            <input name="billing" className="input" placeholder="Billing number" defaultValue={billingNumber} />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load</button>
        </form>
        <Message state={cancelState} />
      </section>

      <section aria-labelledby="cm-lines" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cm-lines" className="text-sm font-semibold">Credit memo</h2>
        <Message state={postState} />
        <form action={postAction}>
          <input type="hidden" name="lineCount" value={lines.length} />
          <input type="hidden" name="requestKey" value="" />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer</span>
              <ConstrainedField kind="customer-company" name="customer" required placeholder="C10000" context={{ companyCode }} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
              <ConstrainedField kind="company" name="companyCode" required value={companyCode} onChange={setCompanyCode} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
              <ConstrainedField kind="currency" name="currency" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
              <input name="reference" className="input w-full" placeholder="CM-2026-001" required />
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
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Original billing document (optional)</span>
              <input name="creditOfBilling" className="input w-full" placeholder="Billing number" defaultValue={billingNumber || ''} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Original customer invoice (optional)</span>
              <input name="creditOfInvoice" className="input w-full" placeholder="Invoice number" defaultValue={selectedBilling?.customerInvoiceNumber ?? ''} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Gross credit amount (tax included)</span>
              <input name="grossAmount" className="input w-full" placeholder="0.00" required />
            </label>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">G/L account</th><th className="px-2 py-2">Net amount (tax excluded)</th>
                  <th className="px-2 py-2">Tax code</th><th className="px-2 py-2">Profit centre</th><th className="px-2 py-2">Text</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-2 py-2">
                      <ConstrainedField kind="gl" name={`gl-${i + 1}`} placeholder="400000" context={{ companyCode }}
                        value={line.gl} onChange={(gl) => setLine(i, { gl })} />
                    </td>
                    <td className="px-2 py-2">
                      <input name={`net-${i + 1}`} className="input w-full" placeholder="0.00"
                        value={line.net} onChange={(e) => setLine(i, { net: e.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <ConstrainedField kind="tax" name={`tax-${i + 1}`} context={{ companyCode }} onLoaded={setTaxRows}
                        value={line.tax} onChange={(tax) => setLine(i, { tax })} />
                    </td>
                    <td className="px-2 py-2">
                      <ConstrainedField kind="profit-center" name={`pc-${i + 1}`}
                        value={line.pc} onChange={(pc) => setLine(i, { pc })} />
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
              Post credit memo
            </button>
          </div>
        </form>
      </section>

      {invoice && (
        <section aria-labelledby="cm-document" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="cm-document" className="text-sm font-semibold">Posted document</h2>
          <Message state={cancelState} />
          <p className="mt-2 text-sm">
            Credit memo <strong>{invoice.invoiceNumber}</strong> for customer {invoice.customerNumber} stands{' '}
            <strong>{invoice.status}</strong>: gross {invoice.grossAmount} {invoice.currency},
            tax {invoice.taxAmount}, journal {invoice.journalDocumentNumber}
            {invoice.dueDate ? `, due ${invoice.dueDate}` : ''}
            {invoice.cancelledBy ? `, cancelled by ${invoice.cancelledBy}` : ''}
            {invoice.cancellationOf ? `, cancelling ${invoice.cancellationOf}` : ''}{invoice.creditOf ? `, against invoice ${invoice.creditOf}` : ''}.
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
                Cancel credit memo
              </button>
            </form>
          )}
        </section>
      )}
    </>
  );
}
