import Link from 'next/link';
import { and, asc, eq } from 'drizzle-orm';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { companyCode, controllingArea, controllingAreaCompany } from '@/modules/foundation/schema';
import { ControllingAreaCompanyAssignmentUI } from '../ControllingAreaCompanyAssignmentUI';

export const dynamic = 'force-dynamic';

const CONTROLLING_AREA_DEFINE = 'CFG.COST.CONTROLLINGAREA.DEFINE';
const COMPANY_CODE_DEFINE = 'CFG.ORG.COMPANYCODE.DEFINE';
const ROUTE = '/config/controlling-area/assign-company-code';

/** OX19 presentation page; assignments remain a distinct activity from OKKP definition. */
export default async function ControllingAreaCompanyCodeAssignmentPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, CONTROLLING_AREA_DEFINE) && can(session, COMPANY_CODE_DEFINE);

  const [areaRows, companyCodeRows, assignmentRows] = await Promise.all([
    withTenant(client, (tx) => tx
      .select({
        code: controllingArea.controllingArea,
        name: controllingArea.name,
        isActive: controllingArea.isActive,
      })
      .from(controllingArea)
      .where(eq(controllingArea.client, client))
      .orderBy(asc(controllingArea.controllingArea))),
    withTenant(client, (tx) => tx
      .select({
        code: companyCode.companyCode,
        name: companyCode.name,
        isActive: companyCode.isActive,
      })
      .from(companyCode)
      .where(eq(companyCode.client, client))
      .orderBy(asc(companyCode.companyCode))),
    withTenant(client, (tx) => tx
      .select({
        controllingArea: controllingAreaCompany.controllingArea,
        controllingAreaName: controllingArea.name,
        companyCodeScope: controllingArea.companyCodeScope,
        controllingAreaCurrency: controllingArea.currency,
        controllingAreaFiscalYearVariant: controllingArea.fiscalYearVariant,
        controllingAreaIsActive: controllingArea.isActive,
        companyCode: controllingAreaCompany.companyCode,
        companyCodeName: companyCode.name,
        companyCodeCurrency: companyCode.currency,
        companyCodeChartOfAccounts: companyCode.chartOfAccounts,
        companyCodeFiscalYearVariant: companyCode.fiscalYearVariant,
        companyCodeIsActive: companyCode.isActive,
      })
      .from(controllingAreaCompany)
      .leftJoin(controllingArea, and(
        eq(controllingArea.client, controllingAreaCompany.client),
        eq(controllingArea.controllingArea, controllingAreaCompany.controllingArea),
      ))
      .leftJoin(companyCode, and(
        eq(companyCode.client, controllingAreaCompany.client),
        eq(companyCode.companyCode, controllingAreaCompany.companyCode),
      ))
      .where(eq(controllingAreaCompany.client, client))
      .orderBy(asc(controllingAreaCompany.controllingArea), asc(controllingAreaCompany.companyCode))),
  ]);

  const controllingAreas = areaRows.map((row) => ({
    code: row.code.trim(),
    name: row.name.trim(),
    isActive: row.isActive,
  }));
  // Show every existing Company Code in F4. Keys outside the approved Char 4 format
  // remain visible for discovery but cannot be selected into the OX19 field.
  const companyCodes = companyCodeRows.map((row) => {
    const code = row.code.trim();
    return {
      code,
      name: row.name.trim(),
      isActive: row.isActive,
      selectable: /^[A-Za-z0-9]{4}$/.test(code),
    };
  });
  const assignments = assignmentRows.map((row) => ({
    controllingArea: row.controllingArea.trim(),
    controllingAreaName: row.controllingAreaName?.trim() ?? null,
    companyCodeScope: row.companyCodeScope,
    controllingAreaCurrency: row.controllingAreaCurrency?.trim() ?? null,
    controllingAreaFiscalYearVariant: row.controllingAreaFiscalYearVariant?.trim() ?? null,
    controllingAreaIsActive: row.controllingAreaIsActive,
    companyCode: row.companyCode.trim(),
    companyCodeName: row.companyCodeName?.trim() ?? null,
    companyCodeCurrency: row.companyCodeCurrency?.trim() ?? null,
    companyCodeChartOfAccounts: row.companyCodeChartOfAccounts?.trim() ?? null,
    companyCodeFiscalYearVariant: row.companyCodeFiscalYearVariant?.trim() ?? null,
    companyCodeIsActive: row.companyCodeIsActive,
  }));

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link href="/config" aria-label={t('nav.workbench')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5] sm:h-9 sm:w-9">‹</Link>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8" aria-label={t('app.name')}>C</span>
          <div className="min-w-0 flex-1 text-center">
            <span className="code text-2xs text-[#3e6078]">OX19 · {t('controllingArea.assignmentActivity')}</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('controllingArea.assignmentPageTitle')}</h1>
          </div>
        </header>
        <nav aria-label={t('nav.workbench')} className="flex flex-wrap items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4 sm:py-2">
          <Link href="/config" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">
            {t('nav.workbench')}
          </Link>
          <Link href="/config/controlling-area" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">
            {t('controllingArea.backToDefinitions')}
          </Link>
          <Link href="/config/company-codes" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">
            {t('controllingArea.companyCodesLink')}
          </Link>
        </nav>
        <p className="border-b border-[#cbd5de] px-3 py-3 text-sm text-[#435b6d] sm:px-4">
          {t('controllingArea.assignmentPageSubtitle')}
        </p>
      </section>

      <ControllingAreaCompanyAssignmentUI
        controllingAreas={controllingAreas}
        companyCodes={companyCodes}
        assignments={assignments}
        canMaintain={canMaintain}
      />
    </div>
  );
}
