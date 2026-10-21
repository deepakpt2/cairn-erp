import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DIFFERENCE_PAGE_SIZE_DEFAULT,
  DIFFERENCE_PAGE_SIZE_MAX,
  PHYSICAL_INVENTORY_DIFF_LIST_CAPABILITY,
  PHYSICAL_INVENTORY_DIFF_LIST_ROUTE,
  PhysicalInventoryDifferenceError,
  getDifferenceDocument,
  listDifferences,
  openDifferenceWorkflow,
  type DifferenceDocumentView,
  type DifferenceRow,
  type DifferenceSelection,
} from '@/modules/inventory/physical-inventory-differences';
import DifferenceList from './DifferenceList';

export const dynamic = 'force-dynamic';

const ROUTE = PHYSICAL_INVENTORY_DIFF_LIST_ROUTE;

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

function flag(value: string | string[] | undefined, fallback: boolean): boolean {
  const text = last(value);
  if (text === '1' || text === 'on') return true;
  if (text === '0') return false;
  return fallback;
}

/**
 * Difference list — SCR-148 / MI20 (as a search alias only).
 *
 * A reading of what was counted. The page posts nothing. A request that names posting or
 * recount is answered with the refusal, and no control on the page offers either.
 */
export default async function PhysicalInventoryDifferencesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const allowed = can(session, PHYSICAL_INVENTORY_DIFF_LIST_CAPABILITY);
  const executed = last(params.executed) === '1';
  const plantFrom = last(params.plantFrom).toUpperCase();
  const fiscalYear = Number(last(params.fiscalYear) || String(new Date().getUTCFullYear()));
  const pageSize = Math.min(DIFFERENCE_PAGE_SIZE_MAX, Math.max(1, Number(last(params.pageSize) || String(DIFFERENCE_PAGE_SIZE_DEFAULT)) || DIFFERENCE_PAGE_SIZE_DEFAULT));
  const minimum = last(params.minimumDifferenceValue);
  const sort = last(params.sort);
  const selection: DifferenceSelection = {
    plantFrom,
    plantTo: last(params.plantTo).toUpperCase() || undefined,
    storageLocationFrom: last(params.storageLocationFrom).toUpperCase() || undefined,
    storageLocationTo: last(params.storageLocationTo).toUpperCase() || undefined,
    documentFrom: last(params.documentFrom).toUpperCase() || undefined,
    documentTo: last(params.documentTo).toUpperCase() || undefined,
    fiscalYear,
    materialFrom: last(params.materialFrom).toUpperCase() || undefined,
    materialTo: last(params.materialTo).toUpperCase() || undefined,
    differenceExists: flag(params.differenceExists, true),
    includeUncounted: flag(params.includeUncounted, false),
    includeUnvalued: flag(params.includeUnvalued, true),
    minimumDifferenceValue: minimum === '' ? undefined : Number(minimum),
    currency: last(params.currency).toUpperCase() || undefined,
    showPeriodNote: flag(params.showPeriodNote, false),
    sort: sort === 'material' || sort === 'difference' || sort === 'monetary' ? sort : 'document',
    sortDescending: flag(params.sortDescending, false),
    page: Math.max(1, Number(last(params.page) || '1') || 1),
    pageSize,
  };

  let rows: DifferenceRow[] = [];
  let total = 0;
  let excludedOtherCurrency = 0;
  let excludedUnvalued = 0;
  let listError: string | null = null;
  let document: DifferenceDocumentView | null = null;
  let workflowMessage: string | null = null;

  if (allowed && executed && plantFrom) {
    try {
      const result = await listDifferences(session.user.client, selection);
      rows = result.rows;
      total = result.total;
      excludedOtherCurrency = result.excludedOtherCurrency;
      excludedUnvalued = result.excludedUnvalued;
    } catch (caught) {
      listError = caught instanceof PhysicalInventoryDifferenceError
        ? `${caught.message}${caught.remedy ? ` ${caught.remedy}` : ''}`
        : 'The difference list could not be read.';
    }
  }

  const workflow = last(params.workflow).toUpperCase();
  if (allowed && (workflow === 'POST' || workflow === 'RECOUNT' || workflow === 'DISPLAY')) {
    try {
      const opened = await openDifferenceWorkflow(session.user.client, {
        workflow: workflow as 'POST' | 'RECOUNT' | 'DISPLAY',
        documentNumber: last(params.doc),
        fiscalYear: Number(last(params.year) || last(params.fiscalYear) || '0'),
      });
      if (workflow === 'DISPLAY') document = opened;
    } catch (caught) {
      workflowMessage = caught instanceof PhysicalInventoryDifferenceError
        ? `${caught.message}${caught.remedy ? ` ${caught.remedy}` : ''}`
        : t('mi20.postingRefused');
    }
  } else if (allowed && last(params.doc) && last(params.year)) {
    document = await getDifferenceDocument(session.user.client, {
      documentNumber: last(params.doc),
      fiscalYear: Number(last(params.year)),
    });
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('mi20.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('mi20.title')}</h1>
          <div className="flex gap-2">
            <Link href="/inventory/physical-inventory-posting" className="btn btn-default min-h-11 sm:min-h-8" data-difference-posting-link>{t('mi20.toPosting')}</Link>
            <Link href="/inventory/physical-inventory-count" className="btn btn-default min-h-11 sm:min-h-8">{t('mi20.toCounts')}</Link>
            <Link href="/inventory/physical-inventory" className="btn btn-default min-h-11 sm:min-h-8">{t('mi20.toDocuments')}</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mi20.subtitle')}</p>
      </header>

      {!allowed && <p className="text-sm text-ink-soft">{t('mi20.capabilityMissing')}</p>}
      {allowed && !executed && <p className="text-sm text-ink-soft">{t('mi20.needSelection')}</p>}
      {allowed && (
        <DifferenceList
          selection={selection}
          rows={rows}
          total={total}
          excludedOtherCurrency={excludedOtherCurrency}
          excludedUnvalued={excludedUnvalued}
          listError={listError}
          document={document}
          workflowMessage={workflowMessage}
        />
      )}
    </div>
  );
}
