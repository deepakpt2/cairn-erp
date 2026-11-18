import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DEFAULT_MAX_HITS,
  PO_ACCOUNT_ASSIGN_CAPABILITY,
  PoAccountAssignError,
  purchaseOrdersByAccountAssignment,
  type PoAccountAssignResult,
  type PoAccountAssignSelection,
} from '@/modules/purchasing/po-account-assignment';
import PoAccountAssignmentShell from './PoAccountAssignmentShell';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * SCR-129 / PROC.PO.ACCOUNTASSIGN (ME2K): purchase orders by account assignment.
 * Read-only; grouped by the assigned object the order commits to.
 */
export default async function OrdersByAccountAssignmentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const initialSelection: PoAccountAssignSelection = {
    scopeOfList: (get('scopeOfList') || 'ALV').toUpperCase(),
    scope: (get('scope') || 'ALL').toUpperCase(),
    accountAssignmentCategory: get('accountAssignmentCategory').toUpperCase(),
    costCenterFrom: get('costCenterFrom').toUpperCase(),
    costCenterTo: get('costCenterTo').toUpperCase(),
    purchasingOrgFrom: get('purchasingOrgFrom').toUpperCase(),
    purchasingOrgTo: get('purchasingOrgTo').toUpperCase(),
    purchasingGroupFrom: get('purchasingGroupFrom').toUpperCase(),
    purchasingGroupTo: get('purchasingGroupTo').toUpperCase(),
    plantFrom: get('plantFrom').toUpperCase(),
    plantTo: get('plantTo').toUpperCase(),
    supplierFrom: get('supplierFrom').toUpperCase(),
    supplierTo: get('supplierTo').toUpperCase(),
    documentDateFrom: get('documentDateFrom'),
    documentDateTo: get('documentDateTo'),
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  let result: PoAccountAssignResult | null = null;
  let reportError: string | null = null;
  if (can(session, PO_ACCOUNT_ASSIGN_CAPABILITY)) {
    try {
      result = await purchaseOrdersByAccountAssignment({ client: session.user.client, selection: initialSelection });
    } catch (error) {
      reportError = error instanceof PoAccountAssignError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The account assignment report could not be calculated.';
    }
  }

  return (
    <Page
      title={t('poAa.title')} code="PROC.PO.ACCOUNTASSIGN · ME2K" width="100rem" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('poAa.subtitle')}</p>
        </>
      }
    >

      <PoAccountAssignmentShell
        canUse={can(session, PO_ACCOUNT_ASSIGN_CAPABILITY)}
        selection={initialSelection}
        result={result}
        reportError={reportError}
      />
    </Page>
  );
}
