import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { StockRequirementsResult, StockRequirementsSelection } from '@/modules/production/stock-requirements';

/**
 * SCR-130 / MD04: the header summary (material, base unit, MRP type, safety stock,
 * stock on hand, closing balance) and the chronological list with its running
 * projected balance. A negative balance is the shortage state and is marked as
 * such on the row, not merely coloured.
 */
export default function StockRequirementsShell({ canUse, selection, result, reportError }: {
  canUse: boolean;
  selection: StockRequirementsSelection;
  result: StockRequirementsResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('md04.capabilityMissing')}</div>;
  }
  const elementLabel = (type: string) => type === 'STOCK' ? t('md04.stockElement')
    : type === 'PURCHASE_REQUISITION' ? t('md04.reqElement')
      : type === 'PURCHASE_ORDER' ? t('md04.poElement')
        : type === 'RESERVATION' ? t('md04.reservationElement')
          : t('md04.safetyElement');
  const exceptionLabel = (code: string) => code === 'SHORTAGE' ? t('md04.shortage')
    : code === 'SAFETY_BREACH' ? t('md04.safetyBreach')
      : t('md04.pastDue');

  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('md04.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('md04.material')}>
            <input name="material" maxLength={40} required className="field-input code w-40"
              defaultValue={selection.material ?? ''} placeholder="MAT-10001" />
          </Field>
          <Field label={t('md04.plant')}>
            <input name="plant" maxLength={10} required className="field-input code w-28"
              defaultValue={selection.plant ?? ''} placeholder="1000" />
          </Field>
          <Field label={t('md04.mrpArea')}>
            <input name="mrpArea" maxLength={10} className="field-input code w-32" defaultValue={selection.mrpArea ?? ''} />
          </Field>
          <Field label={t('md04.specialStock')}>
            <input name="specialStockIndicator" maxLength={1} className="field-input code w-24" defaultValue={selection.specialStockIndicator ?? ''} />
          </Field>
          <Field label={t('md04.periodSplit')}>
            <select name="periodSplit" className="field-input w-40" defaultValue={selection.periodSplit ?? 'DAILY'}>
              <option value="DAILY">{t('md04.periodDaily')}</option>
              <option value="WEEKLY">{t('md04.periodWeekly')}</option>
            </select>
          </Field>
          <Field label={t('md04.horizonEnd')}>
            <input name="horizonEnd" type="date" className="field-input code w-40" defaultValue={selection.horizonEnd ?? ''} />
          </Field>
          <Field label={t('md04.simulationVersion')}>
            <input name="simulationVersion" maxLength={4} className="field-input code w-24" defaultValue={selection.simulationVersion ?? ''} />
          </Field>
          <Field label={t('md04.maxHits')}>
            <input name="maxHits" type="number" min={1} className="field-input code w-32" defaultValue={selection.maxHits} />
          </Field>
          <div>
            <span className="field-label">{t('md04.displayPastDue')}</span>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="pastDueOff" value="1" defaultChecked={selection.displayPastDue === false} />
              {t('md04.displayPastDue')}
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('md04.execute')}</button>
          <Link href="/production/stock-requirements" className="btn btn-default min-h-11 sm:min-h-8">{t('md04.reset')}</Link>
        </div>
      </form>

      {reportError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {reportError}
        </div>
      ) : null}

      {result?.truncated ? (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          {t('md04.truncated', { max: result.maxHits })}
        </div>
      ) : null}

      {result ? (
        <section className="panel p-4" aria-label={t('md04.summary')}>
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <Summary label={t('md04.summary')} value={`${result.material} · ${result.materialDescription} (${result.baseUnit})`} />
            <Summary label={t('md04.mrpType')} value={`${result.plant} · ${result.mrpType ?? '—'}`} />
            <Summary label={t('md04.safetyStock')} value={`${result.safetyStock.toFixed(3)} / ${t('md04.reorderPoint')} ${result.reorderPoint.toFixed(3)}`} />
            <Summary label={t('md04.opening')} value={result.openingStock.toFixed(3)} />
            <Summary label={t('md04.closing')} value={result.closingBalance.toFixed(3)} />
          </div>
          {result.exceptionCounts.SHORTAGE + result.exceptionCounts.SAFETY_BREACH + result.exceptionCounts.PAST_DUE > 0 ? (
            <p className="mt-3 flex flex-wrap gap-3 text-xs">
              {result.exceptionCounts.SHORTAGE > 0
                ? <span className="border border-red-300 px-2 py-1 text-red-800 dark:border-red-800 dark:text-red-200" data-exception="SHORTAGE">{t('md04.shortage')}: {result.exceptionCounts.SHORTAGE}</span>
                : null}
              {result.exceptionCounts.SAFETY_BREACH > 0
                ? <span className="border border-amber-300 px-2 py-1 text-amber-900 dark:border-amber-800 dark:text-amber-200" data-exception="SAFETY_BREACH">{t('md04.safetyBreach')}: {result.exceptionCounts.SAFETY_BREACH}</span>
                : null}
              {result.exceptionCounts.PAST_DUE > 0
                ? <span className="border border-line px-2 py-1 text-ink-soft" data-exception="PAST_DUE">{t('md04.pastDue')}: {result.exceptionCounts.PAST_DUE}</span>
                : null}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="panel overflow-x-auto" aria-label={t('md04.result')}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">
            {t('md04.result')}
            {result ? <span className="ms-2 code text-xs font-normal text-ink-faint">{result.periodSplit}</span> : null}
          </h2>
          {result ? <span className="text-xs text-ink-soft">{result.rowCount} line(s)</span> : null}
        </div>
        <table className="grid-table min-w-[64rem]">
          <thead>
            <tr>
              <th>{t('md04.date')}</th>
              <th>{t('md04.periodEnd')}</th>
              <th>{t('md04.element')}</th>
              <th>{t('md04.document')}</th>
              <th className="text-end">{t('md04.item')}</th>
              <th className="text-end">{t('md04.receipt')}</th>
              <th className="text-end">{t('md04.requirement')}</th>
              <th className="text-end">{t('md04.balance')}</th>
              <th>{t('md04.unit')}</th>
              <th>{t('md04.exceptions')}</th>
              <th>{t('md04.display')}</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !reportError ? (
              <tr><td colSpan={11} className="text-ink-soft">{t('md04.prompt')}</td></tr>
            ) : null}
            {result && result.rows.length === 0 ? (
              <tr><td colSpan={11} className="text-ink-soft">{t('md04.empty')}</td></tr>
            ) : null}
            {result?.rows.map((row, index) => (
              <tr key={`${row.date}|${row.elementType}|${row.documentNumber}|${index}`}
                data-element={row.elementType} data-date={row.date}
                data-balance={row.projectedBalance.toFixed(3)}
                className={row.projectedBalance < 0 ? 'text-red-700 dark:text-red-300' : undefined}>
                <td className="code">{row.date}</td>
                <td className="code text-ink-faint">{row.periodEnd}</td>
                <td>{elementLabel(row.elementType)}</td>
                <td className="code">{row.documentNumber}</td>
                <td className="text-end">{row.documentItem}</td>
                <td className="text-end">{row.direction === 'RECEIPT' ? row.quantity.toFixed(3) : ''}</td>
                <td className="text-end">{row.direction === 'REQUIREMENT' ? row.quantity.toFixed(3) : ''}</td>
                <td className="text-end font-semibold">{row.projectedBalance.toFixed(3)}</td>
                <td>{result.baseUnit}</td>
                <td className="space-x-2 text-xs">
                  {row.exceptions.map((code) => (
                    <span key={code} data-exception-code={code} className="border border-line px-1">{exceptionLabel(code)}</span>
                  ))}
                </td>
                <td className="text-xs">
                  {row.drillDown ? <Link className="code" href={row.drillDown}>{t('md04.display')}</Link> : null}
                </td>
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

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <p className="code text-sm">{value}</p>
    </div>
  );
}
