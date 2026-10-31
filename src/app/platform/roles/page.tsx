import Link from 'next/link';
import { requireSession } from '@/platform/auth/current';
import { getRoleAdminOverview, RoleAdminError } from '@/modules/platform/role-admin';
import RoleManager from './RoleManager';

export const dynamic = 'force-dynamic';

export default async function RolesPage() {
  const session = await requireSession('/platform/roles');
  let overview = null;
  let error: string | null = null;
  try {
    if (!session.sessionId) throw new RoleAdminError('This session cannot be verified for role administration.', 'Sign in again and retry.');
    overview = await getRoleAdminOverview(session.user.client, { userId: session.user.userId, sessionId: session.sessionId });
  } catch (cause) {
    if (cause instanceof RoleAdminError) error = cause.message;
    else throw cause;
  }

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="code text-ink-faint">CFG.PLT.ROLE.MAINTAIN · CFG.PLT.USER.ROLE.MAINTAIN</span>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Roles and capabilities</h1>
          </div>
          <div className="flex gap-2"><Link href="/platform/users" className="btn btn-default">Users</Link><Link href="/" className="btn btn-default">Launchpad</Link></div>
        </div>
        <p className="mt-2 max-w-4xl text-sm text-ink-soft">Tenant-local role maintenance. Only registered capabilities may be assigned; custom roles cannot contain wildcards. Company and plant business scopes remain separate under user access.</p>
      </header>
      {error ? <section className="panel panel-danger p-4 text-sm" role="alert">{error}<p className="mt-2 text-ink-soft">Tenant wildcard ADMINISTRATOR and CFG.PLT.USER.MAINTAIN alone do not authorize this page. Ask the deployment owner to bootstrap a designated active account.</p></section> : overview ? <RoleManager overview={overview} actorUserId={session.user.userId} /> : null}
    </main>
  );
}
