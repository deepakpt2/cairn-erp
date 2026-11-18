
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { SPECIAL_GL_ACTIVITY, listSpecialGlConfigs } from '@/modules/foundation/special-gl';
import { SpecialGl } from './SpecialGl';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/special-gl';

/**
 * Special G/L indicator configuration (SCR-081; OBXR/OBYR as search aliases only).
 */
export default async function SpecialGlPage() {
  const session = await requireSession(ROUTE);
  const rows = await listSpecialGlConfigs(session.user.client);

  return (
    <Page
      title={t('specialGl.title')} code={<>{SPECIAL_GL_ACTIVITY} · OBXR</>} back={null}
      description={t('specialGl.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                      {t('nav.workbench')}
                    </LinkButton>
        </>
      }
    >

      <SpecialGl rows={rows} canMaintain={can(session, SPECIAL_GL_ACTIVITY)} />
    </Page>
  );
}
