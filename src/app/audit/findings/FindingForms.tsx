'use client';

import { useActionState, useEffect, useRef } from 'react';

import {
  exportEvidenceAction,
  logFindingsViewAction,
  raiseFindingAction,
  respondToFindingAction,
  type ExportState,
  type FindingActionState,
} from './actions';

function Status({ state }: { state: FindingActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

/** Logs the view once, after render. Renders nothing. */
export function LogFindingsView({ detail }: { detail: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void logFindingsViewAction(detail);
  }, [detail]);
  return null;
}

export function RaiseFindingForm({
  grantId,
  objectClass,
  objectKey,
}: {
  grantId: string | null;
  objectClass?: string;
  objectKey?: string;
}) {
  const [state, action, pending] = useActionState(raiseFindingAction, { ok: false });
  const bookmark = Boolean(objectClass && objectKey);
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">Raise</h2>
      {grantId && <input type="hidden" name="grantId" value={grantId} />}
      {objectClass && <input type="hidden" name="objectClass" value={objectClass} />}
      {objectKey && <input type="hidden" name="objectKey" value={objectKey} />}
      {bookmark && <p className="text-sm text-ink-soft">Bookmark on <span className="code">{objectClass} {objectKey}</span></p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="field-label">Kind</span>
          <select name="kind" className="field-input" defaultValue={bookmark ? 'BOOKMARK' : 'FINDING'}>
            <option value="FINDING">Finding</option>
            <option value="NOTE">Note</option>
            <option value="BOOKMARK">Bookmark</option>
            <option value="REQUEST">Request to management</option>
          </select>
        </label>
        <label className="sm:col-span-2">
          <span className="field-label">Subject</span>
          <input name="subject" className="field-input w-full" required maxLength={120} />
        </label>
      </div>
      <label className="block">
        <span className="field-label">Body</span>
        <textarea name="body" className="field-input w-full" required rows={3} />
      </label>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Raise</button>
      <Status state={state} />
    </form>
  );
}

export function RespondForm({ findingId }: { findingId: string }) {
  const [state, action, pending] = useActionState(respondToFindingAction, { ok: false });
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="findingId" value={findingId} />
      <textarea name="response" className="field-input w-full" required rows={2} aria-label="Response" placeholder="Management's response" />
      <div className="flex flex-wrap items-center gap-2">
        <select name="status" className="field-input" defaultValue="ANSWERED" aria-label="Status">
          <option value="ANSWERED">Answered</option>
          <option value="ACCEPTED">Accepted</option>
          <option value="WITHDRAWN">Withdrawn</option>
        </select>
        <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Respond</button>
      </div>
      <Status state={state} />
    </form>
  );
}

const emptyExport: ExportState = { ok: false };

export function ExportEvidenceForm() {
  const [state, action, pending] = useActionState(exportEvidenceAction, emptyExport);
  const saved = useRef<string | null>(null);
  useEffect(() => {
    if (!state.ok || !state.csv || !state.filename || saved.current === state.csv) return;
    saved.current = state.csv;
    const url = URL.createObjectURL(new Blob([state.csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = state.filename;
    link.click();
    URL.revokeObjectURL(url);
  }, [state]);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Export evidence pack (CSV)</button>
      <Status state={state} />
    </form>
  );
}
