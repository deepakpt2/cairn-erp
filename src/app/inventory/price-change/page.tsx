
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { PRICE_CHANGE_CAPABILITY, PRICE_CHANGE_ROUTE, listFuturePrices } from '@/modules/inventory/price-change';
import PriceChange from './PriceChange';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * Material price change. MR21 is a search alias only.
 * A batch is not part of this screen.
 */
export default async function PriceChangePage() {
  const session = await requireSession(PRICE_CHANGE_ROUTE);
  const future = await listFuturePrices(session.user.client, { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => []);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Page
      title={t('priceChange.title')} code={t('priceChange.code')} back={{ href: '/', label: t('nav.launchpad') }}
      description={t('priceChange.subtitle')}
    >
      <PriceChange today={today} canPost={can(session, PRICE_CHANGE_CAPABILITY)} future={future} />
    </Page>
  );
}
