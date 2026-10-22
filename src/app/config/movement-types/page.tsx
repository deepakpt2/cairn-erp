import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listMovementTypes,
} from '@/modules/inventory/movement-type-configuration';
import { t } from '@/platform/i18n';
import MovementTypes from './MovementTypes';

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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMJJ</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('movementType.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('movementType.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <MovementTypes movements={movements} canMaintain={canMaintain} />
    </div>
  );
}
