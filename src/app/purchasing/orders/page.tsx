import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { t } from '@/platform/i18n';
import { PO_CREATE_CAPABILITY, getOrder, orderChoices } from '@/modules/purchasing/orders';
import { orderDraftFromQuotation, orderDraftFromRequisition } from '@/modules/purchasing/follow-on';
import {
  RELEASE_CAPABILITIES,
  getDocumentRelease,
} from '@/modules/purchasing/release';
import Orders from './Orders';
import { ChangeLock } from '@/ui/lock/ChangeLock';

export const dynamic = 'force-dynamic';

const ROUTE = '/purchasing/orders';

/**
 * Purchase orders (SCR-056 / ME21N create, ME22N change).
 * Display is SCR-164, not this screen.
 */
export default async function PurchaseOrdersPage({ searchParams }: {
  searchParams: Promise<{ order?: string; quotation?: string; requisition?: string; contract?: string; contractItem?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const draft = params.order
    ? null
    : params.requisition
      ? await orderDraftFromRequisition(client, params.requisition.trim())
      : params.quotation
        ? await orderDraftFromQuotation(client, params.quotation.trim())
        : null;
  const choices = await orderChoices(client);
  const selected = params.order ? await getOrder(client, params.order) : null;
  const selectedRelease = selected
    ? await getDocumentRelease(client, 'PURCHASE_ORDER', selected.orderNumber)
    : null;
  const canChange = can(session, PO_CREATE_CAPABILITY);
  const changeLock = selected && canChange
    ? await openChangeForSession(session, {
        lockObject: 'PURCHASE_ORDER',
        argument: selected.orderNumber,
        transactionCode: 'ME22N',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.PO.CREATE · ME21N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('purchaseOrder.title')}</h1>
          <div className="flex gap-2">
            <Link href="/purchasing/purchase-order-list" className="btn btn-default min-h-11 sm:min-h-8">
              {t('purchaseOrder.list')}
            </Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.launchpad')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('purchaseOrder.subtitle')}</p>
      </header>

      {changeLock?.mode === 'CHANGE' && selected && (
        <ChangeLock lockObject="PURCHASE_ORDER" argument={selected.orderNumber} />
      )}
      <Orders
        choices={choices}
        selected={selected}
        canCreate={canChange}
        viewOnly={changeLock?.mode === 'DISPLAY'}
        lockMessage={changeLock ? displayOnlyMessage(changeLock) : null}
        selectedRelease={selectedRelease}
        canRelease={can(session, RELEASE_CAPABILITIES.PURCHASE_ORDER)}
        draft={draft}
        callOff={params.contract ? { contractNumber: params.contract, contractItem: params.contractItem ?? '' } : null}
      />
    </div>
  );
}
