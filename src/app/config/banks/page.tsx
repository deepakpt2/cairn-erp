import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  CAPABILITY,
  listBankCountryChoices,
  listBanks,
} from '@/modules/foundation/bank-master';
import { Banks } from './Banks';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/banks';

/**
 * Bank master (SCR-036; live since stage 3). Reference alias FI01.
 *
 * Banks are global reference data — one row per bank, shared by every tenant —
 * because house banks (FI12, SCR-037) name a bank by country and key and read its
 * name, city and SWIFT code as facts they do not own. This screen is where those
 * facts are defined; it is gated by a capability rather than a configuration
 * activity, since shared reference data is no tenant's configuration progress.
 */
export default async function BanksPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, CAPABILITY);

  const [banks, countries] = await Promise.all([
    listBanks(client),
    listBankCountryChoices(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CAPABILITY} · FI01</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('bank.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('bank.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: CAPABILITY })}
        </p>
      )}

      <Banks banks={banks} countries={countries} canMaintain={canMaintain} />
    </div>
  );
}
