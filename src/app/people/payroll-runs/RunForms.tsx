'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import {
  cancelRunAction,
  proposeRunAction,
  recalculateRunAction,
  releaseRunAction,
  type PayrollRunActionState,
} from './actions';

function Status({ state }: { state: PayrollRunActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
      {state.ok && state.runId ? (
        <> <Link href={`/people/payroll-runs?run=${state.runId}`} className="underline">Open the run</Link></>
      ) : null}
    </p>
  );
}

export function ProposeRunForm({
  companies,
  defaultCompany,
  defaultYear,
  defaultPeriod,
  requestKey,
}: {
  companies: Array<{ companyCode: string; name: string; currency: string }>;
  defaultCompany: string;
  defaultYear: number;
  defaultPeriod: number;
  requestKey: string;
}) {
  const [state, action, pending] = useActionState(proposeRunAction, { ok: false, requestKey });
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">Propose a run</h2>
      <input type="hidden" name="requestKey" value={state.requestKey ?? requestKey} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="field-label">Company code</span>
          <select name="companyCode" className="field-input w-full" defaultValue={defaultCompany} required>
            {companies.map((c) => (
              <option key={c.companyCode} value={c.companyCode}>{c.companyCode} — {c.name} ({c.currency})</option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Fiscal year</span>
          <input type="number" name="fiscalYear" className="field-input w-full" required min={1900} max={9999} defaultValue={defaultYear} />
        </label>
        <label>
          <span className="field-label">Period</span>
          <select name="period" className="field-input w-full" defaultValue={String(defaultPeriod)} required>
            {Array.from({ length: 16 }, (_, i) => i + 1).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <p className="text-xs text-ink-soft">
        Every employee holding a position in the company during the period is selected. Employees who are not ready are
        listed as exceptions with the reason; nothing is posted.
      </p>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Propose</button>
      <Status state={state} />
    </form>
  );
}

export function RunActions({ runId, status, exceptionCount }: { runId: string; status: string; exceptionCount: number }) {
  const [recalc, recalcAction, recalcPending] = useActionState(recalculateRunAction, { ok: false });
  const [release, releaseAction, releasePending] = useActionState(releaseRunAction, { ok: false });
  const [cancel, cancelAction, cancelPending] = useActionState(cancelRunAction, { ok: false });
  const proposed = status === 'PROPOSED';
  const cancellable = status === 'PROPOSED' || status === 'RELEASED';
  return (
    <section className="panel space-y-3 p-4" aria-label="Run actions">
      <h2 className="panel-title">Actions</h2>
      {proposed && (
        <div className="flex flex-wrap gap-3">
          <form action={recalcAction}>
            <input type="hidden" name="runId" value={runId} />
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={recalcPending}>Recalculate</button>
          </form>
          <form action={releaseAction}>
            <input type="hidden" name="runId" value={runId} />
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={releasePending}>Release</button>
          </form>
          {exceptionCount > 0 && (
            <p className="self-center text-xs text-ink-soft">Release is refused while {exceptionCount} employee{exceptionCount === 1 ? '' : 's'} stand{exceptionCount === 1 ? 's' : ''} as exceptions.</p>
          )}
        </div>
      )}
      <Status state={recalc} />
      <Status state={release} />
      {cancellable && (
        <form action={cancelAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="runId" value={runId} />
          <label className="min-w-64 flex-1">
            <span className="field-label">Reason for cancelling</span>
            <input name="reason" className="field-input w-full" required maxLength={200} />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={cancelPending}>Cancel run</button>
        </form>
      )}
      <Status state={cancel} />
      {!proposed && !cancellable && <p className="text-sm text-ink-soft">This run is {status.toLowerCase()}; nothing more can be done to it here.</p>}
      {status === 'RELEASED' && <p className="text-sm text-ink-soft">Released runs are frozen: they are never recalculated. Posting is payroll phase 3.</p>}
    </section>
  );
}
