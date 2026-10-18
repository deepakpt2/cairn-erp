import type { DownPaymentClearingView } from '@/modules/finance/vendor-down-payment-clearing';

export default function VendorDownPaymentClearing({ view, loadError, canEnter, today }: {
  view: DownPaymentClearingView | null;
  loadError: string | null;
  canEnter: boolean;
  today: string;
}) {
  const downPayments = view?.downPayments ?? [];
  const invoices = view?.invoices ?? [];

  return (
    <>
      <section aria-labelledby="vdpc-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vdpc-header" className="text-sm font-semibold">Selection criteria</h2>
        <form method="get" action="/finance/vendor-down-payment-clearing" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-28" placeholder="1000" defaultValue={view?.companyCode ?? ''} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Vendor</span>
            <input name="vendor" className="input" placeholder="V10000" defaultValue={view?.vendor ?? ''} required />
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
          <form>
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
                <input name="currency" className="input w-full" placeholder="USD" required />
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
                      <tr key={item.documentNumber} className="border-t border-line">
                        <td className="px-2 py-2"><input type="checkbox" name="downPayment" disabled /></td>
                        <td className="px-2 py-2">{item.documentNumber}</td>
                        <td className="px-2 py-2">{item.postingDate}</td>
                        <td className="px-2 py-2">{item.currency}</td>
                        <td className="px-2 py-2">{item.amount.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.applied.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.remaining.toFixed(2)}</td>
                        <td className="px-2 py-2"><input className="input w-24" disabled /></td>
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
                      <tr key={item.documentNumber} className="border-t border-line">
                        <td className="px-2 py-2"><input type="checkbox" name="invoice" disabled /></td>
                        <td className="px-2 py-2">{item.documentNumber}</td>
                        <td className="px-2 py-2">{item.postingDate}</td>
                        <td className="px-2 py-2">{item.dueDate}</td>
                        <td className="px-2 py-2">{item.currency}</td>
                        <td className="px-2 py-2">{item.amount.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.applied.toFixed(2)}</td>
                        <td className="px-2 py-2">{item.remaining.toFixed(2)}</td>
                        <td className="px-2 py-2"><input className="input w-24" disabled /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mt-2 text-sm text-ink-soft">
              The applied totals of both sides must agree — a clearing transfers, it never creates or
              destroys value. Items applied in full clear in place; remainders stand open by the partial model.
              The clearing service lands in a later stage; posting stands disabled until it does.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
                Post clearing
              </button>
            </div>
          </form>
        </section>
      )}

      <section aria-labelledby="vdpc-result" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="vdpc-result" className="text-sm font-semibold">Clearing</h2>
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
