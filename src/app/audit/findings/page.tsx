/**
 * Audit findings and requests — AUDIT.WORKSPACE (raise) and AUDIT.REQUEST.RESPOND
 * (answer). SAP: SAP Audit Management.
 *
 * The auditor raises findings, notes, bookmarks and requests to management and sees
 * their status and response. Management answers — never the raiser.
 * `?objectClass=&objectKey=` pre-fills a bookmark.
 */

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  AUDIT_EXPORT_CAPABILITY,
  AUDIT_FINDING_ROUTE,
  AUDIT_RESPOND_CAPABILITY,
  AUDIT_WORKSPACE_CAPABILITY,
  AUDIT_WORKSPACE_ROUTE,
  auditWorkspaceView,
  listFindings,
  type FindingView,
} from '@/modules/audit/workspace';

import { ExportEvidenceForm, LogFindingsView, RaiseFindingForm, RespondForm } from './FindingForms';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = AUDIT_FINDING_ROUTE;

function FindingsTable({ rows, respondFor }: { rows: FindingView[]; respondFor?: string }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-ink-soft">Nothing raised.</p>;
  return (
    <table className="grid-table">
      <thead>
        <tr><th>Kind</th><th>Subject</th><th>Body</th><th>Raised by</th><th>Status</th><th>Response</th></tr>
      </thead>
      <tbody>
        {rows.map((f) => {
          const open = f.status === 'OPEN' || f.status === 'ANSWERED';
          const mayRespond = respondFor !== undefined && f.raisedByUserId !== respondFor && open;
          return (
            <tr key={f.findingId}>
              <td className="code">{f.kind}</td>
              <td>
                {f.subject}
                {f.objectClass && <div className="code text-xs text-ink-soft">{f.objectClass} {f.objectKey}</div>}
              </td>
              <td className="text-sm">{f.body}</td>
              <td className="code text-xs">{f.raisedByUsername ?? f.raisedByUserId}<div>{f.raisedAt.slice(0, 10)}</div></td>
              <td><span className="chip">{f.status}</span></td>
              <td className="text-sm">
                {f.response && <p>{f.response} <span className="text-xs text-ink-soft">— {f.respondedByUsername ?? f.respondedByUserId}</span></p>}
                {mayRespond && <RespondForm findingId={f.findingId} />}
                {!f.response && !mayRespond && '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default async function AuditFindingsPage({
  searchParams,
}: {
  searchParams: Promise<{ objectClass?: string; objectKey?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const auditor = can(session, AUDIT_WORKSPACE_CAPABILITY);
  const responder = can(session, AUDIT_RESPOND_CAPABILITY);
  const view = auditor ? await auditWorkspaceView(session.user.client, session.user.userId) : null;
  const all = responder ? await listFindings(session.user.client) : [];

  return (
    <Page
      title="Audit findings and requests" code={<>{AUDIT_WORKSPACE_CAPABILITY} · Audit Management</>} back={{ href: '/', label: t('nav.launchpad') }}
      description="Findings, notes, bookmarks and requests to management, with status and response. A request is answered by management, never by the person who raised it."
      actions={
        <>
          <LinkButton href={AUDIT_WORKSPACE_ROUTE}>Auditor workspace</LinkButton>
        </>
      }
    >

      {!auditor && !responder && (
        <p role="status" className="text-sm text-ink-soft">
          You do not hold the auditor workspace capability. Ask for {AUDIT_WORKSPACE_CAPABILITY}.
        </p>
      )}

      {view && (
        <>
          <LogFindingsView detail={view.grant ? `findings view under grant ${view.grant.grantId}` : 'findings view without a live grant'} />
          {!view.grant && <p role="status" className="panel p-4 text-sm text-ink-soft">{view.noGrantReason}</p>}
          <RaiseFindingForm grantId={view.grant?.grantId ?? null} objectClass={params.objectClass} objectKey={params.objectKey} />
          {view.grant && can(session, AUDIT_EXPORT_CAPABILITY) && <ExportEvidenceForm />}
          <section className="panel overflow-x-auto" aria-label="Raised by you">
            <h2 className="panel-title px-4 pt-4">Raised by you</h2>
            <FindingsTable rows={view.findings} />
          </section>
        </>
      )}

      {responder && (
        <section className="panel overflow-x-auto" aria-label="To answer">
          <h2 className="panel-title px-4 pt-4">All findings and requests — management&apos;s response</h2>
          <FindingsTable rows={all} respondFor={session.user.userId} />
        </section>
      )}
    </Page>
  );
}
