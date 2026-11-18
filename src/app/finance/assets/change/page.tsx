
import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import { ASSET_CHANGE_CAPABILITY, getAsset } from '@/modules/finance/asset-master';
import AssetChange from './AssetChange';
import { displayOnlyRemedy } from '@/ui/lock/remedy';
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('assetChange.title')} code="FIN.ASSET.CHANGE · AS02" back={null}
      description={t('assetChange.subtitle')}
      actions={
        <>
          <LinkButton href="/finance/assets">
                      Assets
                    </LinkButton>
        </>
      }
    >

      {!canChange ? (
        <p className="border border-line bg-surface p-4 text-sm text-ink-soft">
          You do not hold the asset change capability.
        </p>
      ) : !asset ? (
        <p className="border border-line bg-surface p-4 text-sm text-ink-soft">
          No asset stands under this key. Choose one from the asset list.
        </p>
      ) : changeLock?.mode === 'DISPLAY' ? (
        <LockNotice message={displayOnlyMessage(changeLock)} remedy={displayOnlyRemedy(changeLock)} />
      ) : (
        <>
          <ChangeLock lockObject="ASSET" argument={assetKey} />
          <AssetChange key={`${asset.companyCode}-${asset.assetNumber}-${asset.subNumber}`} asset={asset} today={today} />
        </>
      )}
    </Page>
  );
}
