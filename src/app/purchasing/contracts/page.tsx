import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import {
  CONTRACT_DISPLAY_CAPABILITY,
  CONTRACT_LIST_CAPABILITY,
  CONTRACT_MAINTAIN_CAPABILITY,
  contractChoices,
  getPurchaseContract,
  listPurchaseContracts,
} from '@/modules/purchasing/contract';
import { RELEASE_CAPABILITIES, getDocumentRelease } from '@/modules/purchasing/release';
import { ChangeLock } from '@/ui/lock/ChangeLock';
import Contracts from './Contracts';

export const dynamic = 'force-dynamic';

const ROUTE = '/purchasing/contracts';

/**
 * Purchase contract. ME31K create and ME32K change share this route.
 * ME33K is the display route and does not save from here. ME31L is not this screen.
 */
export default async function PurchaseContractsPage({ searchParams }: {
  searchParams: Promise<{ contract?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const allowed = can(session, CONTRACT_MAINTAIN_CAPABILITY)
    || can(session, CONTRACT_DISPLAY_CAPABILITY)
    || can(session, CONTRACT_LIST_CAPABILITY)
    || can(session, RELEASE_CAPABILITIES.PURCHASE_CONTRACT);
  if (!allowed) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Purchase contract</h1>
        <p className="mt-2 text-sm">You do not hold a purchase-contract capability.</p>
      </main>
    );
  }
  const params = await searchParams;
  const client = session.user.client;
  const contractNumber = params.contract?.trim() || '';
  const [documents, choices, selected] = await Promise.all([
    listPurchaseContracts(client),
    contractChoices(client),
    contractNumber ? getPurchaseContract(client, contractNumber) : Promise.resolve(null),
  ]);
  const selectedRelease = selected
    ? await getDocumentRelease(client, 'PURCHASE_CONTRACT', selected.contractNumber)
    : null;
  const canChange = can(session, CONTRACT_MAINTAIN_CAPABILITY);
  const changeLock = selected && canChange
    ? await openChangeForSession(session, {
        lockObject: 'PURCHASE_CONTRACT',
        argument: selected.contractNumber,
        transactionCode: 'ME32K',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{contractNumber ? 'PROC.CONTRACT.MAINTAIN · ME32K' : 'PROC.CONTRACT.MAINTAIN · ME31K'}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Purchase contract</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          ME31K creates a quantity or value contract. ME32K changes the open contract. ME33K is the display screen and does not save. ME35K releases only when a strategy claims the contract. This is not ME31L, and saving it does not receive goods or post accounting.
        </p>
      </header>
      {changeLock?.mode === 'CHANGE' && selected && (
        <ChangeLock lockObject="PURCHASE_CONTRACT" argument={selected.contractNumber} />
      )}
      <Contracts
        documents={documents}
        choices={choices}
        selected={selected}
        canCreate={canChange}
        canRelease={can(session, RELEASE_CAPABILITIES.PURCHASE_CONTRACT)}
        selectedRelease={selectedRelease}
        viewOnly={changeLock?.mode === 'DISPLAY'}
        lockMessage={changeLock ? displayOnlyMessage(changeLock) : null}
      />
    </div>
  );
}
