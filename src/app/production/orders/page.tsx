import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PRODUCTION_ORDER_CAPABILITY,
  PRODUCTION_ORDER_RELEASE_CAPABILITY,
  PRODUCTION_ORDER_ROUTE,
  getProductionOrder,
} from '@/modules/inventory/production-orders';
import { wipBatchActive } from '@/modules/production/wip-batch';
import OrderCreate from './OrderCreate';

export const dynamic = 'force-dynamic';

/**
 * Production orders — SCR-138 / PROD.ORDER.CREATE (CO01 as a search alias only).
 *
 * Create an order and release it. Nothing here moves stock or writes to the ledger: the
 * order is the master the goods issue of the next round will post against, and a master
 * that posted would be a posting, not a master.
 */
export default async function ProductionOrdersPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(PRODUCTION_ORDER_ROUTE);
  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const existing = params.order
    ? await getProductionOrder(session.user.client, params.order)
    : null;
  const wipActive = existing ? existing.wipBatchActive === 'X' : await wipBatchActive(session.user.client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.ORDER.CREATE · CO01</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('co01.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('co01.subtitle')}</p>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OPKP is not this screen. A scheduling profile is read from the material plant view and snapshotted.
          This screen does not print, schedule, check capacity, or post a goods receipt.
          OMCWB was read. WIP batch is {wipActive ? 'active' : 'not active'}. A WIP batch was not created.
        </p>
      </header>

      {existing && (
        <section aria-labelledby="order-existing" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="order-existing" className="text-sm font-semibold">
            {t('co01.order')} <span className="code" data-order-number={existing.orderNumber}>{existing.orderNumber}</span>
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {existing.materialNumber} · {t('co01.plant')} {existing.plant} · {t('co01.company')} {existing.companyCode}
            {existing.batch ? ` · Batch ${existing.batch}` : ''}
            {' · '}<span data-status={existing.status}>{existing.status}</span>
          </p>
          {existing.plannedOrderNumber && (
            <p className="mt-1 text-sm">Converted from planned order {existing.plannedOrderNumber}. The planned order was not deleted.</p>
          )}
          <p className="mt-1 text-sm">
            <Link href={`/production/production-order-display?order=${encodeURIComponent(existing.orderNumber)}`}>Display</Link>
            {' · '}
            <Link href={`/production/production-order-change?order=${encodeURIComponent(existing.orderNumber)}`}>Change</Link>
          </p>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('co01.columnItem')}</th>
                <th className="py-1">{t('co01.columnMaterial')}</th>
                <th className="py-1">{t('co01.columnPlant')}</th>
                <th className="py-1">{t('co01.columnLocation')}</th>
                <th className="py-1 text-right">{t('co01.columnQuantity')}</th>
              </tr>
            </thead>
            <tbody>
              {existing.components.map((c) => (
                <tr key={c.itemNumber} className="border-t border-line" data-item={c.itemNumber}>
                  <td className="py-1">{c.itemNumber}</td>
                  <td className="py-1">{c.materialNumber} · {c.materialDescription ?? '—'}</td>
                  <td className="py-1">{c.plant}</td>
                  <td className="py-1">{c.storageLocation ?? '—'}</td>
                  <td className="py-1 text-right tabular">{c.requiredQuantity} {c.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <OrderCreate
        canCreate={can(session, PRODUCTION_ORDER_CAPABILITY)}
        canRelease={can(session, PRODUCTION_ORDER_RELEASE_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
