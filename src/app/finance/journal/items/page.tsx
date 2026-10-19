import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  JOURNAL_ITEMS_CAPABILITY, JournalItemsError, getJournalItems,
  type JournalItemsResult,
} from '@/modules/finance/journal-items';
import ItemsForm from './ItemsForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/journal/items';

/**
 * G/L line item report (SCR-088 / FAGLL03 as a search alias only).
 */
export default async function JournalItemsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const canList = can(session, JOURNAL_ITEMS_CAPABILITY);
  let result: JournalItemsResult | null = null;
  let error: string | null = null;
  if (params.accountFrom && canList) {
    try {
      result = await getJournalItems(session.user.client, {
        accountFrom: params.accountFrom,
        accountTo: params.accountTo || undefined,
        companyCodes: (params.companyCodes ?? '').split(',').map((c) => c.trim()).filter(Boolean),
        fiscalYear: params.fiscalYear ? Number(params.fiscalYear) : undefined,
        postingPeriod: params.postingPeriod ? Number(params.postingPeriod) : undefined,
        postingDateFrom: params.postingDateFrom || undefined,
        postingDateTo: params.postingDateTo || undefined,
        documentNumber: params.documentNumber || undefined,
        documentType: params.documentType || undefined,
        status: params.status === 'OPEN' || params.status === 'CLEARED' ? params.status : 'ALL',
        profitCenter: params.profitCenter || undefined,
        costCenter: params.costCenter || undefined,
        reference: params.reference || undefined,
        maxHits: params.maxHits ? Number(params.maxHits) : undefined,
        page: params.page ? Number(params.page) : undefined,
        pageSize: params.pageSize ? Number(params.pageSize) : undefined,
      });
    } catch (caught) {
      error = caught instanceof JournalItemsError
        ? `${caught.message}${caught.remedy ? ` ${caught.remedy}` : ''}`
        : 'The report could not be executed.';
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.JOURNAL.LIST · FAGLL03</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('journalItems.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('journalItems.subtitle')}</p>
      </header>

      <ItemsForm result={result} error={error} canList={canList} />
    </div>
  );
}
