'use client';

import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import { setChartOfAccountsActiveAction } from './actions';
import { ChartOfAccountsForm, type ChartOfAccountsRecord } from './ChartOfAccountsForm';
import { ChartLifecycleControl } from './ChartLifecycleControl';
import type { ChartOfAccountsChoice, LanguageChoice } from './ChartOfAccountsValueHelp';
import { useState } from 'react';

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
          <table className="grid-table min-w-[61.25rem]">
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
                      <span className={`chip ${chart.isActive ? 'chip-ok' : 'chip-neutral'}`}>{t(chart.isActive ? 'chartOfAccounts.active' : 'chartOfAccounts.deactivated')}</span>
                      {chart.isBlocked && <span className="chip chip-warn">{t('chartOfAccounts.blocked')}</span>}
                    </div>
                  </td>
                  {canMaintain && (
                    <td>
                      <div className="flex flex-col gap-2">
                      {chart.isActive ? (
                        <ChartChangeDialog chart={chart} languages={languages} groupCharts={groupCharts} canMaintain={canMaintain} />
                      ) : (
                        <span className="text-xs text-ink-faint">{t('chartOfAccounts.inactiveRetained')}</span>
                      )}
                      <ChartLifecycleControl
                        action={setChartOfAccountsActiveAction}
                        codeField="chartOfAccounts"
                        code={chart.chartOfAccounts}
                        isActive={chart.isActive}
                        version={chart.version}
                        canMaintain={canMaintain}
                        idPrefix={`chart-of-accounts-${chart.chartOfAccounts.toLowerCase()}`}
                      />
                      </div>
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

function ChartChangeDialog({
  chart,
  languages,
  groupCharts,
  canMaintain,
}: {
  chart: ChartOfAccountsRecord;
  languages: LanguageChoice[];
  groupCharts: ChartOfAccountsChoice[];
  canMaintain: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lock = useChangeLock('CHART_OF_ACCOUNTS', chart.chartOfAccounts.trim(), 'CFG.FIN.COA.DEFINE', open);
  return (
    <details className="min-w-44" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">{t('chartOfAccounts.changeSettings')}</summary>
      <div role="dialog" aria-modal="true" aria-label={`${t('chartOfAccounts.changeTitle')} ${chart.chartOfAccounts}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
        <div className="mx-auto max-w-5xl">
          <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
            <div><span className="code text-xs text-ink-faint">OB13 · {chart.chartOfAccounts}</span><p className="font-semibold">{t('chartOfAccounts.changeTitle')}</p></div>
            <button type="button" className="btn btn-default min-h-11 sm:min-h-9" onClick={(event) => { const details = event.currentTarget.closest('details'); if (details) details.open = false; }}>{t('common.close')}</button>
          </div>
          <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
          <ChartOfAccountsForm key={chart.chartOfAccounts} mode="CHANGE" initial={chart} languages={languages} groupCharts={groupCharts} canMaintain={canMaintain} submitDisabled={lock?.mode !== 'CHANGE'} />
        </div>
      </div>
    </details>
  );
}
