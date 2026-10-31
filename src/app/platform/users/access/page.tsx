/** Central, tenant-scoped company and plant business-access maintenance. */
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  getOrganisationScopeAdminOverview,
  getUserOrganisationScopes,
  ORGANISATION_SCOPE_ADMIN_CAPABILITY,
  OrganisationScopeAdminError,
} from '@/modules/platform/organisation-scope-admin';
import ScopeManager from './ScopeManager';

const ROUTE = '/platform/users/access';

export const dynamic = 'force-dynamic';

export default async function OrganisationScopeAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ query?: string; user?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const allowed = can(session, ORGANISATION_SCOPE_ADMIN_CAPABILITY);
  let overview = null;
  let selected = null;
  let loadError: string | null = null;

  if (allowed) {
    try {
      overview = await getOrganisationScopeAdminOverview(
        session.user.client,
        { userId: session.user.userId, sessionId: session.sessionId ?? '' },
        params.query,
      );
      if (params.user) {
        selected = await getUserOrganisationScopes(
          session.user.client,
          { userId: session.user.userId, sessionId: session.sessionId ?? '' },
          params.user,
        );
      }
    } catch (error) {
      if (error instanceof OrganisationScopeAdminError) loadError = error.message;
      else throw error;
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="code text-ink-faint">{ORGANISATION_SCOPE_ADMIN_CAPABILITY}</span>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Company and plant business access</h1>
          </div>
          <div className="flex gap-2">
            <Link href="/platform/users" className="btn btn-default">Users</Link>
            <Link href="/" className="btn btn-default">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 max-w-4xl text-sm text-ink-soft">
          Assign or revoke the companies and plants a user may work in. These scopes govern business access only; they do not grant roles, capabilities, or user-administration authority, and are independent of employee records.
        </p>
      </header>

      {!allowed ? (
        <section className="panel panel-danger p-4 text-sm" role="status">
          Managing company and plant access needs {ORGANISATION_SCOPE_ADMIN_CAPABILITY}. This page is restricted to central platform administrators.
        </section>
      ) : loadError ? (
        <section className="panel panel-danger p-4 text-sm" role="alert">{loadError}</section>
      ) : overview ? (
        <ScopeManager
          query={params.query ?? ''}
          users={overview.users}
          companies={overview.companies}
          plants={overview.plants}
          selected={selected}
          actorUserId={session.user.userId}
        />
      ) : null}
    </main>
  );
}
