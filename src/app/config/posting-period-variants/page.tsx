import Link from 'next/link';
import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  DEFAULT_INTERVALS,
  listPostingPeriodVariants,
} from '@/modules/foundation/posting-period-variant-definition';
import { PostingPeriodVariantList, PostingPeriodVariantPanel } from './PostingPeriodVariants';

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
export default async function PostingPeriodVariantsPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);
  const variants = await listPostingPeriodVariants(client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
        <header className="flex min-h-16 items-center gap-2 border-b border-[#9eb6c8] bg-[#c9dce9] px-3 py-2 text-[#28445b] sm:gap-3 sm:px-4">
          <Link href="/config" aria-label={t('nav.workbench')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5] sm:h-9 sm:w-9">‹</Link>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm sm:h-8 sm:w-8" aria-label={t('app.name')}>C</span>
          <div className="min-w-0 flex-1 text-center">
            <span className="code text-2xs text-[#3e6078]">{ACTIVITY} · OBBO</span>
            <h1 className="text-sm font-semibold leading-tight sm:text-base">{t('ppv.title')}</h1>
          </div>
        </header>
        <nav aria-label={t('nav.workbench')} className="flex flex-wrap items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4 sm:py-2">
          <Link href="/config" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('nav.workbench')}</Link>
          <Link href="/config/posting-periods" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('ppv.postingPeriodsLink')}</Link>
          <Link href="/config/company-codes" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('ppv.companyCodesLink')}</Link>
          <Link href="/config/fiscal-year-variants" className="inline-flex min-h-11 items-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f8fbfd] sm:min-h-8 sm:py-1">{t('ppv.fiscalYearVariantsLink')}</Link>
        </nav>
        <p className="border-b border-[#cbd5de] px-3 py-3 text-sm text-[#435b6d] sm:px-4">{t('ppv.subtitle')}</p>
      </section>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}
      <PostingPeriodVariantPanel variants={variants} defaults={DEFAULT_INTERVALS} canMaintain={canMaintain} />
      <PostingPeriodVariantList variants={variants} defaults={DEFAULT_INTERVALS} canMaintain={canMaintain} />
    </div>
  );
}
