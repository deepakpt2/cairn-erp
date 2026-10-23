import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { MaterialDocListResult, MaterialDocListSelection } from '@/modules/inventory/material-document-list';

/**
 * SCR-125 / MB51: the selection panel (posting dates required) and the ledger
 * grid. Every row drills down to the material document display — the MB03
 * equivalent — which is a read-only screen on the same capability.
 */
export default function MaterialDocumentListShell({ canUse, selection, result, listError }: {
  canUse: boolean;
  selection: MaterialDocListSelection;
  result: MaterialDocListResult | null;
  listError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('mdList.capabilityMissing')}</div>;
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('mdList.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('mdList.materialFrom')}>
            <input name="materialFrom" maxLength={40} className="field-input code w-40" defaultValue={selection.materialFrom ?? ''} placeholder="MAT-10001" />
          </Field>
          <Field label={t('mdList.materialTo')}>
            <input name="materialTo" maxLength={40} className="field-input code w-40" defaultValue={selection.materialTo ?? ''} placeholder="MAT-19999" />
          </Field>
          <Field label={t('mdList.plantFrom')}>
            <input name="plantFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.plantFrom ?? ''} placeholder="1000" />
          </Field>
          <Field label={t('mdList.plantTo')}>
            <input name="plantTo" maxLength={10} className="field-input code w-32" defaultValue={selection.plantTo ?? ''} placeholder="1099" />
          </Field>
          <Field label={t('mdList.storageLocationFrom')}>
            <input name="storageLocationFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.storageLocationFrom ?? ''} placeholder="0001" />
          </Field>
          <Field label={t('mdList.storageLocationTo')}>
            <input name="storageLocationTo" maxLength={10} className="field-input code w-32" defaultValue={selection.storageLocationTo ?? ''} placeholder="0099" />
          </Field>
          <Field label={t('mdList.movementTypeFrom')}>
            <input name="movementTypeFrom" maxLength={32} className="field-input code w-48" defaultValue={selection.movementTypeFrom ?? ''} placeholder="GOODS_RECEIPT_PO" />
          </Field>
          <Field label={t('mdList.movementTypeTo')}>
            <input name="movementTypeTo" maxLength={32} className="field-input code w-48" defaultValue={selection.movementTypeTo ?? ''} placeholder="GOODS_RECEIPT_PO" />
          </Field>
          <Field label={t('mdList.postingDateFrom')}>
            <input name="postingDateFrom" type="date" required className="field-input code w-40" defaultValue={selection.postingDateFrom ?? ''} />
          </Field>
          <Field label={t('mdList.postingDateTo')}>
            <input name="postingDateTo" type="date" required className="field-input code w-40" defaultValue={selection.postingDateTo ?? ''} />
          </Field>
          <Field label={t('mdList.documentDateFrom')}>
            <input name="documentDateFrom" type="date" className="field-input code w-40" defaultValue={selection.documentDateFrom ?? ''} />
          </Field>
          <Field label={t('mdList.documentDateTo')}>
            <input name="documentDateTo" type="date" className="field-input code w-40" defaultValue={selection.documentDateTo ?? ''} />
          </Field>
          <Field label={t('mdList.stockType')}>
            <input name="stockType" maxLength={16} className="field-input code w-36" defaultValue={selection.stockType ?? ''} placeholder="UNRESTRICTED" />
          </Field>
          <Field label={t('mdList.batch')}>
            <input name="batch" maxLength={10} className="field-input code w-32" defaultValue={selection.batch ?? ''} />
          </Field>
          <Field label={t('mdList.purchaseOrderFrom')}>
            <input name="purchaseOrderFrom" maxLength={10} className="field-input code w-36" defaultValue={selection.purchaseOrderFrom ?? ''} />
          </Field>
          <Field label={t('mdList.purchaseOrderTo')}>
            <input name="purchaseOrderTo" maxLength={10} className="field-input code w-36" defaultValue={selection.purchaseOrderTo ?? ''} />
          </Field>
          <Field label={t('mdList.userName')}>
            <input name="userName" maxLength={60} className="field-input code w-44" defaultValue={selection.userName ?? ''} />
          </Field>
          <Field label={t('mdList.maxHits')}>
            <input name="maxHits" type="number" min={1} className="field-input code w-32" defaultValue={selection.maxHits} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('mdList.execute')}</button>
          <Link href="/inventory/material-document-list" className="btn btn-default min-h-11 sm:min-h-8">
            {t('mdList.reset')}
          </Link>
        </div>
      </form>

      {listError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {listError}
        </div>
      ) : null}

      {result?.truncated ? (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          {t('mdList.truncated', { max: result.maxHits })}
        </div>
      ) : null}

      <section className="panel overflow-x-auto" aria-label={t('mdList.result')}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">{t('mdList.result')}</h2>
          {result ? <span className="text-xs text-ink-soft">{t('mdList.rowCount', { count: result.rowCount })}</span> : null}
        </div>
        <table className="grid-table min-w-[112rem]">
          <thead>
            <tr>
              <th>{t('mdList.document')}</th>
              <th>{t('mdList.item')}</th>
              <th>{t('mdList.movementType')}</th>
              <th>{t('mdList.direction')}</th>
              <th>{t('mdList.material')}</th>
              <th>{t('mdList.description')}</th>
              <th className="text-end">{t('mdList.entryQuantity')}</th>
              <th className="text-end">{t('mdList.baseQuantity')}</th>
              <th>{t('mdList.unit')}</th>
              <th className="text-end">{t('mdList.value')}</th>
              <th>{t('mdList.currency')}</th>
              <th>{t('mdList.plant')}</th>
              <th>{t('mdList.storageLocation')}</th>
              <th>{t('mdList.stockType')}</th>
              <th>{t('mdList.batch')}</th>
              <th>{t('mdList.postingDate')}</th>
              <th>{t('mdList.documentDate')}</th>
              <th>{t('mdList.headerText')}</th>
              <th>{t('mdList.status')}</th>
              <th>{t('mdList.purchaseOrder')}</th>
              <th>{t('mdList.itemText')}</th>
              <th>{t('mdList.user')}</th>
              <th>{t('mdList.journal')}</th>
              <th>{t('mdList.display')}</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !listError ? (
              <tr><td colSpan={24} className="text-ink-soft">{t('mdList.prompt')}</td></tr>
            ) : null}
            {result && result.rows.length === 0 ? (
              <tr><td colSpan={24} className="text-ink-soft">{t('mdList.empty')}</td></tr>
            ) : null}
            {result?.rows.map((row) => (
              <tr key={`${row.materialDocumentNumber}|${row.lineNumber}`} data-document={row.materialDocumentNumber}>
                <td className="code">
                  <Link href={row.drillDown}>{row.materialDocumentNumber} / {row.documentYear}</Link>
                </td>
                <td>{row.lineNumber}</td>
                <td className="code">{row.movementType}</td>
                <td>{row.movementDirection}</td>
                <td className="code">{row.materialNumber}</td>
                <td>{row.materialDescription}</td>
                <td className="text-end">{row.entryQuantity.toFixed(3)}</td>
                <td className="text-end">{row.baseQuantity.toFixed(3)}</td>
                <td>{row.baseUnit}</td>
                <td className="text-end">{row.value.toFixed(2)}</td>
                <td className="code">{row.currency}</td>
                <td className="code">{row.plant}</td>
                <td className="code">{row.storageLocation}</td>
                <td className="code">{row.stockType}</td>
                <td className="code" data-batch={row.batch}>{row.batch || '—'}</td>
                <td>{row.postingDate}</td>
                <td>{row.documentDate}</td>
                <td>{row.headerText}</td>
                <td>{row.status}</td>
                <td className="code">
                  {row.purchaseOrderNumber ? `${row.purchaseOrderNumber} / ${row.purchaseOrderItem ?? ''}` : ''}
                </td>
                <td>{row.itemText}</td>
                <td className="code">{row.createdBy}</td>
                <td className="code">
                  {row.journalDocument
                    ? <Link href={`/finance/journal?document=${encodeURIComponent(row.journalDocument)}`}>{row.journalDocument}</Link>
                    : ''}
                </td>
                <td className="code"><Link href={row.drillDown}>{t('mdList.display')}</Link></td>
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
