import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { RequisitionListResult, RequisitionListSelection } from '@/modules/purchasing/requisition-list';

/**
 * SCR-123 / ME5A: the selection panel and the requisition grid. Every row
 * drills down to the standing requisition display (the ME53N equivalent).
 */
export default function RequisitionListShell({ canUse, selection, result, listError }: {
  canUse: boolean;
  selection: RequisitionListSelection;
  result: RequisitionListResult | null;
  listError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('reqList.capabilityMissing')}</div>;
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('reqList.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('reqList.purchasingGroupFrom')}>
            <input name="purchasingGroupFrom" maxLength={3} className="field-input code w-28"
              defaultValue={selection.purchasingGroupFrom ?? ''} placeholder="001" />
          </Field>
          <Field label={t('reqList.purchasingGroupTo')}>
            <input name="purchasingGroupTo" maxLength={3} className="field-input code w-28"
              defaultValue={selection.purchasingGroupTo ?? ''} placeholder="008" />
          </Field>
          <Field label={t('reqList.plantFrom')}>
            <input name="plantFrom" maxLength={10} className="field-input code w-32"
              defaultValue={selection.plantFrom ?? ''} placeholder="1000" />
          </Field>
          <Field label={t('reqList.plantTo')}>
            <input name="plantTo" maxLength={10} className="field-input code w-32"
              defaultValue={selection.plantTo ?? ''} placeholder="1099" />
          </Field>
          <Field label={t('reqList.materialFrom')}>
            <input name="materialFrom" maxLength={40} className="field-input code w-40"
              defaultValue={selection.materialFrom ?? ''} />
          </Field>
          <Field label={t('reqList.materialTo')}>
            <input name="materialTo" maxLength={40} className="field-input code w-40"
              defaultValue={selection.materialTo ?? ''} />
          </Field>
          <Field label={t('reqList.purchasingOrgFrom')}>
            <input name="purchasingOrgFrom" maxLength={10} className="field-input code w-32"
              defaultValue={selection.purchasingOrgFrom ?? ''} placeholder="1000" />
          </Field>
          <Field label={t('reqList.purchasingOrgTo')}>
            <input name="purchasingOrgTo" maxLength={10} className="field-input code w-32"
              defaultValue={selection.purchasingOrgTo ?? ''} placeholder="1099" />
          </Field>
          <Field label={t('reqList.requisitioner')}>
            <input name="requisitioner" maxLength={60} className="field-input code w-44"
              defaultValue={selection.requisitioner ?? ''} />
          </Field>
          <Field label={t('reqList.requisitionDateFrom')}>
            <input name="requisitionDateFrom" type="date" className="field-input code w-40"
              defaultValue={selection.requisitionDateFrom ?? ''} />
          </Field>
          <Field label={t('reqList.requisitionDateTo')}>
            <input name="requisitionDateTo" type="date" className="field-input code w-40"
              defaultValue={selection.requisitionDateTo ?? ''} />
          </Field>
          <Field label={t('reqList.accountAssignment')}>
            <select name="accountAssignmentCategory" className="field-input w-48"
              defaultValue={selection.accountAssignmentCategory ?? ''}>
              <option value="">{t('reqList.accountAssignmentAll')}</option>
              <option value="COST_CENTER">{t('reqList.accountAssignmentCostCenter')}</option>
              <option value="NONE">{t('reqList.accountAssignmentNone')}</option>
            </select>
          </Field>
          <Field label={t('reqList.maxHits')}>
            <input name="maxHits" type="number" min={1} className="field-input code w-32"
              defaultValue={selection.maxHits} />
          </Field>
          <div>
            <span className="field-label">{t('reqList.displayClosed')}</span>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" name="displayClosed" defaultChecked={selection.displayClosed === true} />
              {t('reqList.displayClosed')}
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('reqList.execute')}</button>
          <Link href="/purchasing/requisition-list" className="btn btn-default min-h-11 sm:min-h-8">
            {t('reqList.reset')}
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
          {t('reqList.truncated', { max: result.maxHits })}
        </div>
      ) : null}

      {result?.closedHidden && !listError ? (
        <div className="border border-line bg-surface-2 px-3 py-2 text-sm text-ink-soft" role="note">
          {t('reqList.closedHidden')}
        </div>
      ) : null}

      <section className="panel overflow-x-auto" aria-label={t('reqList.result')}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">{t('reqList.result')}</h2>
          {result ? <span className="text-xs text-ink-soft">{t('reqList.rowCount', { count: result.rowCount })}</span> : null}
        </div>
        <table className="grid-table min-w-[92rem]">
          <thead>
            <tr>
              <th>{t('reqList.requisition')}</th>
              <th>{t('reqList.material')}</th>
              <th>{t('reqList.shortText')}</th>
              <th className="text-end">{t('reqList.quantity')}</th>
              <th>{t('reqList.unit')}</th>
              <th className="text-end">{t('reqList.ordered')}</th>
              <th className="text-end">{t('reqList.open')}</th>
              <th>{t('reqList.requisitionDate')}</th>
              <th>{t('reqList.deliveryDate')}</th>
              <th>{t('reqList.plant')}</th>
              <th>{t('reqList.purchasingGroup')}</th>
              <th>{t('reqList.purchasingOrgs')}</th>
              <th>{t('reqList.accountAssignmentShort')}</th>
              <th>{t('reqList.requisitionerShort')}</th>
              <th className="text-end">{t('reqList.estimatedPrice')}</th>
              <th>{t('reqList.currency')}</th>
              <th>{t('reqList.noClosedColumn')}</th>
              <th>{t('reqList.display')}</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !listError ? (
              <tr>
                <td colSpan={18} className="text-ink-soft">{t('reqList.prompt')}</td>
              </tr>
            ) : null}
            {result && result.rows.length === 0 ? (
              <tr>
                <td colSpan={18} className="text-ink-soft">{t('reqList.empty')}</td>
              </tr>
            ) : null}
            {result?.rows.map((row) => (
              <tr key={`${row.requisitionNumber}|${row.itemNumber}`} data-requisition={row.requisitionNumber}>
                <td className="code">
                  <Link href={row.drillDown}>{row.requisitionNumber} / {row.itemNumber}</Link>
                </td>
                <td className="code">{row.materialNumber}</td>
                <td>{row.shortText}</td>
                <td className="text-end">{row.quantity.toFixed(3)}</td>
                <td>{row.unit}</td>
                <td className="text-end">{row.orderedQuantity.toFixed(3)}</td>
                <td className="text-end">{row.openQuantity.toFixed(3)}</td>
                <td>{row.requisitionDate}</td>
                <td>{row.deliveryDate}</td>
                <td className="code">{row.plant}</td>
                <td className="code">{row.purchasingGroup}</td>
                <td className="code">{row.purchasingOrgs.join(', ')}</td>
                <td>{row.accountAssignmentCategory}</td>
                <td className="code">{row.requisitioner}</td>
                <td className="text-end">{row.estimatedPrice === null ? '' : row.estimatedPrice.toFixed(2)}</td>
                <td className="code">{row.currency}</td>
                <td>
                  {row.status}
                  {row.markedForDeletion ? ' · MFD' : ''}
                </td>
                <td className="code">
                  <Link href={row.drillDown}>{t('reqList.display')}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
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
