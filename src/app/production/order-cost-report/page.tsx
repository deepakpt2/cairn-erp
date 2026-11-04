import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  getProductionOrderCostReport,
  PRODUCTION_ORDER_COST_REPORT_CAPABILITY,
  PRODUCTION_ORDER_COST_REPORT_ROUTE,
  ProductionOrderCostReportError,
  type ProductionOrderCostReport,
} from '@/modules/production/order-cost-report';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

function format(amount: string, currency: string): string {
  return `${amount} ${currency}`;
}

export default async function ProductionOrderCostReportPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PRODUCTION_ORDER_COST_REPORT_ROUTE);
  if (!can(session, PRODUCTION_ORDER_COST_REPORT_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Production order cost report</h1>
        <p className="mt-2 text-sm">You do not hold {PRODUCTION_ORDER_COST_REPORT_CAPABILITY}.</p>
      </main>
    );
  }

  const raw = await searchParams;
  const orderNumber = one(raw.order);
  const fiscalYear = one(raw.fiscalYear);
  const periodFrom = one(raw.periodFrom);
  const periodTo = one(raw.periodTo);
  let report: ProductionOrderCostReport | null = null;
  let error = '';
  if (orderNumber) {
    try {
      report = await getProductionOrderCostReport({
        client: session.user.client,
        orderNumber,
        fiscalYear,
        periodFrom,
        periodTo,
      });
    } catch (caught) {
      error = caught instanceof ProductionOrderCostReportError
        ? caught.message
        : 'The production-order cost report could not be read.';
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6" data-production-order-cost-report>
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{PRODUCTION_ORDER_COST_REPORT_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Production order cost report</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-4xl text-sm text-ink-soft">
          Read-only posted journal actuals assigned to one production order. Debit, credit, and net are shown separately in document and local currency.
          Confirmation activity quantities are not monetarily valued here; plan rates are not actuals. This report does not settle, post, or calculate WIP or variance.
        </p>
      </header>

      <form className="grid gap-2 sm:grid-cols-5" method="get">
        <label className="grid gap-1 text-sm sm:col-span-2">
          Production order
          <input className="input" name="order" defaultValue={orderNumber} maxLength={12} required />
        </label>
        <label className="grid gap-1 text-sm">
          Fiscal year (optional)
          <input className="input" name="fiscalYear" defaultValue={fiscalYear} inputMode="numeric" maxLength={4} />
        </label>
        <label className="grid gap-1 text-sm">
          Period from
          <input className="input" name="periodFrom" defaultValue={periodFrom} inputMode="numeric" min={1} max={16} />
        </label>
        <label className="grid gap-1 text-sm">
          Period to
          <input className="input" name="periodTo" defaultValue={periodTo} inputMode="numeric" min={1} max={16} />
        </label>
        <button className="btn sm:col-span-5 sm:justify-self-start" type="submit">Read posted costs</button>
      </form>

      {error && <p role="status" data-cost-report-error className="text-sm text-danger">{error}</p>}
      {!orderNumber && <p className="text-sm text-ink-soft">Enter an order number to read its posted journal lines. No order is selected by default.</p>}

      {report && (
        <section className="space-y-4" data-cost-report-order={report.order.orderNumber}>
          <header className="rounded border border-line p-3 text-sm">
            <p className="font-medium">Order {report.order.orderNumber} · {report.order.materialNumber} · Plant {report.order.plant}</p>
            <p>Type {report.order.orderType ?? 'not recorded'} · Status {report.order.status} · Company {report.order.companyCode ?? 'not recorded'} · Order currency {report.order.currency ?? 'not recorded'}</p>
            {report.filter.fiscalYear !== null && (
              <p>Journal posting period filter: fiscal year {report.filter.fiscalYear}{report.filter.periodFrom !== null || report.filter.periodTo !== null ? `, periods ${report.filter.periodFrom ?? 1}–${report.filter.periodTo ?? 16}` : ', all periods'}.</p>
            )}
          </header>

          <section aria-label="Cost totals" className="space-y-2">
            <h2 className="text-lg font-semibold">Totals by company and currency</h2>
            {report.totals.length === 0 ? (
              <p data-cost-report-empty className="text-sm text-ink-soft">No posted journal lines cite this order in the selected period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-cost-report-totals>
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
          </section>

          {report.lines.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">Journal lines ({report.lines.length})</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-cost-report-lines>
                  <thead><tr className="text-left text-ink-faint"><th>Posting date / period</th><th>Document</th><th>Status</th><th>Origin</th><th>G/L</th><th>Dr/Cr</th><th>Document amount</th><th>Local amount</th><th>Material / plant</th><th>Text</th></tr></thead>
                  <tbody>{report.lines.map((line) => (
                    <tr key={`${line.documentNumber}-${line.fiscalYear}-${line.lineNumber}`} data-cost-report-line={`${line.documentNumber}/${line.lineNumber}`}>
                      <td>{line.postingDate} / {line.fiscalYear}-{String(line.postingPeriod).padStart(2, '0')}</td>
                      <td>{line.displayNumber} · line {line.lineNumber}</td>
                      <td>{line.status}{line.reversalOf ? ` · reversal of ${line.reversalOf}` : ''}{line.reversedBy ? ` · reversed by ${line.reversedBy}` : ''}</td>
                      <td>{line.originClass ?? 'not recorded'}{line.originKey ? ` · ${line.originKey}` : ''}</td>
                      <td>{line.glAccount}</td>
                      <td>{line.debitCredit === 'S' ? 'Debit' : 'Credit'}</td>
                      <td>{format(line.amountDocument, line.lineCurrency)}</td>
                      <td>{format(line.amountLocal, line.localCurrency)}</td>
                      <td>{line.material ?? '—'} / {line.plant ?? '—'}</td>
                      <td>{line.lineText ?? '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          )}

          <aside className="space-y-1 rounded border border-line p-3 text-sm" aria-label="Report limits">
            <h2 className="font-semibold">Basis and limits</h2>
            {report.gaps.map((gap) => <p key={gap}>{gap}</p>)}
            <p>Material-document values are source drilldown only; they are not added to these journal totals.</p>
          </aside>
        </section>
      )}
    </main>
  );
}
