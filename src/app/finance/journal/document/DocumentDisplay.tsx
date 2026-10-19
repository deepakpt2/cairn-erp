import Link from 'next/link';

import type { JournalDocumentView } from '@/modules/finance/document-display';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

export default function DocumentDisplay({ document, parkedNumber, notFound, canDisplay }: {
  document: JournalDocumentView | null;
  parkedNumber: string | null;
  notFound: boolean;
  canDisplay: boolean;
}) {
  return (
    <>
      <section aria-labelledby="dd-lookup" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="dd-lookup" className="text-sm font-semibold">Document key</h2>
        <form method="get" className="mt-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className={labelCls}>Document number</span>
              <input name="document" className={inputCls} placeholder="JE-000001" required />
            </label>
            <label className="block">
              <span className={labelCls}>Company code</span>
              <input name="company" className={inputCls} placeholder="1000" required />
            </label>
            <label className="block">
              <span className={labelCls}>Fiscal year</span>
              <input name="year" className={inputCls} placeholder="2026" required />
            </label>
          </div>
          <button type="submit" className="btn btn-primary mt-3 min-h-11 sm:min-h-8" disabled={!canDisplay}>
            Display
          </button>
          {!canDisplay && (
            <p className="mt-2 text-sm text-ink-soft">You do not hold the document flow capability.</p>
          )}
        </form>
        {notFound && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            No posted document stands under this key within your scope.
          </p>
        )}
        {parkedNumber && (
          <p role="status" className="mt-2 text-sm">
            {parkedNumber} stands parked in its own lifecycle and is not a posted document.{' '}
            <Link className="text-accent hover:underline" href={`/finance/journal/park?edit=${parkedNumber}`}>
              Open it in Park a Journal Entry
            </Link>
            .
          </p>
        )}
      </section>

      {document && (
        <>
          <section aria-labelledby="dd-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 id="dd-header" className="text-sm font-semibold">
              Document {document.displayNumber || document.documentNumber}
            </h2>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
              <div><dt className={labelCls}>Company code</dt><dd>{document.companyCode}</dd></div>
              <div><dt className={labelCls}>Document type</dt><dd>{document.documentType}</dd></div>
              <div><dt className={labelCls}>Document date</dt><dd>{document.documentDate}</dd></div>
              <div><dt className={labelCls}>Posting date</dt><dd>{document.postingDate}</dd></div>
              <div><dt className={labelCls}>Period / Year</dt><dd>{document.postingPeriod} / {document.fiscalYear}</dd></div>
              <div><dt className={labelCls}>Status</dt><dd>{document.status}</dd></div>
              <div><dt className={labelCls}>Document currency</dt><dd>{document.documentCurrency}</dd></div>
              <div><dt className={labelCls}>Local currency</dt><dd>{document.localCurrency}</dd></div>
              <div><dt className={labelCls}>Exchange rate</dt><dd>{document.exchangeRate}</dd></div>
              <div><dt className={labelCls}>Reference</dt><dd>{document.reference ?? '—'}</dd></div>
              <div><dt className={labelCls}>Header text</dt><dd>{document.headerText ?? '—'}</dd></div>
              <div><dt className={labelCls}>Posted by</dt><dd>{document.postedBy} · {document.postedAt}</dd></div>
            </dl>
          </section>

          <section aria-labelledby="dd-lines" className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 id="dd-lines" className="text-sm font-semibold">Line items</h2>
            <div className="mt-2 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">Line</th><th className="px-2 py-2">Account</th>
                    <th className="px-2 py-2">D/C</th><th className="px-2 py-2">Document amount</th>
                    <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Local amount</th>
                    <th className="px-2 py-2">Partner</th><th className="px-2 py-2">Cost centre</th>
                    <th className="px-2 py-2">Profit centre</th><th className="px-2 py-2">Assignment</th><th className="px-2 py-2">Tax</th>
                    <th className="px-2 py-2">Clearing</th><th className="px-2 py-2">Text</th>
                  </tr>
                </thead>
                <tbody>
                  {document.lines.map((line) => (
                    <tr key={line.lineNumber} className="border-t border-line">
                      <td className="px-2 py-2">{line.lineNumber}</td>
                      <td className="px-2 py-2">{line.glAccount}</td>
                      <td className="px-2 py-2">{line.debitCredit}</td>
                      <td className="px-2 py-2">{line.amountDocument.toFixed(2)}</td>
                      <td className="px-2 py-2">{line.currency}</td>
                      <td className="px-2 py-2">{line.amountLocal.toFixed(2)}</td>
                      <td className="px-2 py-2">{line.businessPartner ?? '—'}</td>
                      <td className="px-2 py-2">{line.costCenter ?? '—'}</td>
                      <td className="px-2 py-2">{line.profitCenter ?? '—'}</td>
                      <td className="px-2 py-2">{line.assignment ?? '—'}</td>
                      <td className="px-2 py-2">{line.taxCode ?? '—'}</td>
                      <td className="px-2 py-2">{line.clearingDocument ?? '—'}</td>
                      <td className="px-2 py-2">{line.lineText ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-ink-soft">
              Totals in {document.documentCurrency}: debits {document.debitDocument.toFixed(2)},
              credits {document.creditDocument.toFixed(2)}. In {document.localCurrency}:
              debits {document.debitLocal.toFixed(2)}, credits {document.creditLocal.toFixed(2)}.
              Stored amounts stand as posted; nothing is recalculated here.
            </p>
          </section>

          <section aria-labelledby="dd-flow" className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 id="dd-flow" className="text-sm font-semibold">Document flow</h2>
            {document.flow.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No related documents stand linked.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {document.flow.map((link, i) => (
                  <li key={i}>
                    <span className="text-ink-faint">{link.kind.replaceAll('_', ' ')}: </span>
                    {link.href ? (
                      <Link className="text-accent hover:underline" href={link.href}>{link.label}</Link>
                    ) : (
                      link.label
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="dd-history" className="rounded-card border border-line bg-surface p-4 shadow-card">
            <h2 id="dd-history" className="text-sm font-semibold">Change history</h2>
            {document.history.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No change documents stand retained for this document.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {document.history.map((entry, i) => (
                  <li key={i}>
                    {entry.changedAt} · {entry.changeType} by {entry.changedBy}
                    {entry.reason ? ` — ${entry.reason}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
