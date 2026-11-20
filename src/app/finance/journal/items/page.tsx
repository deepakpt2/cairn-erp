import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  JOURNAL_ITEMS_CAPABILITY, JournalItemsError, getJournalItems,
  type JournalItemsResult,
} from '@/modules/finance/journal-items';
import ItemsForm from './ItemsForm';
import { currencyDecimalsFor } from '@/platform/posting/money';
import { ReportExport } from '@/ui/output/ReportExport';
import { Page } from '@/ui/kit';

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
        authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' },
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
    <Page
      title={t('journalItems.title')} code="FIN.JOURNAL.LIST · FAGLL03" back={{ href: '/', label: t('nav.launchpad') }}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('journalItems.subtitle')}</p>
          {result && <div className="mt-3"><ReportExport report="gl-line-items" params={params} /></div>}
        </>
      }
    >

      {params.accountFrom && (
        <p className="text-sm">
          <Link
            className="text-accent hover:underline"
            href={`/finance/journal/balances?report=1&reportCompanies=${encodeURIComponent(params.companyCodes ?? '')}&accountFrom=${encodeURIComponent(params.accountFrom)}&accountTo=${encodeURIComponent(params.accountTo ?? '')}&reportFiscalYear=${encodeURIComponent(params.fiscalYear ?? '')}`}
          >
            ← Balance report
          </Link>
        </p>
      )}
      <ItemsForm result={result} error={error} canList={canList} decimals={await currencyDecimalsFor(session.user.client)} />
    </Page>
  );
}
