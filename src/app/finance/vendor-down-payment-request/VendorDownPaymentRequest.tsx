'use client';

import { useActionState, useState } from 'react';

import type { VendorDownPaymentRequestView } from '@/modules/finance/vendor-down-payment-request';
import { postVendorRequestAction, type VendorRequestActionState } from './actions';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';

const INITIAL: VendorRequestActionState = { ok: false, message: '' };

function Message({ state }: { state: VendorRequestActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

export default function VendorDownPaymentRequest({ requests, canEnter, today }: {
  requests: VendorDownPaymentRequestView[];
  canEnter: boolean;
  today: string;
}) {
  const [state, action, posting] = useActionState(postVendorRequestAction, INITIAL);
  const [companyCode, setCompanyCode] = useState('');

  return (
    <>
      <section aria-labelledby="vdpr-header" className="border border-line bg-surface p-4">
        <h2 id="vdpr-header" className="text-sm font-semibold">Request details</h2>
        <form action={action}>
          <input type="hidden" name="requestKey" value="" />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
              <ConstrainedField kind="company" name="companyCode" required value={companyCode} onChange={setCompanyCode} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Vendor</span>
              <ConstrainedField kind="supplier-company" name="vendor" required placeholder="V10000" context={{ companyCode }} />
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
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Due date</span>
              <input type="date" name="dueDate" className="input w-full" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Requested amount</span>
              <input name="amount" className="input w-full" placeholder="10000.00" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
              <ConstrainedField kind="currency" name="currency" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Request indicator</span>
              <input name="indicator" className="input w-full" placeholder="F" maxLength={1} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document type</span>
              <input name="documentType" className="input w-full" defaultValue="KA" maxLength={2} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
              <input name="reference" className="input w-full" placeholder="REQ-V-2026-001" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Purchase order</span>
              <input name="purchaseOrder" className="input w-full" placeholder="POF-0000001" maxLength={20} />
            </label>
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            A request is a noted item: it creates no payable and moves no account. The request
            indicator must stand configured with its target — the actual down-payment indicator the
            payment (F-48) will post against when the advance is paid. Naming a purchase order ties
            the advance to that commitment; the order must belong to this supplier and company.
            Left blank, the advance is general to the vendor and settles against any of their
            invoices.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
              disabled={!canEnter || posting}
            >
              Post request
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="vdpr-open" className="border border-line bg-surface p-4">
        <h2 id="vdpr-open" className="text-sm font-semibold">Open requests</h2>
        <Message state={state} />
        {requests.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No down-payment requests stand open.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Request</th><th>Vendor</th>
                  <th>Due date</th><th>Currency</th>
                  <th>Requested</th><th>Fulfilled</th>
                  <th>Remaining</th><th>Target</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.requestNumber}>
                    <td>{r.requestNumber}</td>
                    <td>{r.vendor}</td>
                    <td>{r.dueDate}</td>
                    <td>{r.currency}</td>
                    <td className="num">{r.requestedAmount.toFixed(2)}</td>
                    <td className="num">{r.fulfilledAmount.toFixed(2)}</td>
                    <td className="num">{r.remainingAmount.toFixed(2)}</td>
                    <td>{r.targetIndicator}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!canEnter && (
          <p className="mt-2 text-sm text-ink-soft">You do not hold the down payment request capability.</p>
        )}
      </section>
    </>
  );
}
