import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ASSET_CHANGE_CAPABILITY, listAssets } from '@/modules/finance/asset-master';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.ASSET.CHANGE · AS02</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('assetChange.title')}</h1>
          <span className="flex gap-2">
            <Link href="/finance/assets/history" className="btn btn-default min-h-11 sm:min-h-8">
              {t('assetList.history')}
            </Link>
            <Link href="/finance/assets/depreciate" className="btn btn-default min-h-11 sm:min-h-8">
              {t('assetList.depreciate')}
            </Link>
            <Link href="/finance/assets/retire" className="btn btn-default min-h-11 sm:min-h-8">
              {t('assetList.retire')}
            </Link>
            <Link href="/finance/assets/acquire" className="btn btn-default min-h-11 sm:min-h-8">
              {t('assetList.acquire')}
            </Link>
            <Link href="/finance/assets/new" className="btn btn-primary min-h-11 sm:min-h-8">
              {t('assetCreate.title')}
            </Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.launchpad')}
            </Link>
          </span>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('assetChange.subtitle')}</p>
      </header>

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
    </div>
  );
}
