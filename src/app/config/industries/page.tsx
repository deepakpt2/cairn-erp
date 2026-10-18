import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { ACTIVITY, listIndustries } from '@/modules/foundation/industry-definition';
import { t } from '@/platform/i18n';
import Industries from './Industries';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/industries';

/**
 * Maintain industries (SCR-077 / OB44 as a search alias only).
 *
 * The industry master the business partner classifies under, with
 * descriptions by configured language: delivered standard industries
 * per tenant, maintained here in the standing master shape.
 */
export default async function IndustriesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const industries = await listIndustries(session.user.client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OB44</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('industry.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('industry.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <Industries industries={industries} canMaintain={canMaintain} />
    </div>
  );
}
