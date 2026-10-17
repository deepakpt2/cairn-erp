import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listCostCenterAreas,
  listHierarchy,
} from '@/modules/foundation/cost-center-hierarchy';
import CostCenterHierarchy from './CostCenterHierarchy';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/cost-center-hierarchy';

/**
 * Cost centre hierarchy (SCR-042 / KSH1 · OKEON).
 *
 * The standard hierarchy is the area's one tree, with cost centre periods
 * placed into nodes; alternative groups stand beside it, resolved from
 * their leaves. Rollups do not read either structure yet.
 */
export default async function CostCenterHierarchyPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const areas = await listCostCenterAreas(client);
  const selectedArea =
    params.area !== undefined && params.area !== ''
      ? params.area
      : (areas[0]?.controllingArea ?? '');
  const view = await listHierarchy(client, selectedArea);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · KSH1/OKEON</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('costHierarchy.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('costHierarchy.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <CostCenterHierarchy areas={areas} selectedArea={selectedArea} view={view} />
    </div>
  );
}
