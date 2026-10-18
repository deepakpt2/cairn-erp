import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import MaterialNumberRanges from './MaterialNumberRanges';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/material-number-ranges';
const MATERIAL_RANGE_ACTIVITY = 'CFG.INV.MATERIALRANGE.DEFINE';

/**
 * Material number range groups (SCR-051 / MMNR; inert since stage 1).
 *
 * The group view over the standing number-range engine: MATERIALNR
 * intervals grouped as named internal+external pairs, the pairs material
 * types are assigned by. Intervals themselves are maintained on the
 * number range screens; this screen maintains the groups.
 */
export default async function MaterialNumberRangesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, MATERIAL_RANGE_ACTIVITY);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{MATERIAL_RANGE_ACTIVITY} · MMNR</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('materialRange.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config/number-ranges" className="btn btn-default min-h-11 sm:min-h-8">
              Number range intervals
            </Link>
            <Link href="/config/material-types" className="btn btn-default min-h-11 sm:min-h-8">
              Material types
            </Link>
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('materialRange.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: MATERIAL_RANGE_ACTIVITY })}
        </p>
      )}

      <MaterialNumberRanges groups={[]} ungrouped={[]} />
    </div>
  );
}
