import { and, asc, count, eq, inArray, max, min } from 'drizzle-orm';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { companyCode, controllingArea, controllingAreaCompany } from '@/modules/foundation/schema';
import { journalEntry } from '@/modules/finance/schema';
import { listFiscalYearVariants } from '@/modules/foundation/fiscal-year-variant-maintenance';
import { AssignCompanyCodesUI, type AssignableCompanyCode } from '../AssignCompanyCodesUI';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ACTIVITY = 'CFG.FIN.FYV.ASSIGN';
const COMPANY_CODE_DEFINE = 'CFG.ORG.COMPANYCODE.DEFINE';
const ROUTE = '/config/fiscal-year-variants/assign-company-codes';

/**
 * OB37 Assign Fiscal Year Variant to Company Code.
 *
 * A distinct activity from OB29, which defines the variants: this one writes the Company Code,
 * so it asks for both authorities the way OX19 does — the assignment's own and the one that
 * owns the record being changed.
 *
 * The page reads three things beside the Company Codes themselves. The Controlling Area links,
 * because a Company Code in an area shares that area's variant and a reassignment that would
 * break the sharing is refused. The posted document counts and years, because a Company Code
 * that has posted may still change calendar but only with a reason, and the row should say what
 * the reason has to cover. And every variant rather than only the active ones, so a Company
 * Code holding a retired variant can still be displayed truthfully instead of showing a blank.
 */
export default async function AssignFiscalYearVariantPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY) && can(session, COMPANY_CODE_DEFINE);

  const [companyRows, variantRows, areaRows, postingRows] = await Promise.all([
    withTenant(client, (tx) => tx
      .select({
        code: companyCode.companyCode,
        name: companyCode.name,
        currency: companyCode.currency,
        fiscalYearVariant: companyCode.fiscalYearVariant,
        isActive: companyCode.isActive,
      })
      .from(companyCode)
      .where(eq(companyCode.client, client))
      .orderBy(asc(companyCode.companyCode))),
    listFiscalYearVariants(client),
    withTenant(client, (tx) => tx
      .select({
        companyCode: controllingAreaCompany.companyCode,
        area: controllingArea.controllingArea,
        areaName: controllingArea.name,
        areaVariant: controllingArea.fiscalYearVariant,
        areaScope: controllingArea.companyCodeScope,
      })
      .from(controllingAreaCompany)
      .innerJoin(controllingArea, and(
        eq(controllingArea.client, controllingAreaCompany.client),
        eq(controllingArea.controllingArea, controllingAreaCompany.controllingArea),
      ))
      .where(eq(controllingAreaCompany.client, client))
      .orderBy(asc(controllingAreaCompany.controllingArea), asc(controllingAreaCompany.companyCode))),
    withTenant(client, (tx) => tx
      .select({
        code: journalEntry.companyCode,
        documents: count(),
        firstYear: min(journalEntry.fiscalYear),
        lastYear: max(journalEntry.fiscalYear),
      })
      .from(journalEntry)
      // The same definition the assignment service uses: a reversed document still occupied a
      // period, and a draft never did. Two counts of one rule is how a screen and its service
      // come to disagree about whether a book has posted.
      .where(and(
        eq(journalEntry.client, client),
        inArray(journalEntry.status, ['POSTED', 'REVERSED']),
      ))
      .groupBy(journalEntry.companyCode)),
  ]);

  // One Controlling Area per Company Code is the rule OX19 enforces; a row that somehow holds
  // two is shown with the first and refused by the service, which is the louder of the two.
  const areaByCompany = new Map<string, { code: string; name: string | null; variant: string | null; scope: string | null }>();
  for (const row of areaRows) {
    if (areaByCompany.has(row.companyCode)) continue;
    areaByCompany.set(row.companyCode, {
      code: row.area,
      name: row.areaName?.trim() ?? null,
      variant: row.areaVariant?.trim() ?? null,
      scope: row.areaScope,
    });
  }

  // The peers a reassignment has to agree with: the other Company Codes of the same area, each
  // with the variant it holds now.
  const variantByCompany = new Map(companyRows.map((row) => [row.code, row.fiscalYearVariant?.trim() ?? null]));
  const siblingsByCompany = new Map<string, Array<{ code: string; variant: string | null }>>();
  for (const [company, area] of areaByCompany) {
    siblingsByCompany.set(company, areaRows
      .filter((row) => row.area === area.code && row.companyCode !== company)
      .map((row) => ({ code: row.companyCode, variant: variantByCompany.get(row.companyCode) ?? null })));
  }

  const postingsByCompany = new Map(postingRows.map((row) => [row.code, row]));

  const companyCodes: AssignableCompanyCode[] = companyRows.map((row) => {
    const postings = postingsByCompany.get(row.code);
    return {
      code: row.code.trim(),
      name: row.name.trim(),
      currency: row.currency.trim(),
      fiscalYearVariant: row.fiscalYearVariant?.trim() ?? null,
      isActive: row.isActive,
      postedDocuments: postings?.documents ?? 0,
      firstPostedYear: postings?.firstYear ?? null,
      lastPostedYear: postings?.lastYear ?? null,
      area: areaByCompany.get(row.code) ?? null,
      areaSiblings: siblingsByCompany.get(row.code) ?? [],
    };
  });

  const variants = variantRows.map((row) => ({
    code: row.variant,
    name: row.name,
    isActive: row.isActive,
  }));

  return (
    <Page
      title={t('fyvAssignment.pageTitle')} code={<>{ACTIVITY} · OB37</>} back={{ href: '/config', label: t('nav.workbench') }}
      description={t('fyvAssignment.pageSubtitle')}
      actions={
        <>
          <LinkButton href="/config/fiscal-year-variants">{t('fyvAssignment.backToVariants')}</LinkButton>
          <LinkButton href="/config/company-codes">{t('fyvAssignment.companyCodesLink')}</LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <AssignCompanyCodesUI companyCodes={companyCodes} variants={variants} canMaintain={canMaintain} />
    </Page>
  );
}
