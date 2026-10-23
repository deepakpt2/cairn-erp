import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { PRICE_CHANGE_CAPABILITY, PRICE_CHANGE_ROUTE, listFuturePrices } from '@/modules/inventory/price-change';
import PriceChange from './PriceChange';

export const dynamic = 'force-dynamic';

/**
 * Material price change. MR21 is a search alias only.
 * A batch is not part of this screen.
 */
export default async function PriceChangePage() {
  const session = await requireSession(PRICE_CHANGE_ROUTE);
  const future = await listFuturePrices(session.user.client);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('priceChange.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('priceChange.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('priceChange.subtitle')}</p>
      </header>
      <PriceChange today={today} canPost={can(session, PRICE_CHANGE_CAPABILITY)} future={future} />
    </div>
  );
}
