import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { MovementClass, StockAgeingResult, StockAgeingSelection } from '@/modules/inventory/stock-ageing';

const CLASS_LABEL: Record<MovementClass, string> = {
  ACTIVE: 'stockAgeing.class.ACTIVE',
  SLOW_MOVING: 'stockAgeing.class.SLOW_MOVING',
  NON_MOVING: 'stockAgeing.class.NON_MOVING',
};

/** The selection panel and the ageing grid. Unknown values read "unknown", never zero. */
export default function StockAgeingShell({ canUse, bucketText, selection, result, reportError }: {
  canUse: boolean;
  bucketText: string;
  selection: StockAgeingSelection;
  result: StockAgeingResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('stockAgeing.capabilityMissing')}</div>;
  }
  const showValuation = result ? result.selection.valuationPriceDisplay !== false : selection.valuationPriceDisplay !== false;
  const bucketCount = result?.buckets.length ?? 0;
  const columns = 16 + bucketCount + (showValuation ? 3 : 0);
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('stockAgeing.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('stockAgeing.materialFrom')}>
            <input name="materialFrom" maxLength={40} className="field-input code w-40" defaultValue={selection.materialFrom ?? ''} />
          </Field>
          <Field label={t('stockAgeing.materialTo')}>
            <input name="materialTo" maxLength={40} className="field-input code w-40" defaultValue={selection.materialTo ?? ''} />
          </Field>
          <Field label={t('stockAgeing.plantFrom')}>
            <input name="plantFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.plantFrom ?? ''} />
          </Field>
          <Field label={t('stockAgeing.plantTo')}>
            <input name="plantTo" maxLength={10} className="field-input code w-32" defaultValue={selection.plantTo ?? ''} />
          </Field>
          <Field label={t('stockAgeing.stockType')}>
            <input name="stockType" maxLength={30} placeholder="UNRESTRICTED" className="field-input code w-44" defaultValue={selection.stockType ?? ''} />
          </Field>
          <Field label={t('stockAgeing.asOf')}>
            <input name="asOf" type="date" className="field-input code w-40" defaultValue={selection.asOf ?? ''} />
          </Field>
          <Field label={t('stockAgeing.ageBuckets')}>
            <input name="ageBuckets" className="field-input code w-48" defaultValue={bucketText} />
          </Field>
          <Field label={t('stockAgeing.slowMovingDays')}>
            <input name="slowMovingDays" type="number" min={1} className="field-input code w-32" defaultValue={selection.slowMovingDays} />
          </Field>
          <Field label={t('stockAgeing.nonMovingDays')}>
            <input name="nonMovingDays" type="number" min={1} className="field-input code w-32" defaultValue={selection.nonMovingDays} />
          </Field>
          <Field label={t('stockAgeing.maxHits')}>
            <input name="maxHits" type="number" min={1} className="field-input code w-32" defaultValue={selection.maxHits} />
          </Field>
          <div>
            <span className="field-label">{t('stockAgeing.displayZero')}</span>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="displayZero" defaultChecked={selection.displayZero === true} />
              {t('stockAgeing.displayZero')}
            </label>
          </div>
          <div>
            <span className="field-label">{t('stockAgeing.valuationPrice')}</span>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="valuationPriceOff" value="1" defaultChecked={selection.valuationPriceDisplay === false} />
              {t('stockAgeing.valuationPrice')}
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('stockAgeing.execute')}</button>
          <Link href="/inventory/stock-ageing" className="btn btn-default min-h-11 sm:min-h-8">{t('stockAgeing.reset')}</Link>
        </div>
      </form>

      {reportError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {reportError}
        </div>
      ) : null}

      {result?.truncated ? (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          {t('stockAgeing.truncated', { max: result.maxHits })}
        </div>
      ) : null}

      <section className="panel overflow-x-auto" aria-label={t('stockAgeing.result')}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">
            {t('stockAgeing.result')}
            {result ? <span className="ms-2 code text-xs font-normal text-ink-faint">{result.selection.stockType} · {result.selection.asOf}</span> : null}
          </h2>
          {result ? <span className="text-xs text-ink-soft">{t('stockAgeing.rowCount', { count: result.rowCount })}</span> : null}
        </div>
        <table className="grid-table min-w-[84rem]">
          <thead>
            <tr>
              <th>{t('stockAgeing.material')}</th>
              <th>{t('stockAgeing.description')}</th>
              <th>{t('stockAgeing.plant')}</th>
              <th>{t('stockAgeing.unit')}</th>
              <th className="text-end">{t('stockAgeing.onHand')}</th>
              {result?.buckets.map((b) => <th key={b.label} className="text-end">{b.label}</th>)}
              <th>{t('stockAgeing.oldest')}</th>
              <th className="text-end">{t('stockAgeing.avgAge')}</th>
              <th>{t('stockAgeing.lastReceipt')}</th>
              <th>{t('stockAgeing.lastIssue')}</th>
              <th className="text-end">{t('stockAgeing.daysSinceIssue')}</th>
              <th>{t('stockAgeing.class')}</th>
              {showValuation ? <th className="text-end">{t('stockAgeing.price')}</th> : null}
              {showValuation ? <th>{t('stockAgeing.currency')}</th> : null}
              {showValuation ? <th className="text-end">{t('stockAgeing.value')}</th> : null}
              <th className="text-end">{t('stockAgeing.drift')}</th>
              <th>{t('stockAgeing.movements')}</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !reportError ? (
              <tr><td colSpan={columns} className="text-ink-soft">{t('stockAgeing.prompt')}</td></tr>
            ) : null}
            {result && result.rows.length === 0 ? (
              <tr><td colSpan={columns} className="text-ink-soft">{t('stockAgeing.empty')}</td></tr>
            ) : null}
            {result?.rows.map((row) => (
              <tr key={`${row.materialNumber}|${row.plant}`} data-material={row.materialNumber} data-class={row.movementClass}>
                <td className="code">{row.materialNumber}</td>
                <td>{row.materialDescription}</td>
                <td className="code">{row.plant}</td>
                <td>{row.baseUnit}</td>
                <td className="text-end font-semibold num">{row.quantityOnHand.toFixed(3)}</td>
                {row.bucketQuantities.map((q, i) => <td key={i} className="text-end num">{q.toFixed(3)}</td>)}
                <td className="code">{row.oldestLayerDate ?? '—'}</td>
                <td className="text-end num">{row.weightedAverageAgeDays ?? '—'}</td>
                <td className="code">{row.lastReceiptDate ?? '—'}</td>
                <td className="code">{row.lastIssueDate ?? t('stockAgeing.never')}</td>
                <td className="text-end num">{row.daysSinceLastIssue ?? '—'}</td>
                <td>{t(CLASS_LABEL[row.movementClass])}</td>
                {showValuation ? <td className="text-end num">{row.price === null ? t('stockAgeing.unknown') : row.price.toFixed(4)}</td> : null}
                {showValuation ? <td className="code">{row.currency ?? ''}</td> : null}
                {showValuation ? <td className="text-end font-semibold num">{row.value === null ? t('stockAgeing.unknown') : row.value.toFixed(2)}</td> : null}
                <td className="text-end num">{row.drift === null ? '' : row.drift.toFixed(3)}</td>
                <td className="space-x-2 whitespace-nowrap text-xs">
                  <Link className="code" href={row.movementsDrillDown}>{t('stockAgeing.movements')}</Link>
                  <Link className="code" href={row.stockDrillDown}>{t('stockAgeing.stock')}</Link>
                </td>
              </tr>
            ))}
          </tbody>
          {result && result.rows.length > 0 ? (
            <tfoot>
              <tr>
                <td colSpan={4} className="font-semibold">{t('stockAgeing.totals')}</td>
                <td className="text-end font-semibold num">{result.totals.quantityOnHand.toFixed(3)}</td>
                {result.totals.bucketQuantities.map((q, i) => <td key={i} className="text-end num">{q.toFixed(3)}</td>)}
                <td colSpan={6} className="text-xs text-ink-soft">
                  {(Object.keys(CLASS_LABEL) as MovementClass[]).map((c) => `${t(CLASS_LABEL[c])}: ${result.totals.byClass[c]}`).join(' · ')}
                </td>
                {showValuation ? <td /> : null}
                {showValuation ? <td /> : null}
                {showValuation ? (
                  <td className="text-end font-semibold">
                    {result.totals.value === null ? t('stockAgeing.unknown') : result.totals.value.toFixed(2)}
                  </td>
                ) : null}
                <td />
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
