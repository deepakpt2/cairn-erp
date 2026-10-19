import Link from 'next/link';
import { t } from '@/platform/i18n';
import {
  BALANCE_CALCULATION_TYPES, MAX_SUMMARY_LEVEL, MIN_SUMMARY_LEVEL,
  type BalanceSheetResult, type BalanceSheetSelection,
} from '@/modules/finance/balance-sheet';

/**
 * Balance sheet / P&L statement (SCR-107): selection over
 * company, FSV, reporting and comparison ranges, calculation
 * type and summary level; the grid shows opening, period
 * debit/credit, closing, comparative and variance per node,
 * with account drill-down to balances and line items.
 * Read-only; unassigned accounts are named, never dropped.
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

      {result && (
        <>
          <p className="text-sm text-ink-soft">
            {t('bs.calculatedAt', {
              when: result.calculatedAt.slice(0, 19).replace('T', ' '),
              company: result.companyCode, version: result.statementVersion,
              year: result.fiscalYear, from: result.periodFrom, to: result.periodTo,
              type: typeLabels[result.calculationType], level: result.summaryLevel,
              ledger: result.ledger, currency: result.currency,
            })}
            {' · '}
            <a className="text-accent hover:underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(result))}`} download="balance-sheet.csv">
              {t('bs.exportCsv')}
            </a>
          </p>
          {result.warnings.map((warning) => (
            <p key={warning} className="border border-signal-warn/40 bg-signal-warn-soft p-3 text-sm text-ink">{warning}</p>
          ))}
          {result.currentYearResult !== null && (
            <p className="panel p-3 text-sm">
              {t('bs.currentYearResult')}: <span className="tabular font-semibold">{result.currentYearResult.toFixed(2)} {result.currency}</span>
            </p>
          )}
        </>
      )}

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
            {result ? (
              <>
                {result.nodes.map((node) => (
                  <NodeRows key={node.node} node={node} currency={result.currency} company={result.companyCode} year={result.fiscalYear} />
                ))}
                <tr className="font-semibold">
                  <td>{t('bs.totalTurnover')}</td>
                  <td />
                  <td className="tabular text-end">{result.totalDebitTurnover.toFixed(2)}</td>
                  <td className="tabular text-end">{result.totalCreditTurnover.toFixed(2)}</td>
                  <td colSpan={5} />
                </tr>
              </>
            ) : (
              <tr>
                <td colSpan={9} className="text-ink-soft">{t('bs.empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {result && result.unassigned.length > 0 && (
        <section className="panel" aria-label={t('bs.unassignedTitle')}>
          <div className="panel-header"><h2 className="panel-title">{t('bs.unassignedTitle')}</h2></div>
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
    </div>
  );
}

function NodeRows({ node, currency, company, year }: {
  node: BalanceSheetResult['nodes'][number];
  currency: string;
  company: string;
  year: number;
}) {
  return (
    <>
      <tr className={node.depth === 0 ? 'bg-sunken font-semibold' : 'font-medium'}>
        <td style={{ paddingLeft: `${0.75 + node.depth * 1.25}rem` }}>{node.description} <span className="code text-ink-faint">({node.node})</span></td>
        <td className="tabular text-end">{node.openingBalance.toFixed(2)}</td>
        <td className="tabular text-end">{node.debitTurnover.toFixed(2)}</td>
        <td className="tabular text-end">{node.creditTurnover.toFixed(2)}</td>
        <td className="tabular text-end">{node.balance.toFixed(2)}</td>
        <td className="tabular text-end">{node.comparativeBalance === null ? '—' : node.comparativeBalance.toFixed(2)}</td>
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
              {t('bs.lineItems')}
            </Link>
          </td>
          <td className="tabular text-end">{account.openingBalance.toFixed(2)}</td>
          <td className="tabular text-end">{account.debitTurnover.toFixed(2)}</td>
          <td className="tabular text-end">{account.creditTurnover.toFixed(2)}</td>
          <td className="tabular text-end">{account.balance.toFixed(2)} {currency}</td>
          <td className="tabular text-end">{account.comparativeBalance === null ? '—' : account.comparativeBalance.toFixed(2)}</td>
          <td colSpan={3} />
        </tr>
      ))}
    </>
  );
}

function toCsv(result: BalanceSheetResult): string {
  const head = 'Node/Account,Opening,Debit,Credit,Closing,Comparative,Variance,Variance %';
  const lines = [head];
  for (const node of result.nodes) {
    lines.push([`${node.node} ${node.description}`, node.openingBalance, node.debitTurnover, node.creditTurnover, node.balance, node.comparativeBalance ?? '', node.variance ?? '', node.variancePercent ?? ''].join(','));
    for (const account of node.accounts) {
      lines.push([`${account.accountNumber} ${account.accountName}`, account.openingBalance, account.debitTurnover, account.creditTurnover, account.balance, account.comparativeBalance ?? '', '', ''].join(','));
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
