import { and, asc, eq } from 'drizzle-orm';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { companyCode, controllingArea, controllingAreaCompany } from '@/modules/foundation/schema';
import { ControllingAreaCompanyAssignmentUI } from '../ControllingAreaCompanyAssignmentUI';
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('controllingArea.assignmentPageTitle')} code={<>OX19 · {t('controllingArea.assignmentActivity')}</>} back={{ href: '/config', label: t('nav.workbench') }}
      description={t('controllingArea.assignmentPageSubtitle')}
      actions={
        <>
          <LinkButton href="/config/controlling-area">{t('controllingArea.backToDefinitions')}</LinkButton>
          <LinkButton href="/config/company-codes">{t('controllingArea.companyCodesLink')}</LinkButton>
        </>
      }
    >

      <ControllingAreaCompanyAssignmentUI
        controllingAreas={controllingAreas}
        companyCodes={companyCodes}
        assignments={assignments}
        canMaintain={canMaintain}
      />
    </Page>
  );
}
