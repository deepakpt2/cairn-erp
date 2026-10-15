'use client';

import { t } from '@/platform/i18n';
import { ChartOfAccountsForm, type ChartOfAccountsRecord } from './ChartOfAccountsForm';
import type { ChartOfAccountsChoice, LanguageChoice } from './ChartOfAccountsValueHelp';

export function ChartOfAccountsList({
  charts,
  canMaintain,
  languages,
  groupCharts,
}: {
  charts: ChartOfAccountsRecord[];
  canMaintain: boolean;
  languages: LanguageChoice[];
  groupCharts: ChartOfAccountsChoice[];
}) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="chart-of-accounts-list-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="chart-of-accounts-list-title" className="font-semibold">{t('chartOfAccounts.listTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('chartOfAccounts.listRule')}</p>
      </div>
      {charts.length === 0 ? (
        <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{t('chartOfAccounts.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[980px]">
            <thead>
              <tr>
                <th>{t('chartOfAccounts.code')}</th>
                <th>{t('chartOfAccounts.description')}</th>
                <th>{t('chartOfAccounts.language')}</th>
                <th>{t('chartOfAccounts.accountNumberLength')}</th>
                <th>{t('chartOfAccounts.groupChart')}</th>
                <th>{t('chartOfAccounts.costElementIntegration')}</th>
                <th>{t('chartOfAccounts.status')}</th>
                {canMaintain && <th>{t('chartOfAccounts.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {charts.map((chart) => (
                <tr key={chart.chartOfAccounts}>
                  <td className="code font-semibold">{chart.chartOfAccounts}</td>
                  <td>{chart.name}</td>
                  <td className="code">{chart.language}</td>
                  <td className="code tabular">
                    {chart.accountNumberLength}
                    {chart.accountNumberLengthLocked && <span className="ms-2 chip chip-neutral">{t('chartOfAccounts.locked')}</span>}
                    <p className="mt-1 text-xs font-normal text-ink-faint">{t('chartOfAccounts.glAccountCount', { count: chart.glAccountCount })}</p>
                    {chart.hasTransactions && <p className="text-xs font-normal text-ink-faint">{t('chartOfAccounts.transactionLock')}</p>}
                  </td>
                  <td className="code">{chart.groupChart || '—'}</td>
                  <td>{t(`chartOfAccounts.costElementMode.${chart.costElementIntegration.toLowerCase()}`)}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <span className={`chip ${chart.isActive ? 'chip-ok' : 'chip-neutral'}`}>{t(chart.isActive ? 'chartOfAccounts.active' : 'chartOfAccounts.inactive')}</span>
                      {chart.isBlocked && <span className="chip chip-warn">{t('chartOfAccounts.blocked')}</span>}
                    </div>
                  </td>
                  {canMaintain && (
                    <td>
                      {chart.isActive ? (
                        <details className="min-w-44">
                          <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">{t('chartOfAccounts.changeSettings')}</summary>
                          <div role="dialog" aria-modal="true" aria-label={`${t('chartOfAccounts.changeTitle')} ${chart.chartOfAccounts}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
                            <div className="mx-auto max-w-5xl">
                              <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
                                <div><span className="code text-xs text-ink-faint">OB13 · {chart.chartOfAccounts}</span><p className="font-semibold">{t('chartOfAccounts.changeTitle')}</p></div>
                                <button type="button" className="btn btn-default min-h-11 sm:min-h-9" onClick={(event) => { const details = event.currentTarget.closest('details'); if (details) details.open = false; }}>{t('common.close')}</button>
                              </div>
                              <ChartOfAccountsForm key={`${chart.chartOfAccounts}/${chart.version}`} mode="CHANGE" initial={chart} languages={languages} groupCharts={groupCharts} canMaintain={canMaintain} />
                            </div>
                          </div>
                        </details>
                      ) : (
                        <span className="text-xs text-ink-faint">{t('chartOfAccounts.inactiveRetained')}</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
