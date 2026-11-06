'use client';

import { useActionState, useState, type ReactNode } from 'react';
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
import {
  assignableCapabilitiesFor,
  capabilityOptionLabel,
  type CapabilityOption,
} from './capability-option';

const EMPTY: RoleAdminActionState = { ok: false };
type Action = (state: RoleAdminActionState, form: FormData) => Promise<RoleAdminActionState>;

function ActionForm({ action, children }: { action: Action; children: ReactNode }) {
  const [state, formAction, pending] = useActionState(action, EMPTY);
  return <form action={formAction} className="space-y-2">{children}<button type="submit" disabled={pending} className="btn btn-default">{pending ? 'Saving…' : 'Save'}</button>{state.message ? <div className={state.ok ? 'text-sm text-success' : 'text-sm text-danger'} role="status">{state.message}{state.remedy ? <p className="text-ink-soft">{state.remedy}</p> : null}</div> : null}</form>;
}

function Field({ label, name, value, maxLength }: { label: string; name: string; value?: string | null; maxLength: number }) {
  return <label className="block text-xs font-medium text-ink-soft">{label}<input name={name} defaultValue={value ?? ''} maxLength={maxLength} required={name !== 'description'} className="mt-1 w-full rounded border border-line bg-transparent px-2 py-1 text-sm text-ink" /></label>;
}

/**
 * Granting a capability: search, then choose.
 *
 * The option list shows the code and its module/action pair only. Descriptions
 * run to thousands of characters, and putting one in an <option> makes the
 * native list wider than the screen, which is what left the drop-down looking
 * misaligned and unreadable. The description of the selected row is shown
 * underneath instead, where it can wrap and be read. The search is local to
 * this role so the catalogue filter at the foot of the page cannot empty it.
 */
function CapabilityGrantField({ roleCode, capabilities, held }: { roleCode: string; capabilities: CapabilityOption[]; held: string[] }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const options = assignableCapabilitiesFor(held, capabilities, query);
  // A capability just granted leaves the list; do not keep pointing at it.
  const effectiveSelected = options.some((cap) => cap.code === selected) ? selected : '';
  const chosen = options.find((cap) => cap.code === effectiveSelected) ?? null;
  const hint = chosen
    ? chosen.description ?? 'No description recorded for this capability.'
    : options.length
      ? `Choose one of ${options.length} assignable capabilities. The description of the selected capability appears here.`
      : query.trim()
        ? 'No capability matches this search.'
        : 'Every registered capability is already granted to this role.';
  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-ink-soft" htmlFor={`capability-search-${roleCode}`}>Find a capability<input id={`capability-search-${roleCode}`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Code, module, action or description" autoComplete="off" className="field-input mt-1" /></label>
      {options.length ? <label className="block text-xs font-medium text-ink-soft" htmlFor={`capability-code-${roleCode}`}>Registered capability<select id={`capability-code-${roleCode}`} name="capabilityCode" required value={effectiveSelected} onChange={(event) => setSelected(event.target.value)} className="field-input mt-1">{options.map((cap) => <option key={cap.code} value={cap.code}>{capabilityOptionLabel(cap)}</option>)}</select></label> : null}
      <p className="field-hint">{hint}</p>
    </div>
  );
}

export default function RoleManager({ overview, actorUserId, canAssignUsers }: { overview: RoleAdminOverview; actorUserId: string; canAssignUsers: boolean }) {
  const [userFilter, setUserFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState('');
  const needle = (value: string) => value.trim().toLowerCase();
  const userNeedle = needle(userFilter);
  const roleNeedle = needle(roleFilter);
  const capabilityNeedle = needle(capabilityFilter);
  const matchesUser = (user: RoleAdminOverview['users'][number]) => !userNeedle || `${user.username} ${user.fullName} ${user.roles.map((role) => role.code).join(' ')}`.toLowerCase().includes(userNeedle);
  const visibleUsers = overview.users.filter(matchesUser);
  const visibleRoles = overview.roles.filter((role) => !roleNeedle || `${role.code} ${role.name} ${role.description ?? ''}`.toLowerCase().includes(roleNeedle));
  const visibleCapabilities = overview.capabilities.filter((cap) => !capabilityNeedle || `${cap.code} ${cap.module} ${cap.action} ${cap.description ?? ''}`.toLowerCase().includes(capabilityNeedle));
  const assignableRoles = visibleRoles.filter((r) => r.isActive && !r.isSystemRole && r.code !== 'PLATFORM_ADMIN' && !r.capabilities.some((cap) => cap.includes('*') || cap === 'CFG.PLT.ROLE.MAINTAIN' || cap === 'CFG.PLT.USER.ROLE.MAINTAIN'));
  const assignableUsers = visibleUsers.filter((user) => user.id !== actorUserId && user.isActive && !user.isLocked);
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
        {canAssignUsers ? <>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-medium text-ink-soft">Filter users<input value={userFilter} onChange={(event) => setUserFilter(event.target.value)} placeholder="Username, name or current role" className="mt-1 w-full rounded border border-line bg-transparent px-2 py-2 text-sm" /></label>
            <label className="text-xs font-medium text-ink-soft">Filter roles<input value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} placeholder="Role code or name" className="mt-1 w-full rounded border border-line bg-transparent px-2 py-2 text-sm" /></label>
          </div>
          {assignableUsers.length && assignableRoles.length ? <ActionForm action={grantUserRoleAction}>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-xs font-medium text-ink-soft">User<select name="userId" required className="field-input mt-1">{assignableUsers.map((user) => <option key={user.id} value={user.id}>{user.username} — {user.fullName}</option>)}</select></label>
              <label className="text-xs font-medium text-ink-soft">Role<select name="roleCode" required className="field-input mt-1">{assignableRoles.map((role) => <option key={role.code} value={role.code}>{role.code} — {role.name}</option>)}</select></label>
            </div>
            <p className="text-xs text-ink-faint">Self-assignment, wildcard roles, and the protected platform-admin role are refused by the service.</p>
          </ActionForm> : <p className="text-sm text-ink-soft">No eligible ordinary role and active, unlocked target account match these filters.</p>}
        </> : <p className="text-sm text-ink-soft">Role assignment and revocation needs the dedicated {`CFG.PLT.USER.ROLE.MAINTAIN`} capability.</p>}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3"><h2 className="text-lg font-semibold">Tenant roles ({visibleRoles.length} of {overview.roles.length})</h2><label className="text-xs font-medium text-ink-soft">Filter roles<input value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} placeholder="Code, name or description" className="mt-1 block rounded border border-line bg-transparent px-2 py-2 text-sm" /></label></div>
        {visibleRoles.map((role) => {
          const protectedRole = role.isSystemRole || role.code === 'PLATFORM_ADMIN';
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
            {!protectedRole && role.isActive ? <ActionForm action={grantCapabilityAction}><input type="hidden" name="roleCode" value={role.code} /><CapabilityGrantField roleCode={role.code} capabilities={overview.capabilities} held={role.capabilities} /></ActionForm> : null}
          </article>;
        })}
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="text-lg font-semibold">User-role assignments</h2>
        <label className="block max-w-xl text-xs font-medium text-ink-soft">Filter users<input value={userFilter} onChange={(event) => setUserFilter(event.target.value)} placeholder="Username, name or assigned role" className="mt-1 w-full rounded border border-line bg-transparent px-2 py-2 text-sm" /></label>
        <p className="text-xs text-ink-faint">{visibleUsers.length} of {overview.users.length} users shown.</p>
        {visibleUsers.map((user) => <div key={user.id} className="border-b border-line pb-3 last:border-0">
          <p className="font-medium">{user.username} <span className="text-xs text-ink-faint">{user.fullName} · {user.isActive ? 'active' : 'inactive'}{user.isLocked ? ' · locked' : ''}</span></p>
          {user.roles.length ? <ul className="mt-1 space-y-1">{user.roles.map((assignment) => {
            const active = assignment.currentlyEffective;
            return <li key={assignment.code} className="flex flex-wrap items-center gap-2 text-sm"><span>{assignment.code} — {assignment.name}{active ? '' : ' (not currently effective)'}</span>{canAssignUsers && user.id !== actorUserId && active && assignment.code !== 'PLATFORM_ADMIN' ? <ActionForm action={revokeUserRoleAction}><input type="hidden" name="userId" value={user.id} /><input type="hidden" name="roleCode" value={assignment.code} /><button type="submit" className="text-danger underline">Revoke</button></ActionForm> : null}</li>;
          })}</ul> : <p className="text-sm text-ink-faint">No roles assigned.</p>}
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <details className="rounded border border-line p-2"><summary className="cursor-pointer text-xs font-medium">Effective capabilities ({user.effectiveCapabilities.length})</summary><ul className="mt-2 max-h-48 overflow-auto space-y-1">{user.effectiveCapabilities.map((code) => <li key={code} className="code text-xs">{code}</li>)}{!user.effectiveCapabilities.length && <li className="text-xs text-ink-faint">No effective registered capabilities.</li>}</ul></details>
            <details className="rounded border border-line p-2"><summary className="cursor-pointer text-xs font-medium">Organization restrictions ({user.organizationRestrictions.length})</summary>{user.organizationRestrictions.length ? <ul className="mt-2 space-y-1">{user.organizationRestrictions.map((scope) => <li key={`${scope.scopeType}:${scope.scopeValue}`} className="text-xs"><strong>{scope.scopeType}</strong> · {scope.scopeValue}</li>)}</ul> : <p className="mt-2 text-xs text-ink-faint">No scope restrictions recorded; unrestricted by the restriction table.</p>}</details>
          </div>
        </div>)}
      </section>

      <section className="panel p-4">
        <div className="flex flex-wrap items-end justify-between gap-3"><h2 className="font-semibold">Capability catalogue ({visibleCapabilities.length} of {overview.capabilities.length})</h2><label className="text-xs font-medium text-ink-soft">Filter capabilities<input value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)} placeholder="Code, module, action or description" className="mt-1 block rounded border border-line bg-transparent px-2 py-2 text-sm" /></label></div>
        <p className="mt-1 text-sm text-ink-soft">Only these registered codes can be assigned. Role capability patterns are not created by this maintenance path.</p>
        <ul className="mt-3 grid gap-1 md:grid-cols-2">{visibleCapabilities.map((cap) => <li key={cap.code} className="text-xs"><span className="code">{cap.code}</span> · {cap.module}/{cap.action}{cap.isPostingRelevant ? ' · posting-relevant' : ''}</li>)}</ul>
      </section>
    </div>
  );
}
