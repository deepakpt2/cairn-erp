import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  DEFAULT_INTERVALS,
  listPostingPeriodVariants,
} from '@/modules/foundation/posting-period-variant-definition';
import { PostingPeriodVariantList, PostingPeriodVariantPanel } from './PostingPeriodVariants';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/posting-period-variants';

/**
 * OBBO Define Posting Period Variants.
 *
 * The registry of variants, and only the registry: which periods a variant holds open is
 * maintained where it is used, against a Company Code, because that is the screen an
 * operator closing a month is already on. Opening this screen from there and returning is
 * the whole journey.
 */
export default async function PostingPeriodVariantsPage({
  searchParams,
}: {
  /** `deleted` carries the confirmation a delete dialog cannot render: its own row is gone. */
  searchParams: Promise<{ deleted?: string; intervals?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);
  const variants = await listPostingPeriodVariants(client);

  return (
    <Page
      title={t('ppv.title')} code={<>{ACTIVITY} · OBBO</>} back={{ href: '/config', label: t('nav.workbench') }}
      description={t('ppv.subtitle')}
      actions={
        <>
          <LinkButton href="/config/posting-periods">{t('ppv.postingPeriodsLink')}</LinkButton>
          <LinkButton href="/config/company-codes">{t('ppv.companyCodesLink')}</LinkButton>
          <LinkButton href="/config/fiscal-year-variants">{t('ppv.fiscalYearVariantsLink')}</LinkButton>
        </>
      }
    >

      {params.deleted ? (
        <p role="status" className="border border-line bg-sunken px-4 py-3 text-sm text-ink-soft">
          {t('ppv.deleted', { variant: params.deleted, intervals: params.intervals ?? '0' })}
        </p>
      ) : null}

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}
      <PostingPeriodVariantPanel variants={variants} defaults={DEFAULT_INTERVALS} canMaintain={canMaintain} />
      <PostingPeriodVariantList variants={variants} defaults={DEFAULT_INTERVALS} canMaintain={canMaintain} />
    </Page>
  );
}
