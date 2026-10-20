import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { StockPostingDateResult, StockPostingDateSelection } from '@/modules/inventory/stock-posting-date';

/**
 * SCR-126 / MB5B: the selection panel (material, plant and the reporting window
 * all required) and the rollforward grid — opening, receipts, issues and closing,
 * quantity and value — with each row drilling into the movements behind it.
 */
export default function StockOnPostingDateShell({ canUse, selection, result, reportError }: {
  canUse: boolean;
  selection: StockPostingDateSelection;
  result: StockPostingDateResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('stockDate.capabilityMissing')}</div>;
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('stockDate.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('stockDate.materialFrom')}>
            <input name="materialFrom" maxLength={40} required className="field-input code w-40"
              defaultValue={selection.materialFrom ?? ''} placeholder="MAT-10001" />
          </Field>
          <Field label={t('stockDate.materialTo')}>
            <input name="materialTo" maxLength={40} className="field-input code w-40"
              defaultValue={selection.materialTo ?? ''} placeholder="MAT-19999" />
          </Field>
          <Field label={t('stockDate.plantFrom')}>
            <input name="plantFrom" maxLength={10} required className="field-input code w-32"
              defaultValue={selection.plantFrom ?? ''} placeholder="1000" />
          </Field>
          <Field label={t('stockDate.plantTo')}>
            <input name="plantTo" maxLength={10} className="field-input code w-32"
              defaultValue={selection.plantTo ?? ''} placeholder="1099" />
          </Field>
          <Field label={t('stockDate.storageLocationFrom')}>
            <input name="storageLocationFrom" maxLength={10} className="field-input code w-32"
              defaultValue={selection.storageLocationFrom ?? ''} />
          </Field>
          <Field label={t('stockDate.storageLocationTo')}>
            <input name="storageLocationTo" maxLength={10} className="field-input code w-32"
              defaultValue={selection.storageLocationTo ?? ''} />
          </Field>
          <Field label={t('stockDate.dateFrom')}>
            <input name="dateFrom" type="date" required className="field-input code w-40"
              defaultValue={selection.dateFrom ?? ''} />
          </Field>
          <Field label={t('stockDate.dateTo')}>
            <input name="dateTo" type="date" required className="field-input code w-40"
              defaultValue={selection.dateTo ?? ''} />
          </Field>
          <Field label={t('stockDate.stockType')}>
            <input name="stockType" maxLength={16} className="field-input code w-36"
              defaultValue={selection.stockType ?? 'UNRESTRICTED'} placeholder="UNRESTRICTED" />
          </Field>
          <Field label={t('stockDate.maxHits')}>
            <input name="maxHits" type="number" min={1} className="field-input code w-32"
              defaultValue={selection.maxHits} />
          </Field>
          <div>
            <span className="field-label">{t('stockDate.displayZero')}</span>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="displayZero" defaultChecked={selection.displayZero === true} />
              {t('stockDate.displayZero')}
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('stockDate.execute')}</button>
          <Link href="/inventory/stock-posting-date" className="btn btn-default min-h-11 sm:min-h-8">
            {t('stockDate.reset')}
          </Link>
        </div>
      </form>

      {reportError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {reportError}
        </div>
      ) : null}

      {result?.truncated ? (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          {t('stockDate.truncated', { max: result.maxHits })}
        </div>
      ) : null}

      <section className="panel overflow-x-auto" aria-label={t('stockDate.result')}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">{t('stockDate.result')}</h2>
          {result ? <span className="text-xs text-ink-soft">{t('stockDate.rowCount', { count: result.rowCount })}</span> : null}
        </div>
        <table className="grid-table min-w-[88rem]">
          <thead>
            <tr>
              <th rowSpan={2}>{t('stockDate.material')}</th>
              <th rowSpan={2}>{t('stockDate.description')}</th>
              <th rowSpan={2}>{t('stockDate.plant')}</th>
              <th rowSpan={2}>{t('stockDate.storageLocation')}</th>
              <th rowSpan={2}>{t('stockDate.stockType')}</th>
              <th rowSpan={2}>{t('stockDate.unit')}</th>
              <th colSpan={2} className="text-center">{t('stockDate.opening')}</th>
              <th colSpan={2} className="text-center">{t('stockDate.receipts')}</th>
              <th colSpan={2} className="text-center">{t('stockDate.issues')}</th>
              <th colSpan={2} className="text-center">{t('stockDate.closing')}</th>
              <th rowSpan={2}>{t('stockDate.display')}</th>
            </tr>
            <tr>
              <th className="text-end">{t('stockDate.quantity')}</th>
              <th className="text-end">{t('stockDate.value')}</th>
              <th className="text-end">{t('stockDate.quantity')}</th>
              <th className="text-end">{t('stockDate.value')}</th>
              <th className="text-end">{t('stockDate.quantity')}</th>
              <th className="text-end">{t('stockDate.value')}</th>
              <th className="text-end">{t('stockDate.quantity')}</th>
              <th className="text-end">{t('stockDate.value')}</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !reportError ? (
              <tr><td colSpan={15} className="text-ink-soft">{t('stockDate.prompt')}</td></tr>
            ) : null}
            {result && result.rows.length === 0 ? (
              <tr><td colSpan={15} className="text-ink-soft">{t('stockDate.empty')}</td></tr>
            ) : null}
            {result?.rows.map((row) => (
              <tr
                key={`${row.materialNumber}|${row.plant}|${row.storageLocation}|${row.stockType}`}
                data-material={row.materialNumber}
              >
                <td className="code">{row.materialNumber}</td>
                <td>{row.materialDescription}</td>
                <td className="code">{row.plant}</td>
                <td className="code">{row.storageLocation}</td>
                <td className="code">{row.stockType}</td>
                <td>{row.baseUnit}</td>
                <td className="text-end">{row.openingQuantity.toFixed(3)}</td>
                <td className="text-end">{row.openingValue.toFixed(2)}</td>
                <td className="text-end">{row.receiptQuantity.toFixed(3)}</td>
                <td className="text-end">{row.receiptValue.toFixed(2)}</td>
                <td className="text-end">{row.issueQuantity.toFixed(3)}</td>
                <td className="text-end">{row.issueValue.toFixed(2)}</td>
                <td className="text-end font-semibold">{row.closingQuantity.toFixed(3)}</td>
                <td className="text-end font-semibold">{row.closingValue.toFixed(2)}</td>
                <td className="code"><Link href={row.drillDown}>{t('stockDate.display')}</Link></td>
              </tr>
            ))}
          </tbody>
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
