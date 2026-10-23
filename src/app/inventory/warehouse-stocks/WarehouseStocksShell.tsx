import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { WarehouseStockResult, WarehouseStockSelection } from '@/modules/inventory/warehouse-stocks';

/**
 * SCR-127 / MB52: the selection panel and the stock snapshot. The scope of list
 * is required; the valuation price display defaults on; every row carries the
 * four-way stock-type split, its value and two drills. Unknown valuations read
 * "unknown", never zero.
 */
export default function WarehouseStocksShell({ canUse, selection, result, reportError }: {
  canUse: boolean;
  selection: WarehouseStockSelection;
  result: WarehouseStockResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('whStock.capabilityMissing')}</div>;
  }
  const showValuation = result ? result.valuationPriceDisplay : selection.valuationPriceDisplay !== false;
  const showTotals = Boolean(result && result.rows.length > 0);
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('whStock.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('whStock.scopeOfList')}>
            <select name="scopeOfList" required className="field-input code w-44" defaultValue={selection.scopeOfList ?? 'ALV'}>
              <option value="ALV">{t('whStock.scopeAlv')}</option>
              <option value="STANDARD">{t('whStock.scopeStandard')}</option>
            </select>
          </Field>
          <Field label={t('whStock.materialFrom')}>
            <input name="materialFrom" maxLength={40} className="field-input code w-40" defaultValue={selection.materialFrom ?? ''} />
          </Field>
          <Field label={t('whStock.materialTo')}>
            <input name="materialTo" maxLength={40} className="field-input code w-40" defaultValue={selection.materialTo ?? ''} />
          </Field>
          <Field label={t('whStock.plantFrom')}>
            <input name="plantFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.plantFrom ?? ''} />
          </Field>
          <Field label={t('whStock.plantTo')}>
            <input name="plantTo" maxLength={10} className="field-input code w-32" defaultValue={selection.plantTo ?? ''} />
          </Field>
          <Field label={t('whStock.storageLocationFrom')}>
            <input name="storageLocationFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.storageLocationFrom ?? ''} />
          </Field>
          <Field label={t('whStock.storageLocationTo')}>
            <input name="storageLocationTo" maxLength={10} className="field-input code w-32" defaultValue={selection.storageLocationTo ?? ''} />
          </Field>
          <Field label={t('whStock.valuationType')}>
            <input name="valuationType" maxLength={10} className="field-input code w-32" defaultValue={selection.valuationType ?? ''} />
          </Field>
          <Field label={t('whStock.batch')}>
            <input name="batch" maxLength={10} className="field-input code w-32" defaultValue={selection.batch ?? ''} />
          </Field>
          <Field label={t('whStock.specialStock')}>
            <input name="specialStockIndicator" maxLength={1} className="field-input code w-24" defaultValue={selection.specialStockIndicator ?? ''} />
          </Field>
          <Field label={t('whStock.maxHits')}>
            <input name="maxHits" type="number" min={1} className="field-input code w-32" defaultValue={selection.maxHits} />
          </Field>
          <div>
            <span className="field-label">{t('whStock.displayZero')}</span>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="displayZero" defaultChecked={selection.displayZero === true} />
              {t('whStock.displayZero')}
            </label>
          </div>
          <div>
            <span className="field-label">{t('whStock.valuationPrice')}</span>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="valuationPriceOff" value="1" defaultChecked={selection.valuationPriceDisplay === false} />
              {t('whStock.valuationPrice')}
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('whStock.execute')}</button>
          <Link href="/inventory/warehouse-stocks" className="btn btn-default min-h-11 sm:min-h-8">{t('whStock.reset')}</Link>
        </div>
      </form>

      {reportError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {reportError}
        </div>
      ) : null}

      {result?.truncated ? (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          {t('whStock.truncated', { max: result.maxHits })}
        </div>
      ) : null}

      <section className="panel overflow-x-auto" aria-label={t('whStock.result')}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">
            {t('whStock.result')}
            {result ? <span className="ms-2 code text-xs font-normal text-ink-faint">{result.scopeOfList}</span> : null}
          </h2>
          {result ? <span className="text-xs text-ink-soft">{t('whStock.rowCount', { count: result.rowCount })}</span> : null}
        </div>
        <table className="grid-table min-w-[72rem]">
          <thead>
            <tr>
              <th rowSpan={2}>{t('whStock.material')}</th>
              <th rowSpan={2}>{t('whStock.description')}</th>
              <th rowSpan={2}>{t('whStock.plant')}</th>
              <th rowSpan={2}>{t('whStock.storageLocation')}</th>
              <th rowSpan={2}>Batch</th>
              <th rowSpan={2}>{t('whStock.unit')}</th>
              <th colSpan={5} className="text-center">{t('whStock.total')}</th>
              {showValuation ? <th colSpan={3} className="text-center">{t('whStock.value')}</th> : null}
              <th rowSpan={2}>{t('whStock.movements')}</th>
            </tr>
            <tr>
              <th className="text-end">{t('whStock.unrestricted')}</th>
              <th className="text-end">{t('whStock.quality')}</th>
              <th className="text-end">{t('whStock.blocked')}</th>
              <th className="text-end">{t('whStock.special')}</th>
              <th className="text-end">{t('whStock.total')}</th>
              {showValuation ? <th className="text-end">{t('whStock.price')}</th> : null}
              {showValuation ? <th>{t('whStock.currency')}</th> : null}
              {showValuation ? <th className="text-end">{t('whStock.value')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {result === null && !reportError ? (
              <tr><td colSpan={showValuation ? 15 : 12} className="text-ink-soft">{t('whStock.prompt')}</td></tr>
            ) : null}
            {result && result.rows.length === 0 ? (
              <tr><td colSpan={showValuation ? 15 : 12} className="text-ink-soft">{t('whStock.empty')}</td></tr>
            ) : null}
            {result?.rows.map((row) => (
              <tr key={`${row.materialNumber}|${row.plant}|${row.storageLocation}|${row.batch}`} data-material={row.materialNumber} data-batch={row.batch}>
                <td className="code">{row.materialNumber}</td>
                <td>{row.materialDescription}</td>
                <td className="code">{row.plant}</td>
                <td className="code">{row.storageLocation}</td>
                <td className="code">{row.batch || '—'}</td>
                <td>{row.baseUnit}</td>
                <td className="text-end">{row.unrestrictedQuantity.toFixed(3)}</td>
                <td className="text-end">{row.qualityInspectionQuantity.toFixed(3)}</td>
                <td className="text-end">{row.blockedQuantity.toFixed(3)}</td>
                <td className="text-end">{row.specialQuantity.toFixed(3)}</td>
                <td className="text-end font-semibold">{row.totalQuantity.toFixed(3)}</td>
                {showValuation ? (
                  <td className="text-end">{row.price === null ? t('whStock.unknownValue') : row.price.toFixed(4)}</td>
                ) : null}
                {showValuation ? <td className="code">{row.currency ?? ''}</td> : null}
                {showValuation ? (
                  <td className="text-end font-semibold">{row.value === null ? t('whStock.unknownValue') : row.value.toFixed(2)}</td>
                ) : null}
                <td className="space-x-2 whitespace-nowrap text-xs">
                  {row.movementsDrillDown
                    ? <Link className="code" href={row.movementsDrillDown}>{t('whStock.movements')}</Link>
                    : <span className="text-ink-faint">{t('whStock.movements')}</span>}
                  {row.rollforwardDrillDown
                    ? <Link className="code" href={row.rollforwardDrillDown}>{t('whStock.rollforward')}</Link>
                    : null}
                </td>
              </tr>
            ))}
          </tbody>
          {showTotals ? (
            <tfoot>
              <tr>
                <td colSpan={6} className="font-semibold">{t('whStock.totals')}</td>
                <td className="text-end">{result!.totals.unrestrictedQuantity.toFixed(3)}</td>
                <td className="text-end">{result!.totals.qualityInspectionQuantity.toFixed(3)}</td>
                <td className="text-end">{result!.totals.blockedQuantity.toFixed(3)}</td>
                <td className="text-end">{result!.totals.specialQuantity.toFixed(3)}</td>
                <td className="text-end font-semibold">{result!.totals.totalQuantity.toFixed(3)}</td>
                {showValuation ? <td /> : null}
                {showValuation ? <td /> : null}
                {showValuation ? (
                  <td className="text-end font-semibold">
                    {result!.totals.value === null ? t('whStock.unknownValue') : result!.totals.value.toFixed(2)}
                  </td>
                ) : null}
                <td />
              </tr>
            </tfoot>
          ) : null}
        </table>
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
