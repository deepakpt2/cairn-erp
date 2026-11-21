
import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  PR_CREATE_CAPABILITY,
  PurchaseRequisitionError,
  getRequisition,
  requisitionChoices,
} from '@/modules/purchasing/requisitions';
import {
  RELEASE_CAPABILITIES,
  getDocumentRelease,
} from '@/modules/purchasing/release';
import Requisitions from './Requisitions';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/purchasing/requisitions';

/**
 * Purchase requisitions (SCR-055 / ME51N create, ME52N change, ME53N
 * display; inert in stage 1, live since stage 3).
 */
export default async function PurchaseRequisitionsPage({ searchParams }: {
  searchParams: Promise<{ req?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };
  // A caller without the authority or the company scope sees nothing, as for a document that does not exist.
  const unseen = <T,>(fallback: T) => (error: unknown): T => {
    if (error instanceof PurchaseRequisitionError) return fallback;
    throw error;
  };
  const choices = await requisitionChoices(client, authorization).catch(unseen({
    plants: [], storageLocations: [], purchasingGroups: [], units: [], employees: [],
  }));
  const selected = params.req ? await getRequisition(client, params.req, authorization).catch(unseen(null)) : null;
  const selectedRelease = selected
    ? await getDocumentRelease(client, 'PURCHASE_REQUISITION', selected.requisitionNumber)
    : null;
  const canChange = can(session, PR_CREATE_CAPABILITY);
  const changeLock = selected && canChange
    ? await openChangeForSession(session, {
        lockObject: 'PURCHASE_REQUISITION',
        argument: selected.requisitionNumber,
        transactionCode: 'ME52N',
      })
    : null;

  return (
    <Page
      title={t('purchaseRequisition.title')} code="PROC.PR.CREATE · ME51N" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('purchaseRequisition.subtitle')}</p>
        </>
      }
      actions={
        <>
          <LinkButton href="/purchasing/requisition-list">
                        {t('purchaseRequisition.list')}
                      </LinkButton>
          <LinkButton href="/">
                        {t('nav.launchpad')}
                      </LinkButton>
        </>
      }
    >

      {changeLock?.mode === 'CHANGE' && selected && (
        <ChangeLock lockObject="PURCHASE_REQUISITION" argument={selected.requisitionNumber} />
      )}
      <Requisitions
        choices={choices}
        selected={selected}
        canCreate={canChange}
        viewOnly={changeLock?.mode === 'DISPLAY'}
        lockMessage={changeLock ? displayOnlyMessage(changeLock) : null}
        selectedRelease={selectedRelease}
        canRelease={can(session, RELEASE_CAPABILITIES.PURCHASE_REQUISITION)}
      />
    </Page>
  );
}
