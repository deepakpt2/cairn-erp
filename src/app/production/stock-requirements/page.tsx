import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DEFAULT_MAX_HITS,
  STOCK_REQUIREMENTS_CAPABILITY,
  StockRequirementsError,
  stockRequirementsList,
  type StockRequirementsResult,
  type StockRequirementsSelection,
} from '@/modules/production/stock-requirements';
import StockRequirementsShell from './StockRequirementsShell';
import { ReportExport } from '@/ui/output/ReportExport';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * SCR-130 / PROD.MRP.STOCKREQ (MD04): the stock/requirements list for one
 * material in one plant. Computed live on every execution; read-only.
 */
export default async function StockRequirementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const initialSelection: StockRequirementsSelection = {
    material: get('material').toUpperCase(),
    plant: get('plant').toUpperCase(),
    mrpArea: get('mrpArea'),
    specialStockIndicator: get('specialStockIndicator').toUpperCase(),
    // The package defaults the past-due display on; only an explicit off hides them.
    displayPastDue: get('pastDueOff') !== '1',
    periodSplit: (get('periodSplit') || 'DAILY').toUpperCase(),
    simulationVersion: get('simulationVersion'),
    horizonEnd: get('horizonEnd'),
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  let result: StockRequirementsResult | null = null;
  let reportError: string | null = null;
  if (can(session, STOCK_REQUIREMENTS_CAPABILITY)) {
    try {
      result = await stockRequirementsList({
        client: session.user.client,
        today: new Date().toISOString().slice(0, 10),
        selection: initialSelection,
        canDisplaySalesOrders: can(session, 'SALES.ORDER.CREATE'),
      });
    } catch (error) {
      reportError = error instanceof StockRequirementsError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The stock/requirements list could not be calculated.';
    }
  }

  return (
    <Page
      title={t('md04.title')} code="PROD.MRP.STOCKREQ · MD04" width="90rem" back={null}
      description={t('md04.subtitle')}
    >

      {result && result.rows.length > 0 && <div><ReportExport report="stock-requirements" params={params} /></div>}

      <StockRequirementsShell
        canUse={can(session, STOCK_REQUIREMENTS_CAPABILITY)}
        selection={initialSelection}
        result={result}
        reportError={reportError}
      />
    </Page>
  );
}
