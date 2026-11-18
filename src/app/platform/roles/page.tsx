import { can, requireSession } from '@/platform/auth/current';
import { getRoleAdminOverview, RoleAdminError, USER_ROLE_MAINTAIN_CAPABILITY } from '@/modules/platform/role-admin';
import RoleManager from './RoleManager';
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title="Roles and capabilities" code="CFG.PLT.ROLE.MAINTAIN · CFG.PLT.USER.ROLE.MAINTAIN" width="7xl"
      description="Tenant-local role maintenance. Only registered capabilities may be assigned; custom roles cannot contain wildcards. Company and plant business scopes remain separate under user access."
      actions={
        <>
          <LinkButton href="/platform/users">Users</LinkButton>
        </>
      }
    >
      {error ? <section className="panel panel-danger p-4 text-sm" role="alert">{error}<p className="mt-2 text-ink-soft">Tenant wildcard ADMINISTRATOR and CFG.PLT.USER.MAINTAIN alone do not authorize this page. Ask the deployment owner to bootstrap a designated active account.</p></section> : overview ? <RoleManager overview={overview} actorUserId={session.user.userId} canAssignUsers={can(session, USER_ROLE_MAINTAIN_CAPABILITY)} /> : null}
    </Page>
  );
}
