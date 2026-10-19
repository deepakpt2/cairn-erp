'use client';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

/**
 * Asset history sheet shell (SCR-095 stage 1): the selection
 * matrix and grid columns stand complete; the aggregation service
 * wires in stage 3 of R-143.
 */
export default function HistoryForm({ canReport }: { canReport: boolean }) {
  return (
    <>
      <section aria-labelledby="ah-select" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ah-select" className="text-sm font-semibold">Selection</h2>
        <form className="mt-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block"><span className={labelCls}>Company code from</span>
              <input name="companyCodeFrom" className={inputCls} placeholder="1000" required /></label>
            <label className="block"><span className={labelCls}>Company code to</span>
              <input name="companyCodeTo" className={inputCls} placeholder="1099" /></label>
            <label className="block"><span className={labelCls}>Asset class from</span>
              <input name="assetClassFrom" className={inputCls} placeholder="1000" /></label>
            <label className="block"><span className={labelCls}>Asset class to</span>
              <input name="assetClassTo" className={inputCls} placeholder="9999" /></label>
            <label className="block"><span className={labelCls}>Asset number from</span>
              <input name="assetNumberFrom" className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Asset number to</span>
              <input name="assetNumberTo" className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Fiscal year</span>
              <input name="fiscalYear" className={inputCls} placeholder="2026" required /></label>
            <label className="block"><span className={labelCls}>Depreciation area</span>
              <input name="depreciationArea" className={inputCls} defaultValue="01" required /></label>
            <label className="block"><span className={labelCls}>Reporting date</span>
              <input type="date" name="reportingDate" className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Sort version</span>
              <input name="sortVersion" className={inputCls} placeholder="0001" /></label>
            <label className="block"><span className={labelCls}>Display variant</span>
              <input name="layout" className={inputCls} placeholder="/DEFAULT" /></label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
              Execute
            </button>
            <button type="button" className="btn btn-default min-h-11 sm:min-h-8" disabled>
              Export CSV
            </button>
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
        <p className="mt-2 text-sm text-ink-soft">Execute to build the sheet for the selection.</p>
      </section>
    </>
  );
}
