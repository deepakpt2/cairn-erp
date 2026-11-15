import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  getInternalOrderCostReport,
  INTERNAL_ORDER_COST_REPORT_CAPABILITY,
  INTERNAL_ORDER_COST_REPORT_ROUTE,
  InternalOrderCostReportError,
  type InternalOrderCostLine,
  type InternalOrderCostReport,
} from '@/modules/foundation/internal-order-cost-report';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

function format(amount: string, currency: string): string {
  return `${amount} ${currency}`;
}

// A line's own document is linked by company, year and number. A reversal partner may sit in another
// fiscal year, so its link (in the table below) names the document only and the screen resolves the rest.
function documentHref(line: Pick<InternalOrderCostLine, 'documentNumber' | 'companyCode' | 'fiscalYear'>): string {
  const query = new URLSearchParams({ document: line.documentNumber, company: line.companyCode, year: String(line.fiscalYear) });
  return `/finance/journal/document?${query.toString()}`;
}

export default async function InternalOrderLineItemsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(INTERNAL_ORDER_COST_REPORT_ROUTE);
  if (!can(session, INTERNAL_ORDER_COST_REPORT_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Internal order line items</h1>
        <p className="mt-2 text-sm">You do not hold {INTERNAL_ORDER_COST_REPORT_CAPABILITY}.</p>
      </main>
    );
  }

  const raw = await searchParams;
  // `orderNumber` is the form's field; `order` is what related-screen links pass.
  const orderNumber = one(raw.orderNumber) || one(raw.order);
  const fiscalYear = one(raw.fiscalYear);
  const periodFrom = one(raw.periodFrom);
  const periodTo = one(raw.periodTo);
  const glAccount = one(raw.glAccount);
  let report: InternalOrderCostReport | null = null;
  let error = '';
  let remedy = '';
  if (orderNumber) {
    try {
      report = await getInternalOrderCostReport({
        client: session.user.client,
        heldCapabilities: session.user.capabilities,
        orderNumber,
        fiscalYear,
        periodFrom,
        periodTo,
        glAccount,
      });
    } catch (caught) {
      if (caught instanceof InternalOrderCostReportError) {
        error = caught.message;
        remedy = caught.remedy ?? '';
      } else {
        error = 'The internal order line items could not be read.';
      }
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6" data-internal-order-line-items>
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{INTERNAL_ORDER_COST_REPORT_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Internal order line items</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-4xl text-sm text-ink-soft">
          Read-only actual journal lines posted to one internal order: posted and reversed documents, never parked ones.
          Debit, credit, and net are shown separately in document and local currency. Plan, budget and commitments are not shown.
          This report does not settle or post anything.
        </p>
      </header>

      <form className="grid gap-2 sm:grid-cols-6" method="get">
        <label className="grid gap-1 text-sm sm:col-span-2">
          Internal order
          <input className="input" name="orderNumber" defaultValue={orderNumber} maxLength={20} required />
        </label>
        <label className="grid gap-1 text-sm">
          Fiscal year (optional)
          <input className="input" name="fiscalYear" defaultValue={fiscalYear} inputMode="numeric" maxLength={4} />
        </label>
        <label className="grid gap-1 text-sm">
          Period from
          <input className="input" name="periodFrom" type="number" defaultValue={periodFrom} min={1} max={16} />
        </label>
        <label className="grid gap-1 text-sm">
          Period to
          <input className="input" name="periodTo" type="number" defaultValue={periodTo} min={1} max={16} />
        </label>
        <label className="grid gap-1 text-sm">
          Cost element (G/L)
          <input className="input" name="glAccount" defaultValue={glAccount} maxLength={10} />
        </label>
        <button className="btn sm:col-span-6 sm:justify-self-start" type="submit">Read line items</button>
      </form>

      {error && (
        <div role="status" data-line-items-error className="text-sm text-danger">
          <p>{error}</p>
          {remedy && <p>{remedy}</p>}
        </div>
      )}
      {!orderNumber && <p className="text-sm text-ink-soft">Enter an internal order number to read its posted journal lines. No order is selected by default.</p>}

      {report && (
        <section className="space-y-4" data-line-items-order={report.order.orderNumber}>
          <header className="space-y-1 rounded border border-line p-3 text-sm">
            <p className="font-medium">
              Order {report.order.orderNumber} · {report.order.description} · Type {report.order.orderType}
            </p>
            <p>
              Company {report.order.companyCode} · Controlling area {report.order.controllingArea} · Order currency {report.order.currency}
              {' '}· Valid {report.order.startDate} – {report.order.endDate}
            </p>
            <p>Cost centre {report.order.costCenter ?? '—'} · Profit centre {report.order.profitCenter ?? '—'}</p>
            {(report.order.statistical || report.order.markedForDeletion || report.order.isPostingLocked) && (
              <p className="flex flex-wrap gap-2 font-medium text-danger" data-line-items-markers>
                {report.order.statistical && <span data-marker="statistical">Statistical order: its postings are statistical, not real cost.</span>}
                {report.order.markedForDeletion && <span data-marker="deletion">Marked for deletion.</span>}
                {report.order.isPostingLocked && <span data-marker="locked">Locked for posting.</span>}
              </p>
            )}
            {report.filter.fiscalYear !== null && (
              <p>Filter: fiscal year {report.filter.fiscalYear}{report.filter.periodFrom !== null || report.filter.periodTo !== null ? `, periods ${report.filter.periodFrom ?? 1}–${report.filter.periodTo ?? 16}` : ', all periods'}{report.filter.glAccount ? `, G/L ${report.filter.glAccount}` : ''}.</p>
            )}
            {report.filter.fiscalYear === null && report.filter.glAccount && <p>Filter: G/L {report.filter.glAccount}, all years.</p>}
          </header>

          <aside className="space-y-1 rounded border border-line p-3 text-sm" aria-label="What this report cannot show" data-line-items-gaps>
            <h2 className="font-semibold">What this report cannot show</h2>
            <ul className="list-disc pl-5">
              {report.gaps.map((gap) => <li key={gap}>{gap}</li>)}
            </ul>
          </aside>

          <section aria-label="Totals" className="space-y-2">
            <h2 className="text-lg font-semibold">Totals by company and currency</h2>
            {report.totals.length === 0 ? (
              <p data-line-items-empty className="text-sm text-ink-soft">Nothing has been posted to this order for the selected filter.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="grid-table text-sm" data-line-items-totals>
                  <thead><tr className="text-left text-ink-faint"><th>Company</th><th>Document currency</th><th>Debits</th><th>Credits</th><th>Net</th><th>Local currency</th><th>Local debits</th><th>Local credits</th><th>Local net</th></tr></thead>
                  <tbody>{report.totals.map((total) => (
                    <tr key={`${total.companyCode}-${total.documentCurrency}-${total.localCurrency}`}>
                      <td>{total.companyCode}</td><td>{total.documentCurrency}</td>
                      <td>{format(total.debitDocument, total.documentCurrency)}</td>
                      <td>{format(total.creditDocument, total.documentCurrency)}</td>
                      <td>{format(total.netDocument, total.documentCurrency)}</td>
                      <td>{total.localCurrency}</td>
                      <td>{format(total.debitLocal, total.localCurrency)}</td>
                      <td>{format(total.creditLocal, total.localCurrency)}</td>
                      <td>{format(total.netLocal, total.localCurrency)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <p className="text-sm font-medium" data-line-items-net>
              {report.netInOrderCurrency !== null
                ? <>Net in order currency: {format(report.netInOrderCurrency, report.order.currency)}</>
                : <span className="text-danger">No net in order currency {report.order.currency} is stated: the lines are in more than one local currency. See the gaps above.</span>}
            </p>
          </section>

          {report.lines.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">Line items ({report.lines.length})</h2>
              <div className="overflow-x-auto">
                <table className="grid-table text-sm" data-line-items-lines>
                  <thead><tr className="text-left text-ink-faint"><th>Posting date</th><th>Document</th><th>Type</th><th>Year / period</th><th>G/L</th><th>Dr/Cr</th><th>Document amount</th><th>Local amount</th><th>Text</th><th>Reversal</th></tr></thead>
                  <tbody>{report.lines.map((line) => (
                    <tr key={`${line.documentNumber}-${line.fiscalYear}-${line.lineNumber}`} data-line-item={`${line.documentNumber}/${line.lineNumber}`}>
                      <td>{line.postingDate}</td>
                      <td><Link className="underline" href={documentHref(line)}>{line.displayNumber}</Link> · line {line.lineNumber}</td>
                      <td>{line.documentType}</td>
                      <td>{line.fiscalYear}-{String(line.postingPeriod).padStart(2, '0')}</td>
                      <td>{line.glAccount}</td>
                      <td>{line.debitCredit === 'S' ? 'Debit' : 'Credit'}</td>
                      <td>{format(line.amountDocument, line.lineCurrency)}</td>
                      <td>{format(line.amountLocal, line.localCurrency)}</td>
                      <td>{line.lineText ?? '—'}</td>
                      <td>
                        {line.reversalOf && <span>Reversal of <Link className="underline" href={`/finance/journal/document?${new URLSearchParams({ document: line.reversalOf }).toString()}`}>{line.reversalOf}</Link></span>}
                        {line.reversedBy && <span>Reversed by <Link className="underline" href={`/finance/journal/document?${new URLSearchParams({ document: line.reversedBy }).toString()}`}>{line.reversedBy}</Link></span>}
                        {!line.reversalOf && !line.reversedBy && '—'}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          )}
        </section>
      )}
    </main>
  );
}
