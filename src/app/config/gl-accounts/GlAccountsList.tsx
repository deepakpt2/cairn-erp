'use client';

import { Fragment, useActionState, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { t } from '@/platform/i18n';
import {
  deleteGlAccountAction,
  setGlAccountBlocksAction,
  type GlAccountActionState,
} from './actions';
import { GlAccountDialog, ReasonField } from './GlAccountDialog';

/** One G/L account as the list renders it. */
export interface GlAccountListRow {
  chartOfAccounts: string;
  accountNumber: string;
  name: string;
  accountType: string;
  /** Account Group the account belongs to. */
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

/**
 * The two account changes that always owe an explanation: blocks and deletion.
 *
 * Each is its own dialog rather than one generic form, because they post different things
 * — a block change carries the two flags and writes only them, a deletion carries nothing
 * but the reason — and a shared form would have to guess which fields to render.
 */
function BlockDialog({
  chartOfAccounts,
  account,
  isBlockedPosting,
  isBlockedCreation,
}: {
  chartOfAccounts: string;
  account: string;
  isBlockedPosting: boolean;
  isBlockedCreation: boolean;
}) {
  const [state, formAction, pending] = useActionState<GlAccountActionState, FormData>(
    setGlAccountBlocksAction,
    { ok: true },
  );
  const [reason, setReason] = useState('');
  const idPrefix = `fs00-block-${chartOfAccounts}-${account}`;

  return (
    <GlAccountDialog
      label={t('glAccount.blockedPosting')}
      dialogLabel={t('glAccount.blockTitle', { account })}
      codeLine={`FS00 · ${chartOfAccounts}/${account}`}
      bodyText={t('glAccount.blockFlagsRule')}
      state={state}
      formAction={formAction}
      pending={pending}
      submitLabel={t('glAccount.blockButton')}
    >
      <input type="hidden" name="chartOfAccounts" value={chartOfAccounts} />
      <input type="hidden" name="accountNumber" value={account} />

      <label
        htmlFor={`${idPrefix}-posting`}
        className="flex items-start gap-2 border border-line bg-white p-3 text-sm"
      >
        <input
          id={`${idPrefix}-posting`}
          name="isBlockedPosting"
          type="checkbox"
          defaultChecked={isBlockedPosting}
          disabled={pending}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          <span className="font-medium">{t('glAccount.blockedPosting')}</span>
          <span className="mt-0.5 block text-xs text-ink-faint">{t('glAccount.blockedPostingRule')}</span>
        </span>
      </label>

      <label
        htmlFor={`${idPrefix}-creation`}
        className="flex items-start gap-2 border border-line bg-white p-3 text-sm"
      >
        <input
          id={`${idPrefix}-creation`}
          name="isBlockedCreation"
          type="checkbox"
          defaultChecked={isBlockedCreation}
          disabled={pending}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          <span className="font-medium">{t('glAccount.blockedCreation')}</span>
          <span className="mt-0.5 block text-xs text-ink-faint">{t('glAccount.blockedCreationRule')}</span>
        </span>
      </label>

      <ReasonField
        id={`${idPrefix}-reason`}
        hint={t('glAccount.reasonRequired')}
        pending={pending}
        value={reason}
        onChange={setReason}
      />
    </GlAccountDialog>
  );
}

/** Hard delete, offered only because the service refuses an account that was ever used. */
function DeleteDialog({
  chartOfAccounts,
  account,
}: {
  chartOfAccounts: string;
  account: string;
}) {
  const [state, formAction, pending] = useActionState<GlAccountActionState, FormData>(
    deleteGlAccountAction,
    { ok: true },
  );
  const [reason, setReason] = useState('');
  const idPrefix = `fs00-delete-${chartOfAccounts}-${account}`;

  return (
    <GlAccountDialog
      label={t('glAccount.delete')}
      dialogLabel={t('glAccount.deleteTitle', { account })}
      codeLine={`FS00 · ${chartOfAccounts}/${account}`}
      bodyText={t('glAccount.deleteRule')}
      state={state}
      formAction={formAction}
      pending={pending}
      submitLabel={t('glAccount.deleteButton')}
    >
      <input type="hidden" name="chartOfAccounts" value={chartOfAccounts} />
      <input type="hidden" name="accountNumber" value={account} />
      <ReasonField
        id={`${idPrefix}-reason`}
        hint={t('glAccount.reasonRequired')}
        pending={pending}
        value={reason}
        onChange={setReason}
      />
    </GlAccountDialog>
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
}: {
  accounts: GlAccountListRow[];
  canChange: boolean;
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
                              <BlockDialog
                                chartOfAccounts={account.chartOfAccounts}
                                account={account.accountNumber}
                                isBlockedPosting={account.isBlockedPosting}
                                isBlockedCreation={account.isBlockedCreation}
                              />
                            )}
                            {canChange && (
                              <DeleteDialog
                                chartOfAccounts={account.chartOfAccounts}
                                account={account.accountNumber}
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
