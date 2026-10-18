'use client';

import { useActionState } from 'react';

import { postDownPaymentAction, type VendorDownPaymentActionState } from './actions';

const INITIAL: VendorDownPaymentActionState = { ok: false, message: '' };

function Message({ state }: { state: VendorDownPaymentActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

export default function VendorDownPayment({ canEnter, today }: {
  canEnter: boolean;
  today: string;
}) {
  const [state, action, posting] = useActionState(postDownPaymentAction, INITIAL);

  return (
    <>
      <section aria-labelledby="vdp-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vdp-header" className="text-sm font-semibold">Header and bank data</h2>
        <form action={action}>
          <input type="hidden" name="requestKey" value="" />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
              <input name="companyCode" className="input w-full" placeholder="1000" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Vendor</span>
              <input name="vendor" className="input w-full" placeholder="V10000" required />
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
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Bank G/L account</span>
              <input name="bankAccount" className="input w-full" placeholder="113100" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Down payment amount</span>
              <input name="amount" className="input w-full" placeholder="0.00" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
              <input name="currency" className="input w-full" placeholder="USD" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Special G/L indicator</span>
              <input name="specialGlIndicator" className="input w-full" placeholder="A" maxLength={1} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
              <input name="reference" className="input w-full" placeholder="DP-2026-001" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Value date (optional)</span>
              <input type="date" name="valueDate" className="input w-full" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Text</span>
              <input name="text" className="input w-full" placeholder="Advance payment" />
            </label>
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            The indicator resolves to its configured alternative reconciliation account, which the payment
            debits; the advance then stands open outside the vendor&apos;s ordinary payables until cleared
            against invoices.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
              disabled={!canEnter || posting}
            >
              Post down payment
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="vdp-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vdp-result" className="text-sm font-semibold">Down payment</h2>
        <Message state={state} />
        <p className="mt-2 text-sm text-ink-soft">
          A posted down payment is history: never edited, never deleted. Corrections run through document
          reversal, and clearing against invoices stands in its own processing.
        </p>
        {!canEnter && (
          <p className="mt-2 text-sm text-ink-soft">You do not hold the down payment capability.</p>
        )}
      </section>
    </>
  );
}
