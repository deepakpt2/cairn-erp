import Link from 'next/link';
import { notFound } from 'next/navigation';

import { can, requireSession } from '@/platform/auth/current';
import { getUserAdminDetails, canViewUserAdministration } from '@/modules/platform/user-admin';
import { ROLE_MAINTAIN_CAPABILITY } from '@/modules/platform/role-admin';
import { MAINTAIN, PASSWORD_RESET } from '../constants';
import { mfaStatus, MFA_ADMIN_CAPABILITY } from '@/platform/auth/mfa';
import UserDetailControls from '../UserDetailControls';
import { Chip, LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function prettyDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString();
}

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const session = await requireSession('/platform/users');
  const caps = session.user.capabilities;
  if (!canViewUserAdministration(caps)) {
    return <main className="mx-auto max-w-5xl p-4"><section className="panel p-4 text-sm" role="alert">This session cannot view central user administration.</section></main>;
  }
  const { username } = await params;
  const detail = await getUserAdminDetails(session.user.client, username, caps);
  if (!detail) notFound();

  const mfa = await mfaStatus({ client: session.user.client, userId: detail.id });
  const status = detail.isActive ? (detail.isLocked ? 'Active · locked' : 'Active · unlocked') : (detail.isLocked ? 'Inactive · locked' : 'Inactive · unlocked');

  return (
    <Page
      title={detail.username}
      code={<>Application account · tenant {detail.client}</>}
      width="7xl"
      back={{ href: '/platform/users', label: 'User directory' }}
      actions={
        <>
          <Chip tone="neutral">{status}</Chip>
          {caps.includes(ROLE_MAINTAIN_CAPABILITY) && <LinkButton href="/platform/roles">Role administration</LinkButton>}
        </>
      }
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{detail.fullName}</p>
          <p className="max-w-3xl text-sm text-ink-soft">This is an application account, separate from the employee master record. Account edits here do not change HR data, role assignments or organizational restrictions.</p>
        </>
      }
    >

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel p-3"><div className="text-xs uppercase text-ink-faint">Email</div><div className="mt-1 break-all text-sm">{detail.email ?? 'Not recorded'}</div></div>
        <div className="panel p-3"><div className="text-xs uppercase text-ink-faint">Employee record</div><div className="mt-1 text-sm">{detail.hasEmployeeRecord ? 'Linked (separate HR record)' : 'No linked employee'}</div></div>
        <div className="panel p-3"><div className="text-xs uppercase text-ink-faint">Last sign-in</div><div className="mt-1 text-sm">{prettyDate(detail.lastLoginAt)}</div></div>
        <div className="panel p-3"><div className="text-xs uppercase text-ink-faint">Password change</div><div className="mt-1 text-sm">{detail.mustChangePassword ? 'Required at next sign-in' : 'Not required'}</div></div>
      </section>

      <UserDetailControls
        id={detail.id}
        fullName={detail.fullName}
        email={detail.email}
        isActive={detail.isActive}
        isLocked={detail.isLocked}
        canMaintain={can(session, MAINTAIN)}
        canReset={can(session, PASSWORD_RESET)}
        canResetMfa={can(session, MFA_ADMIN_CAPABILITY)}
        mfaEnrolled={mfa.enrolled}
      />

      <section className="panel space-y-3 p-4">
        <div><h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Role assignments</h2><p className="mt-1 text-xs text-ink-faint">Effective status considers the role’s active state and the assignment validity dates in the current tenant.</p></div>
        <div className="overflow-x-auto rounded border border-line">
          <table className="grid-table min-w-[620px] text-left text-sm"><thead className="border-b border-line bg-row text-xs uppercase text-ink-soft"><tr><th>Role</th><th>Kind</th><th>Validity</th><th>Current effect</th></tr></thead><tbody>
            {detail.roles.map((role) => <tr key={role.code} className="border-faint"><td><span className="code">{role.code}</span><div className="text-xs text-ink-soft">{role.name}</div></td><td>{role.isSystemRole ? 'System role' : 'Custom role'}{!role.isRoleActive && ' · inactive role'}</td><td className="text-xs">{prettyDate(role.validFrom)} – {prettyDate(role.validTo)}</td><td>{role.currentlyEffective ? 'Effective' : 'Not effective'}</td></tr>)}
            {!detail.roles.length && <tr><td colSpan={4} className="text-center text-ink-faint">No role assignments recorded.</td></tr>}
          </tbody></table>
        </div>
        {caps.includes(ROLE_MAINTAIN_CAPABILITY) && <p className="text-xs text-ink-soft">Use Role administration to grant or revoke an ordinary role. Protected platform authority cannot be maintained through ordinary assignments.</p>}
      </section>

      <section className="panel space-y-3 p-4">
        <div><h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Effective capabilities</h2><p className="mt-1 text-xs text-ink-faint">Derived from current role assignments against the registered catalogue. A locked or inactive account has no currently usable capabilities. Raw role patterns are shown separately; wildcard patterns are not themselves effective grants here.</p></div>
        <p className="text-sm"><strong>{detail.effectiveCapabilities.length}</strong> registered capability{detail.effectiveCapabilities.length === 1 ? ' is' : 'ies are'} effective.</p>
        <details className="rounded border border-line p-3"><summary className="cursor-pointer text-sm font-medium">Role capability patterns ({detail.capabilityPatterns.length})</summary><ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">{detail.capabilityPatterns.map((pattern) => <li key={pattern} className="code text-xs">{pattern}</li>)}</ul></details>
        <details className="rounded border border-line p-3"><summary className="cursor-pointer text-sm font-medium">Registered effective capability catalogue</summary>
          <div className="mt-3 max-h-96 overflow-auto"><table className="grid-table text-left text-xs"><thead className="sticky top-0 bg-row text-ink-soft"><tr><th>Capability</th><th>Module</th><th>Action</th><th>Posting relevant</th><th>Description</th></tr></thead><tbody>{detail.effectiveCapabilities.map((cap) => <tr key={cap.code} className="border-faint"><td className="code">{cap.code}</td><td>{cap.module}</td><td>{cap.action}</td><td>{cap.isPostingRelevant ? 'Yes' : 'No'}</td><td>{cap.description ?? '—'}</td></tr>)}</tbody></table></div>
        </details>
      </section>

      <section className="panel space-y-3 p-4">
        <div><h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">Organization restrictions</h2><p className="mt-1 text-xs text-ink-faint">Capability authorizes an action; these scopes constrain where it may apply. No rows means unrestricted by this restriction table, not a capability grant.</p></div>
        {detail.organizationRestrictions.length ? <div className="flex flex-wrap gap-2">{detail.organizationRestrictions.map((scope) => <span key={`${scope.scopeType}:${scope.scopeValue}`} className="rounded border border-line px-2 py-1 text-xs"><strong>{scope.scopeType}</strong> · {scope.scopeValue}</span>)}</div> : <p className="text-sm">No organization restrictions are recorded; this account is unrestricted by the scope table.</p>}
      </section>
    </Page>
  );
}
