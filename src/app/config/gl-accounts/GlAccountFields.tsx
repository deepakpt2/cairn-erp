'use client';

import { useMemo, useState } from 'react';
import { t } from '@/platform/i18n';
import { ChartLanguageField, type LanguageChoice } from '../chart-of-accounts/ChartOfAccountsValueHelp';
import { GlAccountValueHelp, type AccountChoice } from './GlAccountValueHelp';
import {
  ACCOUNT_TYPES,
  GL_ACCOUNT_TYPES,
  RECONCILIATION_TYPES,
  deriveGlAccountType,
  deriveIsBalanceSheet,
  resolveFieldStatus,
  type AccountGroupChoice,
  type LegacyReconciliationType,
  type AccountType,
  type FieldStatusMatrix,
  type GlAccountField,
  type GlAccountType,
  type ReconciliationType,
} from './fieldStatus';

export type GlAccountMode = 'CREATE' | 'CHANGE' | 'DISPLAY';

/** Chart-level G/L account values, exactly the FS00 field contract. */
export interface GlAccountValues {
  accountNumber: string;
  name: string;
  accountType: AccountType;
  accountGroup: string;
  glAccountType: GlAccountType;
  isOpenItemManaged: boolean;
  reconciliationType: ReconciliationType | LegacyReconciliationType | '';
  requiresCostObject: boolean;
  isTaxRelevant: boolean;
  groupAccountNumber: string;
  languageKey: string;
  sortKey: string;
  isBlockedPosting: boolean;
  isBlockedCreation: boolean;
}

const EMPTY_ACCOUNT: GlAccountValues = {
  accountNumber: '',
  name: '',
  accountType: 'ASSET',
  accountGroup: '',
  glAccountType: 'BALANCE_SHEET',
  isOpenItemManaged: false,
  reconciliationType: '',
  requiresCostObject: false,
  isTaxRelevant: false,
  groupAccountNumber: '',
  languageKey: 'EN',
  sortKey: '000',
  isBlockedPosting: false,
  isBlockedCreation: false,
};

const TYPE_LABEL: Record<AccountType, string> = {
  ASSET: 'gl.type.asset',
  LIABILITY: 'gl.type.liability',
  EQUITY: 'gl.type.equity',
  REVENUE: 'gl.type.revenue',
  EXPENSE: 'gl.type.expense',
};

/**
 * The FS00 field screen, shared by Create, Change and Display.
 *
 * Every field's presence and insistence come from the selected Account Group's status
 * matrix, so a suppressed field is not rendered at all and never submitted: what the
 * user cannot see, the form cannot post. That is also why the matrix is data rather than
 * a code path per group — a consultant tightens a group without a release. The account number and the Chart of Accounts are keys: both are fixed for the
 * whole screen and immutable after creation.
 */
export function GlAccountFields({
  mode,
  chartOfAccounts,
  chartName,
  accountNumberLength,
  costElementPolicy,
  account,
  initialAccountNumber,
  groups,
  groupMatrices,
  groupAccounts,
  languages,
  canSave,
  mutationReady,
}: {
  mode: GlAccountMode;
  chartOfAccounts: string;
  chartName?: string;
  accountNumberLength: number;
  costElementPolicy: 'AUTOMATIC' | 'MANUAL' | 'NONE';
  /** The stored record; null in Create mode, where nothing exists yet. */
  account: GlAccountValues | null;
  /** Number carried over from the initial screen, so Create does not ask twice. */
  initialAccountNumber?: string;
  groups: AccountGroupChoice[];
  groupMatrices: Record<string, FieldStatusMatrix>;
  groupAccounts: AccountChoice[];
  languages: LanguageChoice[];
  canSave: boolean;
  /** False until the FS00 service stage publishes real writes. */
  mutationReady: boolean;
}) {
  const [values, setValues] = useState<GlAccountValues>(
    account ?? { ...EMPTY_ACCOUNT, accountNumber: initialAccountNumber ?? '' },
  );
  const [reason, setReason] = useState('');
  const readOnly = mode === 'DISPLAY';
  const matrix = groupMatrices[values.accountGroup];

  const status = (field: GlAccountField) => resolveFieldStatus(matrix, field);
  const shows = (field: GlAccountField) => status(field) !== 'SUPPRESS';
  const demands = (field: GlAccountField) => status(field) === 'MANDATORY';

  function set<K extends keyof GlAccountValues>(key: K, value: GlAccountValues[K]) {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  /** XBILK follows the account type unless the group lets the user hold a different one. */
  function chooseAccountType(accountType: AccountType) {
    setValues((previous) => ({ ...previous, accountType, glAccountType: deriveGlAccountType(accountType) }));
  }

  const balanceSheet = deriveIsBalanceSheet(values.glAccountType);
  // A stored legacy value stays selectable, so opening a Change can never drop it.
  const reconciliationOptions: readonly string[] =
    values.reconciliationType !== '' &&
    !RECONCILIATION_TYPES.includes(values.reconciliationType as ReconciliationType)
      ? [...RECONCILIATION_TYPES, values.reconciliationType]
      : RECONCILIATION_TYPES;
  // A block change is the one edit that always owes an explanation.
  const blocksChanged =
    account !== null &&
    (account.isBlockedPosting !== values.isBlockedPosting ||
      account.isBlockedCreation !== values.isBlockedCreation);
  const reasonRequired = mode === 'CHANGE' && blocksChanged;
  const title =
    mode === 'CREATE'
      ? t('glAccount.createTitle')
      : mode === 'CHANGE'
        ? t('glAccount.changeTitle')
        : t('glAccount.displayTitle');
  const submitLabel = mode === 'CREATE' ? t('glAccount.save') : t('glAccount.saveChange');
  const reasonHint = useMemo(() => t('glAccount.reasonRule'), []);

  return (
    <section aria-labelledby="fs00-field-title" className="panel overflow-hidden">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="fs00-field-title" className="panel-title">{title}</h2>
        <p className="mt-1 text-xs text-ink-faint">
          {t('glAccount.costElementPolicy', { policy: costElementPolicy })}
        </p>
      </div>

      {!mutationReady && !readOnly && (
        <p role="status" className="border-b border-line bg-white px-4 py-3 text-sm text-ink-soft">
          {t('glAccount.pendingBackend')}
        </p>
      )}
      {!canSave && !readOnly && (
        <p role="status" className="border-b border-line bg-white px-4 py-3 text-sm text-ink-soft">
          {t('glAccount.modeDenied', {
            authority: mode === 'CREATE' ? 'CFG.FIN.GLACCOUNT.CREATE' : 'CFG.FIN.GLACCOUNT.CHANGE',
          })}
        </p>
      )}

      <form
        className="space-y-4 p-3 sm:p-5"
        onSubmit={(event) => {
          // No service exists to write through yet; never let the browser navigate away
          // and lose the entered values.
          event.preventDefault();
        }}
      >
        <input type="hidden" name="chartOfAccounts" value={chartOfAccounts} />
        <input type="hidden" name="mode" value={mode} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="fs00-chart" className="field-label">{t('glAccount.chart')}</label>
            <input
              id="fs00-chart"
              name="chartOfAccountsDisplay"
              type="text"
              className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
              value={chartName ? `${chartOfAccounts} — ${chartName}` : chartOfAccounts}
              readOnly
            />
            <p className="mt-1 text-xs text-ink-faint">{t('glAccount.chartRule')}</p>
          </div>

          <div className="min-w-0">
            <label htmlFor="fs00-account-number" className="field-label">
              {t('glAccount.accountNumber')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id="fs00-account-number"
              name="accountNumber"
              type="text"
              autoComplete="off"
              required
              readOnly={mode !== 'CREATE'}
              maxLength={accountNumberLength}
              value={values.accountNumber}
              onChange={(event) =>
                set('accountNumber', event.currentTarget.value.replace(/[^A-Za-z0-9]/g, '').slice(0, accountNumberLength))
              }
              className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
            />
            <p className="mt-1 text-xs text-ink-faint">
              {mode === 'CREATE'
                ? t('glAccount.accountNumberRule', { length: accountNumberLength })
                : t('glAccount.immutableKey')}
            </p>
          </div>
        </div>

        {shows('name') && (
          <div className="min-w-0">
            <label htmlFor="fs00-name" className="field-label">
              {t('glAccount.name')}
              {demands('name') && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
            </label>
            <input
              id="fs00-name"
              name="name"
              type="text"
              maxLength={200}
              required={demands('name')}
              readOnly={readOnly}
              value={values.name}
              onChange={(event) => set('name', event.currentTarget.value.slice(0, 200))}
              className="field-input mt-1 min-h-11 w-full sm:min-h-9"
            />
            <p className="mt-1 text-xs text-ink-faint">{t('glAccount.nameRule')}</p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {/* The Account Group is a key, not a matrix-controlled field: it is mandatory
              by contract, and no group may suppress the thing that decides its own field
              status. Its matrix is reported here so the effect of the choice is visible. */}
          <div className="min-w-0">
            <label htmlFor="fs00-account-group" className="field-label">
              {t('glAccount.accountGroup')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <select
              id="fs00-account-group"
              name="accountGroup"
              required
              disabled={readOnly}
              value={values.accountGroup}
              onChange={(event) => set('accountGroup', event.currentTarget.value)}
              className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
            >
              <option value="">{t('glAccount.accountGroupEmpty')}</option>
              {groups.map((group) => (
                <option key={group.code} value={group.code}>{group.code} — {group.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">{t('glAccount.accountGroupRule')}</p>
            {matrix && (
              <p className="mt-1 text-xs text-ink-faint">
                {t('glAccount.groupMatrixTitle', { group: values.accountGroup })}
              </p>
            )}
          </div>

          {shows('accountType') && (
            <div className="min-w-0">
              <label htmlFor="fs00-account-type" className="field-label">
                {t('glAccount.accountType')}
                {demands('accountType') && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
              </label>
              <select
                id="fs00-account-type"
                name="accountType"
                required={demands('accountType')}
                disabled={readOnly}
                value={values.accountType}
                onChange={(event) => chooseAccountType(event.currentTarget.value as AccountType)}
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
              >
                {ACCOUNT_TYPES.map((type) => (
                  <option key={type} value={type}>{t(TYPE_LABEL[type])}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-faint">{t('glAccount.accountTypeRule')}</p>
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {shows('glAccountType') && (
            <div className="min-w-0">
              <label htmlFor="fs00-gl-account-type" className="field-label">
                {t('glAccount.glAccountType')}
                {demands('glAccountType') && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
              </label>
              <select
                id="fs00-gl-account-type"
                name="glAccountType"
                required={demands('glAccountType')}
                disabled={readOnly}
                value={values.glAccountType}
                onChange={(event) => set('glAccountType', event.currentTarget.value as GlAccountType)}
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
              >
                {GL_ACCOUNT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type === 'BALANCE_SHEET' ? t('glAccount.glAccountTypeBalance') : t('glAccount.glAccountTypePl')}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-faint">{t('glAccount.glAccountTypeRule')}</p>
            </div>
          )}

          {/* Derived, never editable: one indicator decides it, so a second input could
              only disagree with the first. */}
          <div className="min-w-0">
            <span className="field-label">{t('glAccount.balanceSheet')}</span>
            <p className="field-input mt-1 min-h-11 w-full bg-sunken text-sm sm:min-h-9" aria-live="polite">
              {balanceSheet ? t('glAccount.glAccountTypeBalance') : t('glAccount.glAccountTypePl')}
            </p>
            <p className="mt-1 text-xs text-ink-faint">{t('glAccount.balanceSheetDerived')}</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {shows('languageKey') && (
            <ChartLanguageField
              id="fs00-language"
              name="languageKey"
              label={t('glAccount.language')}
              value={values.languageKey}
              onChange={(value) => set('languageKey', value)}
              choices={languages}
              disabled={readOnly}
            />
          )}

          {shows('sortKey') && (
            <div className="min-w-0">
              <label htmlFor="fs00-sort-key" className="field-label">
                {t('glAccount.sortKey')}
                {demands('sortKey') && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
              </label>
              <input
                id="fs00-sort-key"
                name="sortKey"
                type="text"
                maxLength={3}
                required={demands('sortKey')}
                readOnly={readOnly}
                value={values.sortKey}
                onChange={(event) => set('sortKey', event.currentTarget.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 3))}
                className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
              />
              <p className="mt-1 text-xs text-ink-faint">{t('glAccount.sortKeyRule')}</p>
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {shows('isOpenItemManaged') && (
            <label className="flex min-h-11 items-start gap-2 border border-line bg-white p-3 text-sm sm:min-h-9">
              <input
                type="checkbox"
                name="isOpenItemManaged"
                className="mt-0.5 h-4 w-4"
                disabled={readOnly}
                checked={values.isOpenItemManaged}
                onChange={(event) => set('isOpenItemManaged', event.currentTarget.checked)}
              />
              <span>
                <span className="font-medium">{t('glAccount.openItem')}</span>
                <span className="mt-0.5 block text-xs text-ink-faint">{t('glAccount.openItemRule')}</span>
              </span>
            </label>
          )}

          {shows('reconciliationType') && (
            <div className="min-w-0">
              <label htmlFor="fs00-reconciliation" className="field-label">
                {t('glAccount.reconciliation')}
                {demands('reconciliationType') && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
              </label>
              <select
                id="fs00-reconciliation"
                name="reconciliationType"
                required={demands('reconciliationType')}
                disabled={readOnly}
                value={values.reconciliationType}
                onChange={(event) =>
                  set(
                    'reconciliationType',
                    event.currentTarget.value as ReconciliationType | LegacyReconciliationType | '',
                  )
                }
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
              >
                <option value="">{t('glAccount.reconciliationNone')}</option>
                {reconciliationOptions.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-faint">{t('glAccount.reconciliationRule')}</p>
            </div>
          )}
        </div>

        {shows('groupAccountNumber') && (
          <GlAccountValueHelp
            id="fs00-group-account"
            name="groupAccountNumber"
            label={t('glAccount.groupAccount')}
            value={values.groupAccountNumber}
            onChange={(value) => set('groupAccountNumber', value)}
            choices={groupAccounts}
            dialogTitle={t('glAccount.groupAccountLookup')}
            emptyText={t('glAccount.groupAccountEmpty')}
            rule={t('glAccount.groupAccountRule')}
            maxLength={10}
            required={demands('groupAccountNumber')}
            readOnly={readOnly}
          />
        )}

        {/* Cost element controls follow the chart's OB13 policy: None suppresses them
            outright, and provisioning itself belongs to the Controlling round. */}
        {costElementPolicy === 'NONE' ? (
          <p className="border border-line bg-sunken p-3 text-xs text-ink-soft">
            {t('glAccount.costElementSuppressed')}
          </p>
        ) : (
          <div className="space-y-4">
            {shows('requiresCostObject') && (
              <label className="flex min-h-11 items-start gap-2 border border-line bg-white p-3 text-sm sm:min-h-9">
                <input
                  type="checkbox"
                  name="requiresCostObject"
                  className="mt-0.5 h-4 w-4"
                  disabled={readOnly}
                  checked={values.requiresCostObject}
                  onChange={(event) => set('requiresCostObject', event.currentTarget.checked)}
                />
                <span>
                  <span className="font-medium">{t('glAccount.costObject')}</span>
                  <span className="mt-0.5 block text-xs text-ink-faint">{t('glAccount.costObjectRule')}</span>
                </span>
              </label>
            )}
            {shows('isTaxRelevant') && (
              <label className="flex min-h-11 items-start gap-2 border border-line bg-white p-3 text-sm sm:min-h-9">
                <input
                  type="checkbox"
                  name="isTaxRelevant"
                  className="mt-0.5 h-4 w-4"
                  disabled={readOnly}
                  checked={values.isTaxRelevant}
                  onChange={(event) => set('isTaxRelevant', event.currentTarget.checked)}
                />
                <span>
                  <span className="font-medium">{t('glAccount.tax')}</span>
                  <span className="mt-0.5 block text-xs text-ink-faint">{t('glAccount.taxRule')}</span>
                </span>
              </label>
            )}
            <p className="text-xs text-ink-faint">{t('glAccount.costElementDeferred')}</p>
          </div>
        )}

        <div className="space-y-4 border-t border-line pt-4">
          {shows('isBlockedPosting') && (
            <label className="flex min-h-11 items-start gap-2 border border-line bg-white p-3 text-sm sm:min-h-9">
              <input
                type="checkbox"
                name="isBlockedPosting"
                className="mt-0.5 h-4 w-4"
                disabled={readOnly}
                checked={values.isBlockedPosting}
                onChange={(event) => set('isBlockedPosting', event.currentTarget.checked)}
              />
              <span>
                <span className="font-medium">{t('glAccount.blockedPosting')}</span>
                <span className="mt-0.5 block text-xs text-ink-faint">{t('glAccount.blockedPostingRule')}</span>
              </span>
            </label>
          )}
          {shows('isBlockedCreation') && (
            <label className="flex min-h-11 items-start gap-2 border border-line bg-white p-3 text-sm sm:min-h-9">
              <input
                type="checkbox"
                name="isBlockedCreation"
                className="mt-0.5 h-4 w-4"
                disabled={readOnly}
                checked={values.isBlockedCreation}
                onChange={(event) => set('isBlockedCreation', event.currentTarget.checked)}
              />
              <span>
                <span className="font-medium">{t('glAccount.blockedCreation')}</span>
                <span className="mt-0.5 block text-xs text-ink-faint">{t('glAccount.blockedCreationRule')}</span>
              </span>
            </label>
          )}
        </div>

        {!readOnly && (
          <div>
            <label htmlFor="fs00-reason" className="field-label">
              {t('glAccount.reason')}
              {reasonRequired && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
            </label>
            <textarea
              id="fs00-reason"
              name="reason"
              rows={3}
              maxLength={500}
              required={reasonRequired}
              minLength={reasonRequired ? 1 : undefined}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value.slice(0, 500))}
              className="field-input mt-1 min-h-20 w-full"
            />
            <p className="mt-1 text-xs text-ink-faint">{reasonRequired ? t('glAccount.reasonRequired') : reasonHint}</p>
          </div>
        )}

        {!readOnly && (
          <div className="flex justify-end border-t border-line pt-4">
            <button
              type="submit"
              className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
              disabled={!canSave || !mutationReady}
            >
              {submitLabel}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
