import Link from 'next/link';
import { t } from '@/platform/i18n';
import type { TrialBalanceResult } from '@/modules/finance/trial-balance';

/**
 * Trial balance / F.01 statement (SCR-106): pick company, FSV,
 * year and period range (plus optional comparison), and read
 * the statement tree — nodes roll up accounts, accounts drill
 * to balances and line items. Read-only; unassigned accounts
 * are named, never dropped.
 */
export default function TrialBalanceShell({ canUse, result }: {
  canUse: boolean;
  result: TrialBalanceResult | null;
}) {
  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.RPT.TRIALBALANCE' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form method="get" className="panel space-y-3 p-4" aria-label={t('trial.selectionTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('trial.company')}>
            <input name="companyCode" required className="field-input code w-36" placeholder="1000" />
          </Field>
          <Field label={t('trial.version')}>
            <input name="statementVersion" required className="field-input code w-36" placeholder="INT" />
          </Field>
          <Field label={t('trial.fiscalYear')}>
            <input name="fiscalYear" type="number" required className="field-input code w-28" placeholder="2026" />
          </Field>
          <Field label={t('trial.periodFrom')}>
            <input name="periodFrom" type="number" min={1} max={16} defaultValue={1} className="field-input code w-24" />
          </Field>
          <Field label={t('trial.periodTo')}>
            <input name="periodTo" type="number" min={1} max={16} required className="field-input code w-24" placeholder="12" />
          </Field>
          <Field label={t('trial.comparisonYear')}>
            <input name="comparisonFiscalYear" type="number" className="field-input code w-28" placeholder="2025" />
          </Field>
          <Field label={t('trial.outputCurrency')}>
            <input name="outputCurrency" maxLength={5} className="field-input code w-28" placeholder="USD" />
          </Field>
          <Field label={t('trial.specialPeriods')}>
            <span className="flex items-center gap-1 pt-2 text-sm text-ink-soft">
              <input type="checkbox" name="includeSpecialPeriods" value="true" /> {t('trial.includeSpecial')}
            </span>
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
          {t('trial.run')}
        </button>
      </form>

      {result && (
        <>
          <p className="text-sm text-ink-soft">
            {t('trial.calculatedAt', {
              when: result.calculatedAt.slice(0, 19).replace('T', ' '),
              company: result.companyCode, version: result.statementVersion,
              year: result.fiscalYear, to: result.periodTo, currency: result.currency,
            })}
          </p>
          {result.warnings.map((warning) => (
            <p key={warning} className="border border-signal-warn/40 bg-signal-warn-soft p-3 text-sm text-ink">{warning}</p>
          ))}
          <section className="panel overflow-x-auto" aria-label={t('trial.gridTitle')}>
            <table className="grid-table min-w-[64rem]">
              <thead>
                <tr>
                  <th>{t('trial.node')}</th>
                  <th className="text-end">{t('trial.balance')}</th>
                  <th className="text-end">{t('trial.debit')}</th>
                  <th className="text-end">{t('trial.credit')}</th>
                  <th className="text-end">{t('trial.comparative')}</th>
                  <th className="text-end">{t('trial.variance')}</th>
                  <th className="text-end">{t('trial.variancePercent')}</th>
                </tr>
              </thead>
              <tbody>
                {result.nodes.map((node) => (
                  <NodeRows key={node.node} node={node} currency={result.currency} company={result.companyCode} year={result.fiscalYear} />
                ))}
                <tr className="font-semibold">
                  <td>{t('trial.totalTurnover')}</td>
                  <td />
                  <td className="tabular text-end">{result.totalDebitTurnover.toFixed(2)}</td>
                  <td className="tabular text-end">{result.totalCreditTurnover.toFixed(2)}</td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </section>

          {result.unassigned.length > 0 && (
            <section className="panel" aria-label={t('trial.unassignedTitle')}>
              <div className="panel-header"><h2 className="panel-title">{t('trial.unassignedTitle')}</h2></div>
              <table className="grid-table">
                <tbody>
                  {result.unassigned.map((account) => (
                    <tr key={account.accountNumber}>
                      <td className="code">{account.accountNumber} — {account.accountName}</td>
                      <td className="tabular text-end">{account.balance.toFixed(2)} {result.currency}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function NodeRows({ node, currency, company, year }: {
  node: TrialBalanceResult['nodes'][number];
  currency: string;
  company: string;
  year: number;
}) {
  return (
    <>
      <tr className={node.depth === 0 ? 'bg-sunken font-semibold' : 'font-medium'}>
        <td style={{ paddingLeft: `${0.75 + node.depth * 1.25}rem` }}>{node.description} <span className="code text-ink-faint">({node.node})</span></td>
        <td className="tabular text-end">{node.balance.toFixed(2)}</td>
        <td className="tabular text-end">{node.debitTurnover.toFixed(2)}</td>
        <td className="tabular text-end">{node.creditTurnover.toFixed(2)}</td>
        <td className="tabular text-end">{node.comparativeBalance === null ? '—' : node.comparativeBalance.toFixed(2)}</td>
        <td className="tabular text-end">{node.variance === null ? '—' : node.variance.toFixed(2)}</td>
        <td className="tabular text-end">{node.variancePercent === null ? '—' : `${node.variancePercent.toFixed(1)}%`}</td>
      </tr>
      {node.accounts.map((account) => (
        <tr key={`${node.node}-${account.accountNumber}`} className="text-ink-soft">
          <td style={{ paddingLeft: `${0.75 + (node.depth + 1) * 1.25}rem` }}>
            <Link
              href={`/finance/journal/balances?company=${encodeURIComponent(company)}&account=${encodeURIComponent(account.accountNumber)}&fiscalYear=${year}`}
              className="text-accent hover:underline"
            >
              {account.accountNumber} — {account.accountName}
            </Link>
          </td>
          <td className="tabular text-end">{account.balance.toFixed(2)} {currency}</td>
          <td className="tabular text-end">{account.debitTurnover.toFixed(2)}</td>
          <td className="tabular text-end">{account.creditTurnover.toFixed(2)}</td>
          <td className="tabular text-end">{account.comparativeBalance === null ? '—' : account.comparativeBalance.toFixed(2)}</td>
          <td colSpan={2} />
        </tr>
      ))}
    </>
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
