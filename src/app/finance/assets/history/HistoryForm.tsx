import Link from 'next/link';

import type { AssetHistorySelection, AssetHistorySheet } from '@/modules/finance/asset-history';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';
const num = (n: number) => n.toFixed(2);

export interface HistoryDefaults {
  companyCodeFrom: string;
  companyCodeTo: string;
  assetClassFrom: string;
  assetClassTo: string;
  assetNumberFrom: string;
  assetNumberTo: string;
  fiscalYear: string;
  depreciationArea: string;
  reportingDate: string;
  sortVersion: string;
  layout: string;
}

/**
 * Asset history sheet (SCR-095): the selection is a judged GET so
 * the sheet is bookmarkable and the export re-runs the identical
 * selection server-side.
 */
export default function HistoryForm({ canReport, defaults, sheet, exportQuery }: {
  canReport: boolean;
  defaults: HistoryDefaults;
  sheet: AssetHistorySheet | null;
  exportQuery: string;
}) {
  const d = defaults;
  return (
    <>
      <section aria-labelledby="ah-select" className="border border-line bg-surface p-4">
        <h2 id="ah-select" className="text-sm font-semibold">Selection</h2>
        <form className="mt-3" method="GET">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block"><span className={labelCls}>Company code from</span>
              <input name="companyCodeFrom" className={inputCls} placeholder="1000" defaultValue={d.companyCodeFrom} required /></label>
            <label className="block"><span className={labelCls}>Company code to</span>
              <input name="companyCodeTo" className={inputCls} placeholder="1099" defaultValue={d.companyCodeTo} /></label>
            <label className="block"><span className={labelCls}>Asset class from</span>
              <input name="assetClassFrom" className={inputCls} placeholder="1000" defaultValue={d.assetClassFrom} /></label>
            <label className="block"><span className={labelCls}>Asset class to</span>
              <input name="assetClassTo" className={inputCls} placeholder="9999" defaultValue={d.assetClassTo} /></label>
            <label className="block"><span className={labelCls}>Asset number from</span>
              <input name="assetNumberFrom" className={inputCls} defaultValue={d.assetNumberFrom} /></label>
            <label className="block"><span className={labelCls}>Asset number to</span>
              <input name="assetNumberTo" className={inputCls} defaultValue={d.assetNumberTo} /></label>
            <label className="block"><span className={labelCls}>Fiscal year</span>
              <input name="fiscalYear" className={inputCls} placeholder="2026" defaultValue={d.fiscalYear} required /></label>
            <label className="block"><span className={labelCls}>Depreciation area</span>
              <input name="depreciationArea" className={inputCls} defaultValue={d.depreciationArea || '01'} required /></label>
            <label className="block"><span className={labelCls}>Reporting date</span>
              <input type="date" name="reportingDate" className={inputCls} defaultValue={d.reportingDate} /></label>
            <label className="block"><span className={labelCls}>Sort version</span>
              <input name="sortVersion" className={inputCls} placeholder="0001" defaultValue={d.sortVersion} /></label>
            <label className="block"><span className={labelCls}>Display variant</span>
              <input name="layout" className={inputCls} placeholder="/DEFAULT" defaultValue={d.layout} /></label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canReport}>
              Execute
            </button>
            {sheet && (
              <Link className="btn btn-default min-h-11 sm:min-h-8" href={`/finance/assets/history/export?${exportQuery}`}>
                Export CSV
              </Link>
            )}
          </div>
          {!canReport && (
            <p className="mt-2 text-sm text-ink-soft">You do not hold the asset reporting capability.</p>
          )}
          <p className="mt-2 text-sm text-ink-soft">
            Read-only: beginning balances plus signed movements reconcile to ending balances,
            from posted records only — running this sheet changes nothing.
          </p>
        </form>
      </section>

      <section aria-labelledby="ah-grid" className="border border-line bg-surface p-4">
        <h2 id="ah-grid" className="text-sm font-semibold">Asset history sheet</h2>
        {!sheet ? (
          <p className="mt-2 text-sm text-ink-soft">Execute to build the sheet for the selection.</p>
        ) : (
          <div className="mt-2 text-sm">
            <p>
              Fiscal year {sheet.fiscalYear} · Area {sheet.depreciationArea} · Reporting date {sheet.reportingDate} ·
              {' '}{sheet.totalRows} asset(s), page {sheet.page}
            </p>
            {sheet.warnings.map((w) => (
              <p key={w} className="mt-1 text-ink-soft">{w}</p>
            ))}
            <div className="mt-2 overflow-x-auto">
              <table className="grid-table text-left">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th>Asset</th><th>Description</th>
                    <th>Capitalized</th>
                    <th>Acq. beginning</th><th>Acquisitions</th>
                    <th>Retirements</th><th>Acq. ending</th>
                    <th>Depr. beginning</th><th>Depr. year</th>
                    <th>Depr. on retirements</th><th>Depr. ending</th>
                    <th>Net book value</th><th>Curr.</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.map((row) => (
                    <tr key={`${row.companyCode}-${row.assetNumber}-${row.subNumber}`}>
                      <td>
                        <Link className="text-teal-800 underline" href={`/finance/assets/change?company=${row.companyCode}&asset=${row.assetNumber}&sub=${row.subNumber}`}>
                          {row.companyCode} · {row.assetClass} · {row.assetNumber}/{row.subNumber}
                        </Link>
                      </td>
                      <td>{row.description} ({row.status})</td>
                      <td>{row.capitalizationDate ?? '—'}</td>
                      <td>{num(row.acquisitionBeginning)}</td>
                      <td>{num(row.acquisitions)}</td>
                      <td>{num(row.retirements)}</td>
                      <td>{num(row.acquisitionEnding)}</td>
                      <td>{num(row.depreciationBeginning)}</td>
                      <td>{num(row.depreciationYear)}</td>
                      <td>{num(row.depreciationOnRetirements)}</td>
                      <td>{num(row.depreciationEnding)}</td>
                      <td>{num(row.netBookValue)}</td>
                      <td>{row.currency}</td>
                    </tr>
                  ))}
                  {sheet.classTotals.map((t) => (
                    <tr key={`class-${t.assetClass}-${t.currency}`} className="bg-slate-50 font-medium">
                      <td colSpan={3}>Class {t.assetClass} subtotal</td>
                      <td>{num(t.acquisitionBeginning)}</td>
                      <td>{num(t.acquisitions)}</td>
                      <td>{num(t.retirements)}</td>
                      <td>{num(t.acquisitionEnding)}</td>
                      <td>{num(t.depreciationBeginning)}</td>
                      <td>{num(t.depreciationYear)}</td>
                      <td>{num(t.depreciationOnRetirements)}</td>
                      <td>{num(t.depreciationEnding)}</td>
                      <td>{num(t.netBookValue)}</td>
                      <td>{t.currency}</td>
                    </tr>
                  ))}
                  {sheet.grandTotals.map((t) => (
                    <tr key={`grand-${t.currency}`} className="border-t-2 font-semibold">
                      <td colSpan={3}>Grand total</td>
                      <td>{num(t.acquisitionBeginning)}</td>
                      <td>{num(t.acquisitions)}</td>
                      <td>{num(t.retirements)}</td>
                      <td>{num(t.acquisitionEnding)}</td>
                      <td>{num(t.depreciationBeginning)}</td>
                      <td>{num(t.depreciationYear)}</td>
                      <td>{num(t.depreciationOnRetirements)}</td>
                      <td>{num(t.depreciationEnding)}</td>
                      <td>{num(t.netBookValue)}</td>
                      <td>{t.currency}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

export type { AssetHistorySelection };
