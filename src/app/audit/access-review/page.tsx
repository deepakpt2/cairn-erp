/**
 * Access review — AUDIT.ACCESS.REVIEW.
 *
 * A review certifies what users hold; it does not grant or remove anything. Removal is a separate act, by a
 * separate authority. The items are role assignments only: restrictions, direct grants and position capabilities
 * are shown beside them and never decided here.
 */
import { randomUUID } from 'node:crypto';
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  AUDIT_ACCESS_REVIEW_CAPABILITY, AUDIT_ACCESS_REVIEW_ROUTE, AccessReviewError,
  getAccessReview, listAccessReviews, recordAccessReviewView, type AccessReviewView,
} from '@/modules/audit/access-review';
import { USER_ROLE_MAINTAIN_CAPABILITY } from '@/modules/platform/role-admin';

import { ApplyButton, CancelButton, CompleteButton, CreateReviewForm, DecideForm } from './AccessReviewForm';

export const dynamic = 'force-dynamic';

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function AccessReviewPage({ searchParams }: { searchParams: Params }) {
  const q = await searchParams;
  const session = await requireSession(AUDIT_ACCESS_REVIEW_ROUTE);
  const allowed = can(session, AUDIT_ACCESS_REVIEW_CAPABILITY);
  const client = session.user.client;
  const reviewId = one(q.review);
  const creating = one(q.new) === '1';

  let selected: AccessReviewView | null = null;
  let missing = false;
  const reviews = allowed ? await listAccessReviews(client) : [];
  if (allowed) {
    await recordAccessReviewView({ client, userId: session.user.userId, username: session.user.username, reviewId });
    if (reviewId) {
      try { selected = await getAccessReview(client, reviewId); } catch (e) { if (e instanceof AccessReviewError) missing = true; else throw e; }
    }
  }
  const canApply = can(session, USER_ROLE_MAINTAIN_CAPABILITY);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{AUDIT_ACCESS_REVIEW_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Access review</h1>
          <div className="flex gap-2">
            {allowed && <Link href={`${AUDIT_ACCESS_REVIEW_ROUTE}?new=1`} className="btn btn-primary min-h-11 sm:min-h-8">New review</Link>}
            <Link href="/platform/users" className="btn btn-default min-h-11 sm:min-h-8">Users</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft">
          <strong>A review certifies what users hold; it does not grant or remove anything. Removal is a separate act, by a separate authority.</strong>{' '}
          <strong>You cannot decide on your own access.</strong>
        </p>
      </header>

      {!allowed && <p role="status" className="text-sm text-ink-soft">You do not hold the access review capability. Ask for {AUDIT_ACCESS_REVIEW_CAPABILITY}.</p>}

      {allowed && creating && <CreateReviewForm requestKey={randomUUID()} today={today} />}

      {allowed && (
        <section className="panel overflow-x-auto" aria-label="Reviews">
          <h2 className="panel-title px-4 pt-4">Reviews</h2>
          {reviews.length === 0 ? <p className="p-4 text-sm text-ink-soft">No access review has been raised in this tenant.</p> : (
            <table className="grid-table">
              <thead><tr><th>Code</th><th>Name</th><th>Date</th><th>Status</th><th className="text-end">Items</th><th className="text-end">Pending</th><th className="text-end">Certified</th><th className="text-end">Revoke</th></tr></thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.reviewId}>
                    <td className="code"><Link className="link" href={`${AUDIT_ACCESS_REVIEW_ROUTE}?review=${r.reviewId}`}>{r.code}</Link></td>
                    <td>{r.name}</td><td className="text-xs">{r.reviewDate}</td>
                    <td><span className={r.status === 'OPEN' ? 'chip' : 'chip chip-warn'}>{r.status}</span></td>
                    <td className="text-end tabular">{r.counts.items}</td><td className="text-end tabular">{r.counts.pending}</td>
                    <td className="text-end tabular">{r.counts.certified}</td><td className="text-end tabular">{r.counts.revoke}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {missing && <p role="alert" className="text-sm text-signal-error">That access review does not exist.</p>}

      {selected && (
        <section className="space-y-4" aria-label="Review">
          <div className="panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="panel-title">{selected.code} — {selected.name}</h2>
                <p className="text-xs text-ink-soft">{selected.reviewDate} · {selected.status}{selected.completedAt ? ` · completed ${selected.completedAt.slice(0, 10)}` : ''} · raised by {selected.createdBy}</p>
                <p className="mt-1 text-sm">{selected.reason}</p>
                <p className="code mt-1 text-xs text-ink-faint">Population: role {selected.roleFilter ?? 'any'} · capability {selected.capabilityFilter ?? 'any'} · user {selected.userFilter ?? 'any'}</p>
              </div>
              <p className="text-xs text-ink-soft">{selected.counts.items} items · {selected.counts.pending} pending · {selected.counts.certified} certified · {selected.counts.revoke} to revoke ({selected.counts.applied} applied, {selected.counts.failed} refused)</p>
            </div>
            {selected.status === 'OPEN' && (
              <div className="mt-3 space-y-2 border-t border-line pt-3">
                {canApply
                  ? <ApplyButton reviewId={selected.reviewId} />
                  : <p className="text-xs text-ink-soft">Applying revocations needs {USER_ROLE_MAINTAIN_CAPABILITY}, which this session does not hold. Record the decisions and ask an administrator to apply them.</p>}
                <CompleteButton reviewId={selected.reviewId} />
                <CancelButton reviewId={selected.reviewId} />
              </div>
            )}
          </div>

          {selected.subjects.map((s) => {
            const items = selected!.items.filter((i) => i.subjectUserId === s.userId);
            return (
              <article key={s.userId} className="panel space-y-3 p-4">
                <h3 className="text-sm font-semibold">
                  <span className="code">{s.username}</span> <span className="text-ink-soft">{s.fullName}</span>
                  {(!s.isActive || s.isLocked) && <span className="chip chip-warn ms-2">{!s.isActive ? 'inactive' : 'locked'}</span>}
                </h3>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div>
                    <h4 className="text-xs font-semibold uppercase text-ink-soft">Effective capabilities today ({s.live.capabilities.length})</h4>
                    <p className="code mt-1 max-h-24 overflow-auto text-xs">{s.live.capabilities.join(' · ') || 'none'}</p>
                  </div>
                  <div className="space-y-2 text-xs">
                    <div><span className="font-semibold uppercase text-ink-soft">Restrictions</span> (shown, never decided): {s.live.restrictions.length ? s.live.restrictions.map((r) => `${r.scopeType} ${r.scopeValue}`).join(', ') : 'none — unrestricted'}</div>
                    <div><span className="font-semibold uppercase text-ink-soft">Direct and delegated grants</span> (shown, never decided): {s.live.directGrants.length
                      ? s.live.directGrants.map((g) => `${g.capabilityCode} (${g.reason} from ${g.granter}, ${g.validFrom} to ${g.validTo ?? 'open-ended'})`).join('; ') : 'none'}</div>
                    <div><span className="font-semibold uppercase text-ink-soft">Separation-of-duties conflicts</span>: {s.live.sodConflicts.length
                      ? s.live.sodConflicts.map((c) => `${c.code} [${c.severity}] ${c.capabilityA} + ${c.capabilityB}`).join('; ') : 'none'}</div>
                  </div>
                </div>

                {items.length === 0 ? (
                  <p className="text-xs text-ink-soft">No role assignment — any authority this user holds comes from a position or a direct grant, which a review shows but never decides.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="grid-table">
                      <thead><tr><th>Line</th><th>Role</th><th>Valid</th><th>Frozen conflicts</th><th>Decision</th><th>Decide</th></tr></thead>
                      <tbody>
                        {items.map((i) => (
                          <tr key={i.lineNumber}>
                            <td className="tabular">{i.lineNumber}</td>
                            <td><span className="code">{i.roleCode}</span><div className="text-xs text-ink-soft">{i.roleName}</div></td>
                            <td className="text-xs">{i.validFrom?.slice(0, 10)} – {i.validTo?.slice(0, 10) ?? 'open'}</td>
                            <td className="text-xs">{i.sodConflicts.length ? i.sodConflicts.map((c) => `${c.code} [${c.severity}]`).join(', ') : '—'}</td>
                            <td className="text-xs">
                              <span className={i.decision === 'PENDING' ? 'chip chip-warn' : 'chip'}>{i.decision}</span>
                              {i.decidedByUsername && <div className="text-ink-soft">by {i.decidedByUsername}</div>}
                              {i.decisionReason && <div>{i.decisionReason}</div>}
                              {i.appliedAt && <div className="text-ink-soft">applied {i.appliedAt.slice(0, 10)}</div>}
                              {i.applyError && <div role="alert" className="text-signal-error">Not applied: {i.applyError}</div>}
                            </td>
                            <td>{selected!.status === 'OPEN' && !i.appliedAt
                              ? <DecideForm reviewId={selected!.reviewId} lineNumber={i.lineNumber} isSelf={i.subjectUserId === session.user.userId} current={i.decision} />
                              : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
