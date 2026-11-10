import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import {
  type AnalysisFilter, type AnalysisKind, type GroupBy, type Period,
  ANALYSIS_KIND_MEANING, ANALYSIS_KINDS, ANALYSIS_LIMIT, GROUP_BY, GROUP_BY_MEANING,
  PERIODS, listAnalysis,
} from '@/modules/sales/analysis';
import { listRegisterChoices } from '@/modules/sales/registers';

export const dynamic = 'force-dynamic';

const ROUTE = '/sales/analysis';
const CAPABILITY = 'SALES.ANALYSIS.LIST';

const asKind = (value: string | undefined): AnalysisKind => (
  (ANALYSIS_KINDS as readonly string[]).includes(value ?? '') ? value as AnalysisKind : 'SALES'
);

const asGroupBy = (value: string | undefined): GroupBy => (
  (GROUP_BY as readonly string[]).includes(value ?? '') ? value as GroupBy : 'CUSTOMER'
);

const asPeriod = (value: string | undefined): Period => (
  (PERIODS as readonly string[]).includes(value ?? '') ? value as Period : 'TOTAL'
);

const one = (value: string | string[] | undefined): string => (
  Array.isArray(value) ? value[0] ?? '' : value ?? ''
);

const KIND_LABEL: Record<AnalysisKind, string> = {
  SALES: 'Sales',
  BACKLOG: 'Backlog',
  RETURNS: 'Returns',
  MARGIN: 'Margin',
};

const PERIOD_LABEL: Record<Period, string> = {
  TOTAL: 'Whole period',
  MONTH: 'By month',
  QUARTER: 'By quarter',
  YEAR: 'By year',
};

/** What the quantity column counts, which is a different thing in each analysis. */
const QUANTITY_LABEL: Record<AnalysisKind, string> = {
  SALES: 'Billed',
  MARGIN: 'Billed',
  BACKLOG: 'Open',
  RETURNS: 'Returned',
};

/**
 * Sales analysis — SAP's MC+I and MCTA.
 *
 * A register answers "show me the documents". An analysis answers what they add up to, and it is read
 * by somebody who is not about to do anything with what they see — which is why the screen says what
 * each number is rather than leaving a clerk to work it out from a column heading.
 *
 * Three things it will not do, all of them deliberate:
 *
 * It will not add money across currencies. Every row carries its currency and the totals are printed
 * once per currency, because a single total over two currencies is not a number.
 *
 * It will not print a margin where no cost stands. The margin is read from the statistical cost
 * condition the pricing carried, and a line priced without one has no margin here — not a margin
 * equal to its revenue, which is the most dangerous figure a margin report can print.
 *
 * It will not total the table. The totals are the totals of the rows shown, so what a reader adds up
 * on the screen is what the screen says.
 */
export default async function SalesAnalysisPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;

  const kind = asKind(one(params.kind));
  const groupBy = asGroupBy(one(params.groupBy));
  const period = asPeriod(one(params.period));
  const filter: AnalysisFilter = {
    customerNumber: one(params.customerNumber),
    materialNumber: one(params.materialNumber),
    salesOrg: one(params.salesOrg),
    plant: one(params.plant),
    documentType: one(params.documentType),
    currency: one(params.currency),
    dateFrom: one(params.dateFrom),
    dateTo: one(params.dateTo),
  };

  const choices = await listRegisterChoices(client);
  const analysis = await listAnalysis(client, { kind, filter, groupBy, period });

  const query = (next: Record<string, string>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ kind, groupBy, period, ...filter, ...next })) {
      if (value) search.set(key, value);
    }
    return `${ROUTE}?${search.toString()}`;
  };

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Sales analysis</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          What the documents add up to, grouped the way the business asks about it. Read from the
          documents that stand rather than from a copy of them, so every figure here ties to the{' '}
          <Link href="/sales/documents" className="underline">billing register</Link> and through it to
          the ledger. Money is never added across currencies, and no margin is printed where the
          pricing carried no cost.
        </p>
      </header>

      <nav aria-label="Analysis" className="flex flex-wrap gap-2">
        {ANALYSIS_KINDS.map((candidate) => (
          <Link
            key={candidate}
            href={query({ kind: candidate })}
            className={`btn min-h-11 sm:min-h-8 ${candidate === kind ? 'btn-primary' : 'btn-default'}`}
          >
            {KIND_LABEL[candidate]}
          </Link>
        ))}
      </nav>

      <nav aria-label="Broken down by" className="flex flex-wrap gap-2">
        {GROUP_BY.map((candidate) => (
          <Link
            key={candidate}
            href={query({ groupBy: candidate })}
            className={`btn min-h-11 sm:min-h-8 ${candidate === groupBy ? 'btn-primary' : 'btn-default'}`}
          >
            {GROUP_BY_MEANING[candidate]}
          </Link>
        ))}
      </nav>

      <nav aria-label="Over the period" className="flex flex-wrap gap-2">
        {PERIODS.map((candidate) => (
          <Link
            key={candidate}
            href={query({ period: candidate })}
            className={`btn min-h-11 sm:min-h-8 ${candidate === period ? 'btn-primary' : 'btn-default'}`}
          >
            {PERIOD_LABEL[candidate]}
          </Link>
        ))}
      </nav>

      <form method="get" action={ROUTE} className="border border-line bg-surface p-4">
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="groupBy" value={groupBy} />
        <input type="hidden" name="period" value={period} />
        <h2 className="text-sm font-semibold">Narrow it</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Customer</span>
            <select name="customerNumber" defaultValue={filter.customerNumber} className="field-input">
              <option value="">Any customer</option>
              {choices.customers.map((row) => (
                <option key={row.partnerNumber} value={row.partnerNumber}>
                  {row.partnerNumber}{row.name ? ` · ${row.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Material</span>
            <select name="materialNumber" defaultValue={filter.materialNumber} className="field-input">
              <option value="">Any material</option>
              {choices.materials.map((row) => (
                <option key={row.materialNumber} value={row.materialNumber}>
                  {row.materialNumber}{row.description ? ` · ${row.description}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Sales organisation</span>
            <select name="salesOrg" defaultValue={filter.salesOrg} className="field-input">
              <option value="">Any sales organisation</option>
              {choices.salesOrgs.map((row) => (
                <option key={row.salesOrg} value={row.salesOrg}>
                  {row.salesOrg}{row.name ? ` · ${row.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Plant</span>
            <select name="plant" defaultValue={filter.plant} className="field-input">
              <option value="">Any plant</option>
              {choices.plants.map((row) => (
                <option key={row.plant} value={row.plant}>
                  {row.plant}{row.name ? ` · ${row.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Document type</span>
            <select name="documentType" defaultValue={filter.documentType} className="field-input">
              <option value="">Any type</option>
              {choices.documentTypes.map((row) => (
                <option key={row.documentType} value={row.documentType}>
                  {row.documentType}{row.name ? ` · ${row.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Currency</span>
            <input
              name="currency"
              defaultValue={filter.currency}
              placeholder="Any currency"
              maxLength={3}
              className="field-input code uppercase"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">From</span>
              <input type="date" name="dateFrom" defaultValue={filter.dateFrom} className="field-input" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">To</span>
              <input type="date" name="dateTo" defaultValue={filter.dateTo} className="field-input" />
            </label>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Read the analysis</button>
          <Link href={`${ROUTE}?kind=${kind}`} className="btn btn-default min-h-11 sm:min-h-8">
            Clear the filter
          </Link>
        </div>
      </form>

      <section aria-labelledby="analysis" className="border border-line bg-surface p-4">
        <h2 id="analysis" className="text-sm font-semibold">{analysis.meaning}</h2>
        <p className="mt-1 text-xs text-ink-faint">
          {GROUP_BY_MEANING[analysis.groupBy].toLowerCase()} · {PERIOD_LABEL[analysis.period].toLowerCase()}
        </p>

        {analysis.rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            {kind === 'RETURNS'
              ? 'Nothing came back in this window. Either no returns have been received, or the tenant has named no returns document types.'
              : kind === 'BACKLOG'
                ? 'Nothing is open. Every order line that stands has been delivered, or what is left is rejected.'
                : 'Nothing answers. Either nothing was billed in this window, or the filter narrowed it to nothing.'}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>{groupBy === 'PERIOD' ? 'Period' : KEY_LABEL[groupBy]}</th>
                  {groupBy !== 'PERIOD' && period !== 'TOTAL' ? <th>Period</th> : null}
                  <th>Curr.</th>
                  <th>Docs</th>
                  <th>{QUANTITY_LABEL[kind]}</th>
                  <th>Net</th>
                  {kind === 'MARGIN' ? <th>Cost</th> : null}
                  {kind === 'MARGIN' ? <th>Margin</th> : null}
                  {kind === 'MARGIN' ? <th>Margin %</th> : null}
                </tr>
              </thead>
              <tbody>
                {analysis.rows.map((row) => (
                  <tr key={`${row.key}/${row.period}/${row.currency}`}>
                    <td className="font-mono">
                      {groupBy === 'PERIOD' ? row.period : row.key}
                      {row.keyName ? <span className="text-ink-faint"> · {row.keyName}</span> : null}
                    </td>
                    {groupBy !== 'PERIOD' && period !== 'TOTAL' ? <td>{row.period}</td> : null}
                    <td className="font-mono">{row.currency}</td>
                    <td className="font-mono">{row.documents}</td>
                    <td className="font-mono">{row.quantity}</td>
                    <td className="font-mono">{row.netValue}</td>
                    {kind === 'MARGIN' ? (
                      <>
                        <td className="font-mono">{row.costValue ?? '—'}</td>
                        <td className="font-mono">{row.marginValue ?? '—'}</td>
                        <td className="font-mono">
                          {row.marginPercent === null ? '—' : `${row.marginPercent}%`}
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-3 space-y-1">
              {analysis.totals.map((total) => (
                <p key={total.currency} className="text-xs text-ink-faint">
                  Total of what is shown, in {total.currency}: {total.quantity} {QUANTITY_LABEL[kind].toLowerCase()},
                  {' '}{total.netValue} net
                  {total.marginValue !== null
                    ? `, ${total.costValue} cost, ${total.marginValue} margin (${total.marginPercent}%)`
                    : null}
                  {kind === 'MARGIN' && !total.costIsComplete
                    ? '. The cost does not cover every line shown, because some were priced without a cost condition — the margin is understated rather than guessed.'
                    : null}
                </p>
              ))}
              <p className="text-xs text-ink-faint">
                {analysis.rows.length} of {analysis.count} answering
                {analysis.truncated
                  ? ` — cut at ${ANALYSIS_LIMIT}, so narrow the filter to see the rest`
                  : ''}. The totals are the totals of what is shown, not of the whole of the table.
              </p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

const KEY_LABEL: Record<GroupBy, string> = {
  CUSTOMER: 'Customer',
  MATERIAL: 'Material',
  SALES_ORG: 'Sales org',
  DOCUMENT_TYPE: 'Type',
  PERIOD: 'Period',
};
