'use client';

import { useActionState, useState } from 'react';

import { createAuditGrantAction, revokeAuditGrantAction, type AuditGrantActionState } from './actions';

const SCOPE_KINDS = [
  { value: 'COMPANY_CODE', label: 'Company code' },
  { value: 'PERIOD', label: 'Period (YYYYPP)' },
  { value: 'MODULE', label: 'Module' },
] as const;

function Status({ state }: { state: AuditGrantActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

export function CreateGrantForm({
  auditors,
  requestKey,
  defaultFrom,
}: {
  auditors: Array<{ userId: string; username: string; fullName: string }>;
  requestKey: string;
  defaultFrom: string;
}) {
  const [state, action, pending] = useActionState(createAuditGrantAction, { ok: false, requestKey });
  const [rows, setRows] = useState(2);
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">Grant auditor access</h2>
      <p className="text-sm text-ink-soft">
        Time-boxed and scoped. The grant carries no capability: while it is live, everything the auditor holds is cut to
        display, and nothing they do can post, change or delete.
      </p>
      <input type="hidden" name="requestKey" value={state.requestKey ?? requestKey} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="field-label">Auditor</span>
          <select name="auditorUserId" className="field-input" required defaultValue="">
            <option value="" disabled>Choose…</option>
            {auditors.map((a) => <option key={a.userId} value={a.userId}>{a.username} — {a.fullName}</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">Valid from</span>
          <input type="date" name="validFrom" className="field-input" required defaultValue={defaultFrom} />
        </label>
        <label>
          <span className="field-label">Valid to (required)</span>
          <input type="date" name="validTo" className="field-input" required />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="field-label">Scope — at least one company code, period or module</legend>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-2">
            <select name="scopeKind[]" className="field-input" defaultValue={i === 1 ? 'MODULE' : 'COMPANY_CODE'} aria-label={`Scope kind ${i + 1}`}>
              {SCOPE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <input name="scopeValue[]" className="field-input code" maxLength={20} aria-label={`Scope value ${i + 1}`} placeholder="1000 · 202610 · FIN" />
          </div>
        ))}
        <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setRows((n) => n + 1)}>Add scope row</button>
      </fieldset>
      <label className="block">
        <span className="field-label">Reason</span>
        <input name="reason" className="field-input w-full" required maxLength={500} placeholder="Engagement and why the access is needed" />
      </label>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Grant access</button>
      <Status state={state} />
    </form>
  );
}

export function RevokeGrantForm({ grantId }: { grantId: string }) {
  const [state, action, pending] = useActionState(revokeAuditGrantAction, { ok: false });
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="grantId" value={grantId} />
      <input name="reason" className="field-input" required maxLength={500} placeholder="Reason" aria-label={`Reason to revoke ${grantId}`} />
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Revoke</button>
      <Status state={state} />
    </form>
  );
}
