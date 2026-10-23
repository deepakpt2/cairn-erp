import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { getBatchLevel } from '@/modules/inventory/batch-level';
import { getInternalBatchAssignment } from '@/modules/inventory/batch-number-assignment';
import { getBatchStatusManagement } from '@/modules/inventory/batch-status';
import { ACTIVITY } from '@/modules/inventory/batch-master';

import DocumentTab from '../DocumentTab';
import CreateBatchForm from './CreateBatchForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/inventory/batches/new';

/** Create batch. MSC1N is a search alias only. A batch does not post stock. */
export default async function CreateBatchPage() {
  const session = await requireSession(ROUTE);
  const canCreate = can(session, ACTIVITY);
  const [level, status, numbering] = await Promise.all([
    getBatchLevel(session.user.client),
    getBatchStatusManagement(session.user.client),
    getInternalBatchAssignment(session.user.client),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · MSC1N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Create batch</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/inventory/batches/display" className="btn btn-default min-h-11 sm:min-h-8">Display batch</Link>
            <Link href="/inventory/batches/change" className="btn btn-default min-h-11 sm:min-h-8">Change batch</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          The material must already be batch-managed. The batch level is {level ? `${level.batchLevel} — ${level.name}` : 'not set'}.
          A plant is required only at plant level. This screen does not post stock and does not classify the batch. A blank number draws an internal number only when OMCZ is active.
          MSC2N and MSC3N are not this screen.
        </p>
      </header>
      {!level && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Set the batch level in OMCE before creating a batch.</p>
      )}
      {!canCreate && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Display only. Ask an administrator for {ACTIVITY}.</p>
      )}
      <CreateBatchForm
        plantRequired={level?.batchLevel === '0'}
        statusActive={status.scope.effective}
        internalActive={numbering.code === 'X'}
        canCreate={canCreate && !!level}
      />
      <DocumentTab client={session.user.client} />
    </div>
  );
}
