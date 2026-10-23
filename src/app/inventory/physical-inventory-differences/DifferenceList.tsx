import Link from 'next/link';
import type { ReactNode } from 'react';

import { t } from '@/platform/i18n';
import type {
  DifferenceDocumentView,
  DifferenceLabel,
  DifferenceRow,
  DifferenceSelection,
} from '@/modules/inventory/physical-inventory-differences';
import { PHYSICAL_INVENTORY_DIFF_LIST_ROUTE } from '@/modules/inventory/physical-inventory-differences';
import type { RecountComparison } from '@/modules/inventory/physical-inventory-recount';

const ROUTE = PHYSICAL_INVENTORY_DIFF_LIST_ROUTE;

const LABEL_KEY: Record<DifferenceLabel, string> = {
  NOT_COUNTED: 'mi20.labelUncounted',
  NO_DIFFERENCE: 'mi20.labelNone',
  PENDING: 'mi20.labelPending',
  POSTED: 'mi20.labelPosted',
  RECOUNT_REQUIRED: 'mi20.labelRecount',
};

function queryOf(selection: DifferenceSelection, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  params.set('executed', '1');
  params.set('plantFrom', selection.plantFrom);
  if (selection.plantTo) params.set('plantTo', selection.plantTo);
  if (selection.storageLocationFrom) params.set('storageLocationFrom', selection.storageLocationFrom);
  if (selection.storageLocationTo) params.set('storageLocationTo', selection.storageLocationTo);
  if (selection.documentFrom) params.set('documentFrom', selection.documentFrom);
  if (selection.documentTo) params.set('documentTo', selection.documentTo);
  params.set('fiscalYear', String(selection.fiscalYear));
  if (selection.materialFrom) params.set('materialFrom', selection.materialFrom);
  if (selection.materialTo) params.set('materialTo', selection.materialTo);
  params.set('differenceExists', selection.differenceExists === false ? '0' : '1');
  params.set('includeUncounted', selection.includeUncounted ? '1' : '0');
  params.set('includeUnvalued', selection.includeUnvalued === false ? '0' : '1');
  if (selection.minimumDifferenceValue !== undefined) params.set('minimumDifferenceValue', String(selection.minimumDifferenceValue));
  if (selection.currency) params.set('currency', selection.currency);
  params.set('showPeriodNote', selection.showPeriodNote ? '1' : '0');
  if (selection.sort) params.set('sort', selection.sort);
  params.set('sortDescending', selection.sortDescending ? '1' : '0');
  params.set('pageSize', String(selection.pageSize ?? 50));
  params.set('page', String(selection.page ?? 1));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `${ROUTE}?${params.toString()}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

/**
 * The selection and the grid. A shortage and a surplus are words on the row, not colours.
 * A link to posting or recount is navigation. Neither action is performed here.
 */
export default function DifferenceList({
  selection,
  rows,
  total,
  excludedOtherCurrency,
  excludedUnvalued,
  listError,
  document,
  comparison = [],
  workflowMessage,
}: {
  selection: DifferenceSelection;
  rows: DifferenceRow[];
  total: number;
  excludedOtherCurrency: number;
  excludedUnvalued: number;
  listError: string | null;
  document: DifferenceDocumentView | null;
  comparison?: RecountComparison[];
  workflowMessage: string | null;
}) {
  const pages = Math.max(1, Math.ceil(total / (selection.pageSize ?? 50)));
  const page = selection.page ?? 1;

  return (
    <>
      <section aria-labelledby="difference-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="difference-selection" className="text-sm font-semibold">{t('mi20.selection')}</h2>
        <form method="get" action={ROUTE} className="mt-3 space-y-3">
          <input type="hidden" name="executed" value="1" />
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('mi20.plantFrom')}>
              <input name="plantFrom" required maxLength={10} className="input w-28" defaultValue={selection.plantFrom} />
            </Field>
            <Field label={t('mi20.plantTo')}>
              <input name="plantTo" maxLength={10} className="input w-28" defaultValue={selection.plantTo ?? ''} />
            </Field>
            <Field label={t('mi20.storageFrom')}>
              <input name="storageLocationFrom" maxLength={10} className="input w-28" defaultValue={selection.storageLocationFrom ?? ''} />
            </Field>
            <Field label={t('mi20.storageTo')}>
              <input name="storageLocationTo" maxLength={10} className="input w-28" defaultValue={selection.storageLocationTo ?? ''} />
            </Field>
            <Field label={t('mi20.documentFrom')}>
              <input name="documentFrom" maxLength={24} className="input w-44" defaultValue={selection.documentFrom ?? ''} />
            </Field>
            <Field label={t('mi20.documentTo')}>
              <input name="documentTo" maxLength={24} className="input w-44" defaultValue={selection.documentTo ?? ''} />
            </Field>
            <Field label={t('mi20.fiscalYear')}>
              <input name="fiscalYear" required inputMode="numeric" className="input w-28" defaultValue={selection.fiscalYear} />
            </Field>
            <Field label={t('mi20.materialFrom')}>
              <input name="materialFrom" maxLength={40} className="input w-36" defaultValue={selection.materialFrom ?? ''} />
            </Field>
            <Field label={t('mi20.materialTo')}>
              <input name="materialTo" maxLength={40} className="input w-36" defaultValue={selection.materialTo ?? ''} />
            </Field>
            <Field label={t('mi20.minimumValue')}>
              <input name="minimumDifferenceValue" inputMode="decimal" className="input w-32" defaultValue={selection.minimumDifferenceValue ?? ''} />
            </Field>
            <Field label={t('mi20.currency')}>
              <input name="currency" maxLength={3} className="input w-24" defaultValue={selection.currency ?? ''} />
            </Field>
            <Field label={t('mi20.sort')}>
              <select name="sort" className="input" defaultValue={selection.sort ?? 'document'}>
                <option value="document">{t('mi20.sortDocument')}</option>
                <option value="material">{t('mi20.sortMaterial')}</option>
                <option value="difference">{t('mi20.sortDifference')}</option>
                <option value="monetary">{t('mi20.sortMonetary')}</option>
              </select>
            </Field>
            <Field label={t('mi20.pageSize')}>
              <input name="pageSize" inputMode="numeric" className="input w-24" defaultValue={selection.pageSize ?? 50} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <Flag name="differenceExists" label={t('mi20.differenceExists')} checked={selection.differenceExists !== false} />
            <Flag name="includeUncounted" label={t('mi20.includeUncounted')} checked={selection.includeUncounted === true} />
            <Flag name="includeUnvalued" label={t('mi20.includeUnvalued')} checked={selection.includeUnvalued !== false} />
            <Flag name="showPeriodNote" label={t('mi20.showPeriodNote')} checked={selection.showPeriodNote === true} />
            <Flag name="sortDescending" label={t('mi20.descending')} checked={selection.sortDescending === true} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('mi20.show')}</button>
            <Link href={ROUTE} className="btn btn-default min-h-11 sm:min-h-8">{t('mi20.reset')}</Link>
          </div>
        </form>
        {listError && <p role="status" data-difference-message className="mt-2 text-sm text-red-700">{listError}</p>}
        {workflowMessage && <p role="status" data-difference-workflow className="mt-2 text-sm text-red-700">{workflowMessage}</p>}
      </section>

      {document && (
        <section aria-labelledby="difference-document" data-difference-document className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="difference-document" className="text-sm font-semibold">
            {t('mi20.displayTitle')} {document.documentNumber} · {document.fiscalYear}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{t('mi20.displayHint')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={`/inventory/physical-inventory-posting?doc=${encodeURIComponent(document.documentNumber)}&year=${document.fiscalYear}`}
              className="btn btn-default inline-flex min-h-11 sm:min-h-8"
              data-difference-posting-link
            >
              {t('mi20.toPosting')}
            </Link>
            <Link
              href={`/inventory/physical-inventory-recount?doc=${encodeURIComponent(document.documentNumber)}&year=${document.fiscalYear}`}
              className="btn btn-default inline-flex min-h-11 sm:min-h-8"
              data-difference-recount-link
            >
              {t('mi20.toRecount')}
            </Link>
          </div>
          <dl className="mt-2 grid gap-x-6 text-sm sm:grid-cols-4">
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('mi20.plantFrom')}</dt><dd>{document.plant}</dd></div>
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('mi20.storageFrom')}</dt><dd>{document.storageLocation ?? '—'}</dd></div>
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('mi20.columnPlannedDate')}</dt><dd>{document.plannedCountDate}</dd></div>
            <div className="flex justify-between gap-3 border-b border-line/60 py-1"><dt className="text-ink-soft">{t('mi20.columnStatus')}</dt><dd data-difference-document-status>{document.status}</dd></div>
          </dl>
        </section>
      )}

      {comparison.length > 0 && (
        <section aria-labelledby="difference-comparison" data-recount-comparison className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="difference-comparison" className="text-sm font-semibold">{t('mi20.comparisonTitle')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('mi20.comparisonHint')}</p>
          {comparison.map((group) => (
            <div key={`${group.recountDocumentNumber}/${group.recountFiscalYear}`} className="mt-3">
              <p className="text-sm">
                {group.originalDocumentNumber}/{group.originalFiscalYear}
                {' → '}
                {group.recountDocumentNumber}/{group.recountFiscalYear}
                {' · '}{group.status}
                {' · '}{group.reason}
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                      <th className="py-1 pr-2">{t('mi20.columnItem')}</th>
                      <th className="py-1 pr-2">{t('mi20.columnMaterial')}</th>
                      <th className="py-1 pr-2">{t('mi20.columnStockType')}</th>
                      <th className="py-1 pr-2">{t('mi20.columnOriginal')}</th>
                      <th className="py-1 pr-2">{t('mi20.columnRecount')}</th>
                      <th className="py-1 pr-2">{t('mi20.columnCounter')}</th>
                      <th className="py-1 pr-2">{t('mi20.columnMaterialDocument')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((item) => (
                      <tr key={item.recountItemNumber} data-recount-comparison-line={item.originalItemNumber} className="border-b border-line/60">
                        <td className="py-1 pr-2">{item.originalItemNumber}</td>
                        <td className="py-1 pr-2">{item.materialNumber}</td>
                        <td className="py-1 pr-2">{item.stockType}</td>
                        <td className="py-1 pr-2 tabular-nums" data-recount-original>
                          {item.originalBook || '—'} / {item.originalCounted || '—'} / {item.originalDifference || '—'}
                        </td>
                        <td className="py-1 pr-2 tabular-nums" data-recount-side>
                          {item.recountBook || '—'} / {item.recountCounted || '—'} / {item.recountDifference || '—'}
                        </td>
                        <td className="py-1 pr-2">{item.recountCounter || '—'} {item.recountCountDate}</td>
                        <td className="py-1 pr-2">{item.materialDocumentNumber || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      )}

      <section aria-labelledby="difference-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="difference-grid" className="text-sm font-semibold">{t('mi20.title')}</h2>
        {excludedOtherCurrency > 0 && (
          <p className="mt-2 text-sm text-ink-soft" data-difference-other-currency>{t('mi20.excludedOther', { count: excludedOtherCurrency })}</p>
        )}
        {excludedUnvalued > 0 && (
          <p className="mt-2 text-sm text-ink-soft" data-difference-unvalued-hidden>{t('mi20.excludedUnvalued', { count: excludedUnvalued })}</p>
        )}
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft" data-difference-empty>{t('mi20.empty')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-1 pr-2">{t('mi20.columnDocument')}</th>
                  <th className="py-1 pr-2">{t('mi20.columnItem')}</th>
                  <th className="py-1 pr-2">{t('mi20.columnMaterial')}</th>
                  <th className="py-1 pr-2">{t('mi20.columnStockType')}</th>
                  <th className="py-1 pr-2 text-right">{t('mi20.columnBook')}</th>
                  <th className="py-1 pr-2 text-right">{t('mi20.columnCounted')}</th>
                  <th className="py-1 pr-2 text-right">{t('mi20.columnDifference')}</th>
                  <th className="py-1 pr-2">{t('mi20.columnDirection')}</th>
                  <th className="py-1 pr-2 text-right">{t('mi20.columnMonetary')}</th>
                  <th className="py-1 pr-2">{t('mi20.columnStatus')}</th>
                  <th className="py-1 pr-2">{t('mi20.columnCountDate')}</th>
                  <th className="py-1 pr-2">{t('mi20.columnPosting')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.documentNumber}/${row.itemNumber}`} data-difference-row={row.itemNumber} className="border-t border-line align-top">
                    <td className="py-1 pr-2">
                      <Link className="link" href={queryOf(selection, { doc: row.documentNumber, year: String(row.fiscalYear) })}>
                        {row.documentNumber}
                      </Link>
                      <span className="block text-xs text-ink-faint">{row.plant}{row.storageLocation ? ` / ${row.storageLocation}` : ''}</span>
                    </td>
                    <td className="py-1 pr-2">{row.itemNumber}</td>
                    <td className="py-1 pr-2">
                      {row.materialNumber}
                      <span className="block text-xs text-ink-faint">{row.description}{row.batch ? ` · Batch ${row.batch}` : ''}</span>
                    </td>
                    <td className="py-1 pr-2">{row.stockType}</td>
                    <td className="py-1 pr-2 text-right tabular-nums" data-difference-book>
                      {row.bookQuantity ?? '—'} {row.bookUnit ?? ''}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {row.baseQuantity ?? '—'} {row.baseUnit}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums" data-difference-quantity>{row.differenceQuantity ?? '—'}</td>
                    <td className="py-1 pr-2" data-difference-direction={row.direction}>
                      {row.direction === 'SHORTAGE' ? t('mi20.shortage') : row.direction === 'SURPLUS' ? t('mi20.surplus') : t('mi20.none')}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums" data-difference-monetary>
                      {row.monetaryDifference === null
                        ? t('mi20.unavailable')
                        : `${row.monetaryDifference} ${row.currency ?? ''}`}
                      {row.monetaryReason && <span className="block text-xs text-ink-faint">{row.monetaryReason}</span>}
                      {row.valuationBasis === 'CURRENT_PLANT_PRICE' && (
                        <span className="block text-xs text-ink-faint">{t('mi20.currentPrice')}</span>
                      )}
                    </td>
                    <td className="py-1 pr-2" data-difference-label>{t(LABEL_KEY[row.label])}</td>
                    <td className="py-1 pr-2">
                      {row.countDate ?? '—'}
                      <span className="block text-xs text-ink-faint">{row.plannedCountDate}</span>
                      {row.counterName && <span className="block text-xs text-ink-faint">{row.counterName}</span>}
                    </td>
                    <td className="py-1 pr-2" data-difference-posting="none">{t('mi20.notPosted')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.some((row) => row.inconsistent) && (
          <p className="mt-2 text-sm text-ink-soft" data-difference-inconsistent>{t('mi20.inconsistent')}</p>
        )}
        {rows.some((row) => row.periodNote) && (
          <ul className="mt-2 text-sm text-ink-soft" data-difference-period>
            {rows.filter((row) => row.periodNote).map((row) => (
              <li key={`note-${row.documentNumber}-${row.itemNumber}`}>{row.materialNumber}: {row.periodNote}</li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span data-difference-page>{t('mi20.page', { page, pages: total === 0 ? 0 : pages })}</span>
          {page > 1 && <Link className="link" href={queryOf(selection, { page: String(page - 1) })}>{t('mi20.previous')}</Link>}
          {page < pages && <Link className="link" href={queryOf(selection, { page: String(page + 1) })}>{t('mi20.next')}</Link>}
        </div>
      </section>
    </>
  );
}

function Flag({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label className="flex items-center gap-2">
      <input type="hidden" name={name} value="0" />
      <input type="checkbox" name={name} value="1" defaultChecked={checked} />
      <span>{label}</span>
    </label>
  );
}
