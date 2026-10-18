import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import Characteristics from './Characteristics';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/characteristics';

/**
 * Characteristics for classification (SCR-057 / CT04; inert since
 * stage 1). The vocabulary release strategies will judge by
 * (SCR-057 stage 3 wires the acts).
 */
export default async function CharacteristicsPage() {
  await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">CFG.PROC.CHARACTERISTIC.DEFINE · CT04</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('characteristic.title')}</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.workbench')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('characteristic.subtitle')}</p>
      </header>

      <Characteristics />
    </div>
  );
}
