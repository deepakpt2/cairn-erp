
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  listNumberRangeObjects,
  NUMBER_RANGE_ACTIVITY,
} from '@/modules/foundation/number-ranges';
import NumberRangeObjects from './NumberRangeObjects';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/number-range-objects';

/**
 * Number range objects (SCR-050 / SNRO; inert since stage 1).
 *
 * The object view over the standing interval screen: every object the
 * applications number from, with its description, number length,
 * warning threshold and year relevance. Object names belong to the
 * application — this screen maintains their facts and, beside it, the
 * intervals the existing number-ranges screen already owns.
 */
export default async function NumberRangeObjectsPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, NUMBER_RANGE_ACTIVITY);
  const objects = await listNumberRangeObjects(session.user.client);

  return (
    <Page
      title={t('nrObject.title')} code={<>{NUMBER_RANGE_ACTIVITY} · SNRO</>} back={null}
      description={t('nrObject.subtitle')}
      actions={
        <>
          <LinkButton href="/config/number-ranges">
                        Number range intervals
                      </LinkButton>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: NUMBER_RANGE_ACTIVITY })}
        </p>
      )}

      <NumberRangeObjects objects={objects} canMaintain={canMaintain} />
    </Page>
  );
}
