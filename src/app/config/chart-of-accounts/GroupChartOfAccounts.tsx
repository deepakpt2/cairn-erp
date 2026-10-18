'use client';

import { useActionState, useEffect, useState } from 'react';
import { t } from '@/platform/i18n';
import {
  saveGroupChartOfAccountsAction,
  setGroupChartOfAccountsActiveAction,
  type ChartOfAccountsActionState,
} from './actions';
import { ActionMessage } from './ChartOfAccountsForm';
import { ChartLanguageField, type LanguageChoice } from './ChartOfAccountsValueHelp';
import { ChartLifecycleControl } from './ChartLifecycleControl';

export interface GroupChartOfAccountsRecord {
  groupChartOfAccounts: string;
  name: string;
  language: string;
  isActive: boolean;
  /** Operational charts still pointing at this Group CoA; references survive deactivation. */
  referencedBy: number;
  version: number;
}

/**
 * Group CoA registry (OB13 amendment).
 *
 * Group Charts of Accounts live in their own tenant-local registry rather than being
 * derived from operational charts, so the Group CoA F4 can never offer a chart that is
 * also used for posting. Keys are reserved tenant-wide across both registries.
 */
export function GroupChartOfAccountsPanel({
  entries,
  languages,
  canMaintain,
}: {
  entries: GroupChartOfAccountsRecord[];
  languages: LanguageChoice[];
  canMaintain: boolean;
}) {
  return (
    <div className="space-y-4">
      <section className="panel overflow-hidden" aria-labelledby="group-chart-panel-title">
        <div className="border-b border-line bg-sunken px-4 py-3">
          <h2 id="group-chart-panel-title" className="font-semibold">{t('chartOfAccounts.groupPanelTitle')}</h2>
          <p className="mt-1 text-xs text-ink-soft">{t('chartOfAccounts.groupPanelRule')}</p>
        </div>
        {canMaintain
          ? <GroupChartOfAccountsForm mode="CREATE" languages={languages} canMaintain={canMaintain} />
          : <p role="status" className="p-4 text-sm text-ink-soft">{t('auth.readOnly', { authority: 'CFG.FIN.COA.DEFINE' })}</p>}
      </section>

      <GroupChartOfAccountsList entries={entries} languages={languages} canMaintain={canMaintain} />
    </div>
  );
}

export function GroupChartOfAccountsForm({
  mode,
  initial,
  languages,
  canMaintain,
}: {
  mode: 'CREATE' | 'CHANGE';
  initial?: GroupChartOfAccountsRecord;
  languages: LanguageChoice[];
  canMaintain: boolean;
}) {
  const [state, action, pending] = useActionState<ChartOfAccountsActionState, FormData>(
    saveGroupChartOfAccountsAction,
    { ok: true },
  );
  const [code, setCode] = useState(initial?.groupChartOfAccounts ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [language, setLanguage] = useState(initial?.language ?? 'EN');
  const [reason, setReason] = useState('');

  // After a save the server refreshes this row; re-sync so the stored values are shown,
  // while the component instance (and its outcome message) stays mounted.
  useEffect(() => {
    if (!initial) return;
    setCode(initial.groupChartOfAccounts);
    setName(initial.name);
    setLanguage(initial.language);
    setReason('');
  }, [
    initial?.groupChartOfAccounts,
    initial?.name,
    initial?.language,
    initial?.version,
  ]);

  const editing = mode === 'CHANGE' && initial !== undefined;
  const idPrefix = editing ? `group-chart-change-${initial.groupChartOfAccounts.toLowerCase()}` : 'group-chart-create';

  return (
    <>
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h3 id={`${idPrefix}-title`} className="font-semibold">
          {t(editing ? 'chartOfAccounts.groupChangeTitle' : 'chartOfAccounts.groupCreateTitle')}
        </h3>
      </div>

      {state.message && <ActionMessage state={state} />}

      <form action={action} className="space-y-4 p-3 sm:p-5">
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="expectedVersion" value={initial?.version ?? 0} />
        {editing && <input type="hidden" name="groupChartOfAccounts" value={initial.groupChartOfAccounts} />}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${idPrefix}-code`} className="field-label">
              {t('chartOfAccounts.groupCode')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            {editing ? (
              <input
                id={`${idPrefix}-code`}
                type="text"
                value={initial.groupChartOfAccounts}
                readOnly
                className="field-input code mt-1 min-h-11 w-full cursor-not-allowed bg-sunken sm:min-h-9"
                aria-label={t('chartOfAccounts.groupCode')}
              />
            ) : (
              <input
                id={`${idPrefix}-code`}
                name="groupChartOfAccounts"
                type="text"
                required
                minLength={4}
                maxLength={4}
                pattern="[A-Z0-9]{4}"
                title={t('chartOfAccounts.groupCodeRule')}
                autoComplete="off"
                autoCapitalize="characters"
                value={code}
                onChange={(event) => setCode(event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                className="field-input code mt-1 min-h-11 w-full uppercase sm:min-h-9"
                disabled={pending || !canMaintain}
              />
            )}
            <p className="mt-1 text-xs text-ink-faint">{t('chartOfAccounts.groupCodeRule')}</p>
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
            <label htmlFor={`${idPrefix}-reason`} className="field-label">{t('chartOfAccounts.changeReason')}</label>
            <textarea
              id={`${idPrefix}-reason`}
              name="reason"
              maxLength={500}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value.slice(0, 500))}
              className="field-input mt-1 min-h-20 w-full"
              disabled={pending || !canMaintain}
            />
          </div>
        </div>

        <div className="flex justify-end border-t border-line pt-4">
          <button
            type="submit"
            className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
            disabled={pending || !canMaintain || languages.length === 0}
          >
            {pending ? t('common.saving') : t(editing ? 'chartOfAccounts.saveButton' : 'chartOfAccounts.groupCreateButton')}
          </button>
        </div>
      </form>
    </>
  );
}

export function GroupChartOfAccountsList({
  entries,
  languages,
  canMaintain,
}: {
  entries: GroupChartOfAccountsRecord[];
  languages: LanguageChoice[];
  canMaintain: boolean;
}) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="group-chart-list-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="group-chart-list-title" className="font-semibold">{t('chartOfAccounts.groupListTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('chartOfAccounts.groupListRule')}</p>
      </div>
      {entries.length === 0 ? (
        <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{t('chartOfAccounts.groupEmpty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[47.5rem]">
            <thead>
              <tr>
                <th>{t('chartOfAccounts.groupCode')}</th>
                <th>{t('chartOfAccounts.description')}</th>
                <th>{t('chartOfAccounts.language')}</th>
                <th>{t('chartOfAccounts.status')}</th>
                {canMaintain && <th>{t('chartOfAccounts.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.groupChartOfAccounts}>
                  <td className="code font-semibold">{entry.groupChartOfAccounts}</td>
                  <td>
                    {entry.name}
                    <p className="mt-1 text-xs font-normal text-ink-faint">
                      {t('chartOfAccounts.groupReferencedBy', { count: entry.referencedBy })}
                    </p>
                  </td>
                  <td className="code">{entry.language}</td>
                  <td>
                    <span className={`chip ${entry.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                      {t(entry.isActive ? 'chartOfAccounts.active' : 'chartOfAccounts.deactivated')}
                    </span>
                  </td>
                  {canMaintain && (
                    <td>
                      <div className="flex flex-col gap-2">
                        <details className="min-w-44">
                          <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
                            {t('chartOfAccounts.changeSettings')}
                          </summary>
                          <div
                            role="dialog"
                            aria-modal="true"
                            aria-label={`${t('chartOfAccounts.groupChangeTitle')} ${entry.groupChartOfAccounts}`}
                            className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6"
                          >
                            <div className="mx-auto max-w-3xl">
                              <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
                                <div>
                                  <span className="code text-xs text-ink-faint">OB13 · {entry.groupChartOfAccounts}</span>
                                  <p className="font-semibold">{t('chartOfAccounts.groupChangeTitle')}</p>
                                </div>
                                <button
                                  type="button"
                                  className="btn btn-default min-h-11 sm:min-h-9"
                                  onClick={(event) => {
                                    const details = event.currentTarget.closest('details');
                                    if (details) details.open = false;
                                  }}
                                >
                                  {t('common.close')}
                                </button>
                              </div>
                              <section className="panel overflow-hidden">
                                <GroupChartOfAccountsForm
                                  key={entry.groupChartOfAccounts}
                                  mode="CHANGE"
                                  initial={entry}
                                  languages={languages}
                                  canMaintain={canMaintain}
                                />
                              </section>
                            </div>
                          </div>
                        </details>

                        <ChartLifecycleControl
                          action={setGroupChartOfAccountsActiveAction}
                          codeField="groupChartOfAccounts"
                          code={entry.groupChartOfAccounts}
                          isActive={entry.isActive}
                          version={entry.version}
                          canMaintain={canMaintain}
                          idPrefix={`group-chart-${entry.groupChartOfAccounts.toLowerCase()}`}
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
