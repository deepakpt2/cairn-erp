'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { t } from '@/platform/i18n';
import { ClaimFailureNotice, LockNotice, useChangeLockClaim } from '@/ui/lock/ChangeLock';
import { shouldDispatch } from '@/ui/lock/claim';
import {
  assignPurchasingOrgCompanyCodeAction,
  type PurchasingOrgCompanyCodeAssignmentState,
} from './actions';

interface CompanyCodeChoice {
  code: string;
  name: string;
}

export function PurchasingOrgCompanyCodeAssignmentForm({
  purchasingOrg,
  companyCodes,
}: {
  purchasingOrg: string;
  companyCodes: CompanyCodeChoice[];
}) {
  const [state, action, pending] = useActionState<PurchasingOrgCompanyCodeAssignmentState, FormData>(
    assignPurchasingOrgCompanyCodeAction,
    { ok: true },
  );
  const [engaged, setEngaged] = useState(false);
  const [reopenRequested, setReopenRequested] = useState(false);
  const [reopenAttempted, setReopenAttempted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const { claim, notice, retry, reportPress, dispatched } = useChangeLockClaim(
    'PURCHASING_ORG_COMPANY',
    purchasingOrg,
    'CFG.PROC.PURORG.ASSIGN_COMPANY',
    engaged,
  );

  // A save press made while the lock is pending is kept once by the shared claim state machine. It is
  // dispatched only after CHANGE is the platform's answer; the server action asserts this same session's
  // persisted lock again before it reaches the assignment service.
  useEffect(() => {
    if (!shouldDispatch(claim)) return;
    dispatched();
    const form = formRef.current;
    if (form) action(new FormData(form));
  }, [claim, dispatched, action]);

  // Assertion failures are returned by the server action before the assignment service writes anything.
  // Reacquire through the same hook, after its cleanup chain has released this session's old claim.
  useEffect(() => {
    if (!reopenRequested || engaged) return;
    setReopenRequested(false);
    setEngaged(true);
  }, [reopenRequested, engaged]);

  const refused = claim.phase === 'refused';
  const waiting = claim.phase === 'pending';
  const acquired = claim.phase === 'open';
  const cannotSubmit = pending || waiting || refused || claim.phase === 'failed' || claim.queued || companyCodes.length === 0 ||
    (Boolean(state.lockFailure) && !reopenAttempted) || (reopenAttempted && !engaged);

  if (state.ok && state.message) {
    return (
      <div className="space-y-2">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        <Link
          className="text-sm text-accent underline"
          href={`/config/purchasing-orgs?purchasingOrg=${encodeURIComponent(state.purchasingOrg ?? purchasingOrg)}`}
        >
          {t('purchasingOrg.open')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {state.message && (
        <div role="alert" className="border border-signal-error/30 bg-signal-error-soft p-2 text-xs text-signal-error">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1">{state.remedy}</p>}
          {state.lockFailure && (!reopenAttempted || claim.phase === 'pending') && (
            <button
              type="button"
              className="btn btn-default mt-2 min-h-11"
              disabled={waiting}
              onClick={() => {
                setReopenAttempted(true);
                setEngaged(false);
                setReopenRequested(true);
              }}
            >
              {t('purchasingOrg.reopenCompanyLock')}
            </button>
          )}
        </div>
      )}
      {claim.phase === 'idle' && (
        <p role="status" className="text-xs text-ink-soft">{t('purchasingOrg.companyLockIdle')}</p>
      )}
      {waiting && (
        <p role="status" aria-live="polite" className="text-xs text-ink-soft">
          {t(claim.queued ? 'purchasingOrg.companyLockPendingSubmit' : 'purchasingOrg.companyLockPending')}
        </p>
      )}
      {acquired && (
        <p role="status" className="text-xs text-signal-ok">{t('purchasingOrg.companyLockAcquired')}</p>
      )}
      <form
        ref={formRef}
        action={action}
        className="flex flex-wrap items-end gap-2"
        onFocus={() => setEngaged(true)}
        onSubmit={(event) => {
          if (claim.phase === 'open') {
            setReopenAttempted(false);
            return;
          }
          event.preventDefault();
          // Idle and pending are explicitly represented. Keep at most one intent for this claim; a grant
          // will send it once, while refusal/failure drops it and leaves the reason/retry visible.
          if (claim.phase === 'idle' || claim.phase === 'pending') {
            reportPress();
            setEngaged(true);
          }
        }}
      >
        <input type="hidden" name="purchasingOrg" value={purchasingOrg} />
        <label className="min-w-64 flex-1">
          <span className="sr-only">{t('purchasingOrg.companyCodeForOrg', { code: purchasingOrg })}</span>
          <select
            name="companyCode"
            required
            defaultValue=""
            className="field-input code"
            disabled={pending || companyCodes.length === 0}
          >
            <option value="">{t('purchasingOrg.chooseCompanyCode')}</option>
            {companyCodes.map((company) => (
              <option key={company.code} value={company.code}>
                {company.code} · {company.name}
              </option>
            ))}
          </select>
        </label>
        <LockNotice message={refused ? notice.message : null} remedy={refused ? notice.remedy : null} />
        <ClaimFailureNotice claim={claim} onRetry={retry} />
        <button className="btn btn-primary" disabled={cannotSubmit}>
          {pending
            ? t('common.saving')
            : state.message && !state.ok
              ? t('purchasingOrg.retryCompanyAssignment')
              : t('purchasingOrg.assignCompanyCode')}
        </button>
      </form>
    </div>
  );
}
