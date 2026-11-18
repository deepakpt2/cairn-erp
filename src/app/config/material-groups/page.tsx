
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listMaterialGroups,
} from '@/modules/inventory/material-group-definition';
import { t } from '@/platform/i18n';
import MaterialGroups from './MaterialGroups';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/material-groups';

/**
 * Material group definition (SCR-049 / OMSF; inert since stage 1).
 *
 * The grid the master-data screens share: the tenant's material groups
 * with their descriptions, kept for classification — procurement,
 * reporting and search — and nothing else. The material group table
 * already stands from the materials build; this screen is where it
 * gains its maintenance service.
 */
export default async function MaterialGroupsPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const groups = await listMaterialGroups(session.user.client);

  return (
    <Page
      title={t('materialGroup.title')} code={<>{ACTIVITY} · OMSF</>} back={null}
      description={t('materialGroup.subtitle')}
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

      <MaterialGroups groups={groups} canMaintain={canMaintain} />
    </Page>
  );
}
