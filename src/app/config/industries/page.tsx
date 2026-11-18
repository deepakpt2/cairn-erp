
import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, listIndustries } from '@/modules/foundation/industry-definition';
import { t } from '@/platform/i18n';
import Industries from './Industries';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/industries';

/**
 * Maintain industries (SCR-077 / OB44 as a search alias only).
 *
 * The industry master the business partner classifies under, with
 * descriptions by configured language: delivered standard industries
 * per tenant, maintained here in the standing master shape.
 */
export default async function IndustriesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const industries = await listIndustries(session.user.client);

  return (
    <Page
      title={t('industry.title')} code={<>{ACTIVITY} · OB44</>} back={null}
      description={t('industry.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <Industries industries={industries} canMaintain={canMaintain} />
    </Page>
  );
}
