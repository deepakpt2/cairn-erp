import Link from 'next/link';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { companyCode, salesOrg, salesOrgText } from '@/modules/foundation/schema';
import { SalesOrgCompanyCodeAssignmentForm } from './SalesOrgCompanyCodeAssignmentForm';

export const dynamic = 'force-dynamic';

const ASSIGNMENT = 'CFG.ORG.SALESORG.ASSIGN_COMPANY';

/** Dedicated OVX3-style assignment activity; OVX0 remains Sales Organization definition. */
export default async function AssignSalesOrgCompanyCodePage() {
  const session = await requireSession('/config/sales-orgs/assign-company');
  const client = session.user.client;
  const canAssign = can(session, ASSIGNMENT);
  const languageKey = session.user.logonLanguage ?? 'E';

  const organisations = await withTenant(client, (tx) =>
    tx
      .select({
        salesOrg: salesOrg.salesOrg,
        companyCode: salesOrg.companyCode,
        isActive: salesOrg.isActive,
      })
      .from(salesOrg)
      .where(eq(salesOrg.client, client))
      .orderBy(asc(salesOrg.salesOrg)),
  );
  const organisationCodes = organisations.map((item) => item.salesOrg.trim());
  const texts = organisationCodes.length
    ? await withTenant(client, (tx) => tx
        .select({ salesOrg: salesOrgText.salesOrg, languageKey: salesOrgText.languageKey, name: salesOrgText.name })
        .from(salesOrgText)
        .where(and(
          eq(salesOrgText.client, client),
          inArray(salesOrgText.salesOrg, organisationCodes),
          inArray(salesOrgText.languageKey, [...new Set([languageKey, 'E'])]),
        )))
    : [];
  const salesOrgChoices = organisations.map((organisation) => {
    const code = organisation.salesOrg.trim();
    const localized = texts.find((item) => item.salesOrg.trim() === code && item.languageKey.trim() === languageKey);
    const english = texts.find((item) => item.salesOrg.trim() === code && item.languageKey.trim() === 'E');
    return {
      code,
      name: localized?.name.trim() || english?.name.trim() || t('salesOrg.noDescription'),
      companyCode: organisation.companyCode?.trim() || null,
      isActive: organisation.isActive,
    };
  });

  const hasActiveSalesOrgs = salesOrgChoices.some((item) => item.isActive);
  // F4 results are tenant-scoped and exposed only to users with the exact assignment authority.
  const companyCodes = canAssign && hasActiveSalesOrgs
    ? await withTenant(client, (tx) => tx
        .select({ code: companyCode.companyCode, name: companyCode.name })
        .from(companyCode)
        .where(and(eq(companyCode.client, client), eq(companyCode.isActive, true)))
        .orderBy(asc(companyCode.companyCode)))
      .then((rows) => rows
        .map((row) => ({ code: row.code.trim(), name: row.name.trim() }))
        .filter((row) => /^[A-Z0-9]{4}$/.test(row.code)))
    : [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link href="/config" aria-label={t('nav.workbench')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5] sm:h-9 sm:w-9">‹</Link>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8" aria-label={t('app.name')}>C</span>
          <div className="min-w-0 flex-1 text-center">
            <span className="code text-2xs text-[#3e6078]">{ASSIGNMENT} · OVX3</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('salesOrg.assignmentTitle')}</h1>
          </div>
          <Link href="/config/sales-orgs" className="hidden shrink-0 text-xs text-[#28445b] underline sm:inline">
            {t('salesOrg.backToDefinitions')}
          </Link>
        </header>
        <div className="flex flex-wrap items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:py-2">
          <Link href="/config" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">
            {t('nav.workbench')}
          </Link>
          <Link href="/config/sales-orgs" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">
            {t('salesOrg.backToDefinitions')}
          </Link>
        </div>
        <p className="border-b border-[#cbd5de] px-3 py-3 text-sm text-[#435b6d] sm:px-4">{t('salesOrg.assignmentSubtitle')}</p>
        <p className="border-b border-[#cbd5de] bg-[#f7f9fa] px-3 py-2 text-xs text-ink-soft sm:px-4">{t('salesOrg.assignmentChangeRule')}</p>
      </section>

      {!canAssign && (
        <p role="status" className="border border-[#d6dce1] bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ASSIGNMENT })}
        </p>
      )}

      {canAssign && organisations.length === 0 && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('salesOrg.noSalesOrgsToAssign')}
        </p>
      )}
      {canAssign && organisations.length > 0 && !hasActiveSalesOrgs && (
        <p role="status" className="border border-[#cbd5de] bg-white p-3 text-sm text-ink-soft">
          {t('salesOrg.noActiveSalesOrgs')}
        </p>
      )}
      {canAssign && hasActiveSalesOrgs && companyCodes.length === 0 && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('salesOrg.noActiveCompanyCodes')}
        </p>
      )}

      {canAssign && hasActiveSalesOrgs && companyCodes.length > 0 && (
        <SalesOrgCompanyCodeAssignmentForm salesOrganisations={salesOrgChoices} companyCodes={companyCodes} />
      )}

      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4">
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-[#334f65]">{t('salesOrg.assignmentListTitle')}</h2>
          <span className="code text-xs text-ink-faint tabular">{organisations.length}</span>
        </div>
        {organisations.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">{t('salesOrg.empty')}</p>
        ) : (
          <>
            <div className="divide-y divide-[#d6dce1] sm:hidden" role="list" aria-label={t('salesOrg.assignmentListTitle')}>
              {salesOrgChoices.map((item) => (
                <article key={item.code} role="listitem" className="space-y-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="code font-semibold">{item.code}</span>
                    <span className={`chip ${item.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                      {t(item.isActive ? 'salesOrg.active' : 'salesOrg.inactive')}
                    </span>
                  </div>
                  <p className="break-words text-sm text-[#263b4d]">{item.name}</p>
                  <p className="text-xs text-ink-soft">
                    {t('salesOrg.assignedCompanyCode')}: <span className="code font-medium">{item.companyCode || t('salesOrg.unassigned')}</span>
                  </p>
                </article>
              ))}
            </div>
            <div className="hidden overflow-x-auto sm:block">
              <table className="min-w-full border-collapse text-sm" aria-label={t('salesOrg.assignmentListTitle')}>
                <thead className="bg-[#eef1f4] text-[#33414c]"><tr className="border-y border-[#c4ccd2]">
                  <th className="w-36 border-r border-[#cbd1d6] px-3 py-2 text-left">{t('salesOrg.salesOrgField')}</th>
                  <th className="px-3 py-2 text-left">{t('salesOrg.name')}</th>
                  <th className="w-32 px-3 py-2 text-left">{t('salesOrg.status')}</th>
                  <th className="w-52 px-3 py-2 text-left">{t('salesOrg.assignedCompanyCode')}</th>
                </tr></thead>
                <tbody>
                  {salesOrgChoices.map((item) => (
                    <tr key={item.code} className="border-b border-[#d6dce1] hover:bg-[#f8fbfd]">
                      <td className="border-r border-[#e1e5e8] px-3 py-2 font-mono">{item.code}</td>
                      <td className="px-3 py-2">{item.name}</td>
                      <td className="px-3 py-2">
                        <span className={`chip ${item.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                          {t(item.isActive ? 'salesOrg.active' : 'salesOrg.inactive')}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono">{item.companyCode || t('salesOrg.unassigned')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
