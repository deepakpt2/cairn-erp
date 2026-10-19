import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { GrIrResult } from '@/modules/finance/grir-reclass';

export interface GrIrDefaults {
  companyCode: string;
  keyDate: string;
  purchaseOrderFrom: string;
  purchaseOrderTo: string;
  postingDateFrom: string;
  postingDateTo: string;
  displayVariant: string;
  testRun: boolean;
  createAccruals: boolean;
  postingDate: string;
  reversalDate: string;
  accrualDocumentType: string;
  accrualAccount: string;
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/**
 * Selection and protocol of the GR/IR analysis (SCR-099).
 * Analysis and posting stay visibly separate: accrual creation is
 * its own switch, and test mode is the default.
 */
export default function GrIrForm({ canExecute, defaults, result, requestKey }: {
  canExecute: boolean;
  defaults: GrIrDefaults;
  result: GrIrResult | null;
  requestKey: string;
}) {
  if (!canExecute) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.GRIR.RECLASS' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4">
        <input type="hidden" name="run" value="1" />
        <input type="hidden" name="requestKey" value={requestKey} />
        <div className="flex flex-wrap gap-3">
          <Field label={t('grir.companyCode')}>
            <input name="companyCode" defaultValue={defaults.companyCode} className="field-input code w-28" required placeholder="1000" />
          </Field>
          <Field label={t('grir.keyDate')}>
            <input type="date" name="keyDate" defaultValue={defaults.keyDate} className="field-input w-40" required />
          </Field>
          <Field label={t('grir.poFrom')}>
            <input name="purchaseOrderFrom" defaultValue={defaults.purchaseOrderFrom} className="field-input code w-36" />
          </Field>
          <Field label={t('grir.poTo')}>
            <input name="purchaseOrderTo" defaultValue={defaults.purchaseOrderTo} className="field-input code w-36" />
          </Field>
          <Field label={t('grir.postingFrom')}>
            <input type="date" name="postingDateFrom" defaultValue={defaults.postingDateFrom} className="field-input w-40" />
          </Field>
          <Field label={t('grir.postingTo')}>
            <input type="date" name="postingDateTo" defaultValue={defaults.postingDateTo} className="field-input w-40" />
          </Field>
          <Field label={t('grir.displayVariant')}>
            <input name="displayVariant" defaultValue={defaults.displayVariant} className="field-input code w-36" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-3">
          <Field label={t('grir.postingDate')}>
            <input type="date" name="postingDate" defaultValue={defaults.postingDate} className="field-input w-40" />
          </Field>
          <Field label={t('grir.reversalDate')}>
            <input type="date" name="reversalDate" defaultValue={defaults.reversalDate} className="field-input w-40" />
          </Field>
          <Field label={t('grir.accrualType')}>
            <input name="accrualDocumentType" defaultValue={defaults.accrualDocumentType} className="field-input code w-24" maxLength={12} />
          </Field>
          <Field label={t('grir.accrualAccount')}>
            <input name="accrualAccount" defaultValue={defaults.accrualAccount} className="field-input code w-32" placeholder="191000" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="testRun" value="on" defaultChecked={defaults.testRun} />
            {t('grir.testRun')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="createAccruals" value="on" defaultChecked={defaults.createAccruals} />
            {t('grir.createAccruals')}
          </label>
        </div>
        <p className="text-2xs text-ink-faint">{t('grir.modeHint')}</p>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('grir.execute')}</button>
      </form>

      {result && (
        <section className="panel overflow-x-auto" aria-label={t('grir.protocol')}>
          <div className="panel-header">
            <h2 className="panel-title">{t('grir.protocol')} · {result.runId}</h2>
            <span className="text-2xs text-ink-faint">{result.status} · {result.companyCode} · {result.keyDate}</span>
            <Link href={`/finance/grir-reclass/export?run=${encodeURIComponent(result.runId)}`} className="btn btn-default min-h-11 sm:min-h-8">
              {t('grir.export')}
            </Link>
          </div>
          {result.warnings.length > 0 && (
            <ul className="space-y-1 border-b border-line bg-signal-warn-soft px-3 py-2 text-sm text-signal-warn">
              {result.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          <table className="grid-table min-w-[72rem]">
            <thead>
              <tr>
                <th>{t('grir.purchaseOrder')}</th>
                <th>{t('grir.vendor')}</th>
                <th>{t('grir.material')}</th>
                <th>{t('grir.plant')}</th>
                <th className="text-end">{t('grir.receivedQty')}</th>
                <th className="text-end">{t('grir.invoicedQty')}</th>
                <th className="text-end">{t('grir.openQty')}</th>
                <th className="text-end">{t('grir.receivedValue')}</th>
                <th className="text-end">{t('grir.invoicedValue')}</th>
                <th className="text-end">{t('grir.openValue')}</th>
                <th>{t('grir.classification')}</th>
                <th>{t('grir.status')}</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.itemNumber}>
                  <td className="code">{item.purchaseOrder}/{item.purchaseOrderItem}</td>
                  <td className="code">{item.vendor}</td>
                  <td className="code">{item.material ?? '—'}</td>
                  <td className="code">{item.plant}</td>
                  <td className="tabular text-end">{qty(item.receivedQuantity)}</td>
                  <td className="tabular text-end">{qty(item.invoicedQuantity)}</td>
                  <td className="tabular text-end">{qty(item.openQuantity)}</td>
                  <td className="tabular text-end">{money(item.receivedValue)}</td>
                  <td className="tabular text-end">{money(item.invoicedValue)}</td>
                  <td className="tabular text-end">{money(item.openValue)}</td>
                  <td>{t(`grir.class.${item.classification}`)}{item.error && <span className="block text-2xs text-signal-error">{item.error}</span>}</td>
                  <td>{item.status}</td>
                </tr>
              ))}
              {result.items.length === 0 && (
                <tr><td colSpan={12} className="text-sm text-ink-soft">{t('grir.empty')}</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-sunken font-semibold">
                <td colSpan={9}>{t('grir.totals')}</td>
                <td className="tabular text-end">{money(result.totalOpenValue)}</td>
                <td colSpan={2}>{t('grir.accrualTotal')} {money(result.totalAccrualAmount)}</td>
              </tr>
            </tfoot>
          </table>
          {(result.accrualDocument || result.reversalDocument) && (
            <p className="border-t border-line px-3 py-2 text-sm text-ink-soft">
              {result.accrualDocument && `${t('grir.accruedAs')} ${result.accrualDocument}. `}
              {result.reversalDocument && `${t('grir.reversedAs')} ${result.reversalDocument}.`}
            </p>
          )}
        </section>
      )}
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
