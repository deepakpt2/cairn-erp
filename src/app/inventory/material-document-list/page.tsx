import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  DEFAULT_MAX_HITS,
  MATERIAL_DOC_LIST_CAPABILITY,
  MaterialDocListError,
  listMaterialDocuments,
  type MaterialDocListResult,
  type MaterialDocListSelection,
} from '@/modules/inventory/material-document-list';
import MaterialDocumentListShell from './MaterialDocumentListShell';

export const dynamic = 'force-dynamic';

/**
 * SCR-125 / INV.MATERIALDOC.LIST (MB51): the material document list. Read-only
 * over the ledger; the posting-date range is required, and reversed documents
 * are listed with their status rather than hidden.
 */
export default async function MaterialDocumentListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const initialSelection: MaterialDocListSelection = {
    materialFrom: get('materialFrom').toUpperCase(),
    materialTo: get('materialTo').toUpperCase(),
    plantFrom: get('plantFrom').toUpperCase(),
    plantTo: get('plantTo').toUpperCase(),
    storageLocationFrom: get('storageLocationFrom').toUpperCase(),
    storageLocationTo: get('storageLocationTo').toUpperCase(),
    movementTypeFrom: get('movementTypeFrom').toUpperCase(),
    movementTypeTo: get('movementTypeTo').toUpperCase(),
    postingDateFrom: get('postingDateFrom'),
    postingDateTo: get('postingDateTo'),
    documentDateFrom: get('documentDateFrom'),
    documentDateTo: get('documentDateTo'),
    stockType: get('stockType').toUpperCase(),
    batch: get('batch').toUpperCase(),
    purchaseOrderFrom: get('purchaseOrderFrom'),
    salesOrder: get('salesOrder'),
    delivery: get('delivery'),
    billingDocument: get('billingDocument'),
    schedulingAgreement: get('schedulingAgreement'),
    serialNumber: get('serialNumber'),
    purchaseOrderTo: get('purchaseOrderTo'),
    userName: get('userName'),
    maxHits: Number(get('maxHits', String(DEFAULT_MAX_HITS))) || DEFAULT_MAX_HITS,
  };

  let result: MaterialDocListResult | null = null;
  let listError: string | null = null;
  if (can(session, MATERIAL_DOC_LIST_CAPABILITY)) {
    try {
      result = await listMaterialDocuments({ client: session.user.client, selection: initialSelection });
    } catch (error) {
      listError = error instanceof MaterialDocListError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The material document list could not be calculated.';
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.MATERIALDOC.LIST · MB51</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('mdList.title')}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mdList.subtitle')}</p>
      </header>

      <MaterialDocumentListShell
        canUse={can(session, MATERIAL_DOC_LIST_CAPABILITY)}
        selection={initialSelection}
        result={result}
        listError={listError}
      />
    </div>
  );
}
