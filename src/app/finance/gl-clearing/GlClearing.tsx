'use client';

import { useActionState, useState } from 'react';

import type { GlClearingView } from '@/modules/finance/gl-clearing';
import { clearAction, type GlClearingActionState } from './actions';

const INITIAL: GlClearingActionState = { ok: false, message: '' };

const itemKey = (i: { documentNumber: string; fiscalYear: number; lineNumber: number }) =>
  `${i.documentNumber}|${i.fiscalYear}|${i.lineNumber}`;

/**
 * Stage-1 shell: selection and the open-item grid stand over
 * the vocabulary; loading and posting arrive in stage 3.
 */
export default function GlClearing({ view, loadError, canClear, today }: {
  view: GlClearingView | null;
  loadError: string | null;
  canClear: boolean;
  today: string;
}) {
  const [state, action, clearing] = useActionState(clearAction, INITIAL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState<'STANDARD' | 'PARTIAL' | 'RESIDUAL'>('STANDARD');
  const [settlements, setSettlements] = useState<Record<string, string>>({});
  const [crossCurrency, setCrossCurrency] = useState(false);
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
  // The amount this clearing applies to an item: the entered settlement, else its remaining balance.
  const appliedOf = (i: { documentNumber: string; fiscalYear: number; lineNumber: number; remaining: number; debitCredit: string }) => {
    const entered = settlements[itemKey(i)];
    const value = entered === undefined || entered === '' ? i.remaining : Number(entered);
    return Number.isFinite(value) ? value : 0;
  };
  const signedOf = (i: Parameters<typeof appliedOf>[0]) => (i.debitCredit === 'S' ? 1 : -1) * appliedOf(i);
  const assigned = chosen.reduce((s, i) => s + signedOf(i), 0);
  const difference = Math.round(assigned * 10000) / 10000;
  // Live tolerance judgement, mirroring the service: a debit difference
  // judges on the expense limits, a credit on the revenue limits, and
  // both the absolute and percentage limits must hold.
  const gross = chosen.reduce((s, i) => s + Math.abs(appliedOf(i)), 0);
  const tol = view?.differenceTolerance ?? null;
  const differenceLimit = tol && difference !== 0
    ? Math.min(
        difference > 0 ? tol.expenseAmount : tol.revenueAmount,
        Math.round(gross * (difference > 0 ? tol.expensePercent : tol.revenuePercent)) / 100,
      )
    : 0;
  const withinTolerance = difference !== 0 && tol !== null && Math.abs(difference) - differenceLimit <= 0.005;
  const postable = difference === 0 || withinTolerance;
  const requestKey = view
    ? `gl-${view.companyCode}-${view.glAccount}-${chosen.map(itemKey).join(',')}-${clearingDate}-${postingDate}-${documentDate}`
    : '';

  return (
    <>
      <section aria-labelledby="glc-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="glc-selection" className="text-sm font-semibold">Selection</h2>
        <form method="get" action="/finance/gl-clearing" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-28" placeholder="1000" defaultValue={view?.companyCode ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">G/L account</span>
            <input name="glAccount" className="input w-36" placeholder="110100" defaultValue={view?.glAccount ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document number</span>
            <input name="documentNumber" className="input w-40" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Assignment</span>
            <input name="assignment" className="input w-40" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
            <input name="reference" className="input w-40" />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load open items</button>
        </form>
        {loadError && <p role="status" className="mt-2 text-sm text-red-700">{loadError}</p>}
        {state.message && (
          <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
            {state.message}{state.remedy ? ` ${state.remedy}` : ''}
          </p>
        )}
        {view && (
          <p className="mt-2 text-sm">
            Account <strong>{view.glAccount}</strong> in company <strong>{view.companyCode}</strong>:
            {' '}{view.openItems.length} open items standing at {view.openBalance.toFixed(2)} {view.accountCurrency}.
          </p>
        )}
      </section>

      {view && (
        <section aria-labelledby="glc-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="glc-items" className="text-sm font-semibold">Open items</h2>
          {items.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">No open items stand for this account and company.</p>
          ) : (
            <form action={action}>
              <input type="hidden" name="companyCode" value={view.companyCode} />
              <input type="hidden" name="glAccount" value={view.glAccount} />
              <input type="hidden" name="requestKey" value={requestKey} />
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Select</th><th className="px-2 py-2">Document</th>
                      <th className="px-2 py-2">Posting date</th><th className="px-2 py-2">Type</th>
                      <th className="px-2 py-2">Assignment</th><th className="px-2 py-2">Reference</th>
                      <th className="px-2 py-2">D/C</th><th className="px-2 py-2">Currency</th>
                      <th className="px-2 py-2">Amount</th><th className="px-2 py-2">Applied</th>
                      <th className="px-2 py-2">Remaining</th><th className="px-2 py-2">Settlement</th>
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
                        <td className="px-2 py-2">{item.assignment}</td>
                        <td className="px-2 py-2">{item.reference}</td>
                        <td className="px-2 py-2">{item.debitCredit}</td>
                        <td className="px-2 py-2">{item.currency}</td>
                        <td className="px-2 py-2">{Number(item.amount).toFixed(2)}</td>
                        <td className="px-2 py-2">{item.applied.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.remaining.toFixed(2)}</td>
                        <td className="px-2 py-2">
                          <input
                            name={`settlement:${itemKey(item)}`}
                            className="input w-28"
                            inputMode="decimal"
                            placeholder={item.remaining.toFixed(2)}
                            value={settlements[itemKey(item)] ?? ''}
                            onChange={(e) => setSettlements((prev) => ({ ...prev, [itemKey(item)]: e.target.value }))}
                            aria-label={`Settlement for document ${item.documentNumber} line ${item.lineNumber}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-sm text-ink-soft">
                Assigned {assigned.toFixed(2)}{currencies.length === 1 ? ` ${currencies[0]}` : ''} ·
                difference {difference.toFixed(2)}.
                {method === 'PARTIAL' && ' Items settled below their remaining balance stay open.'}
                {method === 'RESIDUAL' && ' Items settled below their remaining balance close, their remainder re-standing as a new open item.'}
                {difference === 0
                  ? ' The selected items balance.'
                  : withinTolerance
                    ? ' The difference stands within the tolerance of the default group and posts to the payment difference account.'
                    : tol
                      ? ` The difference stands beyond the tolerance of the default group (at most ${differenceLimit.toFixed(2)} on this selection).`
                      : ' No default tolerance group stands, so the difference must stand at zero before posting.'}
              </p>
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
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document type</span>
                  <input name="documentType" className="input w-24" maxLength={2} placeholder="AB" required />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Clearing method</span>
                  <select name="method" className="input w-40" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                    <option value="STANDARD">Standard clearing</option>
                    <option value="PARTIAL">Partial clearing</option>
                    <option value="RESIDUAL">Residual clearing</option>
                  </select>
                </label>
                {method === 'RESIDUAL' && (
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Residual reason</span>
                    <input name="residualReasonCode" className="input w-24" maxLength={3} placeholder="R01" required />
                  </label>
                )}
                {currencies.length > 1 && (
                  <label className="flex items-end gap-2">
                    <input
                      type="checkbox" name="crossCurrency" value="yes" className="size-4"
                      checked={crossCurrency} onChange={(e) => setCrossCurrency(e.target.checked)}
                    />
                    <span className="text-sm">Clear across currencies at the clearing date</span>
                  </label>
                )}
                <label className="flex items-end gap-2">
                  <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                  <span className="text-sm">I confirm this clearing</span>
                </label>
                <button
                  type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
                  disabled={!canClear || clearing || chosen.length === 0 || !postable}
                >
                  Post clearing
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {view && (
        <section aria-labelledby="glc-history" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="glc-history" className="text-sm font-semibold">Cleared history</h2>
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
