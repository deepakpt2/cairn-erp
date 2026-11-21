
import { can, requireSession } from '@/platform/auth/current';
import { ReportExport } from '@/ui/output/ReportExport';
import {
  getProductionOrderCostReport,
  PRODUCTION_ORDER_COST_REPORT_CAPABILITY,
  PRODUCTION_ORDER_COST_REPORT_ROUTE,
  ProductionOrderCostReportError,
  type ProductionOrderCostReport,
} from '@/modules/production/order-cost-report';
import { Page } from '@/ui/kit';

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
      <Page
      title="Production order cost report" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold {PRODUCTION_ORDER_COST_REPORT_CAPABILITY}.</p>
      </Page>
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
        authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
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
    <Page
      title="Production order cost report" code={PRODUCTION_ORDER_COST_REPORT_CAPABILITY}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">
              Read-only posted journal actuals assigned to one production order. Debit, credit, and net are shown separately in document and local currency.
              Activity cost posted from a confirmation is an actual quantity valued at a configured plan rate (the rate basis is shown) and is counted once, as its journal line; plan rates are not actuals.
              A confirmed activity that is not costed is shown with its reason. This report does not settle, post, or calculate WIP or variance.
            </p>
          {report && <div className="mt-3"><ReportExport report="production-order-cost" params={raw} /></div>}
        </>
      }
    >

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
                <table className="grid-table text-sm" data-cost-report-totals>
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
                <table className="grid-table text-sm" data-cost-report-lines>
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

          {report.activityCosts.length > 0 && (
            <section className="space-y-2" aria-label="Activity cost of confirmations">
              <h2 className="text-lg font-semibold">Activity cost of confirmations ({report.activityCosts.length})</h2>
              <p className="text-sm text-ink-soft">Evidence of the valuation. A posted amount is already a journal line above and is not added again.</p>
              <div className="overflow-x-auto">
                <table className="grid-table text-sm" data-cost-report-activity>
                  <thead><tr className="text-left text-ink-faint"><th>Confirmation / parameter</th><th>Status</th><th>Quantity</th><th>Sender / activity type</th><th>Rate basis</th><th>Amount</th><th>Posting</th><th>Reason</th></tr></thead>
                  <tbody>{report.activityCosts.map((row) => (
                    <tr key={`${row.confirmationNumber}-${row.parameter}`} data-activity-cost={`${row.confirmationNumber}/${row.parameter}`} data-activity-status={row.status}>
                      <td>{row.confirmationNumber} · {row.parameter}</td>
                      <td>{row.status}</td>
                      <td>{row.quantity} {row.unit}{row.activityQuantity && row.activityUnit && row.activityUnit !== row.unit ? ` = ${row.activityQuantity} ${row.activityUnit}` : ''}</td>
                      <td>{row.costCenter ?? '—'} / {row.activityType ?? '—'}</td>
                      <td>{row.rateBasis ? `Actual quantity at plan rate · plan ${row.planVersion} ${row.ratePeriod}/${row.rateYear} · ${row.fixedPrice} + ${row.variablePrice} per ${row.priceUnit}` : '—'}</td>
                      <td>{row.amount ? format(row.amount, row.currency ?? '') : '—'}</td>
                      <td>{row.journalDocument ? `${row.journalDocument}${row.reversalDocument ? ` · reversed by ${row.reversalDocument}` : ''}` : '—'}</td>
                      <td>{row.message ? `${row.message}${row.remedy ? ` ${row.remedy}` : ''}` : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          )}

          {report.wipPostings.length > 0 && (
            <section className="space-y-2" aria-label="Financial WIP postings">
              <h2 className="text-lg font-semibold">Financial WIP postings ({report.wipPostings.length})</h2>
              <p className="text-sm text-ink-soft">Actual-cost WIP of this order. These documents carry no production order, so they are not in the journal totals above.</p>
              <div className="overflow-x-auto">
                <table className="grid-table text-sm" data-cost-report-wip>
                  <thead><tr className="text-left text-ink-faint"><th>#</th><th>Period</th><th>Kind</th><th>Costs</th><th>Output credits</th><th>Eligible WIP</th><th>Delta</th><th>Balance after</th><th>Accounts (WIP / change)</th><th>Document</th></tr></thead>
                  <tbody>{report.wipPostings.map((row) => (
                    <tr key={row.postingId} data-wip-posting={row.seq}>
                      <td>{row.seq}</td><td>{row.fiscalYear}-{String(row.period).padStart(2, '0')}</td><td>{row.kind}</td>
                      <td>{format(row.costTotal, row.currency)}</td><td>{format(row.outputTotal, row.currency)}</td>
                      <td>{format(row.eligibleWip, row.currency)}</td><td>{format(row.delta, row.currency)}</td><td>{format(row.cumulativeAfter, row.currency)}</td>
                      <td>{row.wipAccount} / {row.changeAccount}</td><td>{row.journalDocument}</td>
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
    </Page>
  );
}
