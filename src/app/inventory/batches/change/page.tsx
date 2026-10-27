import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { getBatchLevel } from '@/modules/inventory/batch-level';
import { getBatchStatusManagement } from '@/modules/inventory/batch-status';
import { ACTIVITY, BatchChangeError, readBatch } from '@/modules/inventory/batch-change';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock, LockNotice } from '@/ui/lock/ChangeLock';

import BatchRelations from '../BatchRelations';
import DocumentTab from '../DocumentTab';
import ChangeBatchForm from './ChangeBatchForm';
import { displayOnlyRemedy } from '@/ui/lock/remedy';

export const dynamic = 'force-dynamic';

const ROUTE = '/inventory/batches/change';

/** Change batch. MSC2N is a search alias only. A change does not post stock. */
export default async function ChangeBatchPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const canChange = can(session, ACTIVITY);
  const [level, status] = await Promise.all([
    getBatchLevel(session.user.client),
    getBatchStatusManagement(session.user.client),
  ]);
  const plantRequired = level?.batchLevel === '0';
  const materialNumber = params.material?.trim() ?? '';
  const batchNumber = params.batch?.trim() ?? '';
  const plant = params.plant?.trim() ?? '';
  let opened = null;
  let openError: string | null = null;
  if (canChange && level && materialNumber && batchNumber) {
    try {
      opened = await readBatch({
        client: session.user.client,
        materialNumber,
        plant: plantRequired ? plant : undefined,
        batchNumber,
      });
    } catch (error) {
      if (error instanceof BatchChangeError) openError = error.message;
      else throw error;
    }
  }
  const argument = opened
    ? [opened.materialNumber, opened.plant ?? '', opened.batchNumber].filter(Boolean).join('/')
    : '';
  const changeLock = opened
    ? await openChangeForSession(session, { lockObject: 'BATCH', argument, transactionCode: 'MSC2N' })
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · MSC2N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Change batch</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/inventory/batches/display" className="btn btn-default min-h-11 sm:min-h-8">Display batch</Link>
            <Link href="/inventory/batches/new" className="btn btn-default min-h-11 sm:min-h-8">Create batch</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Open a batch that already stands. The batch level is {level ? `${level.batchLevel} — ${level.name}` : 'not set'}.
          The material, plant, and batch number cannot be changed. This screen does not post stock and does not post movements 341 or 342.
          MSC1N and MSC3N are not this screen.
        </p>
      </header>
      {!canChange && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Display only. Ask an administrator for {ACTIVITY}.</p>
      )}
      {canChange && !level && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Set the batch level in OMCE before changing a batch.</p>
      )}
      {canChange && level && (
        <form method="get" action={ROUTE} className="space-y-3 border border-line bg-white p-4">
          <label className="block text-sm">
            Material
            <input name="material" required maxLength={40} defaultValue={materialNumber} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          {plantRequired && (
            <label className="block text-sm">
              Plant
              <input name="plant" required maxLength={10} defaultValue={plant} className="mt-1 w-full border border-line px-2 py-1" />
            </label>
          )}
          <label className="block text-sm">
            Batch number
            <input name="batch" required maxLength={40} defaultValue={batchNumber} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <button type="submit" className="btn btn-default min-h-11">Open batch</button>
        </form>
      )}
      {openError && <p role="alert" className="border border-line bg-white p-3 text-sm">{openError}</p>}
      {canChange && materialNumber && batchNumber && !opened && !openError && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Batch {batchNumber} does not stand for material {materialNumber}. Create it in MSC1N first.</p>
      )}
      {opened && changeLock?.mode === 'DISPLAY' && (
        <>
          <LockNotice message={displayOnlyMessage(changeLock)} remedy={displayOnlyRemedy(changeLock)} />
          <p className="border border-line bg-white p-3 text-sm">
            Batch <span className="code">{opened.batchNumber}</span> stands for material <span className="code">{opened.materialNumber}</span>. This opening is display only.
          </p>
        </>
      )}
      {opened && changeLock?.mode !== 'DISPLAY' && (
        <>
          <ChangeLock lockObject="BATCH" argument={argument} />
          <ChangeBatchForm key={`${opened.id}-${opened.version}`} batch={opened} statusActive={status.scope.effective} />
        </>
      )}
      {opened && <BatchRelations client={session.user.client} />}
      {opened && <DocumentTab client={session.user.client} />}
    </div>
  );
}
