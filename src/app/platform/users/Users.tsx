'use client';

import { useActionState, useId } from 'react';
import Link from 'next/link';

import { createUserAction, type UserActionState } from './actions';
import type { UserStatusFilter } from '@/modules/platform/user-admin';

const EMPTY: UserActionState = { ok: false };

interface UserRow {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  isActive: boolean;
  isLocked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  roles: Array<{ code: string; name: string }>;
  hasEmployeeRecord: boolean;
}

interface Props {
  client: string;
  users: UserRow[];
  query: string;
  status: UserStatusFilter;
  canCreate: boolean;
  canMaintain: boolean;
  canReset: boolean;
}

function Notice({ state }: { state: UserActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
    </div>
  );
}

function formatDate(value: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export default function Users({ client, users, query, status, canCreate, canMaintain, canReset }: Props) {
  const [createState, createAction, creating] = useActionState(createUserAction, EMPTY);
  const prefix = useId();

  return (
    <div className="space-y-4">
      {canCreate && (
        <section className="panel space-y-3 p-4" aria-labelledby={`${prefix}-create`}>
          <div>
            <h2 id={`${prefix}-create`} className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Create application account</h2>
            <p className="mt-1 text-sm text-ink-soft">Creation requires {client} tenant context and {`CFG.PLT.USER.CREATE`}. No role or employee record is assigned automatically.</p>
          </div>
          <form action={createAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="block text-xs font-medium text-ink-soft">Username
              <input name="username" required minLength={3} maxLength={40} autoComplete="off" className="mt-1 w-full border bg-transparent p-2" />
            </label>
            <label className="block text-xs font-medium text-ink-soft">Full name
              <input name="fullName" required minLength={2} maxLength={120} className="mt-1 w-full border bg-transparent p-2" />
            </label>
            <label className="block text-xs font-medium text-ink-soft">Email (optional)
              <input name="email" type="email" maxLength={200} autoComplete="email" className="mt-1 w-full border bg-transparent p-2" />
            </label>
            <label className="block text-xs font-medium text-ink-soft">Initial password
              <input name="password" type="password" required minLength={10} autoComplete="new-password" className="mt-1 w-full border bg-transparent p-2" />
            </label>
            <div className="flex items-end">
              <button type="submit" disabled={creating} className="btn w-full">{creating ? 'Creating…' : 'Create account'}</button>
            </div>
          </form>
          <Notice state={createState} />
        </section>
      )}

      <section className="panel space-y-3 p-4" aria-labelledby={`${prefix}-directory`}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id={`${prefix}-directory`} className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Application accounts</h2>
            <p className="mt-1 text-xs text-ink-faint">{users.length} matching account{users.length === 1 ? '' : 's'} · roles shown are currently effective direct assignments.</p>
          </div>
          <form method="get" action="/platform/users" className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-ink-soft">Search username, name or email
              <input name="q" defaultValue={query} maxLength={100} className="mt-1 block min-h-9 border bg-transparent px-2" />
            </label>
            <label className="text-xs text-ink-soft">Account status
              <select name="status" defaultValue={status} className="mt-1 block min-h-9 border bg-transparent px-2">
                <option value="ALL">All</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="LOCKED">Locked</option>
                <option value="UNLOCKED">Unlocked</option>
              </select>
            </label>
            <button type="submit" className="btn btn-default min-h-9">Search</button>
            {(query || status !== 'ALL') && <Link href="/platform/users" className="btn btn-default min-h-9">Clear</Link>}
          </form>
        </div>

        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="border-b border-line bg-row text-xs uppercase text-ink-soft">
              <tr>
                <th scope="col" className="p-2">Account</th>
                <th scope="col" className="p-2">Roles</th>
                <th scope="col" className="p-2">Employee record</th>
                <th scope="col" className="p-2">State</th>
                <th scope="col" className="p-2">Last sign-in</th>
                <th scope="col" className="p-2 text-right">Details</th>
              </tr>
            </thead>
            <tbody>
              {users.map((row) => (
                <tr key={row.id} className="border-b border-faint align-top hover:bg-row">
                  <td className="p-2">
                    <div className="font-medium">{row.username}</div>
                    <div className="text-xs text-ink-soft">{row.fullName}</div>
                    <div className="text-xs text-ink-faint">{row.email ?? 'No email on file'}</div>
                  </td>
                  <td className="p-2">
                    {row.roles.length ? <ul className="space-y-1">{row.roles.map((role) => <li key={role.code}><span className="code">{role.code}</span><span className="ml-1 text-xs text-ink-soft">{role.name}</span></li>)}</ul> : <span className="text-ink-faint">No current role</span>}
                  </td>
                  <td className="p-2">{row.hasEmployeeRecord ? 'Linked separately' : 'No linked employee'}</td>
                  <td className="p-2">
                    <div>{row.isActive ? 'Active' : 'Inactive'}</div>
                    <div className={row.isLocked ? 'text-danger' : 'text-ink-faint'}>{row.isLocked ? 'Locked' : 'Unlocked'}</div>
                    {row.mustChangePassword && <div className="text-xs text-warn">Password change required</div>}
                  </td>
                  <td className="p-2 text-xs">{formatDate(row.lastLoginAt)}</td>
                  <td className="p-2 text-right">
                    <Link className="btn btn-default min-h-8" href={`/platform/users/${encodeURIComponent(row.username)}`}>Open</Link>
                  </td>
                </tr>
              ))}
              {!users.length && <tr><td colSpan={6} className="p-5 text-center text-ink-faint">No application accounts match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {!canMaintain && <p className="text-xs text-ink-faint">Account details and lock controls are read-only in this session.</p>}
      </section>

      {canReset && (
        <aside className="rounded border border-line bg-row p-3 text-sm">
          <h2 className="font-medium">Password recovery</h2>
          <p className="mt-1 text-ink-soft">Administrator-issued reset is paused because no approved outbound delivery transport is configured. Reset tokens are not shown in this interface. Use the <Link href="/forgot-password" className="link">public recovery flow</Link> or your organization’s approved support channel.</p>
        </aside>
      )}
    </div>
  );
}
