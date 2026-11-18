
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { MIGO_CAPABILITY, MIGO_ROUTE, MIGO_ALIAS } from '@/modules/inventory/migo';
import MigoShell from './MigoShell';
import { Page } from '@/ui/kit';

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
    <Page
      title={t('migo.title')} code={<>{MIGO_CAPABILITY} · {MIGO_ALIAS}</>} back={{ href: '/', label: t('nav.launchpad') }}
      description={t('migo.subtitle')}
    >

      <MigoShell canPost={can(session, MIGO_CAPABILITY)} today={today} />
    </Page>
  );
}
