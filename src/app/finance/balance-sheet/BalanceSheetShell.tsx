import { t } from '@/platform/i18n';
import {
  BALANCE_CALCULATION_TYPES, MAX_SUMMARY_LEVEL, MIN_SUMMARY_LEVEL,
  type BalanceSheetResult, type BalanceSheetSelection,
} from '@/modules/finance/balance-sheet';

/**
 * Balance sheet / P&L statement (SCR-107): selection over
 * company, FSV, reporting and comparison ranges, calculation
 * type and summary level; the statement grid follows in
 * stage 3. Read-only by construction.
 */
export default function BalanceSheetShell({ canUse, companies, versions, selection, result }: {
  canUse: boolean;
  companies: Array<{ companyCode: string; name: string }>;
  versions: Array<{ version: string; name: string; chartOfAccounts: string }>;
  selection: BalanceSheetSelection;
  result: BalanceSheetResult | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.RPT.BALANCESHEET' })}
      </div>
    );
  }
  const typeLabels: Record<string, string> = {
    ACCUMULATED: t('bs.typeAccumulated'),
    MOVEMENT: t('bs.typeMovement'),
    COMBINED: t('bs.typeCombined'),
  };
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('bs.selectionTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('bs.company')}>
            <select name="companyCode" className="field-input code w-52" defaultValue={selection.companyCode}>
              {companies.map((c) => <option key={c.companyCode} value={c.companyCode}>{c.companyCode} · {c.name}</option>)}
            </select>
          </Field>
          <Field label={t('bs.version')}>
            <select name="statementVersion" className="field-input code w-52" defaultValue={selection.statementVersion}>
              {versions.map((v) => <option key={v.version} value={v.version}>{v.version} — {v.name} ({v.chartOfAccounts})</option>)}
            </select>
          </Field>
          <Field label={t('bs.fiscalYear')}>
            <input name="fiscalYear" type="number" required defaultValue={selection.fiscalYear} className="field-input code w-28" />
          </Field>
          <Field label={t('bs.periodFrom')}>
            <input name="periodFrom" type="number" min={1} max={16} defaultValue={selection.periodFrom} className="field-input code w-24" />
          </Field>
          <Field label={t('bs.periodTo')}>
            <input name="periodTo" type="number" min={1} max={16} required defaultValue={selection.periodTo} className="field-input code w-24" />
          </Field>
          <Field label={t('bs.comparisonYear')}>
            <input name="comparisonFiscalYear" type="number" defaultValue={selection.comparisonFiscalYear ?? ''} className="field-input code w-28" placeholder="2025" />
          </Field>
          <Field label={t('bs.comparisonFrom')}>
            <input name="comparisonPeriodFrom" type="number" min={1} max={16} defaultValue={selection.comparisonPeriodFrom ?? ''} className="field-input code w-24" />
          </Field>
          <Field label={t('bs.comparisonTo')}>
            <input name="comparisonPeriodTo" type="number" min={1} max={16} defaultValue={selection.comparisonPeriodTo ?? ''} className="field-input code w-24" />
          </Field>
          <Field label={t('bs.outputCurrency')}>
            <input name="outputCurrency" maxLength={5} defaultValue={selection.outputCurrency ?? ''} className="field-input code w-28" placeholder="USD" />
          </Field>
          <Field label={t('bs.calculationType')}>
            <select name="calculationType" className="field-input w-64" defaultValue={selection.calculationType}>
              {BALANCE_CALCULATION_TYPES.map((type) => <option key={type} value={type}>{typeLabels[type]}</option>)}
            </select>
          </Field>
          <Field label={t('bs.summaryLevel')}>
            <input name="summaryLevel" type="number" min={MIN_SUMMARY_LEVEL} max={MAX_SUMMARY_LEVEL} defaultValue={selection.summaryLevel} className="field-input code w-24" />
          </Field>
          <Field label={t('bs.ledger')}>
            <input name="ledger" defaultValue={selection.ledger} readOnly className="field-input code w-24" />
          </Field>
          <Field label={t('bs.specialPeriods')}>
            <span className="flex items-center gap-1 pt-2 text-sm text-ink-soft">
              <input type="checkbox" name="includeSpecialPeriods" value="true" /> {t('bs.includeSpecial')}
            </span>
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">
          {t('bs.run')}
        </button>
      </form>

      <section className="panel overflow-x-auto" aria-label={t('bs.gridTitle')}>
        <table className="grid-table min-w-[72rem]">
          <thead>
            <tr>
              <th>{t('bs.node')}</th>
              <th className="text-end">{t('bs.opening')}</th>
              <th className="text-end">{t('bs.debit')}</th>
              <th className="text-end">{t('bs.credit')}</th>
              <th className="text-end">{t('bs.closing')}</th>
              <th className="text-end">{t('bs.comparative')}</th>
              <th className="text-end">{t('bs.variance')}</th>
              <th className="text-end">{t('bs.variancePercent')}</th>
              <th>{t('bs.currency')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={9} className="text-ink-soft">{result ? '' : t('bs.empty')}</td>
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
