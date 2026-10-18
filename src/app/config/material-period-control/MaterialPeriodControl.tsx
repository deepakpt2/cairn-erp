'use client';

/**
 * Material period control (SCR-054 / OMSY; inert since stage 1).
 *
 * One control record per company code: the current and previous
 * material posting periods and the backposting indicators. Companies
 * without a record show as uninitialized. Initialization, indicator
 * maintenance and the period shift land with the service.
 */
export interface MaterialPeriodRow {
  companyCode: string;
  companyName: string;
  initialized: boolean;
  currentYear: number | null;
  currentPeriod: number | null;
  previousYear: number | null;
  previousPeriod: number | null;
  allowBackposting: boolean;
  disallowBackpostingAfterChange: boolean;
  lastChangedBy: string | null;
}

function period(year: number | null, periodValue: number | null): string {
  if (year === null || periodValue === null) return '—';
  return `${year} / ${String(periodValue).padStart(2, '0')}`;
}

export default function MaterialPeriodControl({ rows }: { rows: MaterialPeriodRow[] }) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="material-period-grid" className="space-y-3">
        <h2 id="material-period-grid" className="text-base font-semibold">
          Company control records
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-faint">No company codes stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Company code</th>
                  <th className="py-2 pe-3">Current period</th>
                  <th className="py-2 pe-3">Previous period</th>
                  <th className="py-2 pe-3">Backposting to previous</th>
                  <th className="py-2 pe-3">Disallow after change</th>
                  <th className="py-2 pe-3">Last changed by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.companyCode} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-medium">
                      {row.companyCode}
                      <span className="block text-xs font-normal text-ink-soft">
                        {row.companyName}
                      </span>
                    </td>
                    {row.initialized ? (
                      <>
                        <td className="py-2 pe-3">{period(row.currentYear, row.currentPeriod)}</td>
                        <td className="py-2 pe-3">
                          {period(row.previousYear, row.previousPeriod)}
                        </td>
                        <td className="py-2 pe-3">{row.allowBackposting ? 'Allowed' : 'No'}</td>
                        <td className="py-2 pe-3">
                          {row.disallowBackpostingAfterChange ? 'Yes' : 'No'}
                        </td>
                        <td className="py-2 pe-3">{row.lastChangedBy ?? '—'}</td>
                      </>
                    ) : (
                      <td className="py-2 pe-3 text-ink-faint" colSpan={5}>
                        Not initialized
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
