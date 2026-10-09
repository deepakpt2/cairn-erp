import Link from 'next/link';
import { t } from '@/platform/i18n';
import { listCompanyCodes } from '@/modules/foundation/services';
import { requireSession } from '@/platform/auth/current';

export const dynamic = 'force-dynamic';

/**
 * Company codes — CFG.ORG.COMPANYCODE.DEFINE
 *
 * Shows the assigned configuration resolved, not just the keys. A user checking
 * their implementation plan wants to see that the company code actually points at
 * the chart of accounts and variants they intended, not that some code exists.
 */
export default async function CompanyCodesPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const session = await requireSession('/config/company-codes');
  const client = session.user.client;
  const companies = await listCompanyCodes(client);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">CFG.ORG.COMPANYCODE.DEFINE</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('cc.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('cc.subtitle')}</p>
      </header>

      {companies.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-soft">
          No company codes in tenant {client}.
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-28">{t('cc.code')}</th>
                <th>{t('cc.name')}</th>
                <th className="w-24">{t('cc.currency')}</th>
                <th className="w-20">{t('cc.country')}</th>
                <th className="w-28">{t('cc.coa')}</th>
                <th className="w-20">{t('cc.fyv')}</th>
                <th className="w-20">{t('cc.ppv')}</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.companyCode}>
                  <td className="code font-semibold">{company.companyCode}</td>
                  <td className="font-medium">{company.name}</td>
                  <td className="code">{company.currency}</td>
                  <td className="code">{company.country}</td>
                  <td className="code text-ink-soft">{company.chartOfAccounts}</td>
                  <td className="code text-ink-soft">{company.fiscalYearVariant}</td>
                  <td className="code text-ink-soft">{company.postingPeriodVariant}</td>
                  <td className="text-end">
                    <Link
                      href={`/config/posting-periods?company=${company.companyCode}`}
                      className="text-accent hover:underline"
                    >
                      {t('pp.title')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-2xs text-ink-faint">
        Configuration is tenant-wide, not per company code: a second company code inherits the
        chart of accounts and defines only what is specific to it. That is why adding a company
        is quick.
      </p>
    </div>
  );
}
