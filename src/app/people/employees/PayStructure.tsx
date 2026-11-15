'use client';

import { useActionState } from 'react';

import {
  assignStructureAction,
  endAssignmentAction,
  type PayrollActionState,
} from '../salary-structures/actions';

function Status({ state }: { state: PayrollActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

/** Assign a structure and base amount from a date. Overlaps are refused by name, never resolved silently. */
export function AssignStructureForm({
  personnelNumber,
  structures,
  defaultCurrency,
  requestKey,
  today,
}: {
  personnelNumber: string;
  structures: Array<{ code: string; name: string; currency: string }>;
  defaultCurrency: string;
  requestKey: string;
  today: string;
}) {
  const [state, action, pending] = useActionState(assignStructureAction, { ok: false, requestKey });
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="personnelNumber" value={personnelNumber} />
      <input type="hidden" name="requestKey" value={state.requestKey ?? requestKey} />
      <div className="grid gap-3 sm:grid-cols-5">
        <label className="sm:col-span-2">
          <span className="field-label">Structure</span>
          <select name="structureCode" className="field-input" required defaultValue="">
            <option value="" disabled>Choose…</option>
            {structures.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name} ({s.currency})</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">Base amount</span>
          <input name="baseAmount" className="field-input code" required inputMode="decimal" />
        </label>
        <label>
          <span className="field-label">Currency</span>
          <input name="currency" className="field-input code" required maxLength={3} defaultValue={defaultCurrency} />
        </label>
        <label>
          <span className="field-label">Valid from</span>
          <input type="date" name="validFrom" className="field-input" required defaultValue={today} />
        </label>
        <label>
          <span className="field-label">Valid to (optional, last day)</span>
          <input type="date" name="validTo" className="field-input" />
        </label>
      </div>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending || structures.length === 0}>Assign structure</button>
      <Status state={state} />
    </form>
  );
}

export function EndAssignmentForm({ assignmentId, defaultEnd }: { assignmentId: string; defaultEnd: string }) {
  const [state, action, pending] = useActionState(endAssignmentAction, { ok: false });
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <input type="date" name="validTo" className="field-input" required defaultValue={defaultEnd} aria-label="Last day" />
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>End</button>
      <Status state={state} />
    </form>
  );
}
