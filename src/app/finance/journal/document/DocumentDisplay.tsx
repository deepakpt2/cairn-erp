import Link from 'next/link';

import type { JournalDocumentView } from '@/modules/finance/document-display';

const inputCls = 'field-input';
const labelCls = 'field-label';

const ACCOUNT_TYPE_LEGEND = 'Account type: S G/L · D supplier · K customer';

export default function DocumentDisplay({ document, parkedNumber, notFound, mismatch, canDisplay, canFlow }: {
  document: JournalDocumentView | null;
  parkedNumber: string | null;
  notFound: boolean;
  mismatch: string | null;
  canDisplay: boolean;
  canFlow: boolean;
}) {
  // Where the document was posted in the local currency, the two sets of totals
  // are the same figures. Printing them twice reads as a fault in the screen,
  // so the totals say which currencies they cover once, in the hint below.
  const sameCurrency = document ? document.documentCurrency === document.localCurrency : false;
  return (
    <>
      <section aria-labelledby="dd-lookup" className="panel p-4">
        <h2 id="dd-lookup" className="section-head">Document key</h2>
        <form method="get" className="mt-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              <span className={labelCls}>Document number</span>
              <input name="document" className={inputCls} placeholder="JE-000001" required />
            </label>
            <label>
              <span className={labelCls}>Company code</span>
              <input name="company" className={inputCls} placeholder="1000" />
            </label>
            <label>
              <span className={labelCls}>Fiscal year</span>
              <input name="year" className={inputCls} placeholder="2026" required />
            </label>
          </div>
          <button type="submit" className="btn btn-primary mt-3 min-h-11 sm:min-h-8" disabled={!canDisplay}>
            Display
          </button>
          {/* How a document is identified, as a hint rather than a paragraph:
              it is read once, next to the fields it explains. */}
          <p className="field-hint">The number and the fiscal year identify the document.</p>
          {!canDisplay && (
            <p className="field-hint">You do not hold the document display capability.</p>
          )}
        </form>
        {mismatch && (
          <p role="alert" data-company-mismatch className="mt-2 text-sm text-red-700">{mismatch}</p>
        )}
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
          <section aria-labelledby="dd-header" className="panel p-4">
            <h2 id="dd-header" className="section-head">
              Document {document.displayNumber || document.documentNumber}
              <span className="count">{document.status}</span>
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

          <section aria-labelledby="dd-lines" className="panel p-4">
            <h2 id="dd-lines" className="section-head">
              Line items
              <span className="count">{document.lines.length} lines</span>
            </h2>
            <div className="mt-2 overflow-x-auto">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th title={ACCOUNT_TYPE_LEGEND}>Acct type</th>
                    <th>Account</th>
                    <th>D/C</th>
                    <th>Document amount</th>
                    <th>Currency</th>
                    <th>Local amount</th>
                    <th>Partner</th>
                    <th>Cost centre</th>
                    <th>Profit centre</th>
                    <th>Assignment</th>
                    <th>Tax</th>
                    <th>Clearing</th>
                    <th>Text</th>
                  </tr>
                </thead>
                <tbody>
                  {document.lines.map((line) => (
                    <tr key={line.lineNumber} data-account-type={line.accountType}>
                      <td>{line.lineNumber}</td>
                      <td className="code">{line.accountType}</td>
                      <td>{line.glAccount}</td>
                      <td>{line.debitCredit}</td>
                      <td className="num">{line.amountDocument.toFixed(2)}</td>
                      <td>{line.currency}</td>
                      <td className="num">{line.amountLocal.toFixed(2)}</td>
                      <td>{line.businessPartner ?? '—'}</td>
                      <td>{line.costCenter ?? '—'}</td>
                      <td>{line.profitCenter ?? '—'}</td>
                      <td>{line.assignment ?? '—'}</td>
                      <td>{line.taxCode ?? '—'}</td>
                      <td>{line.clearingDocument ?? '—'}</td>
                      <td>{line.lineText ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
                {/* Totals are data: they belong in the table, beneath the
                    columns they total, rather than in a sentence under it. */}
                <tfoot>
                  <tr>
                    <td colSpan={4}>Debit</td>
                    <td className="num">{document.debitDocument.toFixed(2)}</td>
                    <td>{document.documentCurrency}</td>
                    <td className="num">{document.debitLocal.toFixed(2)}</td>
                    <td colSpan={7} />
                  </tr>
                  <tr>
                    <td colSpan={4}>Credit</td>
                    <td className="num">{document.creditDocument.toFixed(2)}</td>
                    <td>{document.documentCurrency}</td>
                    <td className="num">{document.creditLocal.toFixed(2)}</td>
                    <td colSpan={7} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="field-hint">
              {sameCurrency
                ? `Totals in ${document.documentCurrency}. `
                : `Totals: document ${document.documentCurrency}, local ${document.localCurrency}. `}
              Amounts stand as posted; nothing is recalculated here. {ACCOUNT_TYPE_LEGEND}.
            </p>
          </section>

          <section aria-labelledby="dd-flow" className="panel p-4">
            <h2 id="dd-flow" className="section-head">
              Document flow
              {canFlow && document.flow.length > 0 && (
                <span className="count">{document.flow.length} linked</span>
              )}
            </h2>
            {!canFlow ? (
              <p className="mt-2 field-hint">
                The flow around the document needs the document flow capability; this
                display shows the document alone.
              </p>
            ) : document.flow.length === 0 ? (
              <p className="mt-2 text-sm text-ink-soft">No related documents stand linked.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {document.flow.map((link, i) => (
                  <li key={i}>
                    <span className="text-ink-soft">{link.kind.replaceAll('_', ' ')}: </span>
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

          <section aria-labelledby="dd-history" className="panel p-4">
            <h2 id="dd-history" className="section-head">
              Change history
              {document.history.length > 0 && (
                <span className="count">{document.history.length} changes</span>
              )}
            </h2>
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
