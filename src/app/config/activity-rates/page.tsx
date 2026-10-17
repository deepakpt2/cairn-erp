import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  distinctCenters,
  distinctTypes,
  listActivityRates,
  listActivityTypes,
  listCostCenterAreas,
  listCostCenters,
  planningContext,
} from '@/modules/foundation/activity-rate-definition';
import ActivityRates from './ActivityRates';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/activity-rates';

/**
 * Activity rate planning (SCR-044 / KP26; inert since stage 1).
 *
 * The matrix shape: controlling area, planning version and fiscal year
 * over a cost centre and activity type, then one row per fiscal period
 * the area's variant defines for that year, carrying the planned
 * quantity and the fixed and variable price components per price unit.
 */
export default async function ActivityRatesPage({
  searchParams,
}: {
  searchParams: Promise<{
    area?: string;
    version?: string;
    year?: string;
    center?: string;
    type?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const areas = await listCostCenterAreas(client);
  const area =
    params.area !== undefined && params.area !== ''
      ? params.area
      : (areas[0]?.controllingArea ?? '');
  const version = (params.version ?? '000').toUpperCase();
  const yearText = params.year ?? String(new Date().getUTCFullYear());
  const fiscalYear = /^\d{4}$/.test(yearText) ? Number(yearText) : new Date().getUTCFullYear();
  const center = params.center ?? '';
  const type = params.type ?? '';

  const [centers, types, context] = await Promise.all([
    listCostCenters(client, area),
    listActivityTypes(client, area),
    planningContext(client, area, fiscalYear),
  ]);
  const rates =
    center !== '' && type !== ''
      ? await listActivityRates(client, {
          controllingArea: area,
          planVersion: version,
          fiscalYear,
          costCenter: center,
          activityType: type,
        })
      : [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · KP26</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('actRate.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('actRate.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <ActivityRates
        areas={areas}
        selection={{ area, version, year: yearText, center, type }}
        centers={distinctCenters(centers)}
        types={distinctTypes(types)}
        context={context}
        rates={rates}
        canMaintain={canMaintain}
      />
    </div>
  );
}
