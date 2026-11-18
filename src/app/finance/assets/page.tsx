import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ASSET_CHANGE_CAPABILITY, listAssets } from '@/modules/finance/asset-master';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/assets';

/**
 * Asset master list and change entry (SCR-091 / AS02 as a search
 * alias only).
 */
export default async function AssetsPage() {
  const session = await requireSession(ROUTE);
  const assets = await listAssets(session.user.client);

  return (
    <Page
      title={t('assetChange.title')} code="FIN.ASSET.CHANGE · AS02" back={null}
      description={t('assetChange.subtitle')}
      actions={
        <>
          <span className="flex flex-wrap gap-2">
                      <LinkButton href="/finance/assets/history">
                        {t('assetList.history')}
                      </LinkButton>
                      <LinkButton href="/finance/assets/depreciate">
                        {t('assetList.depreciate')}
                      </LinkButton>
                      <LinkButton href="/finance/assets/retire">
                        {t('assetList.retire')}
                      </LinkButton>
                      <LinkButton href="/finance/assets/acquire">
                        {t('assetList.acquire')}
                      </LinkButton>
                      <LinkButton href="/finance/assets/new" variant="primary">
                        {t('assetCreate.title')}
                      </LinkButton>
                      <LinkButton href="/">
                        {t('nav.launchpad')}
                      </LinkButton>
                    </span>
        </>
      }
    >

      <section aria-labelledby="fa-list" className="border border-line bg-surface p-4">
        <h2 id="fa-list" className="text-sm font-semibold">Assets</h2>
        {assets.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No assets stand in this tenant.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Asset</th><th>Company</th>
                  <th>Class</th><th>Description</th>
                  <th>Capitalized</th><th>Status</th><th>Change</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={`${asset.companyCode}-${asset.assetNumber}-${asset.subNumber}`}>
                    <td>{asset.assetNumber}/{asset.subNumber}</td>
                    <td>{asset.companyCode}</td>
                    <td>{asset.assetClass}</td>
                    <td>{asset.description1}</td>
                    <td>{asset.capitalizationDate ?? '—'}</td>
                    <td>{asset.status}</td>
                    <td>
                      <Link className="text-accent hover:underline"
                        href={`/finance/assets/change?company=${asset.companyCode}&asset=${encodeURIComponent(asset.assetNumber)}&sub=${asset.subNumber}`}>
                        Change
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!can(session, ASSET_CHANGE_CAPABILITY) && (
          <p className="mt-2 text-sm text-ink-soft">You do not hold the asset change capability.</p>
        )}
      </section>
    </Page>
  );
}
