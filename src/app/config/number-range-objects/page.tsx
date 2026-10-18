import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  listNumberRangeObjects,
  NUMBER_RANGE_ACTIVITY,
} from '@/modules/foundation/number-ranges';
import NumberRangeObjects from './NumberRangeObjects';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/number-range-objects';

/**
 * Number range objects (SCR-050 / SNRO; inert since stage 1).
 *
 * The object view over the standing interval screen: every object the
 * applications number from, with its description, number length,
 * warning threshold and year relevance. Object names belong to the
 * application — this screen maintains their facts and, beside it, the
 * intervals the existing number-ranges screen already owns.
 */
export default async function NumberRangeObjectsPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, NUMBER_RANGE_ACTIVITY);
  const objects = await listNumberRangeObjects(session.user.client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{NUMBER_RANGE_ACTIVITY} · SNRO</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('nrObject.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config/number-ranges" className="btn btn-default min-h-11 sm:min-h-8">
              Number range intervals
            </Link>
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('nrObject.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: NUMBER_RANGE_ACTIVITY })}
        </p>
      )}

      <NumberRangeObjects objects={objects} canMaintain={canMaintain} />
    </div>
  );
}
