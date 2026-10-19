import Link from 'next/link';

import { t } from '@/platform/i18n';
import { FX_RATE_TYPES, type FxValuationResult } from '@/modules/finance/fx-valuation';

export interface ValuationDefaults {
  companyCode: string;
  valuationArea: string;
  valuationKeyDate: string;
  postingDate: string;
  fiscalYear: string;
  valuationMethod: string;
  includeOpenItems: boolean;
  includeBalances: boolean;
  testRun: boolean;
  documentType: string;
  reversalDate: string;
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Selection and protocol of the FX valuation (SCR-098). GET-driven
 * like the other reports; the run's request key is judged in stage
 * 3 so a resubmission returns the original run.
 */
export default function ValuationForm({ canExecute, defaults, result, requestKey }: {
  canExecute: boolean;
  defaults: ValuationDefaults;
  result: FxValuationResult | null;
  requestKey: string;
}) {
  if (!canExecute) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.FX.VALUATE' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4">
        <input type="hidden" name="run" value="1" />
        <input type="hidden" name="requestKey" value={requestKey} />
        <div className="flex flex-wrap gap-3">
          <Field label={t('fxValuation.companyCode')}>
            <input name="companyCode" defaultValue={defaults.companyCode} className="field-input code w-28" required placeholder="1000" />
          </Field>
          <Field label={t('fxValuation.valuationArea')}>
            <input name="valuationArea" defaultValue={defaults.valuationArea} className="field-input code w-28" required maxLength={6} placeholder="LOCAL" />
          </Field>
          <Field label={t('fxValuation.keyDate')}>
            <input type="date" name="valuationKeyDate" defaultValue={defaults.valuationKeyDate} className="field-input w-40" required />
          </Field>
          <Field label={t('fxValuation.postingDate')}>
            <input type="date" name="postingDate" defaultValue={defaults.postingDate} className="field-input w-40" required />
          </Field>
          <Field label={t('fxValuation.fiscalYear')}>
            <input name="fiscalYear" defaultValue={defaults.fiscalYear} className="field-input code w-24" required placeholder="2026" />
          </Field>
          <Field label={t('fxValuation.method')}>
            <select name="valuationMethod" defaultValue={defaults.valuationMethod} className="field-input w-36">
              {FX_RATE_TYPES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label={t('fxValuation.documentType')}>
            <input name="documentType" defaultValue={defaults.documentType} className="field-input code w-24" required maxLength={12} placeholder="SA" />
          </Field>
          <Field label={t('fxValuation.reversalDate')}>
            <input type="date" name="reversalDate" defaultValue={defaults.reversalDate} className="field-input w-40" />
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="openItems" value="on" defaultChecked={defaults.includeOpenItems} />
            {t('fxValuation.openItems')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="balances" value="on" defaultChecked={defaults.includeBalances} />
            {t('fxValuation.balances')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="testRun" value="on" defaultChecked={defaults.testRun} />
            {t('fxValuation.testRun')}
          </label>
        </div>
        <p className="text-2xs text-ink-faint">{t('fxValuation.modeHint')}</p>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('fxValuation.execute')}</button>
      </form>

      {result && (
        <section className="panel overflow-x-auto" aria-label={t('fxValuation.protocol')}>
          <div className="panel-header">
            <h2 className="panel-title">{t('fxValuation.protocol')} · {result.runId}</h2>
            <span className="text-2xs text-ink-faint">
              {result.status} · {result.companyCode} · {result.valuationArea} · {result.valuationKeyDate} · {result.currency}
            </span>
            <Link href={`/finance/fx/valuation/export?run=${encodeURIComponent(result.runId)}`} className="btn btn-default min-h-11 sm:min-h-8">
              {t('fxValuation.export')}
            </Link>
          </div>
          {result.warnings.length > 0 && (
            <ul className="space-y-1 border-b border-line bg-signal-warn-soft px-3 py-2 text-sm text-signal-warn">
              {result.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          <table className="grid-table min-w-[64rem]">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('fxValuation.account')}</th>
                <th>{t('fxValuation.source')}</th>
                <th>{t('fxValuation.currency')}</th>
                <th className="text-end">{t('fxValuation.foreign')}</th>
                <th className="text-end">{t('fxValuation.carrying')}</th>
                <th className="text-end">{t('fxValuation.rate')}</th>
                <th className="text-end">{t('fxValuation.required')}</th>
                <th className="text-end">{t('fxValuation.adjustment')}</th>
                <th>{t('fxValuation.classification')}</th>
                <th>{t('fxValuation.status')}</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.itemNumber}>
                  <td className="tabular">{item.itemNumber}</td>
                  <td className="code">{item.accountNumber}</td>
                  <td className="code">{item.sourceDocument ? `${item.sourceDocument}/${item.sourceLine}` : item.sourceKind}</td>
                  <td className="code">{item.currency}</td>
                  <td className="tabular text-end">{money(item.foreignAmount)}</td>
                  <td className="tabular text-end">{money(item.carryingAmount)}</td>
                  <td className="tabular text-end">{item.valuationRate ?? '—'}</td>
                  <td className="tabular text-end">{item.requiredAmount === null ? '—' : money(item.requiredAmount)}</td>
                  <td className="tabular text-end">{item.adjustmentAmount === null ? '—' : money(item.adjustmentAmount)}</td>
                  <td>{item.classification ?? '—'}{item.error && <span className="block text-2xs text-signal-error">{item.error}</span>}</td>
                  <td>{item.status}</td>
                </tr>
              ))}
              {result.items.length === 0 && (
                <tr><td colSpan={11} className="text-sm text-ink-soft">{t('fxValuation.empty')}</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-sunken font-semibold">
                <td colSpan={8}>{t('fxValuation.totals')}</td>
                <td className="tabular text-end">{money(result.totalGain - result.totalLoss)}</td>
                <td colSpan={2}>
                  {t('fxValuation.gain')} {money(result.totalGain)} · {t('fxValuation.loss')} {money(result.totalLoss)}
                </td>
              </tr>
            </tfoot>
          </table>
          {(result.postingDocument || result.reversalDocument) && (
            <p className="border-t border-line px-3 py-2 text-sm text-ink-soft">
              {result.postingDocument && `${t('fxValuation.postedAs')} ${result.postingDocument}. `}
              {result.reversalDocument && `${t('fxValuation.reversedAs')} ${result.reversalDocument}.`}
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
