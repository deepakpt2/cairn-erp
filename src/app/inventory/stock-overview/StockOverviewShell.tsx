import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { StockOverviewResult, StockOverviewSelection } from '@/modules/inventory/stock-overview';

/**
 * SCR-128 / MMBE: the selection panel and the three-level stock tree. Plants
 * open to storage locations (or not, per the expansion level), locations open
 * to their stock types, and every row of the tree is a <details> element so the
 * browser does the collapsing without a line of client script.
 */
export default function StockOverviewShell({ canUse, selection, result, reportError }: {
  canUse: boolean;
  selection: StockOverviewSelection;
  result: StockOverviewResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('stockOvw.capabilityMissing')}</div>;
  }
  const openPlants = result?.expansionLevel === 'STORAGE_LOCATION';
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('stockOvw.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('stockOvw.material')}>
            <input name="material" maxLength={40} required className="field-input code w-40"
              defaultValue={selection.material ?? ''} placeholder="MAT-10001" />
          </Field>
          <Field label={t('stockOvw.plantFrom')}>
            <input name="plantFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.plantFrom ?? ''} />
          </Field>
          <Field label={t('stockOvw.plantTo')}>
            <input name="plantTo" maxLength={10} className="field-input code w-32" defaultValue={selection.plantTo ?? ''} />
          </Field>
          <Field label={t('stockOvw.storageLocationFrom')}>
            <input name="storageLocationFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.storageLocationFrom ?? ''} />
          </Field>
          <Field label={t('stockOvw.storageLocationTo')}>
            <input name="storageLocationTo" maxLength={10} className="field-input code w-32" defaultValue={selection.storageLocationTo ?? ''} />
          </Field>
          <Field label={t('stockOvw.batch')}>
            <input name="batch" maxLength={10} className="field-input code w-32" defaultValue={selection.batch ?? ''} />
          </Field>
          <Field label={t('stockOvw.specialStock')}>
            <input name="specialStockIndicator" maxLength={1} className="field-input code w-24" defaultValue={selection.specialStockIndicator ?? ''} />
          </Field>
          <Field label={t('stockOvw.expansionLevel')}>
            <select name="expansionLevel" className="field-input code w-64" defaultValue={selection.expansionLevel ?? 'STORAGE_LOCATION'}>
              <option value="PLANT">{t('stockOvw.expansionPlant')}</option>
              <option value="STORAGE_LOCATION">{t('stockOvw.expansionLocation')}</option>
            </select>
          </Field>
          <Field label={t('stockOvw.maxHits')}>
            <input name="maxHits" type="number" min={1} className="field-input code w-32" defaultValue={selection.maxHits} />
          </Field>
          <div>
            <span className="field-label">{t('stockOvw.displayZero')}</span>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="displayZero" defaultChecked={selection.displayZero === true} />
              {t('stockOvw.displayZero')}
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('stockOvw.execute')}</button>
          <Link href="/inventory/stock-overview" className="btn btn-default min-h-11 sm:min-h-8">{t('stockOvw.reset')}</Link>
        </div>
      </form>

      {reportError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {reportError}
        </div>
      ) : null}

      {result?.truncated ? (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          {t('stockOvw.truncated', { max: result.maxHits })}
        </div>
      ) : null}

      <section className="panel" aria-label={t('stockOvw.result')}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">
            {t('stockOvw.result')}
            {result ? <span className="ms-2 code text-xs font-normal text-ink-faint">{result.material} · {result.baseUnit}</span> : null}
          </h2>
          {result && result.totalQuantity !== 0 ? (
            <span className="text-xs text-ink-soft">
              {t('stockOvw.total')}: <strong className="code">{result.totalQuantity.toFixed(3)}</strong>
              {' · '}{t('stockOvw.unrestricted')} {result.unrestrictedQuantity.toFixed(3)}
              {' · '}{t('stockOvw.quality')} {result.qualityInspectionQuantity.toFixed(3)}
              {' · '}{t('stockOvw.blocked')} {result.blockedQuantity.toFixed(3)}
              {' · '}{t('stockOvw.special')} {result.specialQuantity.toFixed(3)}
            </span>
          ) : null}
        </div>

        {result === null && !reportError ? (
          <p className="px-3 py-4 text-sm text-ink-soft">{t('stockOvw.prompt')}</p>
        ) : null}
        {result && result.plants.length === 0 ? (
          <p className="px-3 py-4 text-sm text-ink-soft">{t('stockOvw.empty')}</p>
        ) : null}

        <div className="divide-y divide-line">
          {result?.plants.map((plant) => (
            <details key={plant.plant} open={openPlants} data-plant={plant.plant} className="px-3 py-2">
              <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
                <span className="code font-semibold">{t('stockOvw.plant')} {plant.plant}</span>
                <span className="code">{plant.quantity.toFixed(3)}</span>
                <span className="text-xs text-ink-soft">
                  {t('stockOvw.unrestricted')} {plant.unrestrictedQuantity.toFixed(3)}
                  {' · '}{t('stockOvw.quality')} {plant.qualityInspectionQuantity.toFixed(3)}
                  {' · '}{t('stockOvw.blocked')} {plant.blockedQuantity.toFixed(3)}
                  {' · '}{t('stockOvw.special')} {plant.specialQuantity.toFixed(3)}
                </span>
                <span className="ms-auto space-x-3 text-xs">
                  {plant.movementsDrillDown ? <Link className="code" href={plant.movementsDrillDown}>{t('stockOvw.movements')}</Link> : null}
                  {plant.rollforwardDrillDown ? <Link className="code" href={plant.rollforwardDrillDown}>{t('stockOvw.rollforward')}</Link> : null}
                  {plant.warehouseDrillDown ? <Link className="code" href={plant.warehouseDrillDown}>{t('stockOvw.warehouse')}</Link> : null}
                </span>
              </summary>
              <div className="mt-2 space-y-2 border-s border-line ps-4">
                {plant.storageLocations.map((location) => (
                  <details key={`${plant.plant}|${location.storageLocation}`} open={false}
                    data-location={`${plant.plant}|${location.storageLocation}`}>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
                      <span className="code">{t('stockOvw.storageLocation')} {location.storageLocation}</span>
                      <span className="code">{location.quantity.toFixed(3)}</span>
                      <span className="ms-auto space-x-3 text-xs">
                        {location.movementsDrillDown ? <Link className="code" href={location.movementsDrillDown}>{t('stockOvw.movements')}</Link> : null}
                        {location.rollforwardDrillDown ? <Link className="code" href={location.rollforwardDrillDown}>{t('stockOvw.rollforward')}</Link> : null}
                        {location.warehouseDrillDown ? <Link className="code" href={location.warehouseDrillDown}>{t('stockOvw.warehouse')}</Link> : null}
                      </span>
                    </summary>
                    <table className="grid-table mt-2 ms-4 w-auto min-w-[24rem]">
                      <thead>
                        <tr>
                          <th>{t('stockOvw.stockType')}</th>
                          <th className="text-end">{t('stockOvw.quantity')}</th>
                          <th>{t('stockOvw.unit')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {location.stockTypes.map((type) => (
                          <tr key={`${location.storageLocation}|${type.stockType}`} data-stock-type={type.stockType}>
                            <td className="code">{type.stockType}</td>
                            <td className="text-end">{type.quantity.toFixed(3)}</td>
                            <td>{result.baseUnit}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>
      </section>

      {result && result.warnings.length > 0 ? (
        <section className="panel p-4" aria-label="Report warnings">
          <ul className="list-disc space-y-1 ps-5 text-sm text-ink-soft">
            {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
