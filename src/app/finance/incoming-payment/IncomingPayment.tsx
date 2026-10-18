'use client';

import { useActionState, useState } from 'react';

import type { IncomingPaymentView } from '@/modules/finance/incoming-payment';
import { postPaymentAction, type IncomingPaymentActionState } from './actions';

const INITIAL: IncomingPaymentActionState = { ok: false, message: '' };

function Message({ state }: { state: IncomingPaymentActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

const itemKey = (i: { documentNumber: string; fiscalYear: number; lineNumber: number }) =>
  `${i.documentNumber}|${i.fiscalYear}|${i.lineNumber}`;

export default function IncomingPayment({ view, loadError, canEnter, today }: {
  view: IncomingPaymentView | null;
  loadError: string | null;
  canEnter: boolean;
  today: string;
}) {
  const [state, action, posting] = useActionState(postPaymentAction, INITIAL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState('');
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [discounts, setDiscounts] = useState<Record<string, string>>({});
  const [onAccount, setOnAccount] = useState('');

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const items = view?.openItems ?? [];
  const chosen = items.filter((i) => selected.has(itemKey(i)));
  const appliedOf = (i: (typeof items)[number]) => {
    const v = applied[itemKey(i)];
    return v === undefined || v === '' ? i.signed : Number(v) || 0;
  };
  const discountOf = (i: (typeof items)[number]) => Number(discounts[itemKey(i)]) || 0;
  const allocated = chosen.reduce((s, i) => s + appliedOf(i) + discountOf(i), 0) + (Number(onAccount) || 0);
  const difference = Math.round((allocated - (Number(amount) || 0)) * 10000) / 10000;

  return (
    <>
      <section aria-labelledby="ip-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ip-header" className="text-sm font-semibold">Header and bank data</h2>
        <form method="get" action="/finance/incoming-payment" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-28" placeholder="1000" defaultValue={view?.companyCode ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer</span>
            <input name="customer" className="input" placeholder="C10000" defaultValue={view?.customer ?? ''} required />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load open items</button>
        </form>
        {loadError && <p role="status" className="mt-2 text-sm text-red-700">{loadError}</p>}
        {view && (
          <p className="mt-2 text-sm">
            Customer <strong>{view.customer}</strong> in company <strong>{view.companyCode}</strong>:
            {' '}{view.openItems.length} open items standing at {view.openBalance.toFixed(2)}.
          </p>
        )}
      </section>

      {view && (
        <section aria-labelledby="ip-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="ip-items" className="text-sm font-semibold">Open items</h2>
          {items.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">No open items stand for this customer and company.</p>
          ) : (
            <form action={action}>
              <input type="hidden" name="customer" value={view.customer} />
              <input type="hidden" name="companyCode" value={view.companyCode} />
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
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Bank / cash G/L account</span>
                  <input name="bankAccount" className="input w-full" placeholder="101000" required />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Incoming amount</span>
                  <input name="amount" className="input w-full" placeholder="0.00" required
                    value={amount} onChange={(e) => setAmount(e.target.value)} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
                  <input name="currency" className="input w-full" placeholder="USD" required />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
                  <input name="reference" className="input w-full" placeholder="BANK-REF-001" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">On-account amount</span>
                  <input name="onAccount" className="input w-full" placeholder="0.00"
                    value={onAccount} onChange={(e) => setOnAccount(e.target.value)} />
                </label>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Select</th><th className="px-2 py-2">Document</th>
                      <th className="px-2 py-2">Posting date</th><th className="px-2 py-2">Due date</th>
                      <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Outstanding</th>
                      <th className="px-2 py-2">Applied</th><th className="px-2 py-2">Discount</th>
                      <th className="px-2 py-2">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={itemKey(item)} className="border-t border-line">
                        <td className="px-2 py-2">
                          <input
                            type="checkbox" name="item" value={itemKey(item)}
                            checked={selected.has(itemKey(item))}
                            onChange={() => toggle(itemKey(item))}
                          />
                        </td>
                        <td className="px-2 py-2">{item.documentNumber}</td>
                        <td className="px-2 py-2">{item.postingDate}</td>
                        <td className="px-2 py-2">{item.dueDate}</td>
                        <td className="px-2 py-2">{item.currency}</td>
                        <td className="px-2 py-2">{item.amount}</td>
                        <td className="px-2 py-2">
                          <input
                            name={`applied-${itemKey(item)}`} className="input w-24"
                            placeholder={item.signed.toFixed(2)}
                            value={applied[itemKey(item)] ?? ''}
                            onChange={(e) => setApplied((p) => ({ ...p, [itemKey(item)]: e.target.value }))}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <input
                            name={`discount-${itemKey(item)}`} className="input w-20" placeholder="0.00"
                            value={discounts[itemKey(item)] ?? ''}
                            onChange={(e) => setDiscounts((p) => ({ ...p, [itemKey(item)]: e.target.value }))}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <select name={`outcome-${itemKey(item)}`} className="input w-28" defaultValue="RESIDUAL">
                            <option value="RESIDUAL">Residual</option>
                            <option value="PARTIAL">Partial</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-sm text-ink-soft">
                Allocated {allocated.toFixed(2)} · unassigned {difference.toFixed(2)}.
                Applied plus discount settles an item in full; less leaves a residual item or a partial
                payment, as chosen per item. What remains unassigned posts on account or, within the
                tolerance group, as a payment difference.
              </p>
              <p role="status" className="mt-2 text-sm text-ink-soft">
                The completion service lands in a later stage; posting stands disabled until it does.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
                  disabled
                >
                  Post payment
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      <section aria-labelledby="ip-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ip-result" className="text-sm font-semibold">Payment</h2>
        <Message state={state} />
        <p className="mt-2 text-sm text-ink-soft">
          A posted payment and its clearing are history: never edited, never deleted. The cleared items stand on
          the customer's cleared history.
        </p>
      </section>
    </>
  );
}
