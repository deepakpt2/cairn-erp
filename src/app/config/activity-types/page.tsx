import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  ACTIVITY_CATEGORIES,
  COST_CENTER_CATEGORIES,
  PRICE_INDICATORS,
  listActivityTypes,
  listActivityUnits,
  listCostCenterAreas,
} from '@/modules/foundation/activity-type-definition';
import ActivityTypes from './ActivityTypes';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/activity-types';

/**
 * Activity type definition (SCR-043 / KL01; inert since stage 1).
 *
 * The master-detail shape: a controlling-area selector over the tenant's
 * areas, then that area's activity types one row per validity period.
 * Rates per cost centre and period follow as SCR-044; nothing prices or
 * allocates against these rows yet.
 */
export default async function ActivityTypesPage({
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
  const [rows, units] = await Promise.all([
    listActivityTypes(client, selectedArea),
    listActivityUnits(),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · KL01</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('actType.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('actType.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <ActivityTypes
        areas={areas}
        selectedArea={selectedArea}
        rows={rows}
        units={units}
        categories={ACTIVITY_CATEGORIES}
        priceIndicators={PRICE_INDICATORS}
        ccCategories={COST_CENTER_CATEGORIES}
        canMaintain={canMaintain}
      />
    </div>
  );
}
