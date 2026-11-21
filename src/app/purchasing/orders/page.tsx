import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { t } from '@/platform/i18n';
import { PO_CREATE_CAPABILITY, PurchaseOrderError, getOrder, orderChoices } from '@/modules/purchasing/orders';
import { orderDraftFromQuotation, orderDraftFromRequisition } from '@/modules/purchasing/follow-on';
import {
  RELEASE_CAPABILITIES,
  getDocumentRelease,
} from '@/modules/purchasing/release';
import { LinkButton, Page } from '@/ui/kit';
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
      ? await orderDraftFromRequisition(client, params.requisition.trim(), { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => null)
      : params.quotation
        ? await orderDraftFromQuotation(client, params.quotation.trim(), { userId: session.user.userId, sessionId: session.sessionId ?? '' }).catch(() => null)
        : null;
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };
  // A caller without the authority or the company scope sees nothing, as for a document that does not exist.
  const unseen = <T,>(fallback: T) => (error: unknown): T => {
    if (error instanceof PurchaseOrderError) return fallback;
    throw error;
  };
  const choices = await orderChoices(client, authorization).catch(unseen({
    suppliers: [], purchasingOrgs: [], purchasingGroups: [], companies: [], plants: [],
    storageLocations: [], units: [], paymentTerms: [], incoterms: [],
  }));
  const selected = params.order ? await getOrder(client, params.order, authorization).catch(unseen(null)) : null;
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
    <Page
      title={t('purchaseOrder.title')}
      code="PROC.PO.CREATE · ME21N"
      description={t('purchaseOrder.subtitle')}
      actions={<LinkButton href="/purchasing/purchase-order-list">{t('purchaseOrder.list')}</LinkButton>}
      back={{ href: '/', label: t('nav.launchpad') }}
    >
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
    </Page>
  );
}
