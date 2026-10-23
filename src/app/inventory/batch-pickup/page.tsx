import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  BATCH_PICKUP_ALIAS,
  BATCH_PICKUP_CAPABILITY,
  BatchPickupError,
  listBatchPickup,
  type BatchPickupResult,
  type BatchPickupSelection,
} from '@/modules/inventory/batch-pickup';
import BatchPickupShell from './BatchPickupShell';

export const dynamic = 'force-dynamic';

/**
 * INV.BATCH.PICKUP (MB5C): pick-up list for batches that already stand on a
 * material document. Read-only. Sales-document selection is refused by name.
 */
export default async function BatchPickupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : '').trim();
  const selection: BatchPickupSelection = {
    material: get('material').toUpperCase(),
    plant: get('plant').toUpperCase(),
    batch: get('batch').toUpperCase(),
    salesOrder: get('salesOrder'),
    delivery: get('delivery'),
    billingDocument: get('billingDocument'),
    schedulingAgreement: get('schedulingAgreement'),
  };
  const asked = Boolean(
    selection.material || selection.plant || selection.batch
    || selection.salesOrder || selection.delivery || selection.billingDocument || selection.schedulingAgreement,
  );

  let result: BatchPickupResult | null = null;
  let reportError: string | null = null;
  if (asked && can(session, BATCH_PICKUP_CAPABILITY)) {
    try {
      result = await listBatchPickup(session.client, selection);
    } catch (caught) {
      reportError = caught instanceof BatchPickupError ? `${caught.message} ${caught.remedy}` : t('mb5c.failed');
    }
  }

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{BATCH_PICKUP_CAPABILITY} · {BATCH_PICKUP_ALIAS}</span>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{t('mb5c.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mb5c.subtitle')}</p>
      </header>
      <BatchPickupShell
        canUse={can(session, BATCH_PICKUP_CAPABILITY)}
        selection={selection}
        result={result}
        reportError={reportError}
      />
    </div>
  );
}
