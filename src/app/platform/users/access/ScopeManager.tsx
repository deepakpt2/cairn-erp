'use client';

import { useActionState, useMemo, useState } from 'react';
import Link from 'next/link';

import type {
  ManagedOrganisationScope,
  ScopeCompanyChoice,
  ScopePlantChoice,
} from '@/modules/platform/organisation-scope-admin';
import type { UserView } from '@/modules/platform/user-admin';
import {
  grantCompanyScopeAction,
  grantPlantScopeAction,
  revokeOrganisationScopeAction,
  type OrganisationScopeActionState,
} from './actions';

interface Props {
  query: string;
  users: UserView[];
  companies: ScopeCompanyChoice[];
  plants: ScopePlantChoice[];
  selected: { user: UserView; assignments: ManagedOrganisationScope[] } | null;
  actorUserId: string;
}

const EMPTY: OrganisationScopeActionState = { ok: false };

function Notice({ state }: { state: OrganisationScopeActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
    </div>
  );
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function ScopeManager({ query, users, companies, plants, selected, actorUserId }: Props) {
  const [companyState, companyAction, companyPending] = useActionState(grantCompanyScopeAction, EMPTY);
  const [plantState, plantAction, plantPending] = useActionState(grantPlantScopeAction, EMPTY);
  const [revokeState, revokeAction, revokePending] = useActionState(revokeOrganisationScopeAction, EMPTY);
  const [plantCompany, setPlantCompany] = useState('');

  const currentCompanyScopes = useMemo(
    () => new Set(selected?.assignments.filter((item) => item.scopeType === 'COMPANY_CODE').map((item) => item.scopeValue) ?? []),
    [selected],
  );
  const availableCompanies = companies.filter((item) => !currentCompanyScopes.has(item.companyCode));
  const existingActiveCompanies = companies.filter((item) => currentCompanyScopes.has(item.companyCode));
  const currentPlantScopes = new Set(selected?.assignments.filter((item) => item.scopeType === 'PLANT').map((item) => item.scopeValue) ?? []);
  const effectivePlantCompany = existingActiveCompanies.some((item) => item.companyCode === plantCompany)
    ? plantCompany
    : existingActiveCompanies[0]?.companyCode ?? '';
  const availablePlants = plants.filter((item) => item.companyCode === effectivePlantCompany && !currentPlantScopes.has(item.plant));
  const isSelf = selected?.user.id === actorUserId;

  return (
    <div className="space-y-4">
      <Notice state={companyState} />
      <Notice state={plantState} />
      <Notice state={revokeState} />

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Find a user</h2>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="min-w-56 flex-1 text-xs font-medium uppercase tracking-wide text-ink-soft">
            Username, name, or email
            <input name="query" defaultValue={query} maxLength={120} className="mt-1 w-full border bg-transparent p-2 text-sm normal-case" />
          </label>
          <button className="btn btn-default" type="submit">Search</button>
        </form>
        <div className="overflow-x-auto">
          <table className="grid-table w-full text-left text-sm">
            <thead><tr><th>User</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td><span className="font-medium">{user.username}</span><span className="block text-xs text-ink-soft">{user.fullName}</span></td>
                  <td>{user.isActive ? (user.isLocked ? 'Locked' : 'Active') : 'Inactive'}</td>
                  <td>{user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Never'}</td>
                  <td className="text-right">
                    <Link className="link" href={`/platform/users/access?query=${encodeURIComponent(query)}&user=${encodeURIComponent(user.id)}`}>
                      Manage access
                    </Link>
                  </td>
                </tr>
              ))}
              {users.length === 0 ? <tr><td colSpan={4} className="text-ink-soft">No users matched the search.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-faint">Showing up to 100 users in this tenant.</p>
      </section>

      {selected ? (
        <>
          <section className="panel space-y-2 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">Business access for {selected.user.username}</h2>
              <span className="text-sm text-ink-soft">{selected.user.fullName} · {selected.user.isActive ? (selected.user.isLocked ? 'Locked' : 'Active') : 'Inactive'}</span>
            </div>
            <p className="text-sm text-ink-soft">Company and plant scopes do not change this user's roles or administration permissions.</p>
            {isSelf ? <p className="rounded border border-warn p-2 text-sm text-warn">Self-assignment is prohibited. Ask another central administrator to grant access to your account.</p> : null}
            <div className="overflow-x-auto">
              <table className="grid-table w-full text-left text-sm">
                <thead><tr><th>Scope</th><th>Master record</th><th>Company</th><th>Master status</th><th>Granted by</th><th>Granted on</th><th /></tr></thead>
                <tbody>
                  {selected.assignments.map((item) => (
                    <tr key={item.id}>
                      <td><span className="font-medium">{item.scopeType === 'COMPANY_CODE' ? 'Company' : 'Plant'}</span><span className="block font-mono text-xs">{item.scopeValue}</span></td>
                      <td>{item.masterName ?? 'Master record not found'}</td>
                      <td>{item.scopeType === 'PLANT' ? (item.companyCode ?? '—') : '—'}</td>
                      <td>{item.masterStatus.replaceAll('_', ' ')}</td>
                      <td>{item.createdBy}</td>
                      <td>{formatDate(item.createdAt)}</td>
                      <td className="text-right">
                        <form action={revokeAction}>
                          <input type="hidden" name="targetUserId" value={selected.user.id} />
                          <input type="hidden" name="assignmentId" value={item.id} />
                          <button className="btn btn-danger" type="submit" disabled={revokePending}>
                            Revoke
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                  {selected.assignments.length === 0 ? <tr><td colSpan={7} className="text-ink-soft">No company or plant scopes are assigned.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="panel space-y-3 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Grant company access</h2>
              <form action={companyAction} className="space-y-3">
                <input type="hidden" name="targetUserId" value={selected.user.id} />
                <label className="block text-xs font-medium uppercase tracking-wide text-ink-soft">
                  Active company code
                  <select name="companyCode" required defaultValue="" disabled={isSelf || availableCompanies.length === 0} className="mt-1 w-full border bg-transparent p-2 text-sm normal-case">
                    <option value="" disabled>{availableCompanies.length ? 'Choose a company' : 'No additional company scopes available'}</option>
                    {availableCompanies.map((item) => <option value={item.companyCode} key={item.companyCode}>{item.companyCode} · {item.name}</option>)}
                  </select>
                </label>
                <button className="btn btn-primary" type="submit" disabled={isSelf || companyPending || availableCompanies.length === 0}>Grant company scope</button>
              </form>
            </section>

            <section className="panel space-y-3 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Grant plant access</h2>
              {existingActiveCompanies.length === 0 ? (
                <p className="text-sm text-ink-soft">Grant an active company scope first. Plant access must be contained within a company already assigned to this user.</p>
              ) : (
                <form action={plantAction} className="space-y-3">
                  <input type="hidden" name="targetUserId" value={selected.user.id} />
                  <label className="block text-xs font-medium uppercase tracking-wide text-ink-soft">
                    Assigned active company
                    <select name="companyCode" value={effectivePlantCompany} onChange={(event) => setPlantCompany(event.target.value)} disabled={isSelf} className="mt-1 w-full border bg-transparent p-2 text-sm normal-case">
                      {existingActiveCompanies.map((item) => <option value={item.companyCode} key={item.companyCode}>{item.companyCode} · {item.name}</option>)}
                    </select>
                  </label>
                  <label className="block text-xs font-medium uppercase tracking-wide text-ink-soft">
                    Active plant in that company
                    <select name="plantCode" required defaultValue="" disabled={isSelf || availablePlants.length === 0} className="mt-1 w-full border bg-transparent p-2 text-sm normal-case">
                      <option value="" disabled>{availablePlants.length ? 'Choose a plant' : 'No active plants for this company'}</option>
                      {availablePlants.map((item: ScopePlantChoice) => <option value={item.plant} key={item.plant}>{item.plant} · {item.name}</option>)}
                    </select>
                  </label>
                  <button className="btn btn-primary" type="submit" disabled={isSelf || plantPending || availablePlants.length === 0}>Grant plant scope</button>
                </form>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
