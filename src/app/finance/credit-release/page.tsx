import type { Metadata } from 'next';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import Link from 'next/link';
import {
  CREDIT_OVERRIDE_CAPABILITY, CREDIT_RELEASE_CAPABILITY, CreditError,
  listCreditDeterminations, type CreditReleaseFilter,
} from '@/modules/finance/credit';
import CreditReleaseShell from './CreditReleaseShell';

export const metadata: Metadata = { title: 'Release Credit-Blocked Documents' };

export default async function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession('/finance/credit-release');
  const params = await searchParams;
  const filter: CreditReleaseFilter = {
    areaFrom: params.areaFrom?.toUpperCase() || undefined,
    salesOrg: params.salesOrg?.toUpperCase() || undefined,
    customerFrom: params.customerFrom || undefined,
    documentFrom: params.documentFrom || undefined,
    dateFrom: params.dateFrom || undefined,
    dateTo: params.dateTo || undefined,
    blockedOnly: params.blockedOnly === 'true' ? true : undefined,
    includeReleased: params.includeReleased === 'true',
  };
  let determinations: Awaited<ReturnType<typeof listCreditDeterminations>> = [];
  let error: string | null = null;
  if (can(session, CREDIT_RELEASE_CAPABILITY)) {
    try {
      determinations = await listCreditDeterminations(session.user.client, filter);
    } catch (caught) {
      error = caught instanceof CreditError ? caught.message : 'The queue could not be loaded.';
    }
  }
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('finance.label')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{t('release.title')}</h1>
        <p className="text-sm text-ink-soft">{t('release.intro')}</p>
        <Link href="/finance/credit-monitor" className="mt-1 inline-block text-sm text-accent hover:underline">
          {t('release.openMonitor')}
        </Link>
        {error && <p className="mt-2 text-sm font-semibold text-signal-error">{error}</p>}
      </header>
      <CreditReleaseShell
        canUse={can(session, CREDIT_RELEASE_CAPABILITY)}
        canOverride={can(session, CREDIT_OVERRIDE_CAPABILITY)}
        determinations={determinations}
        filter={filter}
      />
    </main>
  );
}
