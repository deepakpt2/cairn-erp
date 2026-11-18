import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { listFiscalYearVariants } from '@/modules/foundation/fiscal-year-variant-maintenance';
import { FiscalYearVariantList, FiscalYearVariantPanel } from './FiscalYearVariants';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ACTIVITY = 'CFG.FIN.FYV.DEFINE';
const ROUTE = '/config/fiscal-year-variants';

/** OB29 Maintain Fiscal Year Variants; assignment to a Company Code remains a separate activity. */
export default async function FiscalYearVariantsPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);
  const variants = await listFiscalYearVariants(client);

  return (
    <Page
      title={t('fiscalYearVariant.title')} code={<>{ACTIVITY} · OB29</>} back={{ href: '/config', label: t('nav.workbench') }}
      description={t('fiscalYearVariant.subtitle')}
      actions={
        <>
          <LinkButton href="/config/posting-periods">{t('fiscalYearVariant.postingPeriodsLink')}</LinkButton>
          <LinkButton href="/config/company-codes">{t('fiscalYearVariant.companyCodesLink')}</LinkButton>
          <LinkButton href="/config/fiscal-year-variants/assign-company-codes">{t('fiscalYearVariant.assignCompanyCodesLink')}</LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}
      <FiscalYearVariantPanel variants={variants} canMaintain={canMaintain} />
      <FiscalYearVariantList variants={variants} canMaintain={canMaintain} />
    </Page>
  );
}
