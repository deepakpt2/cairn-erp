'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { saveChartOfAccountsAction, type ChartOfAccountsActionState } from './actions';
import { ChartLanguageField, ChartOfAccountsValueHelp, type ChartOfAccountsChoice, type LanguageChoice } from './ChartOfAccountsValueHelp';

export type CostElementIntegration = 'AUTOMATIC' | 'MANUAL' | 'NONE';

export interface ChartOfAccountsRecord {
  chartOfAccounts: string;
  name: string;
  language: string;
  accountNumberLength: number;
  groupChart: string | null;
  costElementIntegration: CostElementIntegration;
  isBlocked: boolean;
  isActive: boolean;
  glAccountCount: number;
  hasTransactions: boolean;
  accountNumberLengthLocked: boolean;
  version: number;
}

interface ChartOfAccountsFormProps {
  mode: 'CREATE' | 'CHANGE';
  initial?: ChartOfAccountsRecord;
  languages: LanguageChoice[];
  groupCharts: ChartOfAccountsChoice[];
  canMaintain: boolean;
}

export function ChartOfAccountsForm({ mode, initial, languages, groupCharts, canMaintain }: ChartOfAccountsFormProps) {
  const [state, action, pending] = useActionState<ChartOfAccountsActionState, FormData>(
    saveChartOfAccountsAction,
    { ok: true },
  );
  const [code, setCode] = useState(initial?.chartOfAccounts ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [language, setLanguage] = useState(initial?.language ?? 'EN');
  const [accountNumberLength, setAccountNumberLength] = useState(String(initial?.accountNumberLength ?? 10));
  const [groupChart, setGroupChart] = useState(initial?.groupChart ?? '');
  const [costElementIntegration, setCostElementIntegration] = useState<CostElementIntegration>(initial?.costElementIntegration ?? 'AUTOMATIC');
  const [isBlocked, setIsBlocked] = useState(initial?.isBlocked ?? false);
  const [reason, setReason] = useState('');
  const editing = mode === 'CHANGE' && initial !== undefined;
  const idPrefix = editing ? `ob13-change-${initial.chartOfAccounts.toLowerCase()}` : 'ob13-create';
  const lengthLocked = editing && initial.accountNumberLengthLocked;

  return (
    <section className="panel overflow-hidden" aria-labelledby={`${idPrefix}-title`}>
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id={`${idPrefix}-title`} className="font-semibold">
          {t(editing ? 'chartOfAccounts.changeTitle' : 'chartOfAccounts.createTitle')}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">{t('chartOfAccounts.formHint')}</p>
      </div>

      {state.message && <ActionMessage state={state} />}

      <form action={action} className="space-y-4 p-3 sm:p-5">
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="expectedVersion" value={initial?.version ?? 0} />
        {editing && <input type="hidden" name="chartOfAccounts" value={initial.chartOfAccounts} />}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${idPrefix}-code`} className="field-label">
              {t('chartOfAccounts.code')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            {editing ? (
              <input id={`${idPrefix}-code`} type="text" value={initial.chartOfAccounts} readOnly className="field-input code mt-1 min-h-11 w-full cursor-not-allowed bg-sunken sm:min-h-9" aria-label={t('chartOfAccounts.code')} />
            ) : (
              <input
                id={`${idPrefix}-code`}
                name="chartOfAccounts"
                type="text"
                required
                minLength={4}
                maxLength={4}
                pattern="[A-Z0-9]{4}"
                title={t('chartOfAccounts.codeRule')}
                autoComplete="off"
                autoCapitalize="characters"
                value={code}
                onChange={(event) => setCode(event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                className="field-input code mt-1 min-h-11 w-full uppercase sm:min-h-9"
                disabled={pending || !canMaintain}
              />
            )}
            <p className="mt-1 text-xs text-ink-faint">{t('chartOfAccounts.codeRule')}</p>
          </div>

          <div>
            <label htmlFor={`${idPrefix}-description`} className="field-label">
              {t('chartOfAccounts.description')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id={`${idPrefix}-description`}
              name="name"
              type="text"
              required
              minLength={1}
              maxLength={50}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.currentTarget.value.slice(0, 50))}
              className="field-input mt-1 min-h-11 w-full sm:min-h-9"
              disabled={pending || !canMaintain}
            />
            <p className="mt-1 text-xs text-ink-faint">{t('chartOfAccounts.descriptionRule')}</p>
          </div>

          <ChartLanguageField
            id={`${idPrefix}-language`}
            name="language"
            label={t('chartOfAccounts.language')}
            value={language}
            onChange={setLanguage}
            choices={languages}
            disabled={pending || !canMaintain}
          />

          <div>
            <label htmlFor={`${idPrefix}-account-length`} className="field-label">
              {t('chartOfAccounts.accountNumberLength')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id={`${idPrefix}-account-length`}
              name="accountNumberLength"
              type="number"
              required
              min={1}
              max={10}
              step={1}
              value={accountNumberLength}
              onChange={(event) => setAccountNumberLength(event.currentTarget.value)}
              className={`field-input code mt-1 min-h-11 w-full sm:min-h-9 ${lengthLocked ? 'cursor-not-allowed bg-sunken text-ink-soft' : ''}`}
              readOnly={lengthLocked}
              disabled={pending || !canMaintain}
              aria-describedby={`${idPrefix}-account-length-rule`}
            />
            <p id={`${idPrefix}-account-length-rule`} className="mt-1 text-xs text-ink-faint">
              {t(lengthLocked ? 'chartOfAccounts.accountLengthLocked' : 'chartOfAccounts.accountNumberLengthRule')}
            </p>
          </div>

          <ChartOfAccountsValueHelp
            id={`${idPrefix}-group-chart`}
            name="groupChart"
            label={t('chartOfAccounts.groupChart')}
            value={groupChart}
            onChange={setGroupChart}
            choices={groupCharts.filter((choice) => choice.code !== (initial?.chartOfAccounts ?? code))}
            dialogTitle={t('chartOfAccounts.groupChartLookup')}
            emptyText={t('chartOfAccounts.noGroupChartsMatch')}
            rule={t('chartOfAccounts.groupChartRule')}
            disabled={pending || !canMaintain}
          />

          <div>
            <label htmlFor={`${idPrefix}-cost-element-integration`} className="field-label">
              {t('chartOfAccounts.costElementIntegration')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <select
              id={`${idPrefix}-cost-element-integration`}
              name="costElementIntegration"
              required
              value={costElementIntegration}
              onChange={(event) => setCostElementIntegration(event.currentTarget.value as CostElementIntegration)}
              className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
              disabled={pending || !canMaintain}
            >
              <option value="AUTOMATIC">{t('chartOfAccounts.costElementAutomatic')}</option>
              <option value="MANUAL">{t('chartOfAccounts.costElementManual')}</option>
              <option value="NONE">{t('chartOfAccounts.costElementNone')}</option>
            </select>
            <p className="mt-1 text-xs text-ink-faint">{t('chartOfAccounts.costElementIntegrationRule')}</p>
          </div>

          <div className="sm:col-span-2">
            <label className="flex min-h-11 items-start gap-3 border border-line bg-white px-3 py-3 sm:min-h-9">
              <input type="checkbox" name="isBlocked" checked={isBlocked} onChange={(event) => setIsBlocked(event.currentTarget.checked)} className="mt-0.5 h-4 w-4 accent-accent" disabled={pending || !canMaintain} />
              <span>
                <span className="block text-sm font-medium">{t('chartOfAccounts.blockCreation')}</span>
                <span className="mt-1 block text-xs text-ink-soft">{t('chartOfAccounts.blockCreationRule')}</span>
              </span>
            </label>
          </div>

          <div className="sm:col-span-2">
            <label htmlFor={`${idPrefix}-reason`} className="field-label">{t('chartOfAccounts.changeReason')}</label>
            <textarea id={`${idPrefix}-reason`} name="reason" maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.currentTarget.value.slice(0, 500))} className="field-input mt-1 min-h-20 w-full" disabled={pending || !canMaintain} />
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-3xl text-xs text-ink-soft">{t('chartOfAccounts.creationRule')}</p>
          <button type="submit" className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto" disabled={pending || !canMaintain || languages.length === 0}>
            {pending ? t('common.saving') : t(editing ? 'chartOfAccounts.saveButton' : 'chartOfAccounts.createButton')}
          </button>
        </div>
      </form>
    </section>
  );
}

export function ActionMessage({ state }: { state: ChartOfAccountsActionState }) {
  return (
    <div role={state.ok ? 'status' : 'alert'} className={`mx-3 mt-3 border p-3 text-sm ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}>
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
    </div>
  );
}
