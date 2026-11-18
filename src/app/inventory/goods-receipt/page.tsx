
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  GR_POST_CAPABILITY, getMaterialDocument, getReceiptOrder,
} from '@/modules/inventory/goods-receipt';
import GoodsReceipt from './GoodsReceipt';
import StoReceiptPanel from './StoReceiptPanel';
import { getStoStatus } from '@/modules/inventory/stock-transport';
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
  const orderKey = (params.order ?? '').trim();
  // A stock transport order is shown from its transit ledger, never as a supplier order.
  const sto = orderKey ? await getStoStatus(client, orderKey.toUpperCase(), { userId: session.user.userId }) : null;
  const order = orderKey && !sto ? await getReceiptOrder(client, orderKey) : null;
  const document = params.doc ? await getMaterialDocument(client, params.doc) : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('goodsReceipt.title')} code="INV.GR.POST · MIGO" back={{ href: '/', label: t('nav.launchpad') }}
      description={t('goodsReceipt.subtitle')}
    >

      <GoodsReceipt
        orderHint={orderKey}
        order={order}
        document={document}
        canPost={can(session, GR_POST_CAPABILITY)}
        today={today}
      />
      {sto && <StoReceiptPanel status={sto} canPost={can(session, GR_POST_CAPABILITY)} today={today} />}
    </Page>
  );
}
