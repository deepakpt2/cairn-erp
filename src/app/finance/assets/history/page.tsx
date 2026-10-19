import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ASSET_REPORT_CAPABILITY, AssetHistoryError, getAssetHistorySheet,
  type AssetHistorySheet,
} from '@/modules/finance/asset-history';
import HistoryForm from './HistoryForm';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.ASSET.REPORT · S_ALR_87011990</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('assetHistory.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('assetHistory.subtitle')}</p>
      </header>

      {error && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <HistoryForm
        canReport={canReport}
        defaults={defaults}
        sheet={sheet}
        exportQuery={exportQuery}
      />
    </div>
  );
}
