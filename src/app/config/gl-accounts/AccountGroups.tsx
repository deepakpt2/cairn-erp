'use client';

import { useState } from 'react';
import { t } from '@/platform/i18n';
import { GL_ACCOUNT_FIELDS, accountNumberInRange, type AccountGroupRow, type FieldStatus } from './fieldStatus';

const STATUS_LABEL: Record<FieldStatus, string> = {
  SUPPRESS: 'glAccount.statusSuppress',
  OPTIONAL: 'glAccount.statusOptional',
  MANDATORY: 'glAccount.statusMandatory',
};

/**
 * Account Group registry (KTOKS), maintained inside FS00.
 *
 * A group owns a number range and the field status matrix that drives the field screen,
 * so this panel is where an accountant decides what a group must supply. The matrix is
 * shown per group rather than hidden in a service: a suppressed field that nobody can
 * see is a field nobody can question.
 *
 * The panel is a plain browser-controlled `<details>` per row — never React-controlled —
 * so a save or refresh can never close a dialog before its outcome has been read.
 */
export function AccountGroupsPanel({
  groups,
  canMaintain,
  mutationReady,
}: {
  groups: AccountGroupRow[];
  canMaintain: boolean;
  /** False until the FS00 schema and service stages publish real writes. */
  mutationReady: boolean;
}) {
  const [accountGroup, setAccountGroup] = useState('');
  const [description, setDescription] = useState('');
  const [fromAccountNumber, setFromAccountNumber] = useState('');
  const [toAccountNumber, setToAccountNumber] = useState('');
  const rangeIsValid =
    fromAccountNumber.length > 0 &&
    toAccountNumber.length > 0 &&
    accountNumberInRange(fromAccountNumber, fromAccountNumber, toAccountNumber);

  return (
    <>
      {canMaintain && (
        <section aria-labelledby="fs00-group-create-title" className="panel overflow-hidden">
          <div className="border-b border-line bg-sunken px-4 py-3">
            <h2 id="fs00-group-create-title" className="panel-title">{t('glAccount.groupCreateTitle')}</h2>
            <p className="mt-1 text-xs text-ink-faint">{t('glAccount.groupPanelRule')}</p>
          </div>

          {!mutationReady && (
            <p role="status" className="border-b border-line bg-white px-4 py-3 text-sm text-ink-soft">
              {t('glAccount.groupPending')}
            </p>
          )}

          <form
            className="space-y-4 p-3 sm:p-5"
            onSubmit={(event) => {
              // No registry table exists to write to yet; keep the entered values.
              event.preventDefault();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
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
                />
                <p className="mt-1 text-xs text-ink-faint">{t('glAccount.groupCodeRule')}</p>
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
                />
                <p className="mt-1 text-xs text-ink-faint">{t('glAccount.groupDescriptionRule')}</p>
              </div>
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
                />
                <p className="mt-1 text-xs text-ink-faint">{t('glAccount.groupRangeRule')}</p>
              </div>
            </div>

            <div className="flex justify-end border-t border-line pt-4">
              <button
                type="submit"
                className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
                disabled={!mutationReady || !rangeIsValid}
              >
                {t('glAccount.groupCreateTitle')}
              </button>
            </div>
          </form>
        </section>
      )}

      <section aria-labelledby="fs00-group-list-title" className="panel overflow-hidden">
        <div className="panel-header">
          <h2 id="fs00-group-list-title" className="panel-title">{t('glAccount.groupListTitle')}</h2>
          <span className="text-2xs text-ink-faint">{groups.length}</span>
        </div>

        {groups.length === 0 ? (
          <p role="status" className="p-5 text-center text-sm text-ink-soft">{t('glAccount.groupListEmpty')}</p>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-24">{t('glAccount.groupCode')}</th>
                <th>{t('glAccount.groupDescription')}</th>
                <th className="w-40">{t('glAccount.groupRange')}</th>
                <th className="w-28">{t('glAccount.status')}</th>
                <th className="w-40">{t('glAccount.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.accountGroup}>
                  <td className="code font-semibold">{group.accountGroup}</td>
                  <td>{group.description}</td>
                  <td className="code text-ink-soft">
                    {group.fromAccountNumber} – {group.toAccountNumber}
                  </td>
                  <td>
                    <span className={`chip ${group.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                      {group.isActive ? t('glAccount.active') : t('chartOfAccounts.deactivated')}
                    </span>
                  </td>
                  <td>
                    <details className="min-w-44">
                      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
                        {t('glAccount.groupMatrix')}
                      </summary>
                      <div
                        role="dialog"
                        aria-label={t('glAccount.groupMatrixTitle', { group: group.accountGroup })}
                        className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6"
                      >
                        <div className="mx-auto max-w-2xl">
                          <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
                            <div>
                              <span className="code text-xs text-ink-faint">FS00 · {group.accountGroup}</span>
                              <p className="font-semibold">
                                {t('glAccount.groupMatrixTitle', { group: group.accountGroup })}
                              </p>
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
                            <table className="grid-table">
                              <thead>
                                <tr>
                                  <th>{t('glAccount.groupMatrix')}</th>
                                  <th className="w-32">{t('glAccount.status')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {GL_ACCOUNT_FIELDS.map((field) => {
                                  const status = group.fieldStatus[field] ?? 'OPTIONAL';
                                  return (
                                    <tr key={field}>
                                      <td className="code text-ink-soft">{field}</td>
                                      <td>{t(STATUS_LABEL[status])}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </section>
                        </div>
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
