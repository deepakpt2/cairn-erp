
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listBankChoices,
  listGlAccountChoices,
  listHouseBankCompanies,
  listHouseBankCurrencies,
  listHouseBanks,
} from '@/modules/foundation/house-bank-definition';
import { HouseBanks } from './HouseBanks';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/house-banks';

/**
 * FI12 Define House Banks (SCR-037; live since stage 3).
 *
 * A house bank is the tenant's own bank inside a company code; the accounts
 * under it carry the numbers money actually moves through. The bank it names
 * is defined once in the global bank master (SCR-036) and read from there —
 * this screen maintains the tenant's reference to it, never its facts.
 */
export default async function HouseBanksPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [houseBanks, companies, banks, currencies, glAccountChoices] = await Promise.all([
    listHouseBanks(client),
    listHouseBankCompanies(client),
    listBankChoices(client),
    listHouseBankCurrencies(client),
    listGlAccountChoices(client),
  ]);

  return (
    <Page
      title={t('houseBank.title')} code={<>{ACTIVITY} · FI12</>} back={null}
      description={t('houseBank.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
          <LinkButton href="/config/banks">
                        {t('houseBank.banksLink')}
                      </LinkButton>
          <LinkButton href="/config/company-codes">
                        {t('houseBank.companyCodesLink')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <HouseBanks
        houseBanks={houseBanks}
        companies={companies}
        banks={banks}
        currencies={currencies}
        glAccountChoices={glAccountChoices}
        canMaintain={canMaintain}
      />
    </Page>
  );
}
