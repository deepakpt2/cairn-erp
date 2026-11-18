
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CAPABILITY,
  listBankCountryChoices,
  listBanks,
} from '@/modules/foundation/bank-master';
import { Banks } from './Banks';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/banks';

/**
 * Bank master (SCR-036; live since stage 3). Reference alias FI01.
 *
 * Banks are global reference data — one row per bank, shared by every tenant —
 * because house banks (FI12, SCR-037) name a bank by country and key and read its
 * name, city and SWIFT code as facts they do not own. This screen is where those
 * facts are defined; it is gated by a capability rather than a configuration
 * activity, since shared reference data is no tenant's configuration progress.
 */
export default async function BanksPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, CAPABILITY);

  const [banks, countries] = await Promise.all([
    listBanks(client),
    listBankCountryChoices(client),
  ]);

  return (
    <Page
      title={t('bank.title')} code={<>{CAPABILITY} · FI01</>} back={null}
      description={t('bank.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
          <LinkButton href="/config/house-banks">
                        {t('bank.houseBanksLink')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: CAPABILITY })}
        </p>
      )}

      <Banks banks={banks} countries={countries} canMaintain={canMaintain} />
    </Page>
  );
}
