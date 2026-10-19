import { can, requireSession } from '@/platform/auth/current';
import {
  ASSET_REPORT_CAPABILITY, AssetHistoryError, assetHistoryCsv,
  getAssetHistorySheet, type AssetHistoryRow,
} from '@/modules/finance/asset-history';

const ROUTE = '/finance/assets/history';

/**
 * CSV export of the asset history sheet (SCR-095): the identical
 * judged selection re-runs server-side and every row is exported,
 * page by page. Read-only, like the sheet itself.
 */
export async function GET(request: Request) {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_REPORT_CAPABILITY)) {
    return new Response('You do not hold the asset reporting capability.', { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const get = (name: string) => params.get(name)?.trim() || undefined;
  try {
    const base = {
      companyCodeFrom: get('companyCodeFrom') ?? '',
      companyCodeTo: get('companyCodeTo'),
      assetClassFrom: get('assetClassFrom'),
      assetClassTo: get('assetClassTo'),
      assetNumberFrom: get('assetNumberFrom'),
      assetNumberTo: get('assetNumberTo'),
      fiscalYear: Number(get('fiscalYear')),
      depreciationArea: get('depreciationArea') ?? '01',
      reportingDate: get('reportingDate'),
      pageSize: 500,
    };
    const rows: AssetHistoryRow[] = [];
    let page = 1;
    for (;;) {
      const sheet = await getAssetHistorySheet(session.user.client, { ...base, page });
      rows.push(...sheet.rows);
      if (rows.length >= sheet.totalRows || sheet.rows.length === 0) break;
      page += 1;
    }
    return new Response(assetHistoryCsv(rows), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="asset-history-${base.fiscalYear}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof AssetHistoryError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
}
