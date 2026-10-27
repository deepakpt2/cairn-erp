/**
 * The lifecycle of one change-lock claim, owned by the browser and shared by every screen.
 *
 * `useChangeLock` used to hand its consumers a `ChangeLockState | null`, and `null` carried three
 * different meanings at once: no claim has been asked for, a claim is in flight, and — because the
 * action promise had no rejection handling — a claim that failed. The first two are indistinguishable
 * to a screen, so the row press on OX19 had no way to know that an answer was still owed to it, and
 * the third was not a state at all: the promise rejection went unhandled, the previous answer stayed
 * on screen, and a screen that had just been granted change kept behaving as though it still was.
 *
 * The claim therefore gets explicit phases, and the phases are decided here rather than in a screen,
 * so that every consumer of the shared contract inherits the same rules:
 *
 * - `idle`     nothing asked for. A protected operation is not available, and nothing is owed.
 * - `pending`  a claim is in flight. An answer is owed; a press arriving now is kept, not dropped.
 * - `open`     the platform granted the change lock. This is the only phase that authorises a submit.
 * - `refused`  the platform answered display-only. The opening belongs to another session; the
 *              established recovery sentence is what the operator reads, and a press kept from
 *              before the answer is discarded rather than replayed later.
 * - `failed`   the claim could not be made at all — a rejected action, a lost request, a server
 *              error. This is deliberately NOT `refused`: nothing here says the pair is somebody
 *              else's, because nothing here knows that. The message quotes the platform's own failure
 *              text, so a screen never claims that a lock was acquired or that a change was saved.
 *
 * Three guarantees live in the transition function and are tested in `tests/change-lock-claim.test.ts`:
 * a dispatch is owed only in the `open` phase; any answer — grant, refusal or failure — settles a kept
 * press instead of carrying it forward; and every event is scoped to the lock key it was raised for, so
 * an answer for a superseded row can neither land nor dispatch.
 *
 * `projectClaim` is the old view — the `ChangeLockState | null` that the existing call sites read. It is
 * a projection, not a second source of truth, and the projection rule is what keeps the shared hook
 * compatible: only `open` and `refused` carry a state, so a pending or failed claim reads as "no answer
 * yet", exactly as it always did for a screen gating on `mode !== 'CHANGE'`, and never as a grant.
 */
import type { ChangeLockState } from '@/app/platform/locks/actions';

/** What the browser knows about one claim, in addition to whatever the platform answered. */
export type ChangeLockPhase = 'idle' | 'pending' | 'open' | 'refused' | 'failed';

export interface ChangeLockClaim {
  /** Which lock this claim belongs to: `<object>\0<argument>\0<code>`. Answers for another key are stale. */
  readonly key: string;
  readonly phase: ChangeLockPhase;
  /** The platform's own answer, and only for `open` and `refused`. */
  readonly state: ChangeLockState | null;
  /** The failure text of a claim that never reached an answer. `null` unless the phase is `failed`. */
  readonly error: string | null;
  /** A press kept while an answer was owed. Cleared by any answer. */
  readonly queued: boolean;
  /** Bumped only by an explicit retry, so a claim is never restarted by a render. */
  readonly attempt: number;
}

export const IDLE_CLAIM: ChangeLockClaim = Object.freeze({
  key: '',
  phase: 'idle',
  state: null,
  error: null,
  queued: false,
  attempt: 0,
});

/** The identity a claim is scoped to, so a row that changes hands cannot inherit an answer. */
export function claimKey(lockObject: string, argument: string | null, transactionCode: string): string {
  return `${lockObject}\u0000${argument ?? ''}\u0000${transactionCode}`;
}

export type ClaimEvent =
  /** The claim is being asked for: the screen has opened the row. */
  | { type: 'begin'; key: string }
  /** The action answered, with a grant or a display-only refusal. */
  | { type: 'resolve'; key: string; state: ChangeLockState }
  /** The action could not be reached or threw: no answer about who holds the pair. */
  | { type: 'reject'; key: string; error: string | null }
  /** A press arrived; keep it only while an answer is still owed. */
  | { type: 'press' }
  /** The screen dispatched the kept press; the intent is spent either way. */
  | { type: 'dispatched' }
  /** The operator asked again, after a failure. The only way a claim restarts. */
  | { type: 'retry'; key: string }
  /** The row was closed, the key changed, or the claim was switched off. */
  | { type: 'reset' };

/** The claim's own answer, so a caller never re-reads `state.mode` to know what phase it is in. */
export function phaseOf(state: ChangeLockState): ChangeLockPhase {
  return state.mode === 'CHANGE' ? 'open' : 'refused';
}

/** True when — and only when — a kept press may be dispatched now. */
export function shouldDispatch(claim: ChangeLockClaim): boolean {
  return claim.queued && claim.phase === 'open';
}

/** The value `useChangeLock` has always returned, derived from the claim. */
export function projectClaim(claim: ChangeLockClaim): ChangeLockState | null {
  return claim.phase === 'open' || claim.phase === 'refused' ? claim.state : null;
}

/** Used when the platform gave nothing to show — the text says the claim failed, nothing more. */
export const CLAIM_FAILED_MESSAGE = 'The change lock could not be opened for this record. No change was saved.';

/** What a notice may show for this claim: the platform's refusal, or its failure text. Never both. */
export function claimNotice(claim: ChangeLockClaim): { message: string | null; remedy: string | null } {
  if (claim.phase === 'refused') return { message: claim.state?.message ?? null, remedy: claim.state?.remedy ?? null };
  if (claim.phase === 'failed') return { message: claim.error ?? CLAIM_FAILED_MESSAGE, remedy: null };
  return { message: null, remedy: null };
}

/** A message from whatever the platform threw, so the screen quotes the failure rather than inventing one. */
export function failureText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return CLAIM_FAILED_MESSAGE;
}

/**
 * The whole state machine. Total, and it never invents a grant: `open` is reachable only from a
 * `resolve` whose state says `CHANGE`, and a kept press survives only until an answer arrives.
 */
export function changeLockClaim(claim: ChangeLockClaim, event: ClaimEvent): ChangeLockClaim {
  switch (event.type) {
    case 'begin': {
      // Another lock, or the same row opened again after being closed: nothing carries over, and an
      // answer belonging to the previous key can no longer land.
      if (claim.key !== event.key) {
        // A row form has no field to focus before its button, so the press that opens a claim arrives
        // in the same interaction, before the effect has begun anything: an idle claim hands its kept
        // intent over. A key switch with a claim already in flight is a row being left behind, and the
        // press that belonged to it is dropped rather than carried onto the next row.
        const carried = claim.phase === 'idle' ? claim.queued : false;
        return { ...IDLE_CLAIM, key: event.key, attempt: claim.attempt, phase: 'pending', queued: carried };
      }
      // Re-asking is not a restart: an in-flight or already-answered claim keeps what it has, so no
      // render, and no second press, can release and re-acquire the opening the row already holds.
      if (claim.phase === 'pending' || claim.phase === 'open' || claim.phase === 'refused') return claim;
      return { ...claim, phase: 'pending', state: null, error: null };
    }
    case 'resolve': {
      if (event.key !== claim.key) return claim;
      const phase = phaseOf(event.state);
      // Grant or refusal both settle the claim: an answer is no longer owed, so a kept press is
      // dispatched (when it is authorised) or dropped (when it is not), never carried forward.
      return { ...claim, phase, state: event.state, error: null, queued: phase === 'open' && claim.queued };
    }
    case 'reject': {
      if (event.key !== claim.key) return claim;
      // The failure clears the press: the operator is told the claim failed and may ask again, but
      // nothing the platform never authorised is dispatched on their behalf afterwards.
      return { ...claim, phase: 'failed', state: null, error: event.error ?? CLAIM_FAILED_MESSAGE, queued: false };
    }
    case 'press':
      // An answer already in hand needs no queue: the press proceeds as the form's own submit.
      if (claim.phase === 'open') return claim;
      // A refusal is a refusal: no queue, so no submission when the row is next opened either.
      if (claim.phase === 'refused') return claim;
      // A press after a failure is the retry: it re-claims and keeps the intent for that answer only.
      if (claim.phase === 'failed') {
        return { ...claim, phase: 'pending', state: null, error: null, queued: true, attempt: claim.attempt + 1 };
      }
      return { ...claim, queued: true };
    case 'dispatched':
      return claim.queued ? { ...claim, queued: false } : claim;
    case 'retry':
      if (claim.phase !== 'failed' || event.key !== claim.key) return claim;
      return { ...claim, phase: 'pending', state: null, error: null, queued: false, attempt: claim.attempt + 1 };
    case 'reset':
      // Nothing to forget, so nothing to re-render over.
      if (claim.phase === 'idle' && !claim.queued && !claim.state && !claim.error) return claim;
      return { ...IDLE_CLAIM, attempt: claim.attempt };
    default:
      return claim;
  }
}
