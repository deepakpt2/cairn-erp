import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  RATE_TYPES,
  listCurrencyChoices,
  listExchangeRates,
} from '@/modules/foundation/exchange-rate-maintenance';
import { ExchangeRates } from './ExchangeRates';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/exchange-rates';

/**
 * OB08 Maintain Exchange Rates (SCR-034 stage 1: the screen).
 *
 * The exchange_rate table predates every screen that might maintain it: the standard
 * package seeds a tenant's first rates and nothing has ever let a configurator change
 * one. This screen is that maintenance — every rate beside the date it takes effect
 * and the translation ratios it is quoted for, since a form that hid a factor the
 * rate depends on would misstate the rate. Posted documents carry their own rate, so
 * this table governs future lookups rather than history.
 */
export default async function ExchangeRatesPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, currencies] = await Promise.all([
    listExchangeRates(client),
    listCurrencyChoices(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OB08</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('exRate.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
            <Link href="/config/company-codes" className="btn btn-default min-h-11 sm:min-h-8">
              {t('exRate.companyCodesLink')}
            </Link>
            <Link href="/config/posting-periods" className="btn btn-default min-h-11 sm:min-h-8">
              {t('exRate.postingPeriodsLink')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('exRate.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <ExchangeRates rows={rows} currencies={currencies} rateTypes={RATE_TYPES} canMaintain={canMaintain} />
    </div>
  );
}
