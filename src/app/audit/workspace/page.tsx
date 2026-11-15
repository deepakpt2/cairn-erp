/**
 * Auditor workspace — AUDIT.WORKSPACE. SAP: AIS, under a GRC-style grant.
 *
 * Read-only in the strongest sense: nothing on this page writes business data. It
 * shows the grant (scope, dates, grantor) or why there is none, the read-only
 * drill-through chain, and the auditor's own working state. The view itself is
 * logged from a client island; the change-history search is logged by its action.
 */
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  AUDIT_FINDING_ROUTE,
  AUDIT_TRAIL_CAPABILITY,
  AUDIT_WORKSPACE_CAPABILITY,
  AUDIT_WORKSPACE_ROUTE,
  auditWorkspaceView,
} from '@/modules/audit/workspace';

import { ChangeHistorySearch, LogWorkspaceView } from './WorkspaceClient';

export const dynamic = 'force-dynamic';

const ROUTE = AUDIT_WORKSPACE_ROUTE;
const CAPABILITY = AUDIT_WORKSPACE_CAPABILITY;

function ScopeList({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd className="code text-sm">{values.length ? values.join(', ') : 'Not limited'}</dd>
    </div>
  );
}

export default async function AuditorWorkspacePage() {
  const session = await requireSession(ROUTE);
  const allowed = can(session, CAPABILITY);
  const view = allowed ? await auditWorkspaceView(session.user.client, session.user.userId) : null;
  const grant = view?.grant ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CAPABILITY} · AIS</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Auditor workspace</h1>
          <div className="flex gap-2">
            <Link href={AUDIT_FINDING_ROUTE} className="btn btn-default min-h-11 sm:min-h-8">Findings and requests</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Time-boxed, scoped, read-only access. Nothing you hold can post, change or delete while your grant is live,
          and what you look at and export is logged.
        </p>
      </header>

      {!allowed && (
        <p role="status" className="text-sm text-ink-soft">
          You do not hold the auditor workspace capability. Ask for {CAPABILITY}.
        </p>
      )}

      {view && (
        <>
          <LogWorkspaceView detail={grant ? `workspace view under grant ${grant.grantId}` : 'workspace view without a live grant'} />

          <section className="panel space-y-3 p-4" aria-label="Audit grant">
            <h2 className="panel-title">Your audit grant</h2>
            {grant ? (
              <>
                <p className="text-sm">
                  <span className="chip">ACTIVE</span>{' '}
                  <span className="code">{grant.grantId}</span> — from <strong>{grant.validFrom}</strong> to{' '}
                  <strong>{grant.validTo}</strong>, granted by <strong>{grant.grantedByUsername ?? grant.grantedByUserId}</strong>.
                </p>
                <dl className="grid gap-3 sm:grid-cols-3">
                  <ScopeList label="Company codes" values={grant.scope.COMPANY_CODE} />
                  <ScopeList label="Periods (YYYYPP)" values={grant.scope.PERIOD} />
                  <ScopeList label="Modules" values={grant.scope.MODULE} />
                </dl>
                <p className="text-xs text-ink-soft">Reason: {grant.reason}</p>
              </>
            ) : (
              <p role="status" className="text-sm text-ink-soft">{view.noGrantReason}</p>
            )}
          </section>

          <section className="panel overflow-x-auto" aria-label="Drill-through">
            <h2 className="panel-title px-4 pt-4">The read-only chain</h2>
            <p className="px-4 text-sm text-ink-soft">
              Statement → balance → line items → journal entry → source document → master data as at posting date.
              Each screen opens with your own display authorities.
            </p>
            <table className="grid-table">
              <thead>
                <tr><th>Step</th><th>Screen</th><th>SAP</th><th>Authority</th><th>Open</th></tr>
              </thead>
              <tbody>
                {view.drillThrough.map((hop) => {
                  const opens = hop.capability === '' || can(session, hop.capability);
                  return (
                    <tr key={hop.route}>
                      <td>{hop.step}</td>
                      <td>{hop.label}</td>
                      <td className="code">{hop.sap}</td>
                      <td className="code text-xs">{hop.capability || 'session'}</td>
                      <td>
                        {opens
                          ? <Link href={hop.route} className="underline">{hop.route}</Link>
                          : <span className="text-xs text-ink-soft">Not available to you{grant ? ' under the grant' : ''}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {grant && can(session, AUDIT_TRAIL_CAPABILITY) && <ChangeHistorySearch modules={grant.scope.MODULE} />}

          <section className="panel overflow-x-auto" aria-label="Working state">
            <div className="flex items-center justify-between px-4 pt-4">
              <h2 className="panel-title">Your working state</h2>
              <Link href={AUDIT_FINDING_ROUTE} className="text-sm underline">Raise a finding, note, bookmark or request</Link>
            </div>
            {view.findings.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">Nothing raised yet.</p>
            ) : (
              <table className="grid-table">
                <thead>
                  <tr><th>Kind</th><th>Subject</th><th>Status</th><th>Response</th><th>Raised</th></tr>
                </thead>
                <tbody>
                  {view.findings.map((f) => (
                    <tr key={f.findingId}>
                      <td className="code">{f.kind}</td>
                      <td>{f.subject}</td>
                      <td><span className="chip">{f.status}</span></td>
                      <td className="text-sm">{f.response ? `${f.response} — ${f.respondedByUsername ?? ''}` : '—'}</td>
                      <td className="text-xs">{f.raisedAt.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
