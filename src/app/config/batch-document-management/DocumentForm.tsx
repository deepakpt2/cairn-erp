'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { DocumentManagementRow } from '@/modules/inventory/batch-document-management';
import { ClaimFailureNotice, LockNotice, useChangeLockClaim } from '@/ui/lock/ChangeLock';

import { saveDocumentManagementAction, type DocumentActionState } from './actions';

const empty: DocumentActionState = { ok: false };

export default function DocumentForm({
  client,
  current,
  canMaintain,
}: {
  client: string;
  current: DocumentManagementRow;
  canMaintain: boolean;
}) {
  const router = useRouter();
  const { claim, notice, retry } = useChangeLockClaim('BATCH_DOCUMENT_MANAGEMENT', client, 'ODOC', canMaintain);
  const refused = claim.phase === 'refused';
  // Writable on an answer, not on the absence of a refusal. While the claim is in flight this reads as it
  // always did — and the save is then answered by the action, which re-checks this session's lock — but a
  // claim that never answered used to leave the form open and silent. It is closed now, with the reason on
  // the screen and the one control that can ask for the opening again.
  const writable = canMaintain && !refused && claim.phase !== 'failed';
  const opened = current.code === 'X' ? 'X' : current.version > 0 ? '' : undefined;
  const [selected, setSelected] = useState<string | undefined>(opened);
  const [requestKey, setRequestKey] = useState('');
  const [state, save, pending] = useActionState(saveDocumentManagementAction, empty);
  const version = state.version ?? current.version;

  useEffect(() => {
    setRequestKey((key) => key || crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (state.replaceRequestKey) setRequestKey(crypto.randomUUID());
    if (state.ok) router.refresh();
  }, [state.replaceRequestKey, state.ok, state.message, router]);

  return (
    <form action={save} className="space-y-3 border border-line bg-white p-4">
      <h2 className="text-sm font-semibold">Document management for batches</h2>
      <p className="text-sm text-ink-soft">
        KZDCD. Active is X. Not active is blank. A missing row is not active.
        Saving does not create a document, upload a file, or post.
      </p>
      <LockNotice message={refused ? notice.message : null} remedy={refused ? notice.remedy : null} />
      <ClaimFailureNotice claim={claim} onRetry={retry} />
      <fieldset className="space-y-2 text-sm" disabled={!writable}>
        <legend className="font-medium">Indicator</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="documentManagement" value="X" checked={selected === 'X'} onChange={() => setSelected('X')} />
          <span>X · Active. The documents tab is visible on the batch master.</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="documentManagement" value="" checked={selected === ''} onChange={() => setSelected('')} />
          <span>Blank · Not active. The tab is hidden. A batch and a link are not deleted.</span>
        </label>
      </fieldset>
      <label className="block text-sm">
        Reason
        <input name="reason" required minLength={3} maxLength={500} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending || selected === undefined}>
        {pending ? 'Saving' : 'Save indicator'}
      </button>
      {state.message && (
        <div role={state.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
        </div>
      )}
    </form>
  );
}
