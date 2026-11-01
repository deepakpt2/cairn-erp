'use client';

import { useActionState } from 'react';
import { changeUserAction, setUserLockAction, type UserActionState } from './actions';

const EMPTY: UserActionState = { ok: false };

function Notice({ state }: { state: UserActionState }) {
  if (!state.message) return null;
  return <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status"><p className="font-medium">{state.message}</p>{state.remedy && <p className="mt-1 text-ink-soft">{state.remedy}</p>}</div>;
}

export default function UserDetailControls({
  id,
  fullName,
  email,
  isActive,
  isLocked,
  canMaintain,
  canReset,
}: {
  id: string;
  fullName: string;
  email: string | null;
  isActive: boolean;
  isLocked: boolean;
  canMaintain: boolean;
  canReset: boolean;
}) {
  const [changeState, changeAction, changing] = useActionState(changeUserAction, EMPTY);
  const [lockState, lockAction, locking] = useActionState(setUserLockAction, EMPTY);

  return (
    <div className="space-y-4">
      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Account details</h2>
        {canMaintain ? (
          <form action={changeAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input type="hidden" name="userId" value={id} />
            <label className="text-xs font-medium text-ink-soft">Full name
              <input name="fullName" required minLength={2} maxLength={120} defaultValue={fullName} className="mt-1 block min-h-10 w-full border bg-transparent p-2" />
            </label>
            <label className="text-xs font-medium text-ink-soft">Email
              <input name="email" type="email" maxLength={200} defaultValue={email ?? ''} className="mt-1 block min-h-10 w-full border bg-transparent p-2" />
              <span className="mt-1 block font-normal text-ink-faint">Leave blank to clear the application-account email.</span>
            </label>
            <label className="text-xs font-medium text-ink-soft">Account active
              <select name="isActive" defaultValue={isActive ? 'true' : 'false'} className="mt-1 block min-h-10 w-full border bg-transparent p-2">
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </label>
            <div className="flex items-end"><button type="submit" disabled={changing} className="btn w-full">{changing ? 'Saving…' : 'Save account details'}</button></div>
          </form>
        ) : <p className="text-sm text-ink-soft">Read-only: {`CFG.PLT.USER.MAINTAIN`} is required to change account details.</p>}
        <p className="text-xs text-ink-faint">Deactivating the account revokes its persisted sessions. Reactivating it does not revive those sessions. Employee records and role assignments are not changed here.</p>
        <Notice state={changeState} />
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Authentication state</h2>
        <p className="text-sm">Account is <strong>{isLocked ? 'locked' : 'unlocked'}</strong>.</p>
        {canMaintain ? (
          <form action={lockAction}>
            <input type="hidden" name="userId" value={id} />
            <input type="hidden" name="isLocked" value={isLocked ? 'false' : 'true'} />
            <button type="submit" disabled={locking} className="btn btn-default">{locking ? 'Updating…' : isLocked ? 'Unlock account' : 'Lock account and revoke sessions'}</button>
          </form>
        ) : <p className="text-sm text-ink-soft">Read-only: {`CFG.PLT.USER.MAINTAIN`} is required to lock or unlock accounts.</p>}
        <p className="text-xs text-ink-faint">Locking revokes all currently persisted sessions. Unlocking resets the failed-login counter, but does not create a session or change the password.</p>
        <Notice state={lockState} />
      </section>

      {canReset && <aside className="rounded border border-line bg-row p-3 text-sm"><h2 className="font-medium">Password reset</h2><p className="mt-1 text-ink-soft">Administrator-issued password reset is unavailable until an approved outbound delivery channel is configured. The reset action is intentionally not minting or exposing a token.</p></aside>}
    </div>
  );
}
