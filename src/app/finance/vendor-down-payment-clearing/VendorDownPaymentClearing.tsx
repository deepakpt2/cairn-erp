'use client';

import { useActionState, useState } from 'react';

import type { DownPaymentClearingView } from '@/modules/finance/vendor-down-payment-clearing';
import { postClearingAction, type DownPaymentClearingActionState } from './actions';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

const INITIAL: DownPaymentClearingActionState = { ok: false, message: '' };

function Message({ state }: { state: DownPaymentClearingActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

const itemKey = (i: { documentNumber: string; fiscalYear: number; lineNumber: number }) =>
  `${i.documentNumber}|${i.fiscalYear}|${i.lineNumber}`;

export default function VendorDownPaymentClearing({ view, loadError, canEnter, today }: {
  view: DownPaymentClearingView | null;
  loadError: string | null;
  canEnter: boolean;
  today: string;
}) {
  const [state, action, posting] = useActionState(postClearingAction, INITIAL);
  const accountLock = useChangeLock(
    'VENDOR_DOWN_PAYMENT',
    view ? `${view.vendor}/${view.companyCode}/${view.indicator}` : '',
    'FIN.AP.DOWNPAYMENT.CLEAR',
    Boolean(view && canEnter),
  );
  const [companyCode, setCompanyCode] = useState(view?.companyCode ?? '');
  const [dpSelected, setDpSelected] = useState<Set<string>>(new Set());
  const [invSelected, setInvSelected] = useState<Set<string>>(new Set());
  const [dpApplied, setDpApplied] = useState<Record<string, string>>({});
  const [invApplied, setInvApplied] = useState<Record<string, string>>({});

  const toggle = (set: typeof setDpSelected) => (key: string) => set((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const downPayments = view?.downPayments ?? [];
  const invoices = view?.invoices ?? [];
  const sum = (
    items: Array<{ remaining: number } & { documentNumber: string; fiscalYear: number; lineNumber: number }>,
    selected: Set<string>, amounts: Record<string, string>,
  ) => items.filter((i) => selected.has(itemKey(i)))
    .reduce((s, i) => s + (amounts[itemKey(i)] === undefined || amounts[itemKey(i)] === ''
      ? i.remaining : Number(amounts[itemKey(i)]) || 0), 0);
  const dpTotal = Math.round(sum(downPayments, dpSelected, dpApplied) * 100) / 100;
  const invTotal = Math.round(sum(invoices, invSelected, invApplied) * 100) / 100;
  const balanced = dpTotal > 0 && dpTotal === invTotal;

  return (
    <>
      <section aria-labelledby="vdpc-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vdpc-header" className="text-sm font-semibold">Selection criteria</h2>
        <form method="get" action="/finance/vendor-down-payment-clearing" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <ConstrainedField kind="company" name="companyCode" required value={companyCode} onChange={setCompanyCode} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Vendor</span>
            <ConstrainedField kind="supplier-company" name="vendor" required placeholder="V10000" defaultValue={view?.vendor ?? ''} context={{ companyCode }} />
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
            Vendor <strong>{view.vendor}</strong> in company <strong>{view.companyCode}</strong>:
            {' '}{downPayments.length} down payments stand under indicator <strong>{view.indicator}</strong>
            {' '}(account {view.alternativeAccount}) against {invoices.length} open invoices.
          </p>
        )}
      </section>

      {view && (
        <section aria-labelledby="vdpc-items" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="vdpc-items" className="text-sm font-semibold">Application</h2>
          <form action={action}>
            <input type="hidden" name="vendor" value={view.vendor} />
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
                <ConstrainedField kind="currency" name="currency" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
                <input name="reference" className="input w-full" placeholder="CLR-2026-001" />
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
                      <th className="px-2 py-2">Select</th><th className="px-2 py-2">Document</th>
                      <th className="px-2 py-2">Posting date</th><th className="px-2 py-2">Currency</th>
                      <th className="px-2 py-2">Advance</th><th className="px-2 py-2">Applied</th>
                      <th className="px-2 py-2">Remaining</th><th className="px-2 py-2">Apply now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {downPayments.map((item) => (
                      <tr key={itemKey(item)} className="border-t border-line">
                        <td className="px-2 py-2">
                          <input
                            type="checkbox" name="downPayment" value={itemKey(item)}
                            checked={dpSelected.has(itemKey(item))}
                            onChange={() => toggle(setDpSelected)(itemKey(item))}
                          />
                        </td>
                        <td className="px-2 py-2">{item.documentNumber}</td>
                        <td className="px-2 py-2">{item.postingDate}</td>
                        <td className="px-2 py-2">{item.currency}</td>
                        <td className="px-2 py-2">{item.amount.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.applied.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.remaining.toFixed(2)}</td>
                        <td className="px-2 py-2">
                          <input
                            name={`apply-dp-${itemKey(item)}`} className="input w-24"
                            placeholder={item.remaining.toFixed(2)}
                            value={dpApplied[itemKey(item)] ?? ''}
                            onChange={(e) => setDpApplied((p) => ({ ...p, [itemKey(item)]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="mt-4 text-sm font-semibold">Vendor invoices</h3>
            {invoices.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No vendor invoices stand open.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-2 py-2">Select</th><th className="px-2 py-2">Document</th>
                      <th className="px-2 py-2">Posting date</th><th className="px-2 py-2">Due date</th>
                      <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Payable</th>
                      <th className="px-2 py-2">Applied</th><th className="px-2 py-2">Remaining</th>
                      <th className="px-2 py-2">Settle now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((item) => (
                      <tr key={itemKey(item)} className="border-t border-line">
                        <td className="px-2 py-2">
                          <input
                            type="checkbox" name="invoice" value={itemKey(item)}
                            checked={invSelected.has(itemKey(item))}
                            onChange={() => toggle(setInvSelected)(itemKey(item))}
                          />
                        </td>
                        <td className="px-2 py-2">{item.documentNumber}</td>
                        <td className="px-2 py-2">{item.postingDate}</td>
                        <td className="px-2 py-2">{item.dueDate}</td>
                        <td className="px-2 py-2">{item.currency}</td>
                        <td className="px-2 py-2">{item.amount.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.applied.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.remaining.toFixed(2)}</td>
                        <td className="px-2 py-2">
                          <input
                            name={`settle-inv-${itemKey(item)}`} className="input w-24"
                            placeholder={item.remaining.toFixed(2)}
                            value={invApplied[itemKey(item)] ?? ''}
                            onChange={(e) => setInvApplied((p) => ({ ...p, [itemKey(item)]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mt-2 text-sm text-ink-soft">
              Applying {dpTotal.toFixed(2)} of advances against {invTotal.toFixed(2)} of invoices.
              The applied totals of both sides must agree — a clearing transfers, it never creates or
              destroys value. Items applied in full clear in place; remainders stand open by the partial model.
            </p>
            <LockNotice message={accountLock?.mode === 'DISPLAY' ? accountLock.message : null} remedy={accountLock?.remedy} />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
                disabled={!canEnter || posting || !balanced || accountLock?.mode !== 'CHANGE'}
              >
                Post clearing
              </button>
            </div>
          </form>
        </section>
      )}

      <section aria-labelledby="vdpc-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vdpc-result" className="text-sm font-semibold">Clearing</h2>
        <Message state={state} />
        <p className="mt-2 text-sm text-ink-soft">
          A posted clearing is history: never edited, never deleted. Resetting a clearing stands in the
          standing clearing-reset processing.
        </p>
        {!canEnter && (
          <p className="mt-2 text-sm text-ink-soft">You do not hold the down payment clearing capability.</p>
        )}
      </section>
    </>
  );
}
