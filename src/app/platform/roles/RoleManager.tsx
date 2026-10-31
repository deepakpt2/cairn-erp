'use client';

import { useActionState, type ReactNode } from 'react';
import {
  createRoleAction,
  grantCapabilityAction,
  grantUserRoleAction,
  revokeCapabilityAction,
  revokeUserRoleAction,
  setRoleActiveAction,
  updateRoleAction,
  type RoleAdminActionState,
} from './actions';
import type { RoleAdminOverview } from '@/modules/platform/role-admin';

const EMPTY: RoleAdminActionState = { ok: false };
type Action = (state: RoleAdminActionState, form: FormData) => Promise<RoleAdminActionState>;

function ActionForm({ action, children }: { action: Action; children: ReactNode }) {
  const [state, formAction, pending] = useActionState(action, EMPTY);
  return <form action={formAction} className="space-y-2">{children}<button type="submit" disabled={pending} className="btn btn-default">{pending ? 'Saving…' : 'Save'}</button>{state.message ? <div className={state.ok ? 'text-sm text-success' : 'text-sm text-danger'} role="status">{state.message}{state.remedy ? <p className="text-ink-soft">{state.remedy}</p> : null}</div> : null}</form>;
}

function Field({ label, name, value, maxLength }: { label: string; name: string; value?: string | null; maxLength: number }) {
  return <label className="block text-xs font-medium text-ink-soft">{label}<input name={name} defaultValue={value ?? ''} maxLength={maxLength} required={name !== 'description'} className="mt-1 w-full rounded border border-line bg-transparent px-2 py-1 text-sm text-ink" /></label>;
}

export default function RoleManager({ overview, actorUserId }: { overview: RoleAdminOverview; actorUserId: string }) {
  const assignableRoles = overview.roles.filter((r) => r.isActive && !r.isSystemRole && r.code !== 'PLATFORM_ADMIN' && !r.capabilities.some((cap) => cap.includes('*') || cap === 'CFG.PLT.ROLE.MAINTAIN' || cap === 'CFG.PLT.USER.ROLE.MAINTAIN'));
  const assignableUsers = overview.users.filter((user) => user.id !== actorUserId && user.isActive && !user.isLocked);
  return (
    <div className="space-y-5">
      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">Create a custom role</h2>
        <ActionForm action={createRoleAction}>
          <div className="grid gap-3 md:grid-cols-2"><Field label="Role code" name="code" maxLength={40} /><Field label="Name" name="name" maxLength={80} /><Field label="Description" name="description" maxLength={1000} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isReadOnly" /> Read-only (posting capabilities refused)</label></div>
        </ActionForm>
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="font-semibold">Assign an ordinary role to another user</h2>
        {assignableUsers.length && assignableRoles.length ? <ActionForm action={grantUserRoleAction}>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-xs font-medium text-ink-soft">User<select name="userId" required className="mt-1 w-full rounded border border-line bg-transparent p-2 text-sm">{assignableUsers.map((user) => <option key={user.id} value={user.id}>{user.username} — {user.fullName}</option>)}</select></label>
            <label className="text-xs font-medium text-ink-soft">Role<select name="roleCode" required className="mt-1 w-full rounded border border-line bg-transparent p-2 text-sm">{assignableRoles.map((role) => <option key={role.code} value={role.code}>{role.code} — {role.name}</option>)}</select></label>
          </div>
          <p className="text-xs text-ink-faint">Self-assignment, wildcard roles, and the protected platform-admin role are refused by the service.</p>
        </ActionForm> : <p className="text-sm text-ink-soft">Create an active custom role and ensure an active, unlocked target account exists.</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Tenant roles ({overview.roles.length})</h2>
        {overview.roles.map((role) => {
          const protectedRole = role.isSystemRole || role.code === 'PLATFORM_ADMIN';
          const assignableCapabilities = overview.capabilities.filter((cap) => !role.capabilities.includes(cap.code) && cap.code !== 'CFG.PLT.ROLE.MAINTAIN' && cap.code !== 'CFG.PLT.USER.ROLE.MAINTAIN');
          return <article key={role.code} className="panel space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><span className="code text-ink-faint">{role.code}{protectedRole ? ' · PROTECTED' : ''}</span><h3 className="font-semibold">{role.name}</h3><p className="text-sm text-ink-soft">{role.description || 'No description.'}</p><p className="mt-1 text-xs">{role.isActive ? 'Active' : 'Inactive'}{role.isReadOnly ? ' · Read-only' : ''}</p></div>
              {!protectedRole ? <div className="flex flex-wrap gap-2">
                <ActionForm action={setRoleActiveAction}><input type="hidden" name="code" value={role.code} /><input type="hidden" name="isActive" value={String(!role.isActive)} /><button type="submit" className="btn btn-default">{role.isActive ? 'Deactivate' : 'Activate'}</button></ActionForm>
              </div> : null}
            </div>
            {!protectedRole ? <ActionForm action={updateRoleAction}><input type="hidden" name="code" value={role.code} /><div className="grid gap-3 md:grid-cols-2"><Field label="Name" name="name" value={role.name} maxLength={80} /><Field label="Description" name="description" value={role.description} maxLength={1000} /></div></ActionForm> : null}
            <div><h4 className="text-sm font-semibold">Capabilities ({role.capabilities.length})</h4>
              {role.capabilities.length ? <ul className="mt-2 flex flex-wrap gap-2">{role.capabilities.map((cap) => <li key={cap} className="rounded border border-line px-2 py-1 text-xs"><span className="code">{cap}</span>{!protectedRole ? <ActionForm action={revokeCapabilityAction}><input type="hidden" name="roleCode" value={role.code} /><input type="hidden" name="capabilityCode" value={cap} /><button type="submit" className="ml-2 text-danger underline">Revoke</button></ActionForm> : null}</li>)}</ul> : <p className="mt-1 text-sm text-ink-faint">No capability assignments.</p>}
            </div>
            {!protectedRole && role.isActive ? <ActionForm action={grantCapabilityAction}><div className="grid gap-3 md:grid-cols-2"><input type="hidden" name="roleCode" value={role.code} /><label className="text-xs font-medium text-ink-soft">Registered capability<select name="capabilityCode" required className="mt-1 w-full rounded border border-line bg-transparent p-2 text-sm">{assignableCapabilities.map((cap) => <option key={cap.code} value={cap.code}>{cap.code} — {cap.description ?? cap.action}</option>)}</select></label></div></ActionForm> : null}
          </article>;
        })}
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="text-lg font-semibold">User-role assignments</h2>
        {overview.users.map((user) => <div key={user.id} className="border-b border-line pb-3 last:border-0">
          <p className="font-medium">{user.username} <span className="text-xs text-ink-faint">{user.fullName} · {user.isActive ? 'active' : 'inactive'}{user.isLocked ? ' · locked' : ''}</span></p>
          {user.roles.length ? <ul className="mt-1 space-y-1">{user.roles.map((assignment) => {
            const active = new Date(assignment.validFrom).getTime() <= Date.now() && (!assignment.validTo || new Date(assignment.validTo).getTime() >= Date.now());
            return <li key={assignment.code} className="flex flex-wrap items-center gap-2 text-sm"><span>{assignment.code} — {assignment.name}{active ? '' : ' (inactive assignment)'}</span>{user.id !== actorUserId && active && assignment.code !== 'PLATFORM_ADMIN' ? <ActionForm action={revokeUserRoleAction}><input type="hidden" name="userId" value={user.id} /><input type="hidden" name="roleCode" value={assignment.code} /><button type="submit" className="text-danger underline">Revoke</button></ActionForm> : null}</li>;
          })}</ul> : <p className="text-sm text-ink-faint">No roles assigned.</p>}
        </div>)}
      </section>

      <section className="panel p-4">
        <h2 className="font-semibold">Capability catalogue ({overview.capabilities.length})</h2>
        <p className="mt-1 text-sm text-ink-soft">Only these registered codes can be assigned. Role capability patterns are not created by this maintenance path.</p>
        <ul className="mt-3 grid gap-1 md:grid-cols-2">{overview.capabilities.map((cap) => <li key={cap.code} className="text-xs"><span className="code">{cap.code}</span> · {cap.module}/{cap.action}{cap.isPostingRelevant ? ' · posting-relevant' : ''}</li>)}</ul>
      </section>
    </div>
  );
}
