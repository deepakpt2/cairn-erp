'use client';

import { useActionState, useState } from 'react';

import {
  confirmEnrolmentAction, disableMfaAction, regenerateCodesAction, type MfaState,
} from './mfa-actions';

const NONE: MfaState = { ok: false };

function Notice({ state }: { state: MfaState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className={`mt-3 rounded border p-3 text-sm ${state.ok ? 'border-signal-ok/30 text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}>
      <p>{state.message}</p>{state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
    </div>
  );
}

/** Shown once, behind a box the user ticks to say the codes are stored. Never re-displayed. */
function RecoveryCodes({ codes }: { codes: string[] }) {
  const [stored, setStored] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const text = codes.join('\n') + '\n';
  return (
    <div className="mt-3 rounded border border-line p-3">
      <p className="text-sm font-medium">Recovery codes — each works once. They are shown only now.</p>
      <ol className="code mt-2 grid grid-cols-2 gap-1 text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ol>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-default" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
        <a className="btn btn-default" download="recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}>Download</a>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} /> I have stored these codes safely.</label>
        <button type="button" className="btn btn-primary" disabled={!stored} onClick={() => setHidden(true)}>Done</button>
      </div>
    </div>
  );
}

export function ConfirmPanel() {
  const [state, action, pending] = useActionState(confirmEnrolmentAction, NONE);
  return (
    <>
      <form action={action} className="mt-3 flex max-w-sm items-end gap-2">
        <label className="block flex-1 text-xs font-medium uppercase tracking-wide text-ink-soft">Code from the app
          <input name="code" required inputMode="numeric" autoComplete="one-time-code" className="field-input code mt-1 w-full" placeholder="123456" />
        </label>
        <button type="submit" disabled={pending} className="btn btn-primary">{pending ? 'Checking…' : 'Confirm'}</button>
      </form>
      <Notice state={state} />
      {state.recoveryCodes && <RecoveryCodes codes={state.recoveryCodes} />}
    </>
  );
}

export function RegeneratePanel() {
  const [state, action, pending] = useActionState(regenerateCodesAction, NONE);
  return (
    <>
      <form action={action} className="mt-2 flex max-w-sm items-end gap-2">
        <label className="block flex-1 text-xs font-medium uppercase tracking-wide text-ink-soft">Password
          <input name="password" type="password" required autoComplete="current-password" className="field-input mt-1 w-full normal-case" />
        </label>
        <button type="submit" disabled={pending} className="btn btn-default">Regenerate recovery codes</button>
      </form>
      <Notice state={state} />
      {state.recoveryCodes && <RecoveryCodes codes={state.recoveryCodes} />}
    </>
  );
}

export function DisablePanel() {
  const [state, action, pending] = useActionState(disableMfaAction, NONE);
  return (
    <>
      <form action={action} className="mt-2 grid max-w-md grid-cols-1 gap-2 sm:grid-cols-3 sm:items-end">
        <label className="block text-xs font-medium uppercase tracking-wide text-ink-soft">Password
          <input name="password" type="password" required autoComplete="current-password" className="field-input mt-1 w-full normal-case" />
        </label>
        <label className="block text-xs font-medium uppercase tracking-wide text-ink-soft">Current code
          <input name="code" required inputMode="numeric" autoComplete="one-time-code" className="field-input code mt-1 w-full" />
        </label>
        <button type="submit" disabled={pending} className="btn btn-default">Turn off</button>
      </form>
      <Notice state={state} />
    </>
  );
}
