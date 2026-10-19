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

      <section aria-labelledby="fa-list" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="fa-list" className="text-sm font-semibold">Assets</h2>
        {assets.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No assets stand in this tenant.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Asset</th><th className="px-2 py-2">Company</th>
                  <th className="px-2 py-2">Class</th><th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">Capitalized</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Change</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={`${asset.companyCode}-${asset.assetNumber}-${asset.subNumber}`} className="border-t border-line">
                    <td className="px-2 py-2">{asset.assetNumber}/{asset.subNumber}</td>
                    <td className="px-2 py-2">{asset.companyCode}</td>
                    <td className="px-2 py-2">{asset.assetClass}</td>
                    <td className="px-2 py-2">{asset.description1}</td>
                    <td className="px-2 py-2">{asset.capitalizationDate ?? '—'}</td>
                    <td className="px-2 py-2">{asset.status}</td>
                    <td className="px-2 py-2">
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
