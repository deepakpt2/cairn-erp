
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  GR_POST_CAPABILITY, getMaterialDocument, getReceiptOrder,
} from '@/modules/inventory/goods-receipt';
import GoodsReceipt from './GoodsReceipt';
import { Page } from '@/ui/kit';

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
    <Page
      title={t('goodsReceipt.title')} code="INV.GR.POST · MIGO" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('goodsReceipt.subtitle')}
    >

      <GoodsReceipt
        order={order}
        document={document}
        canPost={can(session, GR_POST_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
