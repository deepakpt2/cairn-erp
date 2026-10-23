import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listTypeReferences,
  listValuationClasses,
  listValuationGaps,
  listValuationReferences,
} from '@/modules/inventory/valuation-class-definition';
import { t } from '@/platform/i18n';
import ValuationClasses from './ValuationClasses';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/valuation-classes';

/**
 * Valuation classes. OMSK is a search alias only.
 * The masters already stand. This screen maintains the reference, the
 * class, and which classes a reference permits. It does not post, and a
 * closed period does not block it.
 */
export default async function ValuationClassesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const client = session.user.client;
  const [references, classes, types, gaps] = await Promise.all([
    listValuationReferences(client),
    listValuationClasses(client),
    listTypeReferences(client),
    listValuationGaps(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMSK</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('valuationClass.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config/material-types" className="btn btn-default min-h-11 sm:min-h-8">
              Material types
            </Link>
            <Link href="/config/account-determination" className="btn btn-default min-h-11 sm:min-h-8">
              Account determination
            </Link>
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('valuationClass.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <ValuationClasses
        references={references}
        classes={classes}
        types={types}
        gaps={gaps}
        canMaintain={canMaintain}
      />
    </div>
  );
}
