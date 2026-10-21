import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  RECONCILE_CAPABILITY,
  reconcileStock,
  type ReconcileResult,
} from '@/modules/inventory/stock-reconcile';
import ReconcileShell from './ReconcileShell';

const RECONCILE_ROUTE = '/inventory/stock-reconcile';

export const dynamic = 'force-dynamic';

/**
 * SCR-144 / INV.STOCK.RECONCILE (MB5L) — does the projection still equal the ledger?
 *
 * Every stock figure on every other screen is read from `stock_quantity`, which is a
 * projection of the material documents. This screen is the one place that asks the documents
 * themselves, names every dimension where the two disagree, and can rebuild the projection from
 * the ledger it should have been derived from.
 */
export default async function StockReconcilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(RECONCILE_ROUTE);
  const params = await searchParams;
  const plant = (typeof params.plant === 'string' ? params.plant : '').trim().toUpperCase();

  let result: ReconcileResult | null = null;
  let reportError: string | null = null;
  if (plant && can(session, RECONCILE_CAPABILITY)) {
    try {
      result = await reconcileStock(session.user.client, { plant });
    } catch (caught) {
      const error = caught as { message?: string; remedy?: string };
      reportError = [error?.message, error?.remedy].filter(Boolean).join(' ') || 'The plant could not be reconciled.';
    }
  }

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.STOCK.RECONCILE · MB5L</span>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{t('recon.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('recon.subtitle')}</p>
      </header>

      <ReconcileShell
        canReconcile={can(session, RECONCILE_CAPABILITY)}
        plant={plant}
        result={result}
        reportError={reportError}
      />
    </div>
  );
}
