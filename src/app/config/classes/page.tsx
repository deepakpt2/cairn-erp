
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ACTIVITY, listClasses } from '@/modules/foundation/class-definition';
import Classes from './Classes';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/classes';

/**
 * Classes for classification (SCR-058 / CL02; inert in stage 1, live
 * since stage 3).
 */
export default async function ClassesPage() {
  const session = await requireSession(ROUTE);
  const loaded = await listClasses(session.user.client);
  const choices = {
    ...loaded,
    classTypes: loaded.classTypes.filter((row) => row.classType !== '022' && row.classType !== '023'),
    classes: loaded.classes.filter((row) => row.classType !== '022' && row.classType !== '023'),
  };

  return (
    <Page
      title={t('classificationClass.title')} code="CFG.PROC.CLASS.DEFINE · CL02" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('classificationClass.subtitle')}</p>
          <p className="max-w-3xl text-sm text-ink-soft">
              OCHA is not this screen. A class assigns a characteristic. It does not store a batch value.
              Batch class types 022 and 023 are not this screen. They are BMC1, and the type comes from the batch level.
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

      <Classes data={choices} canMaintain={can(session, ACTIVITY)} />
    </Page>
  );
}
