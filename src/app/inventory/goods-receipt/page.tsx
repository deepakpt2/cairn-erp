import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  GR_POST_CAPABILITY, getMaterialDocument, getReceiptOrder,
} from '@/modules/inventory/goods-receipt';
import GoodsReceipt from './GoodsReceipt';

export const dynamic = 'force-dynamic';

const ROUTE = '/inventory/goods-receipt';

/**
 * Goods receipt (SCR-061 / MIGO as a search alias only). Action and
 * reference are separate concepts; the movement type is resolved
 * from them by the posting service.
 */
export default async function GoodsReceiptPage({ searchParams }: {
  searchParams: Promise<{ order?: string; doc?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const order = params.order ? await getReceiptOrder(client, params.order) : null;
  const document = params.doc ? await getMaterialDocument(client, params.doc) : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.GR.POST · MIGO</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('goodsReceipt.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('goodsReceipt.subtitle')}</p>
      </header>

      <GoodsReceipt
        order={order}
        document={document}
        canPost={can(session, GR_POST_CAPABILITY)}
        today={today}
      />
    </div>
  );
}
