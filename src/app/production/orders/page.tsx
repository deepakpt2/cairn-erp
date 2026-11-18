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
import { Page } from '@/ui/kit';

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
    <Page
      title={t('co01.title')} code="PROD.ORDER.CREATE · CO01" back={{ href: '/', label: t('nav.launchpad') }}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('co01.subtitle')}</p>
          <p className="max-w-3xl text-sm text-ink-soft">
              OPKP is not this screen. A scheduling profile is read from the material plant view and snapshotted.
              This screen does not print, schedule, check capacity, or post a goods receipt.
              OMCWB was read. WIP batch is {wipActive ? 'active' : 'not active'}. A WIP batch was not created.
            </p>
        </>
      }
    >

      {existing && (
        <section aria-labelledby="order-existing" className="border border-line bg-surface p-4">
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
          {existing.productionVersion && (
            <p className="mt-1 text-sm" data-production-version={existing.productionVersion}>
              Production version {existing.productionVersion}. Bill of material {existing.bomUsage}/{existing.bomAlternative}. A later change to that master data does not rewrite this snapshot.
            </p>
          )}
          <p className="mt-1 text-sm">
            <Link href={`/production/production-order-display?order=${encodeURIComponent(existing.orderNumber)}`}>Display</Link>
            {' · '}
            <Link href={`/production/production-order-change?order=${encodeURIComponent(existing.orderNumber)}`}>Change</Link>
          </p>
          <table className="grid-table mt-2 text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th>{t('co01.columnItem')}</th>
                <th>{t('co01.columnMaterial')}</th>
                <th>{t('co01.columnPlant')}</th>
                <th>{t('co01.columnLocation')}</th>
                <th className="text-right">{t('co01.columnQuantity')}</th>
              </tr>
            </thead>
            <tbody>
              {existing.components.map((c) => (
                <tr key={c.itemNumber} data-item={c.itemNumber} data-bom-item={c.bomItem ?? ''}>
                  <td>{c.itemNumber}</td>
                  <td>{c.materialNumber} · {c.materialDescription ?? '—'}</td>
                  <td>{c.plant}</td>
                  <td>{c.storageLocation ?? '—'}</td>
                  <td className="text-right tabular">{c.requiredQuantity} {c.unit}</td>
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
    </Page>
  );
}
