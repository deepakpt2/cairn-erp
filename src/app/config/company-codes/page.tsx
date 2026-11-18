import Link from 'next/link';
import { and, asc, eq } from 'drizzle-orm';
import { t } from '@/platform/i18n';
import { listCompanyCodes } from '@/modules/foundation/services';
import { chartOfAccounts as chartOfAccountsTable } from '@/modules/foundation/schema';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { country as countryReference, currency as currencyReference } from '@/platform/tables/reference';
import { CompanyCodeCoaAssignmentForm, type ChartOfAccountsChoice } from './CompanyCodeCoaAssignmentForm';
import { CompanyCodeDefinitionForm } from './CompanyCodeDefinitionForm';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const COMPANY_CODE_DEFINE = 'CFG.ORG.COMPANYCODE.DEFINE';
const COMPANY_CODE_ASSIGN_COA = 'CFG.ORG.COMPANYCODE.ASSIGN_COA';

/** Company Codes remain readable; definition and CoA assignment use separate authorities. */
export default async function CompanyCodesPage() {
  const session = await requireSession('/config/company-codes');
  const client = session.user.client;
  const canDefine = can(session, COMPANY_CODE_DEFINE);
  const canAssign = can(session, COMPANY_CODE_ASSIGN_COA);
  const companies = await listCompanyCodes(client);
  const hasUnassignedCoa = companies.some((company) => !company.chartOfAccounts);

  const references = canDefine
    ? await withTenant(client, async (tx) => ({
        countries: await tx
          .select({ code: countryReference.code, name: countryReference.name })
          .from(countryReference)
          .orderBy(asc(countryReference.code)),
        currencies: (await tx
          .select({ code: currencyReference.code, name: currencyReference.name })
          .from(currencyReference)
          .where(eq(currencyReference.isActive, true))
          .orderBy(asc(currencyReference.code))).map((row) => ({ ...row, code: row.code.trim() })),
      }))
    : null;

  // Never expose CoA choices to users without the separate assignment authority.
  const chartChoices: ChartOfAccountsChoice[] = canAssign && hasUnassignedCoa
    ? await withTenant(client, async (tx) =>
        tx
          .select({ code: chartOfAccountsTable.chartOfAccounts, name: chartOfAccountsTable.name })
          .from(chartOfAccountsTable)
          .where(and(
            eq(chartOfAccountsTable.client, client),
            eq(chartOfAccountsTable.isActive, true),
            eq(chartOfAccountsTable.isBlocked, false),
          ))
          .orderBy(asc(chartOfAccountsTable.chartOfAccounts)),
      )
    : [];

  return (
    <Page
      title={t('cc.title')}
      width="5xl"
      back={null}
      code={
        <>
          {canDefine && <span className="mr-3">{COMPANY_CODE_DEFINE}</span>}
          {canAssign && <span className="mr-3">{COMPANY_CODE_ASSIGN_COA}</span>}
          {!canDefine && !canAssign && <span>{COMPANY_CODE_DEFINE}</span>}
        </>
      }
      description={t('cc.subtitle')}
      actions={
        <>
          <LinkButton href="/config/fiscal-year-variants/assign-company-codes">{t('cc.assignFiscalYearVariant')}</LinkButton>
          <LinkButton href="/config/company-codes/assign-chart-of-accounts">{t('cc.assignCoaScreen')}</LinkButton>
        </>
      }
    >

      {canDefine && references && (
        <CompanyCodeDefinitionForm
          countries={references.countries}
          currencies={references.currencies}
        />
      )}
      {!canDefine && (
        <p className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: COMPANY_CODE_DEFINE })}
        </p>
      )}
      {!canAssign && hasUnassignedCoa && (
        <p className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: COMPANY_CODE_ASSIGN_COA })}
        </p>
      )}
      {canAssign && hasUnassignedCoa && chartChoices.length === 0 && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('cc.noActiveCharts')}
        </p>
      )}
      {canAssign && hasUnassignedCoa && chartChoices.length > 0 && (
        <p className="text-sm text-ink-soft">{t('cc.initialCoaNote')}</p>
      )}

      {companies.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-soft">
          No company codes in tenant {client}.
        </div>
      ) : (
        <div className="panel overflow-x-auto">
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
                <th className="min-w-72">{t('cc.assignCoa')}</th>
                <th className="w-32">{t('pp.title')}</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.companyCode}>
                  <td className="code font-semibold">{company.companyCode}</td>
                  <td className="font-medium">{company.name}</td>
                  <td className="code">{company.currency}</td>
                  <td className="code">{company.country}</td>
                  <td className="code text-ink-soft">{company.chartOfAccounts ?? t('cc.unassigned')}</td>
                  <td className="code text-ink-soft">{company.fiscalYearVariant ?? t('cc.unassigned')}</td>
                  <td className="code text-ink-soft">{company.postingPeriodVariant ?? t('cc.unassigned')}</td>
                  <td>
                    {canAssign && !company.chartOfAccounts && chartChoices.length > 0 ? (
                      <CompanyCodeCoaAssignmentForm
                        companyCode={company.companyCode}
                        charts={chartChoices}
                      />
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="text-end">
                    {company.chartOfAccounts && company.fiscalYearVariant && company.postingPeriodVariant ? (
                      <Link
                        href={`/config/posting-periods?company=${encodeURIComponent(company.companyCode)}`}
                        className="text-accent hover:underline"
                      >
                        {t('pp.title')}
                      </Link>
                    ) : (
                      <span className="text-ink-faint">{t('cc.assignmentsPending')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-2xs text-ink-faint">{t('cc.inheritNote')}</p>
    </Page>
  );
}
