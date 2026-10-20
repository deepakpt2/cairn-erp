import Link from 'next/link';

import { t } from '@/platform/i18n';
import {
  PERSPECTIVES,
  SCOPES,
  type PoListResult,
  type PoListSelection,
} from '@/modules/purchasing/purchase-order-list';

/**
 * SCR-124 / ME2L suite: the selection panel (perspective, scope of selection and
 * the full range set) and the purchase order grid. Every row drills down to the
 * standing purchase order display (the ME23N equivalent).
 */
export default function PurchaseOrderListShell({ canUse, selection, result, listError }: {
  canUse: boolean;
  selection: PoListSelection;
  result: PoListResult | null;
  listError?: string | null;
}) {
  if (!canUse) {
    return <div className="panel p-4 text-sm text-ink-soft">{t('poList.capabilityMissing')}</div>;
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('poList.selection')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('poList.perspective')}>
            <select name="perspective" className="field-input w-44" defaultValue={selection.perspective ?? 'VENDOR'}>
              {PERSPECTIVES.map((p) => (
                <option key={p.code} value={p.code}>{p.alias} — {p.label}</option>
              ))}
            </select>
          </Field>
          <Field label={t('poList.scope')}>
            <select name="scope" className="field-input w-52" defaultValue={selection.scope ?? 'ALL'}>
              {SCOPES.map((sc) => <option key={sc.code} value={sc.code}>{sc.label}</option>)}
            </select>
          </Field>
          <Field label={t('poList.vendorFrom')}>
            <input name="vendorFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.vendorFrom ?? ''} placeholder="V10000" />
          </Field>
          <Field label={t('poList.vendorTo')}>
            <input name="vendorTo" maxLength={10} className="field-input code w-32" defaultValue={selection.vendorTo ?? ''} placeholder="V99999" />
          </Field>
          <Field label={t('poList.purchasingOrgFrom')}>
            <input name="purchasingOrgFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.purchasingOrgFrom ?? ''} />
          </Field>
          <Field label={t('poList.purchasingOrgTo')}>
            <input name="purchasingOrgTo" maxLength={10} className="field-input code w-32" defaultValue={selection.purchasingOrgTo ?? ''} />
          </Field>
          <Field label={t('poList.purchasingGroupFrom')}>
            <input name="purchasingGroupFrom" maxLength={3} className="field-input code w-28" defaultValue={selection.purchasingGroupFrom ?? ''} placeholder="001" />
          </Field>
          <Field label={t('poList.purchasingGroupTo')}>
            <input name="purchasingGroupTo" maxLength={3} className="field-input code w-28" defaultValue={selection.purchasingGroupTo ?? ''} placeholder="010" />
          </Field>
          <Field label={t('poList.plantFrom')}>
            <input name="plantFrom" maxLength={10} className="field-input code w-32" defaultValue={selection.plantFrom ?? ''} />
          </Field>
          <Field label={t('poList.plantTo')}>
            <input name="plantTo" maxLength={10} className="field-input code w-32" defaultValue={selection.plantTo ?? ''} />
          </Field>
          <Field label={t('poList.materialFrom')}>
            <input name="materialFrom" maxLength={40} className="field-input code w-40" defaultValue={selection.materialFrom ?? ''} />
          </Field>
          <Field label={t('poList.materialTo')}>
            <input name="materialTo" maxLength={40} className="field-input code w-40" defaultValue={selection.materialTo ?? ''} />
          </Field>
          <Field label={t('poList.materialGroupFrom')}>
            <input name="materialGroupFrom" maxLength={9} className="field-input code w-32" defaultValue={selection.materialGroupFrom ?? ''} />
          </Field>
          <Field label={t('poList.materialGroupTo')}>
            <input name="materialGroupTo" maxLength={9} className="field-input code w-32" defaultValue={selection.materialGroupTo ?? ''} />
          </Field>
          <Field label={t('poList.orderFrom')}>
            <input name="orderFrom" maxLength={10} className="field-input code w-36" defaultValue={selection.orderFrom ?? ''} />
          </Field>
          <Field label={t('poList.orderTo')}>
            <input name="orderTo" maxLength={10} className="field-input code w-36" defaultValue={selection.orderTo ?? ''} />
          </Field>
          <Field label={t('poList.documentDateFrom')}>
            <input name="documentDateFrom" type="date" className="field-input code w-40" defaultValue={selection.documentDateFrom ?? ''} />
          </Field>
          <Field label={t('poList.documentDateTo')}>
            <input name="documentDateTo" type="date" className="field-input code w-40" defaultValue={selection.documentDateTo ?? ''} />
          </Field>
          <Field label={t('poList.maxHits')}>
            <input name="maxHits" type="number" min={1} className="field-input code w-32" defaultValue={selection.maxHits} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('poList.execute')}</button>
          <Link href="/purchasing/purchase-order-list" className="btn btn-default min-h-11 sm:min-h-8">
            {t('poList.reset')}
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
          {t('poList.truncated', { max: result.maxHits })}
        </div>
      ) : null}

      <section className="panel overflow-x-auto" aria-label={t('poList.result')}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-sm font-semibold">
            {t('poList.result')} · {result ? `${result.perspectiveAlias}` : ''}
          </h2>
          {result ? <span className="text-xs text-ink-soft">{t('poList.rowCount', { count: result.rowCount })}</span> : null}
        </div>
        <table className="grid-table min-w-[118rem]">
          <thead>
            <tr>
              <th>{t('poList.order')}</th>
              <th>{t('poList.vendor')}</th>
              <th>{t('poList.purchasingOrg')}</th>
              <th>{t('poList.purchasingGroup')}</th>
              <th>{t('poList.companyCode')}</th>
              <th>{t('poList.documentDate')}</th>
              <th>{t('poList.material')}</th>
              <th>{t('poList.shortText')}</th>
              <th>{t('poList.materialGroup')}</th>
              <th>{t('poList.plant')}</th>
              <th className="text-end">{t('poList.quantity')}</th>
              <th>{t('poList.unit')}</th>
              <th className="text-end">{t('poList.netPrice')}</th>
              <th className="text-end">{t('poList.netValue')}</th>
              <th>{t('poList.currency')}</th>
              <th>{t('poList.deliveryDate')}</th>
              <th>{t('poList.release')}</th>
              <th>{t('poList.requisition')}</th>
              <th className="text-end">{t('poList.delivered')}</th>
              <th className="text-end">{t('poList.invoiced')}</th>
              <th className="text-end">{t('poList.openDelivery')}</th>
              <th className="text-end">{t('poList.openInvoice')}</th>
              <th>{t('poList.accountAssignment')}</th>
              <th>{t('poList.status')}</th>
              <th>{t('poList.display')}</th>
            </tr>
          </thead>
          <tbody>
            {result === null && !listError ? (
              <tr><td colSpan={25} className="text-ink-soft">{t('poList.prompt')}</td></tr>
            ) : null}
            {result && result.rows.length === 0 ? (
              <tr><td colSpan={25} className="text-ink-soft">{t('poList.empty')}</td></tr>
            ) : null}
            {result?.rows.map((row) => (
              <tr key={`${row.orderNumber}|${row.itemNumber}`} data-order={row.orderNumber}>
                <td className="code">
                  <Link href={row.drillDown}>{row.orderNumber} / {row.itemNumber}</Link>
                </td>
                <td className="code">{row.supplierNumber}{row.supplierName ? ` — ${row.supplierName}` : ''}</td>
                <td className="code">{row.purchasingOrg}</td>
                <td className="code">{row.purchasingGroup}</td>
                <td className="code">{row.companyCode}</td>
                <td>{row.documentDate}</td>
                <td className="code">{row.materialNumber}</td>
                <td>{row.shortText}</td>
                <td className="code">{row.materialGroup}</td>
                <td className="code">{row.plant}</td>
                <td className="text-end">{row.quantity.toFixed(3)}</td>
                <td>{row.unit}</td>
                <td className="text-end">{row.netPrice.toFixed(2)} / {row.priceUnit}</td>
                <td className="text-end">{row.netValue.toFixed(2)}</td>
                <td className="code">{row.currency}</td>
                <td>{row.deliveryDate}</td>
                <td>{row.releaseStatus}{row.markedForDeletion ? ' · MFD' : ''}</td>
                <td className="code">
                  {row.requisitionNumber
                    ? `${row.requisitionNumber} / ${row.requisitionItem ?? ''}${row.requisitionQuantity === null ? '' : ` (${row.requisitionQuantity.toFixed(3)})`}`
                    : ''}
                </td>
                <td className="text-end">{row.deliveredQuantity.toFixed(3)}</td>
                <td className="text-end">{row.invoicedQuantity.toFixed(3)}</td>
                <td className="text-end">{row.openDeliveryQuantity.toFixed(3)}</td>
                <td className="text-end">{row.openInvoiceQuantity.toFixed(3)}</td>
                <td>{row.accountAssignmentCategory}</td>
                <td>{row.status}</td>
                <td className="code"><Link href={row.drillDown}>{t('poList.display')}</Link></td>
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
