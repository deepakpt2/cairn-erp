import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import IndustrySectors from './IndustrySectors';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/industry-sectors';
const ACTIVITY = 'CFG.INV.INDUSTRYSECTOR.DEFINE';

/**
 * Industry sector definition (SCR-052 / OMS3; inert since stage 1).
 *
 * The sector master the material master judges against: delivered
 * standard sectors per tenant, maintained here in the standing master
 * shape. The table and service land in the following stages.
 */
export default async function IndustrySectorsPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OMS3</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('industrySector.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('industrySector.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <IndustrySectors sectors={[]} />
    </div>
  );
}
