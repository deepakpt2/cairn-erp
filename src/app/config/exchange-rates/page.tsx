
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  RATE_TYPES,
  listCurrencyChoices,
  listExchangeRates,
} from '@/modules/foundation/exchange-rate-maintenance';
import { ExchangeRates } from './ExchangeRates';
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('exRate.title')} code={<>{ACTIVITY} · OB08</>} back={null}
      description={t('exRate.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
          <LinkButton href="/config/company-codes">
                        {t('exRate.companyCodesLink')}
                      </LinkButton>
          <LinkButton href="/config/posting-periods">
                        {t('exRate.postingPeriodsLink')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <ExchangeRates rows={rows} currencies={currencies} rateTypes={RATE_TYPES} canMaintain={canMaintain} />
    </Page>
  );
}
