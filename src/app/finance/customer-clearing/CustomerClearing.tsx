'use client';

import { useActionState, useState } from 'react';

import type { CustomerClearingView } from '@/modules/finance/customer-clearing';
import { clearAction, type CustomerClearingActionState } from './actions';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

const INITIAL: CustomerClearingActionState = { ok: false, message: '' };

function Message({ state }: { state: CustomerClearingActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

const itemKey = (i: { documentNumber: string; fiscalYear: number; lineNumber: number }) =>
  `${i.documentNumber}|${i.fiscalYear}|${i.lineNumber}`;

export default function CustomerClearing({ view, loadError, canClear, today }: {
  view: CustomerClearingView | null;
  loadError: string | null;
  canClear: boolean;
  today: string;
}) {
  const [state, action, clearing] = useActionState(clearAction, INITIAL);
  const accountLock = useChangeLock(
    'CUSTOMER_ACCOUNT',
    view ? `${view.customer}/${view.companyCode}` : '',
    'FIN.AR.CLEAR',
    Boolean(view && canClear),
  );
  const [companyCode, setCompanyCode] = useState(view?.companyCode ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clearingDate, setClearingDate] = useState(today);
  const [postingDate, setPostingDate] = useState(today);
  const [documentDate, setDocumentDate] = useState(today);

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const items = view?.openItems ?? [];
  const chosen = items.filter((i) => selected.has(itemKey(i)));
  const currencies = [...new Set(chosen.map((i) => i.currency))];
  const assigned = chosen.reduce((s, i) => s + i.signed, 0);
  const difference = Math.round(assigned * 10000) / 10000;
  const requestKey = view
    ? `cc-${view.companyCode}-${view.customer}-${chosen.map(itemKey).join(',')}-${clearingDate}-${postingDate}-${documentDate}`
    : '';

  return (
    <>
      <section aria-labelledby="cc-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="cc-selection" className="text-sm font-semibold">Selection</h2>
        <form method="get" action="/finance/customer-clearing" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Customer account</span>
            <ConstrainedField kind="customer-company" name="customer" required placeholder="C10000" defaultValue={view?.customer ?? ''} context={{ companyCode }} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <ConstrainedField kind="company" name="companyCode" required value={companyCode} onChange={setCompanyCode} />
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
        <Message state={state} />
      </section>

      {view && (
        <section aria-labelledby="cc-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="cc-items" className="text-sm font-semibold">Open items</h2>
          {items.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">No open items stand for this customer and company.</p>
          ) : (
            <form action={action}>
              <input type="hidden" name="customer" value={view.customer} />
              <input type="hidden" name="companyCode" value={view.companyCode} />
              <input type="hidden" name="requestKey" value={requestKey} />
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Select</th><th className="px-2 py-2">Document</th>
                      <th className="px-2 py-2">Posting date</th><th className="px-2 py-2">Type</th>
                      <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Amount</th>
                      <th className="px-2 py-2">Signed</th>
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
                        <td className="px-2 py-2">{item.documentType}</td>
                        <td className="px-2 py-2">{item.currency}</td>
                        <td className="px-2 py-2">{item.amount}</td>
                        <td className="px-2 py-2">{item.signed.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-sm text-ink-soft">
                Assigned {assigned.toFixed(2)}{currencies.length === 1 ? ` ${currencies[0]}` : ''} ·
                difference {difference.toFixed(2)}. The difference must stand at zero before posting.
              </p>
              <LockNotice message={accountLock?.mode === 'DISPLAY' ? accountLock.message : null} remedy={accountLock?.remedy} />
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Clearing date</span>
                  <input type="date" name="clearingDate" className="input" value={clearingDate} onChange={(e) => setClearingDate(e.target.value)} required />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
                  <input type="date" name="postingDate" className="input" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} required />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
                  <input type="date" name="documentDate" className="input" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} required />
                </label>
                <label className="flex items-end gap-2">
                  <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                  <span className="text-sm">I confirm this clearing</span>
                </label>
                <button
                  type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
                  disabled={!canClear || clearing || chosen.length === 0 || difference !== 0 || accountLock?.mode !== 'CHANGE'}
                >
                  Post clearing
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {view && (
        <section aria-labelledby="cc-history" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="cc-history" className="text-sm font-semibold">Cleared history</h2>
          {view.clearedItems.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">
              Nothing stands cleared for this selection yet. A posted clearing is history: it is preserved, never edited or deleted.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">Document</th><th className="px-2 py-2">Amount</th>
                    <th className="px-2 py-2">Cleared by</th><th className="px-2 py-2">Clearing date</th>
                  </tr>
                </thead>
                <tbody>
                  {view.clearedItems.map((item) => (
                    <tr key={itemKey(item)} className="border-t border-line">
                      <td className="px-2 py-2">{item.documentNumber}</td>
                      <td className="px-2 py-2">{item.amount} {item.currency}</td>
                      <td className="px-2 py-2">{item.clearingDocument}</td>
                      <td className="px-2 py-2">{item.clearingDate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
