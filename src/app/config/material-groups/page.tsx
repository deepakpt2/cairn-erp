import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listMaterialGroups,
} from '@/modules/inventory/material-group-definition';
import { t } from '@/platform/i18n';
import MaterialGroups from './MaterialGroups';

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
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMSF</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('materialGroup.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('materialGroup.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <MaterialGroups groups={groups} canMaintain={canMaintain} />
    </div>
  );
}
