import { can, requireSession } from '@/platform/auth/current';
import {
  DEFAULT_MAX_HITS, LEADING_LEDGER, PROFIT_CENTER_REPORT_CAPABILITY,
  ProfitCenterReportError, listProfitCenterLines, profitCenterLinesCsv,
} from '@/modules/foundation/profit-center-report';

const ROUTE = '/controlling/profit-center-report';

/**
 * CSV export of the standing KE5Z selection (SCR-113): read-only,
 * the same derivation and hit-limit window the screen shows.
 */
export async function GET(request: Request) {
  const session = await requireSession(ROUTE);
  if (!can(session, `${PROFIT_CENTER_REPORT_CAPABILITY}.read`)) {
    return new Response('You do not hold the profit center report capability.', { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const get = (name: string, fallback = '') => (params.get(name) ?? fallback).trim();
  const controllingArea = get('controllingArea').toUpperCase();
  if (!controllingArea) return new Response('Controlling area is required.', { status: 400 });
  const fiscalYear = Number(get('fiscalYear', String(new Date().getFullYear()))) || new Date().getFullYear();
  try {
    const result = await listProfitCenterLines({
      client: session.user.client,
      selection: {
        controllingArea,
        profitCenterGroup: get('profitCenterGroup').toUpperCase(),
        profitCenterFrom: get('profitCenterFrom').toUpperCase(),
        profitCenterTo: get('profitCenterTo').toUpperCase(),
        glAccountFrom: get('glAccountFrom'),
        glAccountTo: get('glAccountTo'),
        documentFrom: get('documentFrom'),
        documentTo: get('documentTo'),
        fiscalYear,
        periodFrom: Number(get('periodFrom', '1')) || 1,
        periodTo: Number(get('periodTo', '12')) || 12,
        ledger: (get('ledger', LEADING_LEDGER) || LEADING_LEDGER).toUpperCase(),
        maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
      },
    });
    return new Response(profitCenterLinesCsv(result), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="profit-center-lines-${controllingArea}-${fiscalYear}.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof ProfitCenterReportError) {
      return new Response(error.remedy ? `${error.message} ${error.remedy}` : error.message, { status: 400 });
    }
    throw error;
  }
}
