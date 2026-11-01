/**
 * Central application-user administration. An application account is distinct
 * from the employee master record; the directory shows a link indicator only.
 */
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { canViewUserAdministration, type UserStatusFilter } from '@/modules/platform/user-admin';
import { CREATE, MAINTAIN, PASSWORD_RESET } from './constants';
import { ROLE_MAINTAIN_CAPABILITY } from '@/modules/platform/role-admin';
import { listUsersAction } from './actions';
import Users from './Users';

export const dynamic = 'force-dynamic';

const STATUSES: UserStatusFilter[] = ['ALL', 'ACTIVE', 'INACTIVE', 'LOCKED', 'UNLOCKED'];

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const session = await requireSession('/platform/users');
  const client = session.user.client;
  const capabilities = session.user.capabilities;
  const canRead = canViewUserAdministration(capabilities);
  const params = await searchParams;
  const query = (params.q ?? '').slice(0, 100);
  const status = STATUSES.includes(params.status as UserStatusFilter)
    ? (params.status as UserStatusFilter)
    : 'ALL';

  if (!canRead) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-4 lg:p-6">
        <header className="border-b border-line pb-4">
          <h1 className="text-xl font-semibold">Users</h1>
        </header>
        <section className="panel p-4 text-sm" role="alert">
          <p className="font-medium">This session cannot view central user administration.</p>
          <p className="mt-1 text-ink-soft">An authorized user-administration capability is required. Company- or plant-level business access does not grant this authority.</p>
        </section>
        <Link href="/" className="btn btn-default">Launchpad</Link>
      </main>
    );
  }

  const result = await listUsersAction(client, query, status);
  const users = result.ok ? (result.users ?? []) : [];

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CREATE} · {MAINTAIN} · {PASSWORD_RESET}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Central user administration</h1>
          <nav className="flex flex-wrap gap-2" aria-label="User administration navigation">
            {can(session, MAINTAIN) && <Link href="/platform/users/access" className="btn btn-default">Business access</Link>}
            {capabilities.includes(ROLE_MAINTAIN_CAPABILITY) && <Link href="/platform/roles" className="btn btn-default">Roles and capabilities</Link>}
            <Link href="/" className="btn btn-default">Launchpad</Link>
          </nav>
        </div>
        <p className="mt-2 max-w-4xl text-sm text-ink-soft">
          Application accounts authenticate to Cairn; employee master records are separate HR data. Accounts can exist without an employee link, and this screen never creates or edits employee records.
        </p>
      </header>

      {!can(session, MAINTAIN) && (
        <div className="rounded border border-line bg-warn-soft p-3 text-sm text-warn">
          This session can view the directory but does not hold {MAINTAIN}; account maintenance and lock changes are unavailable.
        </div>
      )}
      {!result.ok && <div className="panel panel-danger p-3 text-sm" role="alert">{result.message}</div>}

      <Users
        client={client}
        users={users}
        query={query}
        status={status}
        canCreate={can(session, CREATE)}
        canMaintain={can(session, MAINTAIN)}
        canReset={can(session, PASSWORD_RESET)}
      />
    </main>
  );
}
