
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  INTERCOMPANY_CAPABILITY, listCompanyChoices, listIntercompanyConfigs,
} from '@/modules/finance/intercompany';
import { IntercompanyPosting } from './IntercompanyPosting';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/intercompany';

/**
 * Intercompany posting (SCR-122; FB01 as a search alias only).
 *
 * One submission posts the sending journal and its receiving mirror in one
 * transaction; the OBYA clearing lines are generated, never typed.
 */
export default async function IntercompanyPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const [companies, pairs] = await Promise.all([
    listCompanyChoices(client),
    listIntercompanyConfigs(client),
  ]);
  const canPost = can(session, INTERCOMPANY_CAPABILITY);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Page
      title={t('icPost.title')} code={<>{INTERCOMPANY_CAPABILITY} · FB01</>}
      description={t('icPost.intro')}
      actions={
        <>
          <LinkButton href="/config/intercompany-clearing">
                        {t('icCfg.title')}
                      </LinkButton>
        </>
      }
    >
      <IntercompanyPosting companies={companies} pairs={pairs} canPost={canPost} today={today} />
    </Page>
  );
}
