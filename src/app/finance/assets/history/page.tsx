
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ASSET_REPORT_CAPABILITY, AssetHistoryError, getAssetHistorySheet,
  type AssetHistorySheet,
} from '@/modules/finance/asset-history';
import HistoryForm from './HistoryForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/assets/history';

/**
 * Asset history sheet (SCR-095 / S_ALR_87011990 as a search alias
 * only): a read-only aggregation over the standing value records,
 * driven by a judged GET selection.
 */
export default async function AssetHistoryPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const canReport = can(session, ASSET_REPORT_CAPABILITY);
  const get = (name: string) => params[name]?.trim() ?? '';
  const defaults = {
    companyCodeFrom: get('companyCodeFrom'),
    companyCodeTo: get('companyCodeTo'),
    assetClassFrom: get('assetClassFrom'),
    assetClassTo: get('assetClassTo'),
    assetNumberFrom: get('assetNumberFrom'),
    assetNumberTo: get('assetNumberTo'),
    fiscalYear: get('fiscalYear'),
    depreciationArea: get('depreciationArea'),
    reportingDate: get('reportingDate'),
    sortVersion: get('sortVersion'),
    layout: get('layout'),
  };

  let sheet: AssetHistorySheet | null = null;
  let error: string | null = null;
  if (canReport && defaults.companyCodeFrom && defaults.fiscalYear) {
    try {
      sheet = await getAssetHistorySheet(session.user.client, {
        companyCodeFrom: defaults.companyCodeFrom,
        companyCodeTo: defaults.companyCodeTo || undefined,
        assetClassFrom: defaults.assetClassFrom || undefined,
        assetClassTo: defaults.assetClassTo || undefined,
        assetNumberFrom: defaults.assetNumberFrom || undefined,
        assetNumberTo: defaults.assetNumberTo || undefined,
        fiscalYear: Number(defaults.fiscalYear),
        depreciationArea: defaults.depreciationArea || '01',
        reportingDate: defaults.reportingDate || undefined,
        sortVersion: defaults.sortVersion || undefined,
        layout: defaults.layout || undefined,
        page: params.page ? Number(params.page) : 1,
      });
    } catch (e) {
      if (e instanceof AssetHistoryError) error = e.message;
      else throw e;
    }
  }
  const exportQuery = new URLSearchParams(
    Object.entries(defaults).filter(([, v]) => v !== ''),
  ).toString();

  return (
    <Page
      title={t('assetHistory.title')} code="FIN.ASSET.REPORT · S_ALR_87011990" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('assetHistory.subtitle')}
    >

      {error && (
        <p role="alert" className="rounded border border-signal-error/40 bg-signal-error-soft px-3 py-2 text-sm text-signal-error">
          {error}
        </p>
      )}
      <HistoryForm
        canReport={canReport}
        defaults={defaults}
        sheet={sheet}
        exportQuery={exportQuery}
      />
    </Page>
  );
}
