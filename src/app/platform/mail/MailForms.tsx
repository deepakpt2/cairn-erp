'use client';

import { useActionState } from 'react';

import type { MailConfigView } from '@/platform/mail/service';
import {
  saveMailConfigAction,
  saveSelfServiceResetAction,
  sendTestMailAction,
  testConnectionAction,
  type MailActionState,
} from './actions';

function Notice({ state }: { state: MailActionState }) {
  if (!state.message) return null;
  return (
    <div
      role={state.ok ? 'status' : 'alert'}
      className={`mt-3 rounded border p-3 text-sm ${state.ok ? 'border-signal-ok/30 text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}
    >
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
    </div>
  );
}

export function NodeForm({ config }: { config: MailConfigView }) {
  const [state, action, pending] = useActionState<MailActionState, FormData>(saveMailConfigAction, { ok: true });
  return (
    <section className="panel p-4">
      <h2 className="panel-title">Node</h2>
      <Notice state={state} />
      <form action={action} className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block"><span className="field-label">Host</span>
          <input name="host" defaultValue={config.host ?? ''} maxLength={200} className="input w-full" autoComplete="off" /></label>
        <label className="block"><span className="field-label">Port</span>
          <input name="port" type="number" min={1} max={65535} defaultValue={config.port} className="input w-full" /></label>
        <label className="block"><span className="field-label">Encryption</span>
          <select name="encryption" defaultValue={config.encryption} className="input w-full">
            <option value="STARTTLS">STARTTLS (587)</option>
            <option value="TLS">TLS (465)</option>
            <option value="NONE">NONE</option>
          </select></label>
        <label className="block"><span className="field-label">Username</span>
          <input name="username" defaultValue={config.username ?? ''} maxLength={200} className="input w-full" autoComplete="off" /></label>
        <label className="block"><span className="field-label">Password · {config.hasPassword ? 'one is set' : 'none set'}</span>
          <input name="password" type="password" defaultValue="" className="input w-full" autoComplete="new-password" placeholder={config.hasPassword ? 'Leave empty to keep the stored password' : ''} /></label>
        <label className="flex items-end gap-2 text-sm"><input name="clearPassword" type="checkbox" /> Remove the stored password</label>
        <label className="block"><span className="field-label">Sender address</span>
          <input name="senderAddress" defaultValue={config.senderAddress ?? ''} maxLength={200} className="input w-full" /></label>
        <label className="block"><span className="field-label">Sender name</span>
          <input name="senderName" defaultValue={config.senderName ?? ''} maxLength={120} className="input w-full" /></label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input name="isEnabled" type="checkbox" defaultChecked={config.isEnabled} /> Node in use (mail is refused while this is off)</label>
        <div className="sm:col-span-2"><button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Saving…' : 'Save node'}</button></div>
      </form>
    </section>
  );
}

export function TestPanel({ config }: { config: MailConfigView }) {
  const [conn, connAction, connPending] = useActionState<MailActionState, FormData>(testConnectionAction, { ok: true });
  const [send, sendAction, sendPending] = useActionState<MailActionState, FormData>(sendTestMailAction, { ok: true });
  return (
    <section className="panel p-4">
      <h2 className="panel-title">Test</h2>
      <div className="mt-4 flex flex-wrap items-end gap-6">
        <form action={connAction}>
          <button type="submit" className="btn btn-default" disabled={connPending}>{connPending ? 'Testing…' : 'Test connection'}</button>
        </form>
        <form action={sendAction} className="flex flex-wrap items-end gap-2">
          <label className="block"><span className="field-label">Send test mail to</span>
            <input name="testAddress" type="email" required maxLength={200} className="input" /></label>
          <button type="submit" className="btn btn-default" disabled={sendPending}>{sendPending ? 'Queuing…' : 'Send test mail'}</button>
        </form>
      </div>
      <Notice state={conn} />
      <Notice state={send} />
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="field-label">Last test</dt><dd className="tabular">{config.lastTestAt ?? '—'}</dd></div>
        <div><dt className="field-label">Result</dt><dd>{config.lastTestResult ?? '—'}</dd></div>
      </dl>
    </section>
  );
}

export function PasswordResetPanel({ enabled, canMaintain, mailEnabled }: { enabled: boolean; canMaintain: boolean; mailEnabled: boolean }) {
  const [state, action, pending] = useActionState<MailActionState, FormData>(saveSelfServiceResetAction, { ok: true });
  return (
    <section className="panel p-4">
      <h2 className="panel-title">Password reset</h2>
      {!mailEnabled && (
        <p className="mt-2 text-xs text-ink-soft">This setting has no effect until the mail node is enabled.</p>
      )}
      <Notice state={state} />
      <form action={action} className="mt-4 space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input name="selfServiceReset" type="checkbox" value="1" defaultChecked={enabled} disabled={!canMaintain} />
          Let users request their own password reset from the sign-in page.
        </label>
        {!canMaintain && (
          <p className="text-xs text-signal-error">
            Saving this needs CFG.PLT.USER.MAINTAIN, which this session does not hold. Ask an administrator to grant CFG.PLT.USER.MAINTAIN to one of your roles.
          </p>
        )}
        <p className="text-xs text-ink-soft">Off by default. Whoever controls a user's mailbox controls that login, so turning this on is recorded in a change document.</p>
        <button type="submit" className="btn btn-primary" disabled={pending || !canMaintain}>{pending ? 'Saving…' : 'Save'}</button>
      </form>
    </section>
  );
}
