'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  AUDIT_ACCESS_REVIEW_CAPABILITY,
  AUDIT_ACCESS_REVIEW_ROUTE,
  AccessReviewError,
  applyAccessReviewRevocations,
  cancelAccessReview,
  completeAccessReview,
  createAccessReview,
  decideAccessReviewItem,
} from '@/modules/audit/access-review';

const ROUTE = AUDIT_ACCESS_REVIEW_ROUTE;

export interface AccessReviewActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  /** A fresh idempotency key for the next submission of the create form. */
  requestKey?: string;
}

const text = (form: FormData, name: string) => (typeof form.get(name) === 'string' ? (form.get(name) as string).trim() : '');

function refusal(error: unknown): AccessReviewActionState {
  if (error instanceof AccessReviewError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

async function reviewer() {
  const session = await requireSession(ROUTE);
  if (!can(session, AUDIT_ACCESS_REVIEW_CAPABILITY)) {
    return { session, refused: { ok: false, message: `You do not hold ${AUDIT_ACCESS_REVIEW_CAPABILITY}.`, remedy: `Ask for ${AUDIT_ACCESS_REVIEW_CAPABILITY}.` } as AccessReviewActionState };
  }
  if (!session.sessionId) return { session, refused: { ok: false, message: 'Your session could not be verified.', remedy: 'Sign in again.' } as AccessReviewActionState };
  return { session, refused: null };
}

const auth = (s: { user: { userId: string }; sessionId?: string }) => ({ userId: s.user.userId, sessionId: s.sessionId! });

export async function createAccessReviewAction(_p: AccessReviewActionState, form: FormData): Promise<AccessReviewActionState> {
  const { session, refused } = await reviewer();
  if (refused) return refused;
  try {
    const review = await createAccessReview({
      client: session.user.client, authorization: auth(session),
      code: text(form, 'code'), name: text(form, 'name'), reviewDate: text(form, 'reviewDate'),
      roleFilter: text(form, 'roleFilter') || undefined, capabilityFilter: text(form, 'capabilityFilter') || undefined,
      userFilter: text(form, 'userFilter') || undefined, reason: text(form, 'reason'), requestKey: text(form, 'requestKey') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Review ${review.code} raised: ${review.counts.items} item${review.counts.items === 1 ? '' : 's'} to decide.`, requestKey: randomUUID() };
  } catch (error) { return refusal(error); }
}

export async function decideAccessReviewItemAction(_p: AccessReviewActionState, form: FormData): Promise<AccessReviewActionState> {
  const { session, refused } = await reviewer();
  if (refused) return refused;
  try {
    await decideAccessReviewItem({
      client: session.user.client, authorization: auth(session), reviewId: text(form, 'reviewId'),
      lineNumber: Number(text(form, 'lineNumber')), decision: text(form, 'decision') as 'CERTIFIED' | 'REVOKE', reason: text(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'Decision recorded.' };
  } catch (error) { return refusal(error); }
}

export async function applyAccessReviewRevocationsAction(_p: AccessReviewActionState, form: FormData): Promise<AccessReviewActionState> {
  const { session, refused } = await reviewer();
  if (refused) return refused;
  try {
    const out = await applyAccessReviewRevocations({ client: session.user.client, authorization: auth(session), reviewId: text(form, 'reviewId') });
    revalidatePath(ROUTE);
    const failed = out.failed.length;
    return {
      ok: failed === 0,
      message: `${out.applied} revocation${out.applied === 1 ? '' : 's'} applied${failed ? `, ${failed} refused` : ''}.`,
      remedy: failed ? out.failed.map((f) => `Line ${f.lineNumber} (${f.roleCode}): ${f.reason}`).join(' ') : undefined,
    };
  } catch (error) { return refusal(error); }
}

export async function completeAccessReviewAction(_p: AccessReviewActionState, form: FormData): Promise<AccessReviewActionState> {
  const { session, refused } = await reviewer();
  if (refused) return refused;
  try {
    await completeAccessReview({ client: session.user.client, authorization: auth(session), reviewId: text(form, 'reviewId'), reason: text(form, 'reason') });
    revalidatePath(ROUTE);
    return { ok: true, message: 'Review completed. It stands as evidence.' };
  } catch (error) { return refusal(error); }
}

export async function cancelAccessReviewAction(_p: AccessReviewActionState, form: FormData): Promise<AccessReviewActionState> {
  const { session, refused } = await reviewer();
  if (refused) return refused;
  try {
    await cancelAccessReview({ client: session.user.client, authorization: auth(session), reviewId: text(form, 'reviewId'), reason: text(form, 'reason') });
    revalidatePath(ROUTE);
    return { ok: true, message: 'Review cancelled.' };
  } catch (error) { return refusal(error); }
}
