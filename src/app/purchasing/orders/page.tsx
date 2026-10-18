import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import Orders from './Orders';

export const dynamic = 'force-dynamic';

const ROUTE = '/purchasing/orders';

/**
 * Purchase orders (SCR-056 / ME21N; inert since stage 1).
 *
 * Header, item, schedule-line and assignment documents converting
 * requisitions (SCR-056 stage 3 wires the acts).
 */
export default async function PurchaseOrdersPage() {
  await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.PO.CREATE · ME21N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('purchaseOrder.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('purchaseOrder.subtitle')}</p>
      </header>

      <Orders />
    </div>
  );
}
