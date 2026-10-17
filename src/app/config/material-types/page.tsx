import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import MaterialTypes from './MaterialTypes';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/material-types';
const ACTIVITY = 'CFG.INV.MATERIALTYPE.DEFINE';

/**
 * Material type definition (SCR-048 / OMS2; inert since stage 1).
 *
 * The master-detail shape the master-data screens share: the tenant's
 * material types in a grid, a detail panel per type, the account
 * category references those types are judged against, and the
 * quantity/value updating rows per plant. The material type table
 * already stands from the materials build — this screen is where it
 * gains its missing definition fields and its maintenance service.
 */
export default async function MaterialTypesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMS2</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('materialType.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('materialType.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <MaterialTypes canMaintain={canMaintain} />
    </div>
  );
}
