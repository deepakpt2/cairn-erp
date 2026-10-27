'use client';

import { useEffect, useReducer } from 'react';


import {
  heartbeatEnqueueAction,
  openChangeLockAction,
  releaseEnqueueAction,
  type ChangeLockState,
} from '@/app/platform/locks/actions';
import {
  changeLockClaim,
  claimKey,
  claimNotice,
  failureNoticeView,
  failureText,
  IDLE_CLAIM,
  projectClaim,
  type ChangeLockClaim,
} from './claim';

/**
 * The answer of a claim, and the one action that can restart it.
 *
 * Screens that only need the platform's answer keep reading `useChangeLock`. A screen that has to tell
 * an owed answer from a failure — anything that keeps a press, or that must say why nothing happened —
 * reads `claim` instead.
 */
export interface ChangeLockClaimHandle {
  claim: ChangeLockClaim;
  /** What a notice should show for this claim: refusal text with its recovery sentence, or the failure. */
  notice: { message: string | null; remedy: string | null };
  /** The only way a claim restarts, for a press the operator makes after a failure. */
  retry: () => void;
  /** A press the gate refused to honour, so the row can say so instead of going quiet. */
  reportPress: () => void;
  /** Called by the screen once it has dispatched a kept press, so the intent is spent. */
  dispatched: () => void;
}

/** A background call whose failure is not the operator's to carry: it must not reject unhandled. */
function quietly(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

/** Keeps a lock this session already holds, and drops it when the screen leaves. */
export function ChangeLock({ lockObject, argument }: { lockObject: string; argument: string }) {
  useEffect(() => {
    if (!argument) return undefined;
    const beat = window.setInterval(() => {
      quietly(heartbeatEnqueueAction(lockObject, argument));
    }, 20_000);
    return () => {
      window.clearInterval(beat);
      quietly(releaseEnqueueAction(lockObject, argument));
    };
  }, [lockObject, argument]);
  return null;
}

/**
 * For a screen that chooses the row in the browser. The first session gets change. A second session is
 * told to display, and the save is refused.
 *
 * The claim itself, with its lifecycle: see `./claim` for what each phase means and for the rules about
 * keeping, dispatching and dropping a press.
 */
export function useChangeLockClaim(
  lockObject: string,
  argument: string | null,
  transactionCode: string,
  enabled: boolean,
): ChangeLockClaimHandle {
  const [claim, dispatch] = useReducer(changeLockClaim, IDLE_CLAIM);
  const key = claimKey(lockObject, argument, transactionCode);
  const open = enabled && Boolean(argument);

  useEffect(() => {
    if (!open || !argument) {
      dispatch({ type: 'reset' });
      return undefined;
    }
    dispatch({ type: 'begin', key });
    // The effect's own teardown is what makes a superseded claim unable to answer: the row that
    // changed hands, or left the screen, cannot land its grant on the row that replaced it. A rejected
    // action is answered here rather than left unhandled, and it lands as `failed`, not as a refusal.
    let settled = false;
    void openChangeLockAction(lockObject, argument, transactionCode).then(
      (state) => {
        if (!settled) dispatch({ type: 'resolve', key, state });
      },
      (error: unknown) => {
        if (!settled) dispatch({ type: 'reject', key, error: failureText(error) });
      },
    );
    const beat = window.setInterval(() => {
      quietly(heartbeatEnqueueAction(lockObject, argument));
    }, 20_000);
    return () => {
      settled = true;
      window.clearInterval(beat);
      quietly(releaseEnqueueAction(lockObject, argument));
    };
  }, [key, open, argument, lockObject, transactionCode, claim.attempt]);

  return {
    claim,
    notice: claimNotice(claim),
    retry: () => dispatch({ type: 'retry', key }),
    reportPress: () => dispatch({ type: 'press' }),
    dispatched: () => dispatch({ type: 'dispatched' }),
  };
}

/**
 * The projection every lock screen already reads: the platform's answer, or `null` while an answer is
 * owed or the claim failed. It never reports a grant the platform did not give, and it is derived from
 * the same claim as everything else, so a screen reading `mode` and a screen reading `phase` cannot
 * disagree about whether this session holds the opening.
 */
export function useChangeLock(
  lockObject: string,
  argument: string | null,
  transactionCode: string,
  enabled: boolean,
): ChangeLockState | null {
  const { claim } = useChangeLockClaim(lockObject, argument, transactionCode, enabled);
  return projectClaim(claim);
}

/**
 * The display-only notice of a change session, with the recovery path under it when the caller has one to
 * show. `remedy` stays opt-in on purpose: several screens reuse this component for their own warnings, and
 * a lock-recovery sentence would be wrong advice on a notice that is not about a lock.
 */
export function LockNotice({ message, remedy }: { message: string | null | undefined; remedy?: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="border border-signal-warn/40 bg-signal-warn-soft p-3 text-sm text-signal-warn">
      <span className="block">{message}</span>
      {remedy && <span className="mt-1 block text-xs">{remedy}</span>}
    </p>
  );
}

/**
 * The notice for a claim that never answered, and the one control that can do anything about it.
 *
 * It renders for `failed` and for nothing else: a refusal is a different fact and keeps its own notice with
 * the recovery sentence about the other session, and a claim still in flight has nothing to report yet. The
 * retry button is therefore also the guard against a double request — once it is pressed the phase leaves
 * `failed`, the notice goes with it, and the reducer refuses a retry that is not on a failed claim, so
 * pressing twice cannot start two claims. What it restarts is a new claim: the grant the failed attempt did
 * not get is not carried over, and neither is any press the failure dropped.
 *
 * The lines are the catalogue's, and only the operator-safe line of what the platform threw is among them —
 * `failureNoticeView` and `failureDetail` in `./claim` decide them, keeping stack frames, paths, queries and
 * credentials off the screen.
 */
export function ClaimFailureNotice({ claim, onRetry }: { claim: ChangeLockClaim; onRetry: () => void }) {
  const view = failureNoticeView(claim);
  if (!view) return null;
  return (
    <div role="alert" className="border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">
      {view.lines.map((line, index) => (
        <p key={line} className={index === 0 ? undefined : 'mt-1 text-xs'}>
          {line}
        </p>
      ))}
      <button type="button" className="btn btn-default mt-2 min-h-11" onClick={onRetry}>
        {view.action.label}
      </button>
    </div>
  );
}

export type { ChangeLockClaim, ChangeLockPhase } from './claim';
