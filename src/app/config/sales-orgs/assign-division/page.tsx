import Link from 'next/link';
import { and, eq, inArray } from 'drizzle-orm';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { salesOrgText } from '@/modules/foundation/schema';
import {
  listSalesOrgDivisionAssignments,
  salesOrgDivisionF4Choices,
} from '@/modules/foundation/sales-org-division-assignment';
import { SalesOrgDivisionAssignmentsList } from './AssignmentsList';
import { SalesOrgDivisionAssignmentForm } from './AssignmentForm';

export const dynamic = 'force-dynamic';

const ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_DIVISION';
const ROUTE = '/config/sales-orgs/assign-division';
const SALES_AREA_ACTIVITY = 'CFG.ORG.SALESAREA.DEFINE';

/** OVXA tenant-local many-to-many Sales Organization / Division assignment. */
export default async function AssignDivisionPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);
  const canDefineSalesArea = can(session, SALES_AREA_ACTIVITY);
  const languageKey = session.user.logonLanguage ?? 'E';

  const assignments = await listSalesOrgDivisionAssignments(client);
  const valueHelp = canMaintain
    ? await salesOrgDivisionF4Choices(client)
    : { salesOrganizations: [], divisions: [] };

  const organisationCodes = [...new Set([
    ...assignments.map((item) => item.salesOrg.trim()),
    ...valueHelp.salesOrganizations.map((code) => code.trim()),
  ])];
  const organisationTexts = organisationCodes.length
    ? await withTenant(client, (tx) => tx
        .select({ salesOrg: salesOrgText.salesOrg, languageKey: salesOrgText.languageKey, name: salesOrgText.name })
        .from(salesOrgText)
        .where(and(
          eq(salesOrgText.client, client),
          inArray(salesOrgText.salesOrg, organisationCodes),
          inArray(salesOrgText.languageKey, [...new Set([languageKey, 'E'])]),
        )))
    : [];

  function organisationName(code: string) {
    const localised = organisationTexts.find((item) =>
      item.salesOrg.trim() === code && item.languageKey.trim() === languageKey,
    );
    const english = organisationTexts.find((item) =>
      item.salesOrg.trim() === code && item.languageKey.trim() === 'E',
    );
    return localised?.name.trim() || english?.name.trim() || t('salesOrg.noDescription');
  }

  const salesOrganizations = valueHelp.salesOrganizations.map((code) => ({
    code: code.trim(),
    name: organisationName(code.trim()),
  }));
  const assignmentRows = assignments.map((item) => ({
    salesOrg: item.salesOrg.trim(),
    salesOrgName: organisationName(item.salesOrg.trim()),
    salesOrgActive: item.salesOrgActive,
    division: item.division.trim(),
    divisionName: item.divisionName.trim(),
    divisionActive: item.divisionActive,
  }));
  const hasActiveSalesOrganizations = salesOrganizations.length > 0;
  const hasActiveDivisions = valueHelp.divisions.length > 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link href="/config" aria-label={t('nav.workbench')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5] sm:h-9 sm:w-9">‹</Link>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8" aria-label={t('app.name')}>C</span>
          <div className="min-w-0 flex-1 text-center">
            <span className="code text-2xs text-[#3e6078]">{ACTIVITY} · OVXA</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('salesOrgDivision.title')}</h1>
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
          <Link href="/config/divisions" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">
            {t('division.title')}
          </Link>
          {canDefineSalesArea && <Link href="/config/sales-areas" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('salesArea.navLink')}</Link>}
        </div>
        <p className="border-b border-[#cbd5de] px-3 py-3 text-sm text-[#435b6d] sm:px-4">{t('salesOrgDivision.subtitle')}</p>
        <p className="border-b border-[#cbd5de] bg-[#f7f9fa] px-3 py-2 text-xs text-ink-soft sm:px-4">{t('salesOrgDivision.assignmentRule')}</p>
      </section>

      {!canMaintain && (
        <p role="status" className="border border-[#d6dce1] bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}
      {canMaintain && !hasActiveSalesOrganizations && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('salesOrgDivision.noActiveSalesOrgs')}
        </p>
      )}
      {canMaintain && !hasActiveDivisions && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('salesOrgDivision.noActiveDivisions')}
        </p>
      )}

      {canMaintain && hasActiveSalesOrganizations && hasActiveDivisions && (
        <SalesOrgDivisionAssignmentForm salesOrganizations={salesOrganizations} divisions={valueHelp.divisions} />
      )}

      <SalesOrgDivisionAssignmentsList assignments={assignmentRows} canRemove={canMaintain} />
    </div>
  );
}
