import { t } from '@/platform/i18n';
import { MAX_SUMMARY_LEVEL, MIN_SUMMARY_LEVEL, type BalanceSheetSelection } from '@/modules/finance/balance-sheet';
import type { ProfitLossResult } from '@/modules/finance/profit-loss';

/**
 * Profit and loss statement (SCR-111): selection over company,
 * FSV, reporting and comparison ranges; the P&L grid follows
 * in stage 3. Read-only by construction.
 */
export default function ProfitLossShell({ canUse, companies, versions, selection, result }: {
  canUse: boolean;
  companies: Array<{ companyCode: string; name: string }>;
  versions: Array<{ version: string; name: string; chartOfAccounts: string }>;
  selection: BalanceSheetSelection;
  result: ProfitLossResult | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.RPT.PROFITLOSS' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('pl.selectionTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('pl.company')}>
            <select name="companyCode" className="field-input code w-52" defaultValue={selection.companyCode}>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}
            </select>
          </Field>
          <Field label={t('pl.version')}>
            <select name="statementVersion" className="field-input code w-52" defaultValue={selection.statementVersion}>
              {versions.map((v) => <option key={v.version} value={v.version}>{v.version} — {v.name} ({v.chartOfAccounts})</option>)}
            </select>
          </Field>
          <Field label={t('pl.fiscalYear')}>
            <input name="fiscalYear" type="number" required defaultValue={selection.fiscalYear} className="field-input code w-28" />
          </Field>
          <Field label={t('pl.periodFrom')}>
            <input name="periodFrom" type="number" min={1} max={16} defaultValue={selection.periodFrom} className="field-input code w-24" />
          </Field>
          <Field label={t('pl.periodTo')}>
            <input name="periodTo" type="number" min={1} max={16} required defaultValue={selection.periodTo} className="field-input code w-24" />
          </Field>
          <Field label={t('pl.comparisonYear')}>
            <input name="comparisonFiscalYear" type="number" defaultValue={selection.comparisonFiscalYear ?? ''} className="field-input code w-28" placeholder="2025" />
          </Field>
          <Field label={t('pl.comparisonFrom')}>
            <input name="comparisonPeriodFrom" type="number" min={1} max={16} defaultValue={selection.comparisonPeriodFrom ?? ''} className="field-input code w-24" />
          </Field>
          <Field label={t('pl.comparisonTo')}>
            <input name="comparisonPeriodTo" type="number" min={1} max={16} defaultValue={selection.comparisonPeriodTo ?? ''} className="field-input code w-24" />
          </Field>
          <Field label={t('pl.outputCurrency')}>
            <input name="outputCurrency" maxLength={5} defaultValue={selection.outputCurrency ?? ''} className="field-input code w-28" placeholder="USD" />
          </Field>
          <Field label={t('pl.summaryLevel')}>
            <input name="summaryLevel" type="number" min={MIN_SUMMARY_LEVEL} max={MAX_SUMMARY_LEVEL} defaultValue={selection.summaryLevel} className="field-input code w-24" />
          </Field>
          <Field label={t('pl.ledger')}>
            <input name="ledger" defaultValue={selection.ledger} readOnly className="field-input code w-24" />
          </Field>
          <Field label={t('pl.specialPeriods')}>
            <span className="flex items-center gap-1 pt-2 text-sm text-ink-soft">
              <input type="checkbox" name="includeSpecialPeriods" value="true" /> {t('pl.includeSpecial')}
            </span>
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">
          {t('pl.run')}
        </button>
      </form>

      <section className="panel overflow-x-auto" aria-label={t('pl.gridTitle')}>
        <table className="grid-table min-w-[64rem]">
          <thead>
            <tr>
              <th>{t('pl.node')}</th>
              <th className="text-end">{t('pl.periodMovement')}</th>
              <th className="text-end">{t('pl.yearToDate')}</th>
              <th className="text-end">{t('pl.comparative')}</th>
              <th className="text-end">{t('pl.variance')}</th>
              <th className="text-end">{t('pl.variancePercent')}</th>
              <th>{t('pl.currency')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={7} className="text-ink-soft">{result ? '' : t('pl.empty')}</td>
            </tr>
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
