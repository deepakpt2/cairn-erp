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
      <section aria-labelledby="ah-select" className="rounded-card border border-line bg-surface p-4 shadow-card">
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

      <section aria-labelledby="ah-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
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
              <table className="min-w-full text-left">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">Asset</th><th className="px-2 py-2">Description</th>
                    <th className="px-2 py-2">Capitalized</th>
                    <th className="px-2 py-2">Acq. beginning</th><th className="px-2 py-2">Acquisitions</th>
                    <th className="px-2 py-2">Retirements</th><th className="px-2 py-2">Acq. ending</th>
                    <th className="px-2 py-2">Depr. beginning</th><th className="px-2 py-2">Depr. year</th>
                    <th className="px-2 py-2">Depr. on retirements</th><th className="px-2 py-2">Depr. ending</th>
                    <th className="px-2 py-2">Net book value</th><th className="px-2 py-2">Curr.</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.map((row) => (
                    <tr key={`${row.companyCode}-${row.assetNumber}-${row.subNumber}`} className="border-t border-line">
                      <td className="px-2 py-2">
                        <Link className="text-teal-800 underline" href={`/finance/assets/change?company=${row.companyCode}&asset=${row.assetNumber}&sub=${row.subNumber}`}>
                          {row.companyCode} · {row.assetClass} · {row.assetNumber}/{row.subNumber}
                        </Link>
                      </td>
                      <td className="px-2 py-2">{row.description} ({row.status})</td>
                      <td className="px-2 py-2">{row.capitalizationDate ?? '—'}</td>
                      <td className="px-2 py-2">{num(row.acquisitionBeginning)}</td>
                      <td className="px-2 py-2">{num(row.acquisitions)}</td>
                      <td className="px-2 py-2">{num(row.retirements)}</td>
                      <td className="px-2 py-2">{num(row.acquisitionEnding)}</td>
                      <td className="px-2 py-2">{num(row.depreciationBeginning)}</td>
                      <td className="px-2 py-2">{num(row.depreciationYear)}</td>
                      <td className="px-2 py-2">{num(row.depreciationOnRetirements)}</td>
                      <td className="px-2 py-2">{num(row.depreciationEnding)}</td>
                      <td className="px-2 py-2">{num(row.netBookValue)}</td>
                      <td className="px-2 py-2">{row.currency}</td>
                    </tr>
                  ))}
                  {sheet.classTotals.map((t) => (
                    <tr key={`class-${t.assetClass}-${t.currency}`} className="border-t border-line bg-slate-50 font-medium">
                      <td className="px-2 py-2" colSpan={3}>Class {t.assetClass} subtotal</td>
                      <td className="px-2 py-2">{num(t.acquisitionBeginning)}</td>
                      <td className="px-2 py-2">{num(t.acquisitions)}</td>
                      <td className="px-2 py-2">{num(t.retirements)}</td>
                      <td className="px-2 py-2">{num(t.acquisitionEnding)}</td>
                      <td className="px-2 py-2">{num(t.depreciationBeginning)}</td>
                      <td className="px-2 py-2">{num(t.depreciationYear)}</td>
                      <td className="px-2 py-2">{num(t.depreciationOnRetirements)}</td>
                      <td className="px-2 py-2">{num(t.depreciationEnding)}</td>
                      <td className="px-2 py-2">{num(t.netBookValue)}</td>
                      <td className="px-2 py-2">{t.currency}</td>
                    </tr>
                  ))}
                  {sheet.grandTotals.map((t) => (
                    <tr key={`grand-${t.currency}`} className="border-t-2 border-line font-semibold">
                      <td className="px-2 py-2" colSpan={3}>Grand total</td>
                      <td className="px-2 py-2">{num(t.acquisitionBeginning)}</td>
                      <td className="px-2 py-2">{num(t.acquisitions)}</td>
                      <td className="px-2 py-2">{num(t.retirements)}</td>
                      <td className="px-2 py-2">{num(t.acquisitionEnding)}</td>
                      <td className="px-2 py-2">{num(t.depreciationBeginning)}</td>
                      <td className="px-2 py-2">{num(t.depreciationYear)}</td>
                      <td className="px-2 py-2">{num(t.depreciationOnRetirements)}</td>
                      <td className="px-2 py-2">{num(t.depreciationEnding)}</td>
                      <td className="px-2 py-2">{num(t.netBookValue)}</td>
                      <td className="px-2 py-2">{t.currency}</td>
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
