import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACCOUNT_DETERMINATION_CAPABILITY,
  listAccountDetermination,
} from '@/modules/sales/account-determination-maintenance';
import { SalesAccountDeterminationSetup } from './SalesAccountDeterminationSetup';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/sales-account-determination';

export default async function SalesAccountDeterminationPage() {
  const session = await requireSession(ROUTE);
  const configuration = await listAccountDetermination(session.user.client);
  const canMaintain = can(session, ACCOUNT_DETERMINATION_CAPABILITY);
  const undetermined = configuration.keys.filter(
    (key) => !configuration.rows.some((row) => row.accountKey === key.key && row.isActive),
  );

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACCOUNT_DETERMINATION_CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Revenue account determination</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Where each part of a sale lands in the ledger. A pricing step says what kind of figure it produced —
          the price, a discount, freight, output tax — and that key, with the chart of accounts, the sales
          organisation and the account assignment groups of the customer and the material, is what names the
          account. Where no row stands for a key, the document is refused rather than posted somewhere
          plausible: revenue nobody chose is not revenue.
        </p>
        {!canMaintain && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Maintenance requires an explicit exact-code role grant for{' '}
            {ACCOUNT_DETERMINATION_CAPABILITY}; broad wildcard role patterns do not grant it.
          </p>
        )}
      </header>

      <section aria-labelledby="account-keys" className="border border-line bg-surface p-4">
        <h2 id="account-keys" className="text-sm font-semibold">The keys a pricing step can carry</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="grid-table text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th>Key</th>
                <th>Meaning</th>
                <th>What it is</th>
                <th>Determined</th>
              </tr>
            </thead>
            <tbody>
              {configuration.keys.map((key) => (
                <tr key={key.key}>
                  <td className="font-mono">{key.key}</td>
                  <td>{key.name}</td>
                  <td className="text-ink-soft">{key.meaning}</td>
                  <td>
                    {configuration.rows.some((row) => row.accountKey === key.key && row.isActive)
                      ? 'Yes'
                      : <span className="text-red-700">No — a document of this key cannot be posted</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {undetermined.length > 0 && (
          <p className="mt-2 text-sm text-ink-soft">
            {undetermined.map((key) => key.key).join(', ')} stands undetermined, so no document carrying{' '}
            {undetermined.length === 1 ? 'it' : 'them'} can be posted.
          </p>
        )}
      </section>

      <section aria-labelledby="determination-rows" className="border border-line bg-surface p-4">
        <h2 id="determination-rows" className="text-sm font-semibold">As configured</h2>
        {configuration.rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No determination stands for this tenant, so no sales document can be posted at all.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Chart</th>
                  <th>Sales org</th>
                  <th>Customer group</th>
                  <th>Material group</th>
                  <th>Key</th>
                  <th>Posts to</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {configuration.rows.map((row) => (
                  <tr key={`${row.chartOfAccounts}/${row.salesOrg}/${row.customerAccountAssignmentGroup}/${row.materialAccountAssignmentGroup}/${row.accountKey}`}>
                    <td className="font-mono">{row.chartOfAccounts}</td>
                    <td className="font-mono">{row.salesOrg || '(any)'}</td>
                    <td className="font-mono">{row.customerAccountAssignmentGroup || '(any)'}</td>
                    <td className="font-mono">{row.materialAccountAssignmentGroup || '(any)'}</td>
                    <td className="font-mono">{row.accountKey}</td>
                    <td className="font-mono">
                      {row.glAccount}
                      {row.accountName ? <span className="text-ink-faint"> · {row.accountName}</span> : null}
                    </td>
                    <td>
                      {row.isActive
                        ? (row.accountStands ? 'Answers' : <span className="text-red-700">Account missing from the chart</span>)
                        : 'Withdrawn'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 max-w-3xl text-xs text-ink-faint">
          The most specific row that fits answers, in one fixed order: the sales organisation first, then the
          customer’s group, then the material’s. Blank is a value and is matched as one, so a customer
          maintained with no group is answered by the rows that name none — never by a row invented for them.
        </p>
      </section>

      {canMaintain && (
        <SalesAccountDeterminationSetup
          rows={configuration.rows}
          keys={configuration.keys}
          charts={configuration.charts}
          organisations={configuration.organisations}
          accounts={configuration.accounts}
        />
      )}
    </main>
  );
}
