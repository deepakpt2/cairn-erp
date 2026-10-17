import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listBankChoices,
  listHouseBankCompanies,
  listHouseBanks,
} from '@/modules/foundation/house-bank-definition';
import { HouseBanks } from './HouseBanks';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/house-banks';

/**
 * FI12 Define House Banks (SCR-037 stage 1: the screen).
 *
 * A house bank is the tenant's own bank inside a company code; the accounts
 * under it carry the numbers money actually moves through. The bank it names
 * is defined once in the global bank master (SCR-036) and read from there —
 * this screen maintains the tenant's reference to it, never its facts.
 */
export default async function HouseBanksPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [houseBanks, companies, banks] = await Promise.all([
    listHouseBanks(client),
    listHouseBankCompanies(client),
    listBankChoices(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · FI12</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('houseBank.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
            <Link href="/config/banks" className="btn btn-default min-h-11 sm:min-h-8">
              {t('houseBank.banksLink')}
            </Link>
            <Link href="/config/company-codes" className="btn btn-default min-h-11 sm:min-h-8">
              {t('houseBank.companyCodesLink')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('houseBank.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <HouseBanks
        houseBanks={houseBanks}
        companies={companies}
        banks={banks}
        canMaintain={canMaintain}
      />
    </div>
  );
}
