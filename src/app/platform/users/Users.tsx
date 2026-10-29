'use client';

import { useActionState, useId, useState } from 'react';
import Link from 'next/link';

import {
  changeUserAction,
  createUserAction,
  initiatePasswordResetAction,
  type UserActionState,
} from './actions';

const EMPTY: UserActionState = { ok: false };

interface Props {
  users: Array<{
    id: string;
    username: string;
    fullName: string;
    email: string | null;
    isActive: boolean;
    isLocked: boolean;
    mustChangePassword: boolean;
    lastLoginAt: string | null;
  }>;
  canMaintain: boolean;
  canReset: boolean;
}

function Notice({ state }: { state: UserActionState }) {
  if (!state.message) return null;
  return (
    <div
      className={
        state.ok
          ? 'panel panel-success mt-3 p-3 text-sm'
          : 'panel panel-danger mt-3 p-3 text-sm'
      }
      role="status"
    >
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.token ? (
        <p className="mt-2 text-sm text-ink">
          Reset token (deliver out of band): <b>{state.token}</b>
        </p>
      ) : null}
      {state.ok && state.userId ? (
        <p className="mt-2">
          <Link className="link" href={`/platform/users?user=${state.userId}`}>
            Open {state.username}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

export default function Users({
  users,
  canMaintain,
  canReset,
}: Props) {
  const [createState, createAction] = useActionState(createUserAction, EMPTY);
  const [changeState, changeAction] = useActionState(changeUserAction, EMPTY);
  const [resetState, resetAction] = useActionState(initiatePasswordResetAction, EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft mb-2">
          New user
        </h2>
        <form action={createAction} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <label className="block text-2xs font-medium uppercase tracking-wide text-ink-soft">
            Username
          </label>
          <input
            name="username"
            required
            maxLength={40}
            className="w-full border bg-transparent p-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7]"
          />
          <label className="block text-2xs font-medium uppercase tracking-wide text-ink-soft">
            Full name
          </label>
          <input
            name="fullName"
            required
            maxLength={120}
            className="w-full border bg-transparent p-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7]"
          />
          <label className="block text-2xs font-medium uppercase tracking-wide text-ink-soft">
            Email
          </label>
          <input
            name="email"
            type="email"
            maxLength={200}
            className="w-full border bg-transparent p-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7]"
          />
          <label className="block text-2xs font-medium uppercase tracking-wide text-ink-soft">
            Password
          </label>
          <input
            name="password"
            type="password"
            required
            minLength={10}
            className="w-full border bg-transparent p-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7]"
          />
          <button type="submit" disabled={!canMaintain} className="btn">
            Create user
          </button>
        </form>
        <Notice state={createState} />
      </section>

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft mb-2">
          Users
        </h2>
        <div className="overflow-auto border border-line rounded">
          <table className="w-full text-left text-2xs">
            <thead>
              <tr>
                <th className="pb-2">Username</th>
                <th className="pb-2">Full name</th>
                <th className="pb-2">Email</th>
                <th className="pb-2">Active</th>
                <th className="pb-2">Locked</th>
                <th className="pb-2">Must change</th>
                <th className="pb-2 text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((row) => (
                <tr key={row.id} className="border-b border-faint hover:bg-row">
                  <td className="py-2">{row.username}</td>
                  <td className="py-2">{row.fullName}</td>
                  <td className="py-2">{row.email ?? '—'}</td>
                  <td className="py-2">{row.isActive ? 'Yes' : 'No'}</td>
                  <td className="py-2">{row.isLocked ? 'Yes' : 'No'}</td>
                  <td className="py-2">{row.mustChangePassword ? 'Yes' : 'No'}</td>
                  <td className="py-2 text-end">
                    {editingId === row.id ? (
                      <form action={changeAction} className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input name="userId" type="hidden" defaultValue={row.id} />
                        <input
                          name="fullName"
                          defaultValue={row.fullName}
                          className="border bg-transparent p-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7]"
                        />
                        <input
                          name="email"
                          type="email"
                          defaultValue={row.email ?? ''}
                          className="border bg-transparent p-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7]"
                        />
                        <input name="isActive" type="checkbox" defaultChecked={row.isActive} />
                        <input name="changedBy" type="hidden" />
                        <button type="submit" disabled={!canMaintain} className="btn btn-default min-h-8">
                          Save
                        </button>
                        <button type="button" onClick={() => setEditingId(null)} className="link min-h-8">
                          Cancel
                        </button>
                      </form>
                    ) : (
                      canMaintain ? (
                        <button type="button" onClick={() => setEditingId(row.id)} className="link min-h-8">
                          Change
                        </button>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-ink-faint">
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Notice state={changeState} />
      </section>

      {canReset && (
        <section className="panel space-y-3 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft mb-2">
            Initiate password reset
          </h2>
          <form action={resetAction} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-2xs font-medium uppercase tracking-wide text-ink-soft">
              User id
            </label>
            <input
              name="userId"
              required
              className="w-full border bg-transparent p-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7]"
            />
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">
              Create reset token
            </button>
          </form>
          <Notice state={resetState} />
        </section>
      )}
    </div>
  );
}