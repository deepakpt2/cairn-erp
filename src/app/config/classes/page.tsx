import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ACTIVITY, listClasses } from '@/modules/foundation/class-definition';
import Classes from './Classes';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/classes';

/**
 * Classes for classification (SCR-058 / CL02; inert in stage 1, live
 * since stage 3).
 */
export default async function ClassesPage() {
  const session = await requireSession(ROUTE);
  const choices = await listClasses(session.user.client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">CFG.PROC.CLASS.DEFINE · CL02</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('classificationClass.title')}</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.workbench')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('classificationClass.subtitle')}</p>
      </header>

      <Classes data={choices} canMaintain={can(session, ACTIVITY)} />
    </div>
  );
}
