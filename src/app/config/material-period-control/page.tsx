import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listMaterialPeriodControl,
} from '@/modules/inventory/material-period-control';
import { t } from '@/platform/i18n';
import MaterialPeriodControl from './MaterialPeriodControl';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/material-period-control';

/**
 * Material period control (SCR-054 / OMSY; inert since stage 1).
 *
 * The MM period gate per company code: the current and previous
 * material posting periods and their backposting indicators, with the
 * initialize, indicator and shift acts (SCR-054, live since stage 3).
 */
export default async function MaterialPeriodControlPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const rows = await listMaterialPeriodControl(session.user.client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMSY</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('materialPeriod.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('materialPeriod.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <MaterialPeriodControl rows={rows} canMaintain={canMaintain} />
    </div>
  );
}
