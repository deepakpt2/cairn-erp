
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listCountryChoices,
  listTaxCodes,
} from '@/modules/foundation/tax-code-definition';
import { TaxCodes } from './TaxCodes';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/tax-codes';

/**
 * FTXP Define Tax Codes for Sales and Purchases (SCR-035 stage 1: the screen).
 *
 * The activity has routed here since the seed with no screen behind the route, and
 * journal lines have carried a tax code as free text for just as long: this screen
 * is where the codes get defined — per country, with the rate and the condition and
 * account keys a posting rule reads. Posted lines keep the amounts they were posted
 * with; a definition governs what is determined from its change onward.
 */
export default async function TaxCodesPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, countries] = await Promise.all([
    listTaxCodes(client),
    listCountryChoices(client),
  ]);

  return (
    <Page
      title={t('taxCode.title')} code={<>{ACTIVITY} · FTXP</>} back={null}
      description={t('taxCode.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
          <LinkButton href="/config/company-codes">
                        {t('taxCode.companyCodesLink')}
                      </LinkButton>
          <LinkButton href="/config/gl-accounts">
                        {t('taxCode.glAccountsLink')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <TaxCodes rows={rows} countries={countries} canMaintain={canMaintain} />
    </Page>
  );
}
