import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listEmployeeToleranceGroups,
  listToleranceCompanies,
} from '@/modules/foundation/employee-tolerance-definition';
import { ToleranceGroups } from './ToleranceGroups';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/tolerance-groups';

/**
 * OBA4 Define Employee Tolerance Groups (SCR-039; inert since stage 1).
 *
 * Nothing delivers tolerance groups and nothing enforces them yet: a tenant
 * that has never opened this screen has no posting ceilings at all. The
 * registry starts empty by design, and the screen says posting does not
 * read it until that work lands.
 */
export default async function ToleranceGroupsPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, companies] = await Promise.all([
    listEmployeeToleranceGroups(client),
    listToleranceCompanies(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OBA4</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('tolGroup.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('tolGroup.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <ToleranceGroups rows={rows} companies={companies} canMaintain={canMaintain} />
    </div>
  );
}
