import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  POSTING_EVENTS,
  listAccountDeterminations,
  listDeterminationCharts,
  listDeterminationValuationClasses,
  listGlAccountChoices,
} from '@/modules/foundation/account-determination';
import { AccountDetermination } from './AccountDetermination';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/account-determination';

/**
 * OBYC Define Account Determination (SCR-040; inert since stage 1).
 *
 * The spine of logistics-to-accounting integration, in the product's own
 * event vocabulary: the reference transaction keys are search aliases and
 * never stored (R-89). Nothing derives accounts from these rows yet, and
 * the screen says so.
 */
export default async function AccountDeterminationPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, charts, valuationClasses, glChoices] = await Promise.all([
    listAccountDeterminations(client),
    listDeterminationCharts(client),
    listDeterminationValuationClasses(client),
    listGlAccountChoices(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OBYC</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('acctDet.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
            <Link href="/config/chart-of-accounts" className="btn btn-default min-h-11 sm:min-h-8">
              {t('acctDet.chartsLink')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('acctDet.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <AccountDetermination
        rows={rows}
        charts={charts}
        valuationClasses={valuationClasses}
        glChoices={glChoices}
        events={POSTING_EVENTS}
        canMaintain={canMaintain}
      />
    </div>
  );
}
