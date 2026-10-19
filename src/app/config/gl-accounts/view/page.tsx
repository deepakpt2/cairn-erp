import { can, requireSession } from '@/platform/auth/current';
import { listAccountSegments } from '@/modules/finance/gl-account-transfer';
import { GlAccountModeScreen } from '../GlAccountModeScreen';

export const dynamic = 'force-dynamic';

/** FSS0 — Display mode. Read-only for anyone holding the display authority. */
export default async function ViewGlAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ chart?: string; account?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession('/config/gl-accounts/view');
  const segments = params.chart && params.account && can(session, 'CFG.FIN.GLACCOUNT.DISPLAY')
    ? await listAccountSegments(session.user.client, { chartOfAccounts: params.chart, glAccount: params.account })
    : [];
  return (
    <>
      <GlAccountModeScreen mode="DISPLAY" searchParams={Promise.resolve(params)} />
      {segments.length > 0 && (
        <section className="mx-auto w-full max-w-6xl px-4 pb-6 sm:px-6" aria-label="Company code segments">
          <div className="panel overflow-x-auto">
            <div className="panel-header"><h2 className="panel-title">Company Code Segments</h2></div>
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Company Code</th><th>Account Currency</th><th>Tax Category</th>
                  <th>Open-Item Managed</th><th>Sort Key</th><th>Blocked for Posting</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment) => (
                  <tr key={segment.companyCode}>
                    <td className="code">{segment.companyCode}</td>
                    <td className="code">{segment.accountCurrency}</td>
                    <td className="code">{segment.taxCategory ?? '—'}</td>
                    <td>{segment.isOpenItemManaged ? 'Yes' : 'No'}</td>
                    <td className="code">{segment.sortKey}</td>
                    <td>{segment.isBlockedPosting ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
