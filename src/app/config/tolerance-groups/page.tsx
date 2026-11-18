
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listEmployeeToleranceGroups,
  listToleranceCompanies,
} from '@/modules/foundation/employee-tolerance-definition';
import { ToleranceGroups } from './ToleranceGroups';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/tolerance-groups';

/**
 * OBA4 Define Employee Tolerance Groups (SCR-039; inert since stage 1).
 *
 * Nothing delivers tolerance groups and nothing enforces them yet: a tenant
 * that has never opened this screen has no posting ceilings at all. The
 * registry starts empty by design, and the screen says posting does not
 * read it until that work lands.
 */
export default async function ToleranceGroupsPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, companies] = await Promise.all([
    listEmployeeToleranceGroups(client),
    listToleranceCompanies(client),
  ]);

  return (
    <Page
      title={t('tolGroup.title')} code={<>{ACTIVITY} · OBA4</>} back={null}
      description={t('tolGroup.subtitle')}
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

      <ToleranceGroups rows={rows} companies={companies} canMaintain={canMaintain} />
    </Page>
  );
}
