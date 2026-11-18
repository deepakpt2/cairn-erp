/**
 * Auditor access grants — AUDIT.ACCESS.GRANT. SAP: GRC Emergency Access Management.
 *
 * Held by a controller, never by the auditor. Grants are time-boxed and scoped,
 * revoked rather than deleted, and every grant and revocation is change-documented
 * and logged.
 */
import { randomUUID } from 'node:crypto';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  AUDIT_GRANT_CAPABILITY,
  AUDIT_GRANT_ROUTE,
  AUDIT_WORKSPACE_ROUTE,
  listGrantableUsers,
  listGrants,
} from '@/modules/audit/workspace';

import { CreateGrantForm, RevokeGrantForm } from './GrantForms';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = AUDIT_GRANT_ROUTE;
const CAPABILITY = AUDIT_GRANT_CAPABILITY;

export default async function AuditGrantsPage() {
  const session = await requireSession(ROUTE);
  const allowed = can(session, CAPABILITY);
  const [grants, auditors] = allowed
    ? await Promise.all([listGrants(session.user.client), listGrantableUsers(session.user.client)])
    : [[], []];
  const candidates = auditors.filter((a) => a.userId !== session.user.userId);

  return (
    <Page
      title="Auditor access grants" code={<>{CAPABILITY} · GRC</>} back={{ href: '/', label: t('nav.launchpad') }}
      description="Give a person acting as auditor time-boxed, read-only access limited to company codes, periods and modules. One standing grant per auditor. Only users who hold AUDIT.WORKSPACE can be chosen."
      actions={
        <>
          <LinkButton href={AUDIT_WORKSPACE_ROUTE}>Auditor workspace</LinkButton>
        </>
      }
    >

      {!allowed && (
        <p role="status" className="text-sm text-ink-soft">
          You do not hold the auditor access grant capability. Ask for {CAPABILITY}.
        </p>
      )}

      {allowed && (
        <>
          {candidates.length === 0 ? (
            <p role="status" className="panel p-4 text-sm text-ink-soft">
              No user holds AUDIT.WORKSPACE yet. Give the auditor a display-only role carrying it first.
            </p>
          ) : (
            <CreateGrantForm auditors={candidates} requestKey={randomUUID()} defaultFrom={new Date().toISOString().slice(0, 10)} />
          )}

          <section className="panel overflow-x-auto" aria-label="Grants">
            <h2 className="panel-title px-4 pt-4">Grants</h2>
            {grants.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">No audit grant has been given in this tenant.</p>
            ) : (
              <table className="grid-table">
                <thead>
                  <tr><th>Auditor</th><th>From</th><th>To</th><th>Status</th><th>Scope</th><th>Granted by</th><th>Reason</th><th>Revoke</th></tr>
                </thead>
                <tbody>
                  {grants.map((g) => (
                    <tr key={g.grantId}>
                      <td className="code">{g.auditorUsername ?? g.auditorUserId}</td>
                      <td className="text-xs">{g.validFrom}</td>
                      <td className="text-xs">{g.validTo}</td>
                      <td>
                        <span className={g.status === 'ACTIVE' ? 'chip' : 'chip chip-warn'}>{g.status}</span>
                        {g.revokedByUsername && <div className="text-xs text-ink-soft">by {g.revokedByUsername}</div>}
                      </td>
                      <td className="code text-xs">
                        {[
                          g.scope.COMPANY_CODE.length ? `CC ${g.scope.COMPANY_CODE.join(',')}` : '',
                          g.scope.PERIOD.length ? `PER ${g.scope.PERIOD.join(',')}` : '',
                          g.scope.MODULE.length ? `MOD ${g.scope.MODULE.join(',')}` : '',
                        ].filter(Boolean).join(' · ')}
                      </td>
                      <td className="code">{g.grantedByUsername ?? g.grantedByUserId}</td>
                      <td className="text-sm">{g.reason}</td>
                      <td>{g.status === 'ACTIVE' || g.status === 'DRAFT' ? <RevokeGrantForm grantId={g.grantId} /> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Page>
  );
}
