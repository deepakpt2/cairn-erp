
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listMovementTypes,
} from '@/modules/inventory/movement-type-configuration';
import { t } from '@/platform/i18n';
import MovementTypes from './MovementTypes';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/movement-types';

/**
 * Movement type configuration. OMJJ is a search alias only.
 * The catalogue already stands; this screen maintains that row.
 * It does not post stock or a journal, and a closed period does not block it.
 */
export default async function MovementTypesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const movements = await listMovementTypes(session.user.client);

  return (
    <Page
      title={t('movementType.title')} code={<>{ACTIVITY} · OMJJ</>} back={null}
      description={t('movementType.subtitle')}
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

      <MovementTypes movements={movements} canMaintain={canMaintain} />
    </Page>
  );
}
