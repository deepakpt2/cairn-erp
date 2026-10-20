import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DEFAULT_MAX_HITS,
  PO_LIST_CAPABILITY,
  PoListError,
  listPurchaseOrders,
  type PoListResult,
  type PoListSelection,
} from '@/modules/purchasing/purchase-order-list';
import PurchaseOrderListShell from './PurchaseOrderListShell';

export const dynamic = 'force-dynamic';

/**
 * SCR-124 / PROC.PO.LIST (ME2L suite): purchase orders as a list. Read-only over
 * the standing canon — the delivered and invoiced quantities come from posted
 * goods receipts and supplier invoices, and nothing on this screen stores state.
 */
export default async function PurchaseOrderListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const initialSelection: PoListSelection = {
    perspective: (get('perspective', 'VENDOR') || 'VENDOR').toUpperCase(),
    scope: (get('scope', 'ALL') || 'ALL').toUpperCase(),
    vendorFrom: get('vendorFrom').toUpperCase(),
    vendorTo: get('vendorTo').toUpperCase(),
    purchasingOrgFrom: get('purchasingOrgFrom').toUpperCase(),
    purchasingOrgTo: get('purchasingOrgTo').toUpperCase(),
    purchasingGroupFrom: get('purchasingGroupFrom').toUpperCase(),
    purchasingGroupTo: get('purchasingGroupTo').toUpperCase(),
    plantFrom: get('plantFrom').toUpperCase(),
    plantTo: get('plantTo').toUpperCase(),
    materialFrom: get('materialFrom').toUpperCase(),
    materialTo: get('materialTo').toUpperCase(),
    materialGroupFrom: get('materialGroupFrom').toUpperCase(),
    materialGroupTo: get('materialGroupTo').toUpperCase(),
    orderFrom: get('orderFrom'),
    orderTo: get('orderTo'),
    documentDateFrom: get('documentDateFrom'),
    documentDateTo: get('documentDateTo'),
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  let result: PoListResult | null = null;
  let listError: string | null = null;
  if (can(session, PO_LIST_CAPABILITY)) {
    try {
      result = await listPurchaseOrders({ client: session.user.client, selection: initialSelection });
    } catch (error) {
      listError = error instanceof PoListError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The purchase order list could not be calculated.';
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.PO.LIST · ME2L / ME2M / ME2N / ME2C</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('poList.title')}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('poList.subtitle')}</p>
      </header>

      <PurchaseOrderListShell
        canUse={can(session, PO_LIST_CAPABILITY)}
        selection={initialSelection}
        result={result}
        listError={listError}
      />
    </div>
  );
}
