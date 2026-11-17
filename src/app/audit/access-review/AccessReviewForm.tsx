'use client';

import { useActionState } from 'react';

import {
  applyAccessReviewRevocationsAction, cancelAccessReviewAction, completeAccessReviewAction,
  createAccessReviewAction, decideAccessReviewItemAction, type AccessReviewActionState,
} from './actions';

const NONE: AccessReviewActionState = { ok: false };

function Notice({ state }: { state: AccessReviewActionState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className={`mt-2 rounded border p-2 text-sm ${state.ok ? 'border-signal-ok/30 text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}>
      <p>{state.message}</p>{state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
    </div>
  );
}

export function CreateReviewForm({ requestKey, today }: { requestKey: string; today: string }) {
  const [state, action, pending] = useActionState(createAccessReviewAction, NONE);
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">Raise a review</h2>
      <input type="hidden" name="requestKey" value={state.requestKey ?? requestKey} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium text-ink-soft">Code<input name="code" required maxLength={40} placeholder="UAR-2026Q4" className="field-input code mt-1 w-full" /></label>
        <label className="text-xs font-medium text-ink-soft sm:col-span-2">Name<input name="name" required maxLength={100} className="field-input mt-1 w-full" /></label>
        <label className="text-xs font-medium text-ink-soft">Review date<input name="reviewDate" type="date" required max={today} defaultValue={today} className="field-input mt-1 w-full" /></label>
        <label className="text-xs font-medium text-ink-soft">Role filter<input name="roleFilter" maxLength={40} className="field-input code mt-1 w-full" /></label>
        <label className="text-xs font-medium text-ink-soft">Capability filter<input name="capabilityFilter" maxLength={64} placeholder="PROC.*" className="field-input code mt-1 w-full" /></label>
        <label className="text-xs font-medium text-ink-soft">User id filter<input name="userFilter" maxLength={36} className="field-input code mt-1 w-full" /></label>
        <label className="text-xs font-medium text-ink-soft sm:col-span-2">Why is this review being raised?<input name="reason" required className="field-input mt-1 w-full" /></label>
      </div>
      <p className="text-xs text-ink-soft">A blank filter means every active, unlocked user. One item is frozen for each role assignment in force today.</p>
      <button type="submit" disabled={pending} className="btn btn-primary">{pending ? 'Raising…' : 'Raise review'}</button>
      <Notice state={state} />
    </form>
  );
}

export function DecideForm({ reviewId, lineNumber, isSelf, current }: { reviewId: string; lineNumber: number; isSelf: boolean; current: string }) {
  const [state, action, pending] = useActionState(decideAccessReviewItemAction, NONE);
  if (isSelf) return <p className="text-xs text-ink-soft">This is your own access. Another reviewer must decide it.</p>;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="reviewId" value={reviewId} />
      <input type="hidden" name="lineNumber" value={lineNumber} />
      <input name="reason" required placeholder="Reason" aria-label="Reason" className="field-input w-48" />
      <button name="decision" value="CERTIFIED" type="submit" disabled={pending} className="btn btn-default">Certify</button>
      <button name="decision" value="REVOKE" type="submit" disabled={pending} className="btn btn-default">Revoke</button>
      {current !== 'PENDING' && <span className="text-2xs text-ink-faint">Deciding again overwrites.</span>}
      <Notice state={state} />
    </form>
  );
}

function ReviewButton({ label, reviewId, withReason, reasonRequired, act }: {
  label: string; reviewId: string; withReason?: boolean; reasonRequired?: boolean;
  act: (p: AccessReviewActionState, f: FormData) => Promise<AccessReviewActionState>;
}) {
  const [state, action, pending] = useActionState(act, NONE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="reviewId" value={reviewId} />
      {withReason && <input name="reason" required={reasonRequired} placeholder={reasonRequired ? 'Reason (required)' : 'Note (optional)'} className="field-input w-56" />}
      <button type="submit" disabled={pending} className="btn btn-default">{label}</button>
      <Notice state={state} />
    </form>
  );
}

export const ApplyButton = ({ reviewId }: { reviewId: string }) => <ReviewButton label="Apply revocations" reviewId={reviewId} act={applyAccessReviewRevocationsAction} />;
export const CompleteButton = ({ reviewId }: { reviewId: string }) => <ReviewButton label="Complete review" reviewId={reviewId} withReason act={completeAccessReviewAction} />;
export const CancelButton = ({ reviewId }: { reviewId: string }) => <ReviewButton label="Cancel review" reviewId={reviewId} withReason reasonRequired act={cancelAccessReviewAction} />;
