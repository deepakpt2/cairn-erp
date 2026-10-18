import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { SPECIAL_GL_ACTIVITY, listSpecialGlConfigs } from '@/modules/foundation/special-gl';
import { SpecialGl } from './SpecialGl';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/special-gl';

/**
 * Special G/L indicator configuration (SCR-081; OBXR/OBYR as search aliases only).
 */
export default async function SpecialGlPage() {
  const session = await requireSession(ROUTE);
  const rows = await listSpecialGlConfigs(session.user.client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{SPECIAL_GL_ACTIVITY} · OBXR</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('specialGl.title')}</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.workbench')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('specialGl.subtitle')}</p>
      </header>

      <SpecialGl rows={rows} canMaintain={can(session, SPECIAL_GL_ACTIVITY)} />
    </div>
  );
}
