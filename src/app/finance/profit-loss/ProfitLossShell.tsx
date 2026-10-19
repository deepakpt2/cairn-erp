import Link from 'next/link';
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

      {result && (
        <>
          <p className="text-sm text-ink-soft">
            {t('pl.calculatedAt', {
              when: result.calculatedAt.slice(0, 19).replace('T', ' '),
              company: result.companyCode, version: result.statementVersion,
              year: result.fiscalYear, from: result.periodFrom, to: result.periodTo,
              level: result.summaryLevel, ledger: result.ledger, currency: result.currency,
            })}
            {' · '}
            <a className="text-accent hover:underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(result))}`} download="profit-loss.csv">
              {t('pl.exportCsv')}
            </a>
          </p>
          {result.warnings.map((warning) => (
            <p key={warning} className="border border-signal-warn/40 bg-signal-warn-soft p-3 text-sm text-ink">{warning}</p>
          ))}
          {result.currentYearResult !== null && (
            <p className="panel p-3 text-sm">
              {t('pl.currentYearResult')}: <span className="tabular font-semibold">{result.currentYearResult.toFixed(2)} {result.currency}</span>
            </p>
          )}
        </>
      )}

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
            {result ? (
              result.nodes.map((node) => (
                <NodeRows key={node.node} node={node} currency={result.currency} company={result.companyCode} year={result.fiscalYear} />
              ))
            ) : (
              <tr>
                <td colSpan={7} className="text-ink-soft">{t('pl.empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {result && result.unassigned.length > 0 && (
        <section className="panel" aria-label={t('pl.unassignedTitle')}>
          <div className="panel-header"><h2 className="panel-title">{t('pl.unassignedTitle')}</h2></div>
          <table className="grid-table">
            <tbody>
              {result.unassigned.map((account) => (
                <tr key={account.accountNumber}>
                  <td className="code">{account.accountNumber} — {account.accountName}</td>
                  <td className="tabular text-end">{account.periodMovement.toFixed(2)} {result.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function NodeRows({ node, currency, company, year }: {
  node: ProfitLossResult['nodes'][number];
  currency: string;
  company: string;
  year: number;
}) {
  return (
    <>
      <tr className={node.depth === 0 ? 'bg-sunken font-semibold' : 'font-medium'}>
        <td style={{ paddingLeft: `${0.75 + node.depth * 1.25}rem` }}>{node.description} <span className="code text-ink-faint">({node.node})</span></td>
        <td className="tabular text-end">{node.periodMovement.toFixed(2)}</td>
        <td className="tabular text-end">{node.yearToDateMovement.toFixed(2)}</td>
        <td className="tabular text-end">{node.comparativeMovement === null ? '—' : node.comparativeMovement.toFixed(2)}</td>
        <td className="tabular text-end">{node.variance === null ? '—' : node.variance.toFixed(2)}</td>
        <td className="tabular text-end">{node.variancePercent === null ? '—' : `${node.variancePercent.toFixed(1)}%`}</td>
        <td className="code">{currency}</td>
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
            {' · '}
            <Link
              href={`/finance/journal/items?accountFrom=${encodeURIComponent(account.accountNumber)}&accountTo=${encodeURIComponent(account.accountNumber)}&companyCodes=${encodeURIComponent(company)}&fiscalYear=${year}`}
              className="text-accent hover:underline"
            >
              {t('pl.lineItems')}
            </Link>
          </td>
          <td className="tabular text-end">{account.periodMovement.toFixed(2)}</td>
          <td className="tabular text-end">{account.yearToDateMovement.toFixed(2)}</td>
          <td className="tabular text-end">{account.comparativeMovement === null ? '—' : account.comparativeMovement.toFixed(2)}</td>
          <td colSpan={3} />
        </tr>
      ))}
    </>
  );
}

function toCsv(result: ProfitLossResult): string {
  const head = 'Node/Account,Period Movement,Year-to-Date Movement,Comparative Movement,Variance,Variance %';
  const lines = [head];
  for (const node of result.nodes) {
    lines.push([`${node.node} ${node.description}`, node.periodMovement, node.yearToDateMovement, node.comparativeMovement ?? '', node.variance ?? '', node.variancePercent ?? ''].join(','));
    for (const account of node.accounts) {
      lines.push([`${account.accountNumber} ${account.accountName}`, account.periodMovement, account.yearToDateMovement, account.comparativeMovement ?? '', '', ''].join(','));
    }
  }
  return lines.join('\n');
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}
