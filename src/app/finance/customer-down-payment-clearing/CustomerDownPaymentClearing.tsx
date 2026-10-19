'use client';

import { useState } from 'react';

import type { CustomerDownPaymentClearingView } from '@/modules/finance/customer-down-payment-clearing';

const itemKey = (i: { documentNumber: string; fiscalYear: number; lineNumber: number }) =>
  `${i.documentNumber}|${i.fiscalYear}|${i.lineNumber}`;

interface AllocationRow {
  downPaymentKey: string;
  invoiceKey: string;
  amount: string;
}

export default function CustomerDownPaymentClearing({ view, loadError, canEnter, today }: {
  view: CustomerDownPaymentClearingView | null;
  loadError: string | null;
  canEnter: boolean;
  today: string;
}) {
  const [rows, setRows] = useState<AllocationRow[]>([]);

  const downPayments = view?.downPayments ?? [];
  const invoices = view?.invoices ?? [];
  const dpByKey = new Map(downPayments.map((i) => [itemKey(i), i]));
  const invByKey = new Map(invoices.map((i) => [itemKey(i), i]));

  const allocatedFor = (side: 'dp' | 'inv', key: string) => Math.round(rows
    .filter((r) => (side === 'dp' ? r.downPaymentKey : r.invoiceKey) === key)
    .reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100;
  const totalAllocated = Math.round(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100;
  const overAllocated = rows.some((r) => {
    const dp = dpByKey.get(r.downPaymentKey);
    const inv = invByKey.get(r.invoiceKey);
    return (dp && allocatedFor('dp', r.downPaymentKey) > dp.remaining + 0.005)
      || (inv && allocatedFor('inv', r.invoiceKey) > inv.remaining + 0.005)
      || !(Number(r.amount) > 0);
  });
  const ready = totalAllocated > 0 && !overAllocated;

  const setRow = (index: number, patch: Partial<AllocationRow>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <>
      <section aria-labelledby="cdpc-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cdpc-header" className="text-sm font-semibold">Selection criteria</h2>
        <form method="get" action="/finance/customer-down-payment-clearing" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-28" placeholder="1000" defaultValue={view?.companyCode ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer</span>
            <input name="customer" className="input" placeholder="C10000" defaultValue={view?.customer ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Special G/L indicator</span>
            <input name="indicator" className="input w-20" placeholder="A" maxLength={1} defaultValue={view?.indicator ?? ''} required />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load open items</button>
        </form>
        {loadError && <p role="status" className="mt-2 text-sm text-red-700">{loadError}</p>}
        {view && (
          <p className="mt-2 text-sm">
            Customer <strong>{view.customer}</strong> in company <strong>{view.companyCode}</strong>:
            {' '}{downPayments.length} down payments stand under indicator <strong>{view.indicator}</strong>
            {' '}(account {view.alternativeAccount}) against {invoices.length} open invoices
            {' '}(account {view.reconciliationAccount}).
          </p>
        )}
      </section>

      {view && (
        <section aria-labelledby="cdpc-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="cdpc-items" className="text-sm font-semibold">Allocation</h2>
          <form>
            <input type="hidden" name="customer" value={view.customer} />
            <input type="hidden" name="companyCode" value={view.companyCode} />
            <input type="hidden" name="indicator" value={view.indicator} />
            <input type="hidden" name="requestKey" value="" />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
                <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
                <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Clearing date</span>
                <input type="date" name="clearingDate" className="input w-full" defaultValue={today} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
                <input name="currency" className="input w-full" placeholder="USD" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
                <input name="reference" className="input w-full" placeholder="CLR-2026-002" />
              </label>
            </div>

            <h3 className="mt-4 text-sm font-semibold">Down payments</h3>
            {downPayments.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No down payments stand open under this indicator.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Document</th><th className="px-2 py-2">Posting date</th>
                      <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Advance</th>
                      <th className="px-2 py-2">Applied</th><th className="px-2 py-2">Remaining</th>
                      <th className="px-2 py-2">Allocated here</th>
                    </tr>
                  </thead>
                  <tbody>
                    {downPayments.map((item) => (
                      <tr key={itemKey(item)} className="border-t border-line">
                        <td className="px-2 py-2">{item.documentNumber}</td>
                        <td className="px-2 py-2">{item.postingDate}</td>
                        <td className="px-2 py-2">{item.currency}</td>
                        <td className="px-2 py-2">{item.amount.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.applied.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.remaining.toFixed(2)}</td>
                        <td className="px-2 py-2">{allocatedFor('dp', itemKey(item)).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="mt-4 text-sm font-semibold">Customer invoices</h3>
            {invoices.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No customer invoices stand open.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Document</th><th className="px-2 py-2">Posting date</th>
                      <th className="px-2 py-2">Due date</th><th className="px-2 py-2">Currency</th>
                      <th className="px-2 py-2">Receivable</th><th className="px-2 py-2">Applied</th>
                      <th className="px-2 py-2">Remaining</th><th className="px-2 py-2">Allocated here</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((item) => (
                      <tr key={itemKey(item)} className="border-t border-line">
                        <td className="px-2 py-2">{item.documentNumber}</td>
                        <td className="px-2 py-2">{item.postingDate}</td>
                        <td className="px-2 py-2">{item.dueDate}</td>
                        <td className="px-2 py-2">{item.currency}</td>
                        <td className="px-2 py-2">{item.amount.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.applied.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.remaining.toFixed(2)}</td>
                        <td className="px-2 py-2">{allocatedFor('inv', itemKey(item)).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="mt-4 text-sm font-semibold">Allocations</h3>
            {rows.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">
                No allocations yet. Add one row per application of a down payment to an invoice —
                one advance may settle several invoices, and one invoice may draw on several advances.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {rows.map((row, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Down payment</span>
                      <select
                        aria-label="Down payment" className="input" value={row.downPaymentKey}
                        onChange={(e) => setRow(index, { downPaymentKey: e.target.value })}
                      >
                        <option value="">Select…</option>
                        {downPayments.map((i) => (
                          <option key={itemKey(i)} value={itemKey(i)}>
                            {i.documentNumber} · {i.remaining.toFixed(2)} {i.currency} open
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Invoice</span>
                      <select
                        aria-label="Invoice" className="input" value={row.invoiceKey}
                        onChange={(e) => setRow(index, { invoiceKey: e.target.value })}
                      >
                        <option value="">Select…</option>
                        {invoices.map((i) => (
                          <option key={itemKey(i)} value={itemKey(i)}>
                            {i.documentNumber} · {i.remaining.toFixed(2)} {i.currency} open
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Amount</span>
                      <input
                        aria-label="Allocation amount" className="input w-28" value={row.amount}
                        onChange={(e) => setRow(index, { amount: e.target.value })}
                      />
                    </label>
                    <button
                      type="button" className="btn btn-default min-h-11 sm:min-h-8"
                      onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button" className="btn btn-default mt-2 min-h-11 sm:min-h-8"
              onClick={() => setRows((prev) => [...prev, { downPaymentKey: '', invoiceKey: '', amount: '' }])}
            >
              Add allocation
            </button>

            <p className="mt-2 text-sm text-ink-soft">
              Allocating {totalAllocated.toFixed(2)} of advances against invoices. Every allocation
              moves value from the alternative account to the ordinary receivable account — the
              clearing document balances by construction, and remainders stand open by the partial model.
            </p>
            {overAllocated && (
              <p role="status" className="mt-2 text-sm text-red-700">
                An allocation stands above an item's remaining amount, or not above zero.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
                disabled title="Posting stands disabled until the clearing service lands."
              >
                Post clearing
              </button>
            </div>
          </form>
        </section>
      )}

      <section aria-labelledby="cdpc-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cdpc-result" className="text-sm font-semibold">Clearing</h2>
        <p className="mt-2 text-sm text-ink-soft">
          A posted clearing is history: never edited, never deleted. Resetting a clearing stands in the
          standing clearing-reset processing.
        </p>
        {!canEnter && (
          <p className="mt-2 text-sm text-ink-soft">You do not hold the customer down payment clearing capability.</p>
        )}
      </section>
    </>
  );
}
