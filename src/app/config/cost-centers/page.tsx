import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  COST_CENTER_CATEGORIES,
  listAreaCompanyCodes,
  listCostCenterAreas,
  listCostCenters,
} from '@/modules/foundation/cost-center-definition';
import CostCenters from './CostCenters';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/cost-centers';

/**
 * Cost centre definition (SCR-041 / KS01).
 *
 * The master-detail shape: a controlling-area selector over the tenant's
 * areas, then that area's cost centres one row per validity period. The
 * hierarchy that groups centres for reporting follows as SCR-042; postings
 * carry centre codes as text and do not validate them yet.
 */
export default async function CostCentersPage({
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
  const [rows, companyCodes] = await Promise.all([
    listCostCenters(client, selectedArea),
    listAreaCompanyCodes(client, selectedArea),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · KS01</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('costCenter.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('costCenter.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <CostCenters
        areas={areas}
        selectedArea={selectedArea}
        rows={rows}
        companyCodes={companyCodes}
        categories={COST_CENTER_CATEGORIES}
        canMaintain={canMaintain}
      />
    </div>
  );
}
