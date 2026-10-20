import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { PoAccountAssignResult, PoAccountAssignSelection } from '@/modules/purchasing/po-account-assignment';

/**
 * SCR-129 / ME2K: the selection panel, the commitment-by-object grouping and the
 * assignment-line grid. The scope of list and the scope of selection are both
 * required; every row names its order and its cost centre.
 */
export default function PoAccountAssignmentShell({ canUse, selection, result, reportError }: {
  canUse: boolean;
  selection: PoAccountAssignSelection;
  result: PoAccountAssignResult | null;
  reportError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('poAa.capabilityMissing')}</div>;
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('poAa.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('poAa.scopeOfList')}>
            <select name="scopeOfList" required className="field-input code w-44" defaultValue={selection.scopeOfList ?? 'ALV'}>
              <option value="ALV">{t('poAa.scopeAlv')}</option>
              <option value="STANDARD">{t('poAa.scopeStandard')}</option>
            </select>
          </Field>
          <Field label={t('poAa.scope')}>
            <select name="scope" required className="field-input w-52" defaultValue={selection.scope ?? 'ALL'}>
              <option value="ALL">{t('poAa.scopeAll')}</option>
              <option value="STILL_TO_BE_DELIVERED">{t('poAa.scopeDeliver')}</option>
              <option value="STILL_TO_BE_INVOICED">{t('poAa.scopeInvoice')}</option>
              <option value="COMPLETED">{t('poAa.scopeCompleted')}</option>
            </select>
          </Field>
          <Field label={t('poAa.category')}>
            <input name="accountAssignmentCategory" maxLength={16} className="field-input code w-36"
              defaultValue={selection.accountAssignmentCategory ?? ''} placeholder="K" />
          </Field>
          <Field label={t('poAa.costCenterFrom')}>
            <input name="costCenterFrom" maxLength={10} className="field-input code w-36" defaultValue={selection.costCenterFrom ?? ''} />
          </Field>
          <Field label={t('poAa.costCenterTo')}>
            <input name="costCenterTo" maxLength={10} className="field-input code w-36" defaultValue={selection.costCenterTo ?? ''} />
          </Field>
          <Field label={t('poAa.orgFrom')}>
            <input name="purchasingOrgFrom" maxLength={10} className="field-input code w-36" defaultValue={selection.purchasingOrgFrom ?? ''} />
          </Field>
          <Field label={t('poAa.orgTo')}>
            <input name="purchasingOrgTo" maxLength={10} className="field-input code w-36" defaultValue={selection.purchasingOrgTo ?? ''} />
          </Field>
          <Field label={t('poAa.groupFrom')}>
            <input name="purchasingGroupFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.purchasingGroupFrom ?? ''} />
          </Field>
          <Field label={t('poAa.groupTo')}>
            <input name="purchasingGroupTo" maxLength={10} className="field-input code w-32" defaultValue={selection.purchasingGroupTo ?? ''} />
          </Field>
          <Field label={t('poAa.plantFrom')}>
            <input name="plantFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.plantFrom ?? ''} />
          </Field>
          <Field label={t('poAa.plantTo')}>
            <input name="plantTo" maxLength={10} className="field-input code w-32" defaultValue={selection.plantTo ?? ''} />
          </Field>
          <Field label={t('poAa.supplierFrom')}>
            <input name="supplierFrom" maxLength={20} className="field-input code w-36" defaultValue={selection.supplierFrom ?? ''} />
          </Field>
          <Field label={t('poAa.supplierTo')}>
            <input name="supplierTo" maxLength={20} className="field-input code w-36" defaultValue={selection.supplierTo ?? ''} />
          </Field>
          <Field label={t('poAa.dateFrom')}>
            <input name="documentDateFrom" type="date" className="field-input code w-40" defaultValue={selection.documentDateFrom ?? ''} />
          </Field>
          <Field label={t('poAa.dateTo')}>
            <input name="documentDateTo" type="date" className="field-input code w-40" defaultValue={selection.documentDateTo ?? ''} />
          </Field>
          <Field label={t('poAa.maxHits')}>
            <input name="maxHits" type="number" min={1} className="field-input code w-32" defaultValue={selection.maxHits} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('poAa.execute')}</button>
          <Link href="/purchasing/orders-by-account-assignment" className="btn btn-default min-h-11 sm:min-h-8">{t('poAa.reset')}</Link>
        </div>
      </form>

      {reportError ? (
        <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {reportError}
        </div>
      ) : null}

      {result?.truncated ? (
        <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          {t('poAa.truncated', { max: result.maxHits })}
        </div>
      ) : null}

      {result && result.groups.length > 0 ? (
        <section className="panel overflow-x-auto" aria-label={t('poAa.groups')}>
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold">{t('poAa.groups')}</h2>
            <span className="text-xs text-ink-soft">
              {t('poAa.total')}: <strong className="code">{result.totalAssignedValue.toFixed(2)}</strong>
            </span>
          </div>
          <table className="grid-table w-auto min-w-[32rem]">
            <thead>
              <tr>
                <th>{t('poAa.group')}</th>
                <th className="text-end">{t('poAa.groupLines')}</th>
                <th className="text-end">{t('poAa.groupValue')}</th>
              </tr>
            </thead>
            <tbody>
              {result.groups.map((group) => (
                <tr key={group.costCenter} data-group={group.costCenter}>
                  <td className="code">
                    <Link href={`/controlling/cost-center-report?costCenter=${encodeURIComponent(group.costCenter)}`}>
                      {group.costCenter}
                    </Link>
                  </td>
                  <td className="text-end">{group.lineCount}</td>
                  <td className="text-end font-semibold">{group.assignedValue.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="panel overflow-x-auto" aria-label={t('poAa.result')}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">
            {t('poAa.result')}
            {result ? <span className="ms-2 code text-xs font-normal text-ink-faint">{result.scopeOfList} · {result.scope}</span> : null}
          </h2>
          {result ? (
            <span className="text-xs text-ink-soft">{t('poAa.rowCount', { count: result.rowCount, groups: result.groupCount })}</span>
          ) : null}
        </div>
        <table className="grid-table min-w-[92rem]">
          <thead>
            <tr>
              <th>{t('poAa.order')}</th>
              <th className="text-end">{t('poAa.item')}</th>
              <th className="text-end">{t('poAa.line')}</th>
              <th>{t('poAa.costCenter')}</th>
              <th>{t('poAa.glAccount')}</th>
              <th>{t('poAa.material')}</th>
              <th>{t('poAa.description')}</th>
              <th>{t('poAa.plant')}</th>
              <th className="text-end">{t('poAa.quantity')}</th>
              <th>{t('poAa.unit')}</th>
              <th className="text-end">{t('poAa.netValue')}</th>
              <th className="text-end">{t('poAa.percent')}</th>
              <th className="text-end">{t('poAa.assignedValue')}</th>
              <th>{t('poAa.currency')}</th>
              <th>{t('poAa.deliveryDate')}</th>
              <th>{t('poAa.release')}</th>
              <th>{t('poAa.supplier')}</th>
              <th>{t('poAa.display')}</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !reportError ? (
              <tr><td colSpan={18} className="text-ink-soft">{t('poAa.prompt')}</td></tr>
            ) : null}
            {result && result.rows.length === 0 ? (
              <tr><td colSpan={18} className="text-ink-soft">{t('poAa.empty')}</td></tr>
            ) : null}
            {result?.rows.map((row) => (
              <tr key={`${row.orderNumber}|${row.itemNumber}|${row.assignmentLine}`}
                data-order={row.orderNumber} data-cost-center={row.costCenter}>
                <td className="code">{row.orderNumber}</td>
                <td className="text-end">{row.itemNumber}</td>
                <td className="text-end">{row.assignmentLine}</td>
                <td className="code">{row.costCenter}</td>
                <td className="code">{row.glAccount}</td>
                <td className="code">{row.materialNumber}</td>
                <td>{row.materialDescription}</td>
                <td className="code">{row.plant}</td>
                <td className="text-end">{row.quantity.toFixed(3)}</td>
                <td>{row.unit}</td>
                <td className="text-end">{row.netValue.toFixed(2)}</td>
                <td className="text-end">{row.distributionPercentage.toFixed(2)}</td>
                <td className="text-end font-semibold">{row.assignedValue.toFixed(2)}</td>
                <td className="code">{row.currency}</td>
                <td className="code">{row.deliveryDate}</td>
                <td className="code">{row.releaseStatus}</td>
                <td className="code">{row.supplierNumber}</td>
                <td className="space-x-2 whitespace-nowrap text-xs">
                  <Link className="code" href={row.orderDrillDown}>{t('poAa.order')}</Link>
                  <Link className="code" href={row.costCenterDrillDown}>{t('poAa.costCenter')}</Link>
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
