import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DEFAULT_MAX_HITS,
  PR_LIST_CAPABILITY,
  RequisitionListError,
  listPurchaseRequisitions,
  type RequisitionListResult,
  type RequisitionListSelection,
} from '@/modules/purchasing/requisition-list';
import RequisitionListShell from './RequisitionListShell';
import { ReportExport } from '@/ui/output/ReportExport';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * SCR-123 / PROC.REQ.LIST (ME5A): purchase requisitions as a list. A read-only
 * report over the standing requisition items — it derives the purchasing
 * organisation through the plant assignment and the conversion status from
 * live purchase-order items, and stores nothing of its own.
 */
export default async function RequisitionListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const initialSelection: RequisitionListSelection = {
    purchasingGroupFrom: get('purchasingGroupFrom').toUpperCase(),
    purchasingGroupTo: get('purchasingGroupTo').toUpperCase(),
    plantFrom: get('plantFrom').toUpperCase(),
    plantTo: get('plantTo').toUpperCase(),
    materialFrom: get('materialFrom').toUpperCase(),
    materialTo: get('materialTo').toUpperCase(),
    purchasingOrgFrom: get('purchasingOrgFrom').toUpperCase(),
    purchasingOrgTo: get('purchasingOrgTo').toUpperCase(),
    requisitioner: get('requisitioner'),
    requisitionDateFrom: get('requisitionDateFrom'),
    requisitionDateTo: get('requisitionDateTo'),
    accountAssignmentCategory: get('accountAssignmentCategory').toUpperCase(),
    displayClosed: get('displayClosed') === 'on' || get('displayClosed') === '1',
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  let result: RequisitionListResult | null = null;
  let listError: string | null = null;
  if (can(session, PR_LIST_CAPABILITY)) {
    try {
      result = await listPurchaseRequisitions({ client: session.user.client, selection: initialSelection });
    } catch (error) {
      listError = error instanceof RequisitionListError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The requisition list could not be calculated.';
    }
  }

  return (
    <Page
      title={t('reqList.title')} code="PROC.REQ.LIST · ME5A" width="110rem" back={null}
      description={t('reqList.subtitle')}
    >

      {result && result.rows.length > 0 && <div><ReportExport report="requisition-list" params={params} /></div>}

      <RequisitionListShell
        canUse={can(session, PR_LIST_CAPABILITY)}
        selection={initialSelection}
        result={result}
        listError={listError}
      />
    </Page>
  );
}
