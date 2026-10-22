import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock } from '@/ui/lock/ChangeLock';
import { t } from '@/platform/i18n';
import {
  PR_CREATE_CAPABILITY,
  getRequisition,
  listRequisitions,
  requisitionChoices,
} from '@/modules/purchasing/requisitions';
import {
  RELEASE_CAPABILITIES,
  getDocumentRelease,
  listDocumentReleases,
} from '@/modules/purchasing/release';
import Requisitions from './Requisitions';

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
  const [documents, choices, releases] = await Promise.all([
    listRequisitions(client),
    requisitionChoices(client),
    listDocumentReleases(client, 'PURCHASE_REQUISITION'),
  ]);
  const selected = params.req ? await getRequisition(client, params.req) : null;
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
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.PR.CREATE · ME51N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('purchaseRequisition.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('purchaseRequisition.subtitle')}</p>
      </header>

      {changeLock?.mode === 'CHANGE' && selected && (
        <ChangeLock lockObject="PURCHASE_REQUISITION" argument={selected.requisitionNumber} />
      )}
      <Requisitions
        documents={documents}
        choices={choices}
        selected={selected}
        canCreate={canChange}
        viewOnly={changeLock?.mode === 'DISPLAY'}
        lockMessage={changeLock ? displayOnlyMessage(changeLock) : null}
        releases={Object.fromEntries(releases)}
        selectedRelease={selectedRelease}
        canRelease={can(session, RELEASE_CAPABILITIES.PURCHASE_REQUISITION)}
      />
    </div>
  );
}
