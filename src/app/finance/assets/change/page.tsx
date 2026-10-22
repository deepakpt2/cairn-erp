import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import { ASSET_CHANGE_CAPABILITY, getAsset } from '@/modules/finance/asset-master';
import AssetChange from './AssetChange';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/assets/change';

/**
 * Change asset master (SCR-091 / AS02 as a search alias only).
 */
export default async function ChangeAssetPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const canChange = can(session, ASSET_CHANGE_CAPABILITY);
  const asset = params.company && params.asset && canChange
    ? await getAsset(session.user.client, params.company, params.asset, params.sub ?? '0000')
    : null;
  const assetKey = asset ? `${asset.companyCode.trim()}/${asset.assetNumber.trim()}/${asset.subNumber.trim()}` : '';
  const changeLock = asset
    ? await openChangeForSession(session, {
        lockObject: 'ASSET',
        argument: assetKey,
        transactionCode: 'FIN.ASSET.CHANGE',
      })
    : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.ASSET.CHANGE · AS02</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('assetChange.title')}</h1>
          <Link href="/finance/assets" className="btn btn-default min-h-11 sm:min-h-8">
            Assets
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('assetChange.subtitle')}</p>
      </header>

      {!canChange ? (
        <p className="rounded-card border border-line bg-surface p-4 text-sm text-ink-soft shadow-card">
          You do not hold the asset change capability.
        </p>
      ) : !asset ? (
        <p className="rounded-card border border-line bg-surface p-4 text-sm text-ink-soft shadow-card">
          No asset stands under this key. Choose one from the asset list.
        </p>
      ) : changeLock?.mode === 'DISPLAY' ? (
        <LockNotice message={displayOnlyMessage(changeLock)} />
      ) : (
        <>
          <ChangeLock lockObject="ASSET" argument={assetKey} />
          <AssetChange key={`${asset.companyCode}-${asset.assetNumber}-${asset.subNumber}`} asset={asset} today={today} />
        </>
      )}
    </div>
  );
}
