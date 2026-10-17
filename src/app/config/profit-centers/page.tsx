import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listCostCenterAreas,
  listProfitCenters,
  listResponsibleUsers,
} from '@/modules/foundation/profit-center-definition';
import ProfitCenters from './ProfitCenters';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/profit-centers';

/**
 * Profit centre definition (SCR-045 / KE51; inert since stage 1).
 *
 * The master-detail shape shared with the controlling masters: a
 * controlling-area selector over the tenant's areas, then that area's
 * profit centres one row per validity period. Hierarchy placement
 * arrives with the profit centre hierarchy activity, as it did for
 * cost centres; the segment is free text until a segment master stands.
 */
export default async function ProfitCentersPage({
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
  const [rows, users] = await Promise.all([
    listProfitCenters(client, selectedArea),
    listResponsibleUsers(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · KE51</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('profitCenter.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('profitCenter.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <ProfitCenters areas={areas} selectedArea={selectedArea} rows={rows} users={users} />
    </div>
  );
}
