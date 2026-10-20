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
      });
    } catch (error) {
      reportError = error instanceof StockRequirementsError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The stock/requirements list could not be calculated.';
    }
  }

  return (
    <div className="mx-auto max-w-[90rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.MRP.STOCKREQ · MD04</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('md04.title')}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('md04.subtitle')}</p>
      </header>

      <StockRequirementsShell
        canUse={can(session, STOCK_REQUIREMENTS_CAPABILITY)}
        selection={initialSelection}
        result={result}
        reportError={reportError}
      />
    </div>
  );
}
