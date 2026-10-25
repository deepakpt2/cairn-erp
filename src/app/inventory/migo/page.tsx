import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { MIGO_CAPABILITY, MIGO_ROUTE, MIGO_ALIAS } from '@/modules/inventory/migo';
import MigoShell from './MigoShell';

export const dynamic = 'force-dynamic';

/**
 * MIGO — one screen, an action and a reference document type — SCR-139 / INV.MIGO.POST
 * (MIGO as a search alias only).
 *
 * The screen carries SAP's whole action/reference vocabulary and resolves every cell to
 * posts-here, delivered-elsewhere or refused-by-name. This round's posting cell is
 * A07 + R08: the 261 component issue against a released or technically completed
 * production order. A created order is still refused. Technical completion does
 * not copy the closed-order ban.
 */
export default async function MigoPage() {
  const session = await requireSession(MIGO_ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{MIGO_CAPABILITY} · {MIGO_ALIAS}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('migo.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('migo.subtitle')}</p>
      </header>

      <MigoShell canPost={can(session, MIGO_CAPABILITY)} today={today} />
    </div>
  );
}
