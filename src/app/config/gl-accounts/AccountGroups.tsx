'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import {
  saveAccountGroupAction,
  saveAccountGroupFieldStatusAction,
  setAccountGroupActiveAction,
  type GlAccountActionState,
} from './actions';
import { GlAccountActionMessage, GlAccountDialog, ReasonField } from './GlAccountDialog';
import {
  FIELD_STATUSES,
  GL_ACCOUNT_FIELDS,
  STORAGE_MANDATORY_FIELDS,
  accountNumberInRange,
  resolveFieldStatus,
  type AccountGroupRow,
  type FieldStatus,
  type GlAccountField,
} from './fieldStatus';

/** A registry row plus what the panel needs to make deactivation an informed choice. */
export interface AccountGroupPanelRow extends AccountGroupRow {
  /** Accounts currently assigned to this group; they keep it if it is deactivated. */
  accountCount: number;
}

/** One selectable Chart of Accounts — the registry is chart-scoped, so the form needs one. */
export interface AccountGroupChartChoice {
  code: string;
  name: string;
}

const STATUS_LABEL: Record<FieldStatus, string> = {
  SUPPRESS: 'glAccount.statusSuppress',
  OPTIONAL: 'glAccount.statusOptional',
  MANDATORY: 'glAccount.statusMandatory',
};

/** Screen labels for the twelve controlled fields, so the matrix reads as the screen does. */
const FIELD_LABEL_KEY: Record<GlAccountField, string> = {
  name: 'glAccount.name',
  accountType: 'glAccount.accountType',
  glAccountType: 'glAccount.glAccountType',
  isOpenItemManaged: 'glAccount.openItem',
  reconciliationType: 'glAccount.reconciliation',
  requiresCostObject: 'glAccount.costObject',
  isTaxRelevant: 'glAccount.tax',
  groupAccountNumber: 'glAccount.groupAccount',
  languageKey: 'glAccount.language',
  sortKey: 'glAccount.sortKey',
  isBlockedPosting: 'glAccount.blockedPosting',
  isBlockedCreation: 'glAccount.blockedCreation',
};

/**
 * Account Group registry (`KTOKS`), maintained inside FS00 (SCR-028, R-51/D-123).
 *
 * A group owns a number range and the field status matrix that drives the field screen, so
 * this panel is where an accountant decides what a group must supply. The matrix is shown
 * per group rather than hidden in a service: a suppressed field nobody can see is a field
 * nobody can question.
 *
 * There is no delete here. Accounts keep their group for as long as they exist, so a group
 * leaves use by being deactivated and its history stays intact — the panel says how many
 * accounts that leaves behind, because that number is the reason the rule exists.
 */
export function AccountGroupsPanel({
  groups,
  charts,
  canCreate,
  canChange,
}: {
  groups: AccountGroupPanelRow[];
  charts: AccountGroupChartChoice[];
  canCreate: boolean;
  canChange: boolean;
}) {
  return (
    <>
      {canCreate && <CreateGroupForm charts={charts} />}

      <section aria-labelledby="fs00-group-list-title" className="panel overflow-hidden">
        <div className="panel-header">
          <h2 id="fs00-group-list-title" className="panel-title">{t('glAccount.groupListTitle')}</h2>
          <span className="text-2xs text-ink-faint">{groups.length}</span>
        </div>
        <p className="border-b border-line px-4 py-2 text-xs text-ink-faint">
          {t('glAccount.groupPanelRule')}
        </p>

        {groups.length === 0 ? (
          <p role="status" className="p-5 text-center text-sm text-ink-soft">{t('glAccount.groupListEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-20">{t('glAccount.chart')}</th>
                  <th className="w-24">{t('glAccount.groupCode')}</th>
                  <th>{t('glAccount.groupDescription')}</th>
                  <th className="w-40">{t('glAccount.groupRange')}</th>
                  <th className="w-20">{t('glAccount.groupAccounts')}</th>
                  <th className="w-28">{t('glAccount.status')}</th>
                  <th className="w-56">{t('glAccount.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={`${group.chartOfAccounts}-${group.accountGroup}`}>
                    <td className="code text-ink-soft">{group.chartOfAccounts}</td>
                    <td className="code font-semibold">{group.accountGroup}</td>
                    <td>{group.description}</td>
                    <td className="code text-ink-soft">
                      {group.fromAccountNumber} – {group.toAccountNumber}
                    </td>
                    <td className="text-ink-soft">{group.accountCount}</td>
                    <td>
                      <span className={`chip ${group.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                        {group.isActive ? t('glAccount.active') : t('chartOfAccounts.deactivated')}
                      </span>
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <FieldStatusDialog group={group} canChange={canChange} />
                        {canChange && group.isActive && <ChangeGroupDialog group={group} />}
                        {canChange && <GroupLifecycleDialog group={group} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** Create one Account Group: a chart, a key, a description and the range it owns. */
function CreateGroupForm({ charts }: { charts: AccountGroupChartChoice[] }) {
  const [state, formAction, pending] = useActionState<GlAccountActionState, FormData>(
    saveAccountGroupAction,
    { ok: true },
  );
  const [chartOfAccounts, setChartOfAccounts] = useState(charts[0]?.code ?? '');
  const [accountGroup, setAccountGroup] = useState('');
  const [description, setDescription] = useState('');
  const [fromAccountNumber, setFromAccountNumber] = useState('');
  const [toAccountNumber, setToAccountNumber] = useState('');
  const rangeIsValid =
    fromAccountNumber.length > 0 &&
    toAccountNumber.length > 0 &&
    accountNumberInRange(fromAccountNumber, fromAccountNumber, toAccountNumber);

  if (charts.length === 0) {
    return (
      <section aria-labelledby="fs00-group-create-title" className="panel overflow-hidden">
        <div className="border-b border-line bg-sunken px-4 py-3">
          <h2 id="fs00-group-create-title" className="panel-title">{t('glAccount.groupCreateTitle')}</h2>
        </div>
        <p role="status" className="p-5 text-center text-sm text-ink-soft">{t('glAccount.chartEmpty')}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="fs00-group-create-title" className="panel overflow-hidden">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="fs00-group-create-title" className="panel-title">{t('glAccount.groupCreateTitle')}</h2>
        <p className="mt-1 text-xs text-ink-faint">{t('glAccount.groupPanelRule')}</p>
      </div>

      {state.message && <GlAccountActionMessage state={state} />}

      <form action={formAction} className="space-y-4 p-3 sm:p-5">
        <input type="hidden" name="mode" value="CREATE" />
        <input type="hidden" name="expectedVersion" value={0} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="fs00-group-chart" className="field-label">
              {t('glAccount.chart')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <select
              id="fs00-group-chart"
              name="chartOfAccounts"
              required
              value={chartOfAccounts}
              onChange={(event) => setChartOfAccounts(event.currentTarget.value)}
              className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
              disabled={pending}
            >
              {charts.map((chart) => (
                <option key={chart.code} value={chart.code}>
                  {chart.code} — {chart.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">{t('glAccount.chartRule')}</p>
          </div>

          <div className="min-w-0">
            <label htmlFor="fs00-group-code" className="field-label">
              {t('glAccount.groupCode')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id="fs00-group-code"
              name="accountGroup"
              type="text"
              required
              maxLength={4}
              pattern="[A-Za-z0-9]{4}"
              autoComplete="off"
              value={accountGroup}
              onChange={(event) =>
                setAccountGroup(event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))
              }
              className="field-input code mt-1 min-h-11 w-full uppercase sm:min-h-9"
              disabled={pending}
            />
            <p className="mt-1 text-xs text-ink-faint">{t('glAccount.groupCodeRule')}</p>
          </div>
        </div>

        <div className="min-w-0">
          <label htmlFor="fs00-group-description" className="field-label">
            {t('glAccount.groupDescription')}
            <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
          </label>
          <input
            id="fs00-group-description"
            name="description"
            type="text"
            required
            maxLength={50}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value.slice(0, 50))}
            className="field-input mt-1 min-h-11 w-full sm:min-h-9"
            disabled={pending}
          />
          <p className="mt-1 text-xs text-ink-faint">{t('glAccount.groupDescriptionRule')}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="fs00-group-from" className="field-label">
              {t('glAccount.groupFrom')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id="fs00-group-from"
              name="fromAccountNumber"
              type="text"
              required
              maxLength={10}
              value={fromAccountNumber}
              onChange={(event) =>
                setFromAccountNumber(event.currentTarget.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 10))
              }
              className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
              disabled={pending}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="fs00-group-to" className="field-label">
              {t('glAccount.groupTo')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id="fs00-group-to"
              name="toAccountNumber"
              type="text"
              required
              maxLength={10}
              value={toAccountNumber}
              onChange={(event) =>
                setToAccountNumber(event.currentTarget.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 10))
              }
              className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
              disabled={pending}
            />
            <p className="mt-1 text-xs text-ink-faint">{t('glAccount.groupRangeRule')}</p>
          </div>
        </div>

        <div className="flex justify-end border-t border-line pt-4">
          <button
            type="submit"
            className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
            disabled={pending || !rangeIsValid}
          >
            {pending ? t('common.saving') : t('glAccount.groupCreateTitle')}
          </button>
        </div>
      </form>
    </section>
  );
}

/** Change a group's description and range; the key and the chart are its identity. */
function ChangeGroupDialog({ group }: { group: AccountGroupPanelRow }) {
  const [state, formAction, pending] = useActionState<GlAccountActionState, FormData>(
    saveAccountGroupAction,
    { ok: true },
  );
  const [description, setDescription] = useState(group.description);
  const [fromAccountNumber, setFromAccountNumber] = useState(group.fromAccountNumber);
  const [toAccountNumber, setToAccountNumber] = useState(group.toAccountNumber);
  const [reason, setReason] = useState('');
  const idPrefix = `fs00-group-change-${group.chartOfAccounts}-${group.accountGroup}`;
  return (
    <GlAccountDialog
      label={t('glAccount.change')}
      dialogLabel={t('glAccount.groupChangeTitle', { group: group.accountGroup })}
      codeLine={`FS00 · ${group.chartOfAccounts}/${group.accountGroup}`}
      bodyText={t('glAccount.groupRangeLockedRule')}
      state={state}
      formAction={formAction}
      pending={pending}
      submitLabel={t('glAccount.saveChange')}
    >
      <input type="hidden" name="mode" value="CHANGE" />
      <input type="hidden" name="chartOfAccounts" value={group.chartOfAccounts} />
      <input type="hidden" name="accountGroup" value={group.accountGroup} />
      <input type="hidden" name="expectedVersion" value={group.version} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={`${idPrefix}-chart`} className="field-label">{t('glAccount.chart')}</label>
          <input
            id={`${idPrefix}-chart`}
            type="text"
            className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
            value={group.chartOfAccounts}
            readOnly
          />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${idPrefix}-code`} className="field-label">{t('glAccount.groupCode')}</label>
          <input
            id={`${idPrefix}-code`}
            type="text"
            className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
            value={group.accountGroup}
            readOnly
          />
          <p className="mt-1 text-xs text-ink-faint">{t('glAccount.immutableKey')}</p>
        </div>
      </div>

      <div className="min-w-0">
        <label htmlFor={`${idPrefix}-description`} className="field-label">
          {t('glAccount.groupDescription')}
          <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
        </label>
        <input
          id={`${idPrefix}-description`}
          name="description"
          type="text"
          required
          maxLength={50}
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value.slice(0, 50))}
          className="field-input mt-1 min-h-11 w-full sm:min-h-9"
          disabled={pending}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={`${idPrefix}-from`} className="field-label">
            {t('glAccount.groupFrom')}
            <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
          </label>
          <input
            id={`${idPrefix}-from`}
            name="fromAccountNumber"
            type="text"
            required
            maxLength={10}
            value={fromAccountNumber}
            onChange={(event) =>
              setFromAccountNumber(event.currentTarget.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 10))
            }
            className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
            disabled={pending}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${idPrefix}-to`} className="field-label">
            {t('glAccount.groupTo')}
            <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
          </label>
          <input
            id={`${idPrefix}-to`}
            name="toAccountNumber"
            type="text"
            required
            maxLength={10}
            value={toAccountNumber}
            onChange={(event) =>
              setToAccountNumber(event.currentTarget.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 10))
            }
            className="field-input code mt-1 min-h-11 w-full sm:min-h-9"
            disabled={pending}
          />
          <p className="mt-1 text-xs text-ink-faint">{t('glAccount.groupRangeRule')}</p>
        </div>
      </div>

      <div className="border-t border-line pt-4">
        <ReasonField
          id={`${idPrefix}-reason`}
          hint={t('glAccount.reasonRule')}
          pending={pending}
          value={reason}
          onChange={setReason}
          required={false}
        />
      </div>
    </GlAccountDialog>
  );
}

/** Deactivate or reactivate a group; deactivating owes a reason. */
function GroupLifecycleDialog({ group }: { group: AccountGroupPanelRow }) {
  const [state, formAction, pending] = useActionState<GlAccountActionState, FormData>(
    setAccountGroupActiveAction,
    { ok: true },
  );
  const [reason, setReason] = useState('');
  const deactivating = group.isActive;
  const idPrefix = `fs00-group-lifecycle-${group.chartOfAccounts}-${group.accountGroup}`;

  return (
    <GlAccountDialog
      label={deactivating ? t('glAccount.groupDeactivate') : t('glAccount.groupReactivate')}
      dialogLabel={`${deactivating ? t('glAccount.groupDeactivate') : t('glAccount.groupReactivate')} ${group.accountGroup}`}
      codeLine={`FS00 · ${group.chartOfAccounts}/${group.accountGroup}`}
      bodyText={deactivating ? t('glAccount.groupLifecycleRule') : t('glAccount.groupAccountsRule')}
      state={state}
      formAction={formAction}
      pending={pending}
      submitLabel={deactivating ? t('glAccount.groupDeactivate') : t('glAccount.groupReactivate')}
    >
      <input type="hidden" name="chartOfAccounts" value={group.chartOfAccounts} />
      <input type="hidden" name="accountGroup" value={group.accountGroup} />
      <input type="hidden" name="isActive" value={deactivating ? 'false' : 'true'} />
      <input type="hidden" name="expectedVersion" value={group.version} />

      <p className="border border-line bg-white p-3 text-sm text-ink-soft">
        {t('glAccount.groupAccounts')}: <span className="code font-semibold">{group.accountCount}</span>
        {deactivating && ` — ${t('glAccount.groupAccountsRule')}`}
      </p>

      <ReasonField
        id={`${idPrefix}-reason`}
        hint={deactivating ? t('glAccount.reasonRequired') : t('glAccount.reasonRule')}
        pending={pending}
        value={reason}
        onChange={setReason}
        required={deactivating}
      />
    </GlAccountDialog>
  );
}

/**
 * The field status matrix of one group.
 *
 * Rendered as a select per field, in the same order and with the same labels as the field
 * screen, so what a consultant sets here is recognisable there. The two fields the account
 * cannot be stored without are locked at Mandatory and say why: a rule that can be broken
 * silently is a rule nobody can rely on.
 */
function FieldStatusDialog({
  group,
  canChange,
}: {
  group: AccountGroupPanelRow;
  canChange: boolean;
}) {
  const [state, formAction, pending] = useActionState<GlAccountActionState, FormData>(
    saveAccountGroupFieldStatusAction,
    { ok: true },
  );
  const [statuses, setStatuses] = useState<Record<GlAccountField, FieldStatus>>(() => {
    const initial = {} as Record<GlAccountField, FieldStatus>;
    for (const field of GL_ACCOUNT_FIELDS) initial[field] = resolveFieldStatus(group.fieldStatus, field);
    return initial;
  });
  const [reason, setReason] = useState('');
  const idPrefix = `fs00-group-matrix-${group.chartOfAccounts}-${group.accountGroup}`;
  const editable = canChange && group.isActive;

  return (
    <GlAccountDialog
      label={t('glAccount.groupMatrix')}
      dialogLabel={t('glAccount.groupMatrixTitle', { group: group.accountGroup })}
      codeLine={`FS00 · ${group.chartOfAccounts}/${group.accountGroup}`}
      bodyText={t('glAccount.matrixRule')}
      state={state}
      formAction={formAction}
      pending={pending}
      submitLabel={t('glAccount.matrixSave')}
      readOnly={!editable}
    >
      <input type="hidden" name="chartOfAccounts" value={group.chartOfAccounts} />
      <input type="hidden" name="accountGroup" value={group.accountGroup} />
      <input type="hidden" name="expectedVersion" value={group.version} />

      <table className="grid-table">
        <thead>
          <tr>
            <th>{t('glAccount.groupMatrix')}</th>
            <th className="w-40">{t('glAccount.status')}</th>
          </tr>
        </thead>
        <tbody>
          {GL_ACCOUNT_FIELDS.map((field) => {
            const locked = STORAGE_MANDATORY_FIELDS.includes(field);
            return (
              <tr key={field}>
                <td>
                  <label className="field-label" htmlFor={`${idPrefix}-${field}`}>
                    {t(FIELD_LABEL_KEY[field])}
                  </label>
                  {locked && (
                    <span className="mt-0.5 block text-xs text-ink-faint">
                      {t('glAccount.fieldStatusMandatory', { group: group.accountGroup })}
                    </span>
                  )}
                </td>
                <td>
                  <select
                    id={`${idPrefix}-${field}`}
                    name={`status_${field}`}
                    className="field-input code min-h-11 w-full sm:min-h-9"
                    value={statuses[field]}
                    disabled={pending || locked || !editable}
                    onChange={(event) =>
                      setStatuses((previous) => ({
                        ...previous,
                        [field]: event.currentTarget.value as FieldStatus,
                      }))
                    }
                  >
                    {FIELD_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {t(STATUS_LABEL[status])}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {editable && (
        <div className="border-t border-line pt-4">
          <ReasonField
            id={`${idPrefix}-reason`}
            hint={t('glAccount.reasonRule')}
            pending={pending}
            value={reason}
            onChange={setReason}
            required={false}
          />
        </div>
      )}
    </GlAccountDialog>
  );
}
