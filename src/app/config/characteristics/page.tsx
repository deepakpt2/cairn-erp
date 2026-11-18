
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ACTIVITY, listCharacteristics } from '@/modules/foundation/characteristic-definition';
import Characteristics from './Characteristics';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/characteristics';

/**
 * Characteristics for classification (SCR-057 / CT04; inert in
 * stage 1, live since stage 3).
 */
export default async function CharacteristicsPage() {
  const session = await requireSession(ROUTE);
  const rows = await listCharacteristics(session.user.client);

  return (
    <Page
      title={t('characteristic.title')} code="CFG.PROC.CHARACTERISTIC.DEFINE · CT04" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('characteristic.subtitle')}</p>
          <p className="max-w-3xl text-sm text-ink-soft">
              OCHA is not this screen. OCHA is the batch management IMG. The description stands in the
              tenant language. Where-used is the class that names this characteristic. A batch value is
              not stored here. Class type 023 is not active.
            </p>
        </>
      }
      actions={
        <>
          <LinkButton href="/config">
                      {t('nav.workbench')}
                    </LinkButton>
        </>
      }
    >

      <Characteristics rows={rows} canMaintain={can(session, ACTIVITY)} />
    </Page>
  );
}
