'use client';

import type { VendorDownPaymentRequestView } from '@/modules/finance/vendor-down-payment-request';

export default function VendorDownPaymentRequest({ requests, canEnter, today }: {
  requests: VendorDownPaymentRequestView[];
  canEnter: boolean;
  today: string;
}) {
  return (
    <>
      <section aria-labelledby="vdpr-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vdpr-header" className="text-sm font-semibold">Request details</h2>
        <form>
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
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Due date</span>
              <input type="date" name="dueDate" className="input w-full" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Requested amount</span>
              <input name="amount" className="input w-full" placeholder="10000.00" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
              <input name="currency" className="input w-full" placeholder="USD" required />
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
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            A request is a noted item: it creates no payable and moves no account. The request
            indicator must stand configured with its target — the actual down-payment indicator the
            payment (F-48) will post against when the advance is paid.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
              disabled title="Posting stands disabled until the request service lands."
            >
              Post request
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="vdpr-open" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vdpr-open" className="text-sm font-semibold">Open requests</h2>
        {requests.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No down-payment requests stand open.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Request</th><th className="px-2 py-2">Vendor</th>
                  <th className="px-2 py-2">Due date</th><th className="px-2 py-2">Currency</th>
                  <th className="px-2 py-2">Requested</th><th className="px-2 py-2">Fulfilled</th>
                  <th className="px-2 py-2">Remaining</th><th className="px-2 py-2">Target</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.requestNumber} className="border-t border-line">
                    <td className="px-2 py-2">{r.requestNumber}</td>
                    <td className="px-2 py-2">{r.vendor}</td>
                    <td className="px-2 py-2">{r.dueDate}</td>
                    <td className="px-2 py-2">{r.currency}</td>
                    <td className="px-2 py-2">{r.requestedAmount.toFixed(2)}</td>
                    <td className="px-2 py-2">{r.fulfilledAmount.toFixed(2)}</td>
                    <td className="px-2 py-2">{r.remainingAmount.toFixed(2)}</td>
                    <td className="px-2 py-2">{r.targetIndicator}</td>
                    <td className="px-2 py-2">{r.status}</td>
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
