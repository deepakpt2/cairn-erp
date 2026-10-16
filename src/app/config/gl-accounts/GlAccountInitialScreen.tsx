'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '@/platform/i18n';
import {
  ChartOfAccountsValueHelp,
  type ChartOfAccountsChoice,
} from '../chart-of-accounts/ChartOfAccountsValueHelp';
import { GlAccountValueHelp, type AccountChoice } from './GlAccountValueHelp';
import type { GlAccountMode } from './GlAccountFields';

const ROUTE = '/config/gl-accounts';

/**
 * The FS00 initial screen: Chart of Accounts, G/L account number and mode.
 *
 * The reference transaction asks these three questions before showing a single field,
 * and so does this screen: the account number's maximum length is a property of the chart,
 * so the chart has to be known before the number can be validated. Only
 * active, unblocked charts are offered; accounts of a blocked chart stay readable but
 * cannot be created.
 */
export function GlAccountInitialScreen({
  charts,
  accountsByChart,
  accountNumberLengths,
  canCreate,
  canChange,
}: {
  charts: ChartOfAccountsChoice[];
  accountsByChart: Record<string, AccountChoice[]>;
  accountNumberLengths: Record<string, number>;
  canCreate: boolean;
  canChange: boolean;
}) {
  const router = useRouter();
  const initialMode: GlAccountMode = canCreate ? 'CREATE' : canChange ? 'CHANGE' : 'DISPLAY';
  const [chart, setChart] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [mode, setMode] = useState<GlAccountMode>(initialMode);

  const accounts = accountsByChart[chart] ?? [];
  const length = accountNumberLengths[chart] ?? 10;
  const needsAccount = mode !== 'CREATE';
  const canContinue = chart.length === 4 && (!needsAccount || accountNumber.length > 0);

  function continueTo() {
    if (!canContinue) return;
    const query = new URLSearchParams({ chart });
    if (accountNumber && (needsAccount || mode === 'CREATE')) query.set('account', accountNumber);
    const path = mode === 'CREATE' ? 'new' : mode === 'CHANGE' ? 'edit' : 'view';
    router.push(`${ROUTE}/${path}?${query.toString()}`);
  }

  const modes: { id: GlAccountMode; label: string; allowed: boolean; authority: string }[] = [
    { id: 'CREATE', label: t('glAccount.modeCreate'), allowed: canCreate, authority: 'CFG.FIN.GLACCOUNT.CREATE' },
    { id: 'CHANGE', label: t('glAccount.modeChange'), allowed: canChange, authority: 'CFG.FIN.GLACCOUNT.CHANGE' },
    { id: 'DISPLAY', label: t('glAccount.modeDisplay'), allowed: true, authority: 'CFG.FIN.GLACCOUNT.DISPLAY' },
  ];

  return (
    <section aria-labelledby="fs00-initial-title" className="panel overflow-hidden">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="fs00-initial-title" className="panel-title">{t('glAccount.initialTitle')}</h2>
        <p className="mt-1 text-xs text-ink-faint">{t('glAccount.initialRule')}</p>
      </div>

      <div className="space-y-4 p-3 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <ChartOfAccountsValueHelp
            id="fs00-initial-chart"
            name="chart"
            label={t('glAccount.chart')}
            value={chart}
            onChange={(value) => {
              setChart(value);
              setAccountNumber('');
            }}
            choices={charts}
            dialogTitle={t('glAccount.chartLookup')}
            emptyText={t('glAccount.chartEmpty')}
            rule={t('glAccount.chartRule')}
          />

          <GlAccountValueHelp
            id="fs00-initial-account"
            name="account"
            label={t('glAccount.accountNumber')}
            value={accountNumber}
            onChange={setAccountNumber}
            choices={accounts}
            dialogTitle={t('glAccount.accountNumberLookup')}
            emptyText={t('glAccount.accountNumberEmpty')}
            rule={t('glAccount.accountNumberRule', { length })}
            maxLength={length}
            required={needsAccount}
            disabled={chart.length !== 4}
          />
        </div>

        <fieldset>
          <legend className="field-label">{t('glAccount.mode')}</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {modes.map((option) => (
              <label
                key={option.id}
                className="flex min-h-11 items-center gap-2 border border-line bg-white px-3 text-sm sm:min-h-9"
                title={option.allowed ? undefined : t('glAccount.modeDenied', { authority: option.authority })}
              >
                <input
                  type="radio"
                  name="mode"
                  value={option.id}
                  className="h-4 w-4"
                  checked={mode === option.id}
                  disabled={!option.allowed}
                  onChange={() => setMode(option.id)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex justify-end border-t border-line pt-4">
          <button
            type="button"
            className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
            disabled={!canContinue}
            onClick={continueTo}
          >
            {t('glAccount.continue')}
          </button>
        </div>
      </div>
    </section>
  );
}
