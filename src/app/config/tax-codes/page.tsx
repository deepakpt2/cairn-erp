import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listCountryChoices,
  listTaxCodes,
} from '@/modules/foundation/tax-code-definition';
import { TaxCodes } from './TaxCodes';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/tax-codes';

/**
 * FTXP Define Tax Codes for Sales and Purchases (SCR-035 stage 1: the screen).
 *
 * The activity has routed here since the seed with no screen behind the route, and
 * journal lines have carried a tax code as free text for just as long: this screen
 * is where the codes get defined — per country, with the rate and the condition and
 * account keys a posting rule reads. The table arrives with the migration in
 * stage 2 and the write path with the service in stage 3; until then the forms are
 * inert and say so.
 */
export default async function TaxCodesPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);

  const [rows, countries] = await Promise.all([
    listTaxCodes(client),
    listCountryChoices(client),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · FTXP</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('taxCode.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
            <Link href="/config/company-codes" className="btn btn-default min-h-11 sm:min-h-8">
              {t('taxCode.companyCodesLink')}
            </Link>
            <Link href="/config/gl-accounts" className="btn btn-default min-h-11 sm:min-h-8">
              {t('taxCode.glAccountsLink')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('taxCode.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <TaxCodes rows={rows} countries={countries} canMaintain={canMaintain} />
    </div>
  );
}
