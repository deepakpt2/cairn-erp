import { Fragment } from 'react';
import { t } from '@/platform/i18n';
import { listGlAccounts } from '@/modules/foundation/services';
import { requireSession } from '@/platform/auth/current';

export const dynamic = 'force-dynamic';

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

/**
 * G/L account list — FIN.GL.MASTER.LIST
 *
 * Grouped by the first digit of the account number, which is how accountants read
 * a chart of accounts: 1 assets, 2 liabilities and equity, 3 revenue, 4‑6 cost and
 * expense. The grouping is derived from the number rather than stored, so it can
 * never disagree with it.
 */
export default async function GlAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; q?: string }>;
}) {
  const params = await searchParams;
  // The tenant comes from the session, never from the query string. A `?client=`
  // override here would let a signed-in user of one tenant read another's books.
  const session = await requireSession();
  const client = session.user.client;

  const search = params.q ?? '';
  const accounts = await listGlAccounts(client, { search });

  const groups = new Map<string, typeof accounts>();
  for (const account of accounts) {
    const key = TYPE_GROUP[account.accountType] ?? account.accountNumber.charAt(0);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(account);
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.GL.MASTER.LIST</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('gl.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('gl.subtitle')}</p>
      </header>

      <form method="get" className="mb-4 flex gap-2">
        <input type="hidden" name="client" value={client} />
        <input
          type="text"
          name="q"
          defaultValue={search}
          placeholder={t('gl.search')}
          className="field-input flex-1"
        />
        <button type="submit" className="btn btn-primary">
          {t('registry.search')}
        </button>
      </form>

      <div className="panel overflow-hidden">
        <div className="panel-header">
          <h2 className="panel-title">{t('gl.title')}</h2>
          <span className="text-2xs text-ink-faint">{accounts.length}</span>
        </div>
        <table className="grid-table">
          <thead>
            <tr>
              <th className="w-24">{t('gl.number')}</th>
              <th>{t('gl.name')}</th>
              <th className="w-28">{t('gl.type')}</th>
              <th className="w-28">{t('gl.openItem')}</th>
              <th className="w-28">{t('gl.reconciliation')}</th>
              <th className="w-20">{t('gl.costObject')}</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([group, items]) => (
              <Fragment key={group}>
                <tr>
                  <td colSpan={6} className="bg-sunken text-2xs font-semibold uppercase tracking-wide text-ink-faint">
                    {group} · {items.length} account{items.length === 1 ? '' : 's'}
                  </td>
                </tr>
                {items.map((account) => (
                  <tr key={account.accountNumber}>
                    <td className="code font-semibold">{account.accountNumber}</td>
                    <td>{account.name}</td>
                    <td className="text-ink-soft">{t(TYPE_LABEL[account.accountType])}</td>
                    <td>
                      {account.isOpenItemManaged ? (
                        <span className="chip chip-info">Open</span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="text-ink-soft">
                      {account.reconciliationType
                        ? t(`gl.recon.${account.reconciliationType.toLowerCase()}`)
                        : '—'}
                    </td>
                    <td className="text-ink-soft">
                      {account.requiresCostObject ? 'Yes' : '—'}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
