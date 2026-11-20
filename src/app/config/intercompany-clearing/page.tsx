
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  INTERCOMPANY_CONFIG_CAPABILITY, listCompanyChoices, listIntercompanyConfigs,
} from '@/modules/finance/intercompany';
import { IntercompanyClearing } from './IntercompanyClearing';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/intercompany-clearing';

/**
 * OBYA — intercompany clearing configuration (SCR-122).
 *
 * One row per ordered company pair; the clearing accounts here override the
 * OBYA account each company already carries, and a pair that has posted
 * stands as history rather than being deleted.
 */
export default async function IntercompanyClearingPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, INTERCOMPANY_CONFIG_CAPABILITY);
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };
  // The service judges capability and Company Code scope itself; a caller without the capability sees nothing.
  const [pairs, companies] = canMaintain
    ? await Promise.all([listIntercompanyConfigs(client, authorization, [INTERCOMPANY_CONFIG_CAPABILITY]), listCompanyChoices(client, authorization, [INTERCOMPANY_CONFIG_CAPABILITY])])
    : [[], []];
  return (
    <Page
      title={t('icCfg.title')} code={<>{INTERCOMPANY_CONFIG_CAPABILITY} · OBYA</>}
      description={t('icCfg.intro')}
      actions={
        <>
          <LinkButton href="/finance/intercompany">
                        {t('icCfg.post')}
                      </LinkButton>
        </>
      }
    >
      <IntercompanyClearing pairs={pairs} companies={companies} canMaintain={canMaintain} />
    </Page>
  );
}
