
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ACTIVITY, listReleaseConfiguration } from '@/modules/foundation/release-strategy-definition';
import ReleaseStrategies from './ReleaseStrategies';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/release-strategies';

/**
 * Release strategies (SCR-059; inert in stage 1, live since stage 3).
 * The activity has stood in the seed since the platform round; this
 * is its page.
 */
export default async function ReleaseStrategiesPage() {
  const session = await requireSession(ROUTE);
  const data = await listReleaseConfiguration(session.user.client);

  return (
    <Page
      title={t('releaseStrategy.title')} code="CFG.PROC.RELEASE.DEFINE" back={null}
      description={t('releaseStrategy.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                      {t('nav.workbench')}
                    </LinkButton>
        </>
      }
    >

      <ReleaseStrategies data={data} canMaintain={can(session, ACTIVITY)} />
    </Page>
  );
}
