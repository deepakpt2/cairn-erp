'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { t } from '@/platform/i18n';

/** One G/L account as the list renders it. */
export interface GlAccountListRow {
  chartOfAccounts: string;
  accountNumber: string;
  name: string;
  accountType: string;
  /** Empty until the Account Group column exists. */
  accountGroup: string;
  isOpenItemManaged: boolean;
  reconciliationType: string | null;
  requiresCostObject: boolean;
  isBlockedPosting: boolean;
  isBlockedCreation: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  ASSET: 'gl.type.asset',
  LIABILITY: 'gl.type.liability',
  EQUITY: 'gl.type.equity',
  REVENUE: 'gl.type.revenue',
  EXPENSE: 'gl.type.expense',
};

const TYPE_GROUP: Record<string, string> = {
  ASSET: '1',
  LIABILITY: '2',
  EQUITY: '2',
  REVENUE: '3',
  EXPENSE: '5',
};

const ROUTE = '/config/gl-accounts';

/** Row dialog for a change that always owes an explanation: blocks and deletion. */
function RowDialog({
  label,
  dialogLabel,
  bodyText,
  submitLabel,
  idPrefix,
  disabled,
}: {
  label: string;
  dialogLabel: string;
  bodyText: string;
  submitLabel: string;
  idPrefix: string;
  disabled: boolean;
}) {
  return (
    <details className="min-w-44">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
        {label}
      </summary>
      {/* Browser-controlled on purpose: a React-controlled `open` would let a save or
          refresh close the dialog before the outcome has been read. */}
      <div
        role="dialog"
        aria-label={dialogLabel}
        className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6"
      >
        <div className="mx-auto max-w-2xl">
          <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
            <p className="font-semibold">{dialogLabel}</p>
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
            <div className="border-b border-line bg-sunken px-4 py-3">
              <p className="text-sm text-ink-soft">{bodyText}</p>
            </div>
            <form
              className="space-y-4 p-3 sm:p-5"
              onSubmit={(event) => {
                event.preventDefault();
              }}
            >
              <div>
                <label htmlFor={`${idPrefix}-reason`} className="field-label">
                  {t('glAccount.reason')}
                  <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
                </label>
                <textarea
                  id={`${idPrefix}-reason`}
                  name="reason"
                  rows={3}
                  required
                  minLength={1}
                  maxLength={500}
                  className="field-input mt-1 min-h-20 w-full"
                />
                <p className="mt-1 text-xs text-ink-faint">{t('glAccount.reasonRule')}</p>
              </div>
              <div className="flex justify-end border-t border-line pt-4">
                <button type="submit" className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto" disabled={disabled}>
                  {submitLabel}
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </details>
  );
}

/**
 * Defined G/L accounts, grouped by the leading digit of the account number — the way an
 * accountant reads a chart of accounts: 1 assets, 2 liabilities and equity, 3 revenue,
 * 5 cost and expense. The grouping is derived from the account type and number rather
 * than stored, so it can never disagree with them.
 */
export function GlAccountsList({
  accounts,
  canChange,
  mutationReady,
}: {
  accounts: GlAccountListRow[];
  canChange: boolean;
  /** False until the FS00 service stage publishes real writes. */
  mutationReady: boolean;
}) {
  const groups = new Map<string, GlAccountListRow[]>();
  for (const account of accounts) {
    const key = TYPE_GROUP[account.accountType] ?? account.accountNumber.charAt(0);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(account);
  }

  return (
    <section aria-labelledby="fs00-list-title" className="panel overflow-hidden">
      <div className="panel-header">
        <h2 id="fs00-list-title" className="panel-title">{t('glAccount.listTitle')}</h2>
        <span className="text-2xs text-ink-faint">{accounts.length}</span>
      </div>
      <p className="border-b border-line px-4 py-2 text-xs text-ink-faint">{t('glAccount.listRule')}</p>

      {accounts.length === 0 ? (
        <p role="status" className="p-5 text-center text-sm text-ink-soft">{t('glAccount.accountNumberEmpty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-20">{t('glAccount.chart')}</th>
                <th className="w-24">{t('gl.number')}</th>
                <th>{t('gl.name')}</th>
                <th className="w-28">{t('gl.type')}</th>
                <th className="w-24">{t('glAccount.groupCode')}</th>
                <th className="w-32">{t('glAccount.status')}</th>
                <th className="w-56">{t('glAccount.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {[...groups.entries()].map(([group, items]) => (
                <Fragment key={group}>
                  <tr>
                    <td
                      colSpan={7}
                      className="bg-sunken text-2xs font-semibold uppercase tracking-wide text-ink-faint"
                    >
                      {group} · {items.length} account{items.length === 1 ? '' : 's'}
                    </td>
                  </tr>
                  {items.map((account) => {
                    const query = `chart=${encodeURIComponent(account.chartOfAccounts)}&account=${encodeURIComponent(account.accountNumber)}`;
                    const blocked = account.isBlockedPosting || account.isBlockedCreation;
                    return (
                      <tr key={`${account.chartOfAccounts}-${account.accountNumber}`}>
                        <td className="code text-ink-soft">{account.chartOfAccounts}</td>
                        <td className="code font-semibold">{account.accountNumber}</td>
                        <td>{account.name}</td>
                        <td className="text-ink-soft">{t(TYPE_LABEL[account.accountType] ?? 'gl.type.asset')}</td>
                        <td className="code text-ink-soft">{account.accountGroup || '—'}</td>
                        <td>
                          {blocked ? (
                            <span className="chip chip-warn">
                              {account.isBlockedPosting ? t('glAccount.blockedChip') : t('glAccount.creationBlockedChip')}
                            </span>
                          ) : (
                            <span className="chip chip-ok">{t('glAccount.active')}</span>
                          )}
                        </td>
                        <td>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <Link
                              href={`${ROUTE}/view?${query}`}
                              className="min-h-11 py-2 text-sm font-medium text-accent hover:underline sm:min-h-9 sm:py-1"
                            >
                              {t('glAccount.display')}
                            </Link>
                            {canChange && (
                              <Link
                                href={`${ROUTE}/edit?${query}`}
                                className="min-h-11 py-2 text-sm font-medium text-accent hover:underline sm:min-h-9 sm:py-1"
                              >
                                {t('glAccount.change')}
                              </Link>
                            )}
                            {canChange && (
                              <RowDialog
                                label={t('glAccount.blockedPosting')}
                                dialogLabel={t('glAccount.blockTitle', { account: account.accountNumber })}
                                bodyText={t('glAccount.blockedPostingRule')}
                                submitLabel={t('glAccount.blockButton')}
                                idPrefix={`fs00-block-${account.chartOfAccounts}-${account.accountNumber}`}
                                disabled={!mutationReady}
                              />
                            )}
                            {canChange && (
                              <RowDialog
                                label={t('glAccount.delete')}
                                dialogLabel={t('glAccount.deleteTitle', { account: account.accountNumber })}
                                bodyText={t('glAccount.deleteRule')}
                                submitLabel={t('glAccount.deleteButton')}
                                idPrefix={`fs00-delete-${account.chartOfAccounts}-${account.accountNumber}`}
                                disabled={!mutationReady}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
