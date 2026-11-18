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
import { LinkButton, Page } from '@/ui/kit';

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
      <Page
      title="Users" width="5xl" back={null}
    >
        <section className="panel p-4 text-sm" role="alert">
          <p className="font-medium">This session cannot view central user administration.</p>
          <p className="mt-1 text-ink-soft">An authorized user-administration capability is required. Company- or plant-level business access does not grant this authority.</p>
        </section>
        <Link href="/" className="btn btn-default">Launchpad</Link>
      </Page>
    );
  }

  const result = await listUsersAction(client, query, status);
  const users = result.ok ? (result.users ?? []) : [];

  return (
    <Page
      title="Central user administration" code={<>{CREATE} · {MAINTAIN} · {PASSWORD_RESET}</>} width="7xl" back={null}
      description="Application accounts authenticate to Cairn; employee master records are separate HR data. Accounts can exist without an employee link, and this screen never creates or edits employee records."
      actions={
        <>
          <nav className="flex flex-wrap gap-2" aria-label="User administration navigation">
                      {can(session, MAINTAIN) && <LinkButton href="/platform/users/access">Business access</LinkButton>}
                      {capabilities.includes(ROLE_MAINTAIN_CAPABILITY) && <LinkButton href="/platform/roles">Roles and capabilities</LinkButton>}
                      <LinkButton href="/">Launchpad</LinkButton>
                    </nav>
        </>
      }
    >

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
    </Page>
  );
}
