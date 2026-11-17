/**
 * ITEM-19 — access review. Real erp_test database; fixtures built like platform-role-admin.test.ts:
 * a PLATFORM_ADMIN session is the only thing `revokeRoleFromUser` accepts as the remover.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSession } from '@/platform/auth/session';
import { loadCapabilities } from '@/platform/auth/session';
import {
  appUser, authOrgRestriction, role, roleCapability, sodRule, userCapability, userRole, userSession,
} from '@/platform/tables/security';
import { accessReview, accessReviewItem } from '@/modules/audit/schema';
import {
  AUDIT_ACCESS_REVIEW_CAPABILITY, applyAccessReviewRevocations, cancelAccessReview, completeAccessReview,
  createAccessReview, decideAccessReviewItem, getAccessReview, listAccessReviews, type AccessReviewView,
} from '@/modules/audit/access-review';
import {
  PLATFORM_ADMIN_ROLE_CODE, ROLE_MAINTAIN_CAPABILITY, USER_ROLE_MAINTAIN_CAPABILITY,
} from '@/modules/platform/role-admin';
import { createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';

interface Person { id: string; username: string; auth: { userId: string; sessionId: string } }
let tenant: TestTenant;
let other: TestTenant;
let admin: Person;     // PLATFORM_ADMIN: reviews and removes
let reviewer: Person;  // reviews only
let c = 0;
const DAY = 86_400_000;

async function mk(client: string, name: string, roleCode?: string, caps: string[] = []): Promise<Person> {
  c += 1;
  const id = randomUUID();
  const username = `ar.${name}.${c}`;
  let sessionId = '';
  await withTenant(client, async (tx) => {
    await tx.insert(appUser).values({ id, client, username, fullName: `AR ${name}`, passwordHash: 'TEST_ONLY_NOT_A_CREDENTIAL', createdBy: 'TEST' });
    if (roleCode) {
      await tx.insert(role).values({ client, code: roleCode, name: `Name of ${roleCode}`, isSystemRole: roleCode === PLATFORM_ADMIN_ROLE_CODE, createdBy: 'TEST' }).onConflictDoNothing();
      for (const code of caps) await tx.insert(roleCapability).values({ client, roleCode, capabilityCode: code, createdBy: 'TEST' }).onConflictDoNothing();
      await tx.insert(userRole).values({ client, userId: id, roleCode, createdBy: 'TEST' });
    }
    await createSession(tx, { client, userId: id, userAgent: 'access-review.test' });
    const [s] = await tx.select({ id: userSession.id }).from(userSession).where(and(eq(userSession.client, client), eq(userSession.userId, id))).orderBy(desc(userSession.issuedAt)).limit(1);
    sessionId = s!.id;
  });
  return { id, username, auth: { userId: id, sessionId } };
}
const addRole = (client: string, userId: string, roleCode: string, caps: string[], validFrom?: Date, validTo?: Date | null) =>
  withTenant(client, async (tx) => {
    await tx.insert(role).values({ client, code: roleCode, name: `Name of ${roleCode}`, createdBy: 'TEST' }).onConflictDoNothing();
    for (const code of caps) await tx.insert(roleCapability).values({ client, roleCode, capabilityCode: code, createdBy: 'TEST' }).onConflictDoNothing();
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: 'TEST', ...(validFrom ? { validFrom } : {}), ...(validTo !== undefined ? { validTo } : {}) });
  });

const raise = (by: Person, over: Partial<Parameters<typeof createAccessReview>[0]> = {}) =>
  createAccessReview({
    client: tenant.client, authorization: by.auth, code: `UAR-${++c}`, name: 'Review', reviewDate: new Date().toISOString().slice(0, 10),
    reason: 'Quarterly recertification', ...over,
  });
const decide = (by: Person, r: AccessReviewView, line: number, decision: 'CERTIFIED' | 'REVOKE', reason = 'Needed') =>
  decideAccessReviewItem({ client: tenant.client, authorization: by.auth, reviewId: r.reviewId, lineNumber: line, decision, reason });
const lineOf = (r: AccessReviewView, userId: string, roleCode?: string) => r.items.find((i) => i.subjectUserId === userId && (!roleCode || i.roleCode === roleCode))!.lineNumber;
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { remedy?: string; code?: string }; } throw new Error('expected a refusal'); };
const changeDocs = (objectKey: string) => withTenant(tenant.client, async (tx) => (await tx.execute(sql`
  select d.id, d.object_key, i.field_name, i.old_value, i.new_value, i.is_security_relevant, d.reason
    from change_document d join change_document_item i on i.change_document_id = d.id
   where d.object_class = 'access_review' and d.object_key like ${objectKey + '%'} order by d.changed_at, i.field_name`)) as unknown as Array<Record<string, unknown>>);
const heldBy = async (ids: string[]) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await withTenant(tenant.client, (tx) => loadCapabilities(tx, tenant.client, id))).sort()] as const)));

beforeAll(async () => {
  tenant = await createTenant('access-review-a', { withConfiguration: false });
  other = await createTenant('access-review-b', { withConfiguration: false });
  admin = await mk(tenant.client, 'admin', PLATFORM_ADMIN_ROLE_CODE, [ROLE_MAINTAIN_CAPABILITY, USER_ROLE_MAINTAIN_CAPABILITY, AUDIT_ACCESS_REVIEW_CAPABILITY]);
  reviewer = await mk(tenant.client, 'reviewer', 'AR_REVIEWER', [AUDIT_ACCESS_REVIEW_CAPABILITY]);
  // The audit services want an explicit Company Code reach on whoever acts (service-authority.ts).
  await withTenant(tenant.client, (tx) => tx.insert(authOrgRestriction).values(
    [admin, reviewer].map((p) => ({ id: randomUUID(), client: tenant.client, userId: p.id, scopeType: 'COMPANY_CODE' as const, scopeValue: '1000', createdBy: 'TEST' })),
  ));
}, 30_000);
afterAll(async () => { await destroyTenant(tenant.client); await destroyTenant(other.client); });

describe('raising a review', () => {
  it('1 — one item per currently-effective assignment, none for an ended one', async () => {
    const u = await mk(tenant.client, 'one', 'AR1_LIVE', ['TEST.AR.ONE']);
    await addRole(tenant.client, u.id, 'AR1_OLD', ['TEST.AR.OLD'], new Date(Date.now() - 10 * DAY), new Date(Date.now() - DAY));
    const r = await raise(reviewer);
    const mine = r.items.filter((i) => i.subjectUserId === u.id);
    expect(mine.map((i) => i.roleCode)).toEqual(['AR1_LIVE']);
    expect(mine[0]).toMatchObject({ roleName: 'Name of AR1_LIVE', decision: 'PENDING' });
    const expected = await withTenant(tenant.client, async (tx) => Number((await tx.execute(sql`
      select count(*)::int n from user_role ur join app_user u on u.id = ur.user_id and u.client = ur.client
       where ur.client = ${tenant.client} and u.is_active and not u.is_locked and ur.valid_from <= now() and (ur.valid_to is null or ur.valid_to >= now())`))[0]!.n));
    expect(r.items).toHaveLength(expected);
  });

  it('2 — filters by role, by capability (including a wildcard held or asked for) and by user', async () => {
    const p = await mk(tenant.client, 'proc', 'AR2_PROC', ['PROC.*']);
    const q = await mk(tenant.client, 'po', 'AR2_PO', ['PROC.PO.CREATE']);
    const n = await mk(tenant.client, 'none', 'AR2_NONE', ['TEST.AR.TWO']);
    const byRole = await raise(reviewer, { roleFilter: 'AR2_PROC' });
    expect([...new Set(byRole.items.map((i) => i.subjectUserId))]).toEqual([p.id]);
    const byCap = await raise(reviewer, { capabilityFilter: 'PROC.PO.CREATE' });
    expect(new Set(byCap.items.map((i) => i.subjectUserId))).toEqual(new Set([p.id, q.id]));
    const byPattern = await raise(reviewer, { capabilityFilter: 'PROC.*' });
    expect(new Set(byPattern.items.map((i) => i.subjectUserId))).toEqual(new Set([p.id, q.id]));
    const byUser = await raise(reviewer, { userFilter: n.id });
    expect(byUser.items.map((i) => i.subjectUserId)).toEqual([n.id]);
    expect(byUser).toMatchObject({ userFilter: n.id, roleFilter: null });
  });

  it('3 — an empty population is refused; an inactive or locked user is not in one', async () => {
    expect((await refusal(raise(reviewer, { roleFilter: 'NO_SUCH_ROLE' }))).code).toBe('ACCESS_REVIEW_EMPTY');
    const gone = await mk(tenant.client, 'gone', 'AR3_GONE', ['TEST.AR.THREE']);
    await withTenant(tenant.client, (tx) => tx.update(appUser).set({ isLocked: true }).where(eq(appUser.id, gone.id)));
    expect((await refusal(raise(reviewer, { userFilter: gone.id }))).code).toBe('ACCESS_REVIEW_EMPTY');
  });

  it('4 — authority held only by a direct grant shows with its capabilities and produces no item', async () => {
    const d = await mk(tenant.client, 'direct');
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    await withTenant(tenant.client, (tx) => tx.insert(userCapability).values({ id: randomUUID(), client: tenant.client, userId: d.id, capabilityCode: 'TEST.AR.DIRECT', validFrom: today, validTo: end, reason: 'DELEGATION', granter: 'boss', createdBy: 'TEST' }));
    const r = await raise(reviewer, { userFilter: d.id });
    expect(r.items).toHaveLength(0);
    const s = r.subjects.find((x) => x.userId === d.id)!;
    expect(s.itemCount).toBe(0);
    expect(s.live.capabilities).toContain('TEST.AR.DIRECT');
    expect(s.live.directGrants).toEqual([expect.objectContaining({ capabilityCode: 'TEST.AR.DIRECT', granter: 'boss', validTo: end })]);
  });

  it('19 — a repeated requestKey returns the same review and creates no second one', async () => {
    const u = await mk(tenant.client, 'key', 'AR19', ['TEST.AR.K']);
    const key = randomUUID();
    const a = await raise(reviewer, { userFilter: u.id, requestKey: key });
    const b = await raise(reviewer, { userFilter: u.id, requestKey: key });
    expect(b.reviewId).toBe(a.reviewId);
    expect(await withTenant(tenant.client, async (tx) => (await tx.select().from(accessReview).where(eq(accessReview.requestKey, key))).length)).toBe(1);
  });

  it('refuses a missing reason, a future date and a caller without the capability', async () => {
    expect((await refusal(raise(reviewer, { reason: ' ' }))).code).toBe('ACCESS_REVIEW_REASON');
    expect((await refusal(raise(reviewer, { reviewDate: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10) }))).code).toBe('ACCESS_REVIEW_DATE');
    const nobody = await mk(tenant.client, 'nobody', 'AR_NOBODY', ['TEST.NOTHING']);
    expect((await refusal(raise(nobody))).code).toBe('ACCESS_REVIEW_AUTHORITY');
  });
});

describe('deciding', () => {
  it('5-7 — a decision is stored and change-documented; self-decision and a missing reason are refused', async () => {
    const u = await mk(tenant.client, 'dec', 'AR5', ['TEST.AR.FIVE']);
    const r = await raise(reviewer, { roleFilter: 'AR5' });
    const line = lineOf(r, u.id);
    const item = await decide(reviewer, r, line, 'CERTIFIED', 'Still on the team');
    expect(item).toMatchObject({ decision: 'CERTIFIED', decidedByUserId: reviewer.id, decisionReason: 'Still on the team' });
    expect(item.decidedAt).toBeTruthy();
    const docs = await changeDocs(`${r.reviewId}/${line}`);
    expect(docs.find((d) => d.field_name === 'decision')).toMatchObject({ new_value: 'CERTIFIED', is_security_relevant: 'true' });

    expect((await refusal(decide(reviewer, r, line, 'CERTIFIED', ' '))).code).toBe('ACCESS_REVIEW_REASON');
    const own = await mk(tenant.client, 'self', 'AR6_SELF', [AUDIT_ACCESS_REVIEW_CAPABILITY]);
    await withTenant(tenant.client, (tx) => tx.insert(authOrgRestriction).values({ id: randomUUID(), client: tenant.client, userId: own.id, scopeType: 'COMPANY_CODE', scopeValue: '1000', createdBy: 'TEST' }));
    const r2 = await raise(reviewer, { roleFilter: 'AR6_SELF' });
    const e = await refusal(decide(own, r2, lineOf(r2, own.id), 'CERTIFIED'));
    expect(e).toMatchObject({ code: 'ACCESS_REVIEW_SELF', message: 'You cannot decide on your own access.' });
    expect(e.remedy).toMatch(/another reviewer/i);
  });

  it('8 — certifying an inactive or locked user is refused; revoking is allowed', async () => {
    const u = await mk(tenant.client, 'dormant', 'AR8', ['TEST.AR.EIGHT']);
    const r = await raise(reviewer, { roleFilter: 'AR8' });
    await withTenant(tenant.client, (tx) => tx.update(appUser).set({ isLocked: true }).where(eq(appUser.id, u.id)));
    const e = await refusal(decide(reviewer, r, lineOf(r, u.id), 'CERTIFIED'));
    expect(e).toMatchObject({ code: 'ACCESS_REVIEW_INACTIVE' });
    expect(e.message).toContain('cannot be certified');
    expect((await decide(reviewer, r, lineOf(r, u.id), 'REVOKE', 'Left the company')).decision).toBe('REVOKE');
  });

  it('9 — re-deciding overwrites and the previous decision is in the change document', async () => {
    const u = await mk(tenant.client, 'redo', 'AR9', ['TEST.AR.NINE']);
    const r = await raise(reviewer, { roleFilter: 'AR9' });
    const line = lineOf(r, u.id);
    await decide(reviewer, r, line, 'CERTIFIED', 'first view');
    expect((await decide(reviewer, r, line, 'REVOKE', 'second view')).decision).toBe('REVOKE');
    const docs = (await changeDocs(`${r.reviewId}/${line}`)).filter((d) => d.field_name === 'decision');
    expect(docs.map((d) => [d.old_value, d.new_value])).toEqual([['PENDING', 'CERTIFIED'], ['CERTIFIED', 'REVOKE']]);
  });

  it('18 — SoD conflicts are listed with rule and severity, and do not block a decision', async () => {
    const u = await mk(tenant.client, 'sod', 'AR18', ['TEST.SOD.A', 'TEST.SOD.B']);
    await withTenant(tenant.client, (tx) => tx.insert(sodRule).values({ client: tenant.client, code: 'AR18_RULE', description: 'A with B', capabilityA: 'TEST.SOD.A', capabilityB: 'TEST.SOD.B', severity: 'HIGH', createdBy: 'TEST' }));
    const r = await raise(reviewer, { roleFilter: 'AR18' });
    const item = r.items.find((i) => i.subjectUserId === u.id)!;
    expect(item.sodConflicts).toEqual([expect.objectContaining({ code: 'AR18_RULE', severity: 'HIGH' })]);
    expect(r.subjects.find((s) => s.userId === u.id)!.live.sodConflicts[0]).toMatchObject({ code: 'AR18_RULE', severity: 'HIGH' });
    expect((await decide(reviewer, r, item.lineNumber, 'CERTIFIED', 'accepted risk')).decision).toBe('CERTIFIED');
  });
});

describe('applying', () => {
  it('10, 20 — the assignment is expired not deleted, stamps are set, and capabilities only ever shrink', async () => {
    const u = await mk(tenant.client, 'apply', 'AR10', ['TEST.AR.TEN']);
    const keep = await mk(tenant.client, 'keep', 'AR10K', ['TEST.AR.TENK']);
    const before = await heldBy([u.id, keep.id]);
    const r = await raise(reviewer, { roleFilter: 'AR10' });
    expect(await heldBy([u.id, keep.id])).toEqual(before); // raising grants nothing
    await decide(reviewer, r, lineOf(r, u.id), 'REVOKE', 'No longer needed');
    const out = await applyAccessReviewRevocations({ client: tenant.client, authorization: admin.auth, reviewId: r.reviewId });
    expect(out).toEqual({ applied: 1, failed: [] });
    const [row] = await withTenant(tenant.client, (tx) => tx.select().from(userRole).where(and(eq(userRole.userId, u.id), eq(userRole.roleCode, 'AR10'))));
    expect(row!.validTo!.getTime()).toBeLessThanOrEqual(Date.now());
    const item = (await getAccessReview(tenant.client, r.reviewId)).items.find((i) => i.subjectUserId === u.id)!;
    expect(item.appliedAt).toBeTruthy(); expect(item.appliedByUserId).toBe(admin.id);
    const after = await heldBy([u.id, keep.id]);
    expect(after[keep.id]).toEqual(before[keep.id]);
    expect(after[u.id]!.length).toBeLessThan(before[u.id]!.length);
    expect(after[u.id]!.every((x) => before[u.id]!.includes(x))).toBe(true);
  });

  it('11 — applying without CFG.PLT.USER.ROLE.MAINTAIN is refused and says the decisions stand', async () => {
    const u = await mk(tenant.client, 'noapply', 'AR11', ['TEST.AR.ELEVEN']);
    const r = await raise(reviewer, { roleFilter: 'AR11' });
    await decide(reviewer, r, lineOf(r, u.id), 'REVOKE', 'x');
    const e = await refusal(applyAccessReviewRevocations({ client: tenant.client, authorization: reviewer.auth, reviewId: r.reviewId }));
    expect(e.message).toContain('CFG.PLT.USER.ROLE.MAINTAIN');
    expect(e.remedy).toMatch(/Record the decisions and ask an administrator to apply them/);
    expect((await getAccessReview(tenant.client, r.reviewId)).items.find((i) => i.subjectUserId === u.id)!.decision).toBe('REVOKE');
  });

  it('12 — a refusal (protected role) is recorded in apply_error and the others are still applied', async () => {
    const u = await mk(tenant.client, 'protected', 'AR12_OK', ['TEST.AR.TWELVE']);
    await addRole(tenant.client, u.id, PLATFORM_ADMIN_ROLE_CODE, []);
    const r = await raise(reviewer, { userFilter: u.id });
    const pa = lineOf(r, u.id, PLATFORM_ADMIN_ROLE_CODE); const ok = lineOf(r, u.id, 'AR12_OK');
    await decide(reviewer, r, pa, 'REVOKE', 'revoke the protected role'); await decide(reviewer, r, ok, 'REVOKE', 'and the ordinary one');
    const out = await applyAccessReviewRevocations({ client: tenant.client, authorization: admin.auth, reviewId: r.reviewId });
    expect(out.applied).toBe(1);
    expect(out.failed).toEqual([expect.objectContaining({ lineNumber: pa, roleCode: PLATFORM_ADMIN_ROLE_CODE })]);
    const items = (await getAccessReview(tenant.client, r.reviewId)).items;
    expect(items.find((i) => i.lineNumber === pa)!.applyError).toMatch(/Protected platform administrator/);
    expect(items.find((i) => i.lineNumber === ok)!.appliedAt).toBeTruthy();
  });
});

describe('completing and cancelling', () => {
  it('13-15 — pending blocks (naming the count), an unapplied revoke blocks, a failed one does not', async () => {
    const a = await mk(tenant.client, 'ca', 'AR13A', ['TEST.AR.A13']);
    const b = await mk(tenant.client, 'cb', 'AR13B', ['TEST.AR.B13']);
    const r = await raise(reviewer, { capabilityFilter: 'TEST.AR.?13'.replace('?', 'A') });
    void b;
    const both = await raise(reviewer, { roleFilter: 'AR13A' });
    const second = await raise(reviewer, { roleFilter: 'AR13B' });
    expect(r.items).toHaveLength(1);
    const e13 = await refusal(completeAccessReview({ client: tenant.client, authorization: reviewer.auth, reviewId: both.reviewId }));
    expect(e13).toMatchObject({ code: 'ACCESS_REVIEW_PENDING' }); expect(e13.message).toContain('1 item');

    await decide(reviewer, both, lineOf(both, a.id), 'REVOKE', 'x');
    expect((await refusal(completeAccessReview({ client: tenant.client, authorization: reviewer.auth, reviewId: both.reviewId }))).code).toBe('ACCESS_REVIEW_UNAPPLIED');

    // a failed revocation is on the record and lets the review complete
    const prot = await mk(tenant.client, 'cp', PLATFORM_ADMIN_ROLE_CODE, []);
    const pr = await raise(reviewer, { userFilter: prot.id });
    await decide(reviewer, pr, lineOf(pr, prot.id), 'REVOKE', 'try');
    await applyAccessReviewRevocations({ client: tenant.client, authorization: admin.auth, reviewId: pr.reviewId });
    const done = await completeAccessReview({ client: tenant.client, authorization: reviewer.auth, reviewId: pr.reviewId, reason: 'signed off' });
    expect(done).toMatchObject({ status: 'COMPLETED', completedByUserId: reviewer.id });
    expect(done.counts).toMatchObject({ revoke: 1, applied: 0, failed: 1 });
    expect(await changeDocs(pr.reviewId)).toEqual(expect.arrayContaining([expect.objectContaining({ field_name: 'status', new_value: 'COMPLETED' })]));
    void second;
  });

  it('16 — cancel needs a reason and is refused after completion', async () => {
    const u = await mk(tenant.client, 'cx', 'AR16', ['TEST.AR.SIXTEEN']);
    const r = await raise(reviewer, { roleFilter: 'AR16' });
    expect((await refusal(cancelAccessReview({ client: tenant.client, authorization: reviewer.auth, reviewId: r.reviewId, reason: ' ' }))).code).toBe('ACCESS_REVIEW_REASON');
    await decide(reviewer, r, lineOf(r, u.id), 'CERTIFIED', 'ok');
    await completeAccessReview({ client: tenant.client, authorization: reviewer.auth, reviewId: r.reviewId });
    expect((await refusal(cancelAccessReview({ client: tenant.client, authorization: reviewer.auth, reviewId: r.reviewId, reason: 'oops' }))).code).toBe('ACCESS_REVIEW_CLOSED');
    const r2 = await raise(reviewer, { roleFilter: 'AR16' });
    expect((await cancelAccessReview({ client: tenant.client, authorization: reviewer.auth, reviewId: r2.reviewId, reason: 'duplicate' })).status).toBe('CANCELLED');
    expect((await listAccessReviews(tenant.client, { status: 'CANCELLED' })).map((x) => x.reviewId)).toContain(r2.reviewId);
  });

  it('17 — the frozen capabilities do not change when the role does; the live picture does', async () => {
    const u = await mk(tenant.client, 'frozen', 'AR17', ['TEST.AR.OLD17']);
    const r = await raise(reviewer, { roleFilter: 'AR17' });
    await withTenant(tenant.client, (tx) => tx.insert(roleCapability).values({ client: tenant.client, roleCode: 'AR17', capabilityCode: 'TEST.AR.NEW17', createdBy: 'TEST' }));
    const again = await getAccessReview(tenant.client, r.reviewId);
    expect(again.items.find((i) => i.subjectUserId === u.id)!.effectiveCapabilities).toEqual(['TEST.AR.OLD17']);
    expect(again.subjects.find((s) => s.userId === u.id)!.live.capabilities.sort()).toEqual(['TEST.AR.NEW17', 'TEST.AR.OLD17']);
  });

  it('a review of tenant A is invisible to tenant B', async () => {
    const r = await raise(reviewer, { userFilter: admin.id });
    expect(await withTenant(other.client, (tx) => tx.select().from(accessReviewItem).where(eq(accessReviewItem.reviewId, r.reviewId)))).toEqual([]);
    await expect(getAccessReview(other.client, r.reviewId)).rejects.toMatchObject({ code: 'ACCESS_REVIEW_NOT_FOUND' });
  });
});
