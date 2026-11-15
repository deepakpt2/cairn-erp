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
import { ACTIVITY_PRICE_CAPABILITY, ActivityPriceError, listCalculableActivities } from '@/modules/foundation/activity-price';
import ActivityRates from './ActivityRates';
import { PricePanel } from './PricePanel';
import { randomUUID } from 'node:crypto';

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
  // KSPI: the price calculation panel, for holders of its own capability. What a run over the year
  // would do is shown before anything is pressed; a refusal of the listing is shown as text.
  const canCalculate = can(session, ACTIVITY_PRICE_CAPABILITY);
  let planned: Awaited<ReturnType<typeof listCalculableActivities>> = null;
  let plannedProblem: string | null = null;
  if (canCalculate && area && context) {
    try {
      planned = await listCalculableActivities(
        { client, controllingArea: area, fiscalYear, planVersion: version },
        { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
      );
    } catch (error) {
      if (!(error instanceof ActivityPriceError)) throw error;
      plannedProblem = `${error.message}${error.remedy ? ` ${error.remedy}` : ''}`;
    }
  }
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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
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

      {canCalculate && area && context && (plannedProblem ? (
        <p role="status" className="panel p-4 text-sm text-signal-error">{plannedProblem}</p>
      ) : (
        <PricePanel
          selection={{ controllingArea: area, fiscalYear, planVersion: version }}
          periods={context.periods.filter((p) => p.periodType === 'REGULAR').map((p) => p.period)}
          currency={context.currency}
          planned={planned?.pairs ?? []}
          defaultRange={planned ? { periodFrom: planned.periodFrom, periodTo: planned.periodTo } : null}
          requestKey={randomUUID()}
        />
      ))}
    </div>
  );
}
