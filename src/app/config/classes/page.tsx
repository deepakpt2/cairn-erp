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
  const loaded = await listClasses(session.user.client);
  const choices = {
    ...loaded,
    classTypes: loaded.classTypes.filter((row) => row.classType !== '022' && row.classType !== '023'),
    classes: loaded.classes.filter((row) => row.classType !== '022' && row.classType !== '023'),
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">CFG.PROC.CLASS.DEFINE · CL02</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('classificationClass.title')}</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.workbench')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('classificationClass.subtitle')}</p>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OCHA is not this screen. A class assigns a characteristic. It does not store a batch value.
          Batch class types 022 and 023 are not this screen. They are BMC1, and the type comes from the batch level.
        </p>
      </header>

      <Classes data={choices} canMaintain={can(session, ACTIVITY)} />
    </div>
  );
}
