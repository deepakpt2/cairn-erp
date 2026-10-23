'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { DocumentManagementRow } from '@/modules/inventory/batch-document-management';
import { useChangeLock } from '@/ui/lock/ChangeLock';

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
  const lock = useChangeLock('BATCH_DOCUMENT_MANAGEMENT', client, 'ODOC', canMaintain);
  const writable = canMaintain && lock?.mode !== 'DISPLAY';
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
      {lock?.mode === 'DISPLAY' && lock.message && (
        <p role="status" className="text-sm">{lock.message}</p>
      )}
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
