import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { GL_BALANCE_CAPABILITY } from '@/modules/finance/gl-balances';
import BalancesForm from './BalancesForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/journal/balances';

/**
 * G/L account balances by period (SCR-089 / FS10N as a search
 * alias only). Stage 1 shell: derivation lands in stage 3 of R-137.
 */
export default async function GlBalancesPage() {
  const session = await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.GL.BALANCE · FS10N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('glBalance.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('glBalance.subtitle')}</p>
      </header>

      <BalancesForm view={null} error={null} canDisplay={can(session, GL_BALANCE_CAPABILITY)} />
    </div>
  );
}
