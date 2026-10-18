import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { PO_CREATE_CAPABILITY, getOrder, listOrders, orderChoices } from '@/modules/purchasing/orders';
import {
  RELEASE_CAPABILITIES,
  getDocumentRelease,
  listDocumentReleases,
} from '@/modules/purchasing/release';
import Orders from './Orders';

export const dynamic = 'force-dynamic';

const ROUTE = '/purchasing/orders';

/**
 * Purchase orders (SCR-056 / ME21N create, ME22N change, ME23N
 * display; inert in stage 1, live since stage 3).
 */
export default async function PurchaseOrdersPage({ searchParams }: {
  searchParams: Promise<{ order?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const [documents, choices, releases] = await Promise.all([
    listOrders(client),
    orderChoices(client),
    listDocumentReleases(client, 'PURCHASE_ORDER'),
  ]);
  const selected = params.order ? await getOrder(client, params.order) : null;
  const selectedRelease = selected
    ? await getDocumentRelease(client, 'PURCHASE_ORDER', selected.orderNumber)
    : null;

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

      <Orders
        documents={documents}
        choices={choices}
        selected={selected}
        canCreate={can(session, PO_CREATE_CAPABILITY)}
        releases={Object.fromEntries(releases)}
        selectedRelease={selectedRelease}
        canRelease={can(session, RELEASE_CAPABILITIES.PURCHASE_ORDER)}
      />
    </div>
  );
}
