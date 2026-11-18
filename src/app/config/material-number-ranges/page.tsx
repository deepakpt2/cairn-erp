
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listMaterialNumberRangeGroups,
} from '@/modules/inventory/material-number-range-groups';
import { t } from '@/platform/i18n';
import MaterialNumberRanges from './MaterialNumberRanges';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/material-number-ranges';

/**
 * Material number range groups (SCR-051 / MMNR; live since stage 3).
 *
 * The group view over the standing number-range engine: MATERIALNR
 * intervals grouped as named internal+external pairs, the pairs material
 * types are assigned by. Intervals themselves are maintained on the
 * number range screens; this screen maintains the groups.
 */
export default async function MaterialNumberRangesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const { groups, ungrouped } = await listMaterialNumberRangeGroups(session.user.client);

  return (
    <Page
      title={t('materialRange.title')} code={<>{ACTIVITY} · MMNR</>} back={null}
      description={t('materialRange.subtitle')}
      actions={
        <>
          <LinkButton href="/config/number-ranges">
                        Number range intervals
                      </LinkButton>
          <LinkButton href="/config/material-types">
                        Material types
                      </LinkButton>
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

      <MaterialNumberRanges groups={groups} ungrouped={ungrouped} canMaintain={canMaintain} />
    </Page>
  );
}
