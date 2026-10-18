import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listPostingPeriodVariantAssignments,
} from '@/modules/foundation/posting-period-variant-assignment';
import { listPostingPeriodVariants } from '@/modules/foundation/posting-period-variant-definition';
import { PostingPeriodVariantAssignments } from './PostingPeriodVariantAssignments';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/posting-period-variants/assign-company-codes';

/**
 * OBBP Assign Company Code to Posting Period Variant (SCR-033 stage 1: the screen).
 *
 * A distinct activity from OBBO, which defines the variants: this one writes the
 * Company Code, so it shows every Company Code with the variant it posts against
 * and lets the assignment be made here — the journey the OBBO deletion remedy has
 * been pointing at.
 */
export default async function AssignPostingPeriodVariantPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, variants] = await Promise.all([
    listPostingPeriodVariantAssignments(client),
    listPostingPeriodVariants(client),
  ]);
  const choices = variants.map((row) => ({ variant: row.variant, name: row.name }));

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OBBP</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('ppvAssign.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
            <Link href="/config/posting-period-variants" className="btn btn-default min-h-11 sm:min-h-8">
              {t('ppvAssign.defineLink')}
            </Link>
            <Link href="/config/company-codes" className="btn btn-default min-h-11 sm:min-h-8">
              {t('ppvAssign.companyCodesLink')}
            </Link>
            <Link href="/config/posting-periods" className="btn btn-default min-h-11 sm:min-h-8">
              {t('ppvAssign.postingPeriodsLink')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('ppvAssign.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <PostingPeriodVariantAssignments rows={rows} choices={choices} canMaintain={canMaintain} />
    </div>
  );
}
