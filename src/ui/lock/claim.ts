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
 *              else's, because nothing here knows that. The notice says the change was not made, in
 *              the catalogue's own words, and offers the one action that can restart a claim.
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
import { t } from '@/platform/i18n';
import type { ChangeLockState } from '@/app/platform/locks/actions';

/** What the browser knows about one claim, in addition to whatever the platform answered. */
export type ChangeLockPhase = 'idle' | 'pending' | 'open' | 'refused' | 'failed';

export interface ChangeLockClaim {
  /** Which lock this claim belongs to: `<object>\0<argument>\0<code>`. Answers for another key are stale. */
  readonly key: string;
  readonly phase: ChangeLockPhase;
  /** The platform's own answer, and only for `open` and `refused`. */
  readonly state: ChangeLockState | null;
  /**
   * What the platform threw, kept verbatim for the screen to judge: `null` unless the phase is `failed`,
   * and never shown as it stands. `failureDetail` decides what an operator may be told.
   */
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

/** An answer has not been given yet, so nothing is authorised and the row is still waiting. */
export function awaitingClaim(claim: ChangeLockClaim): boolean {
  return claim.phase === 'idle' || claim.phase === 'pending';
}

/** The value `useChangeLock` has always returned, derived from the claim. */
export function projectClaim(claim: ChangeLockClaim): ChangeLockState | null {
  if (claim.phase === 'open' || claim.phase === 'refused') return claim.state;
  /**
   * A claim that never reached the server is projected as a display answer, not as the absence of one.
   *
   * `null` reads to a legacy screen as "nothing has been asked yet", so the form stays open, the save is
   * pressed, and the answer it gets is `ENQUEUE_NOT_HELD` — "Open the object in change. A save does not
   * take a lock the screen did not hold." — advice for an operator who never tried, when the truth is that
   * this screen tried and the request died. The refusal-shaped projection says what happened, in the two
   * lines the screen already renders, and closes whatever a grant opened.
   *
   * This is only safe because the consumer surface was measured first, and is pinned by
   * `tests/change-lock-ux-contract.test.ts`: every place that compares a projected `mode` with `DISPLAY`
   * either gates on it or echoes `message`/`remedy` — none composes wording of its own — and no screen
   * treats the projection as a boolean, the family Pass 35 closed. A failure therefore cannot be read as
   * permission anywhere, and cannot be dressed up as a refusal the platform never made. `idle` and `pending` stay `null`: the first render has no claim to report on, and a
   * screen has to be able to ask for one.
   */
  if (claim.phase === 'failed') {
    const { message, remedy, detail } = claimNotice(claim);
    return { mode: 'DISPLAY', message, remedy: [detail, remedy].filter(Boolean).join(' ') || null };
  }
  return null;
}

/**
 * What a notice may show for this claim, in the catalogue's own words: the platform's refusal with its
 * recovery sentence, or the failure sentence with the recovery a failed operation already gets
 * elsewhere. Never both, and never a promise that a lock was taken or a change was saved.
 *
 * `detail` is the one place anything the platform threw can reach the screen, and it is filtered — see
 * `failureDetail`. A claim with no text to show is still fully explained by `message` and `remedy`.
 */
export function claimNotice(claim: ChangeLockClaim): {
  message: string | null;
  remedy: string | null;
  detail: string | null;
} {
  if (claim.phase === 'refused') {
    return { message: claim.state?.message ?? null, remedy: claim.state?.remedy ?? null, detail: null };
  }
  if (claim.phase === 'failed') {
    return { message: t('lock.claimFailed'), remedy: t('lock.claimFailedRecovery'), detail: failureDetail(claim.error) };
  }
  return { message: null, remedy: null, detail: null };
}

/** How much of what the platform threw an operator may be told, in one line. */
const DETAIL_LIMIT = 180;

/**
 * What must never reach a screen: a stack frame, a file path, a query, a credential, or anything the
 * server wrote for its own log. A failed claim is the browser's problem to explain, not the platform's
 * internals to publish. The refusal's own wording is on the list too: only an answer the platform
 * actually gave may say that another session holds the record, and an answer that arrived as a rejection
 * is not one — a failure notice that repeated it would be inventing a lock holder.
 */
const NOT_FOR_OPERATORS = new RegExp(
  [
    '[\\r\\n]',
    'https?://',
    'at \\S+ \\(',
    '\\.tsx?:\\d+',
    'node_modules',
    '/(?:home|var|usr|etc|proc|tmp|srv)/',
    '\\bselect\\b.*\\bfrom\\b',
    '\\binsert\\s+into\\b',
    '\\bupdate\\b.*\\bset\\b',
    '\\bdelete\\s+from\\b',
    '\\bpassword\\b',
    '\\bsecret\\b',
    '\\btoken\\b',
    '\\bauthorization\\b',
    '\\bdatabase_url\\b',
    'is being changed by',
    'display only',
    '(?:postgres|postgresql|redis|mysql)://',
  ].join('|'),
  'i',
);

/**
 * A message worth showing the operator, or `null`. Only a short single line that reads like a plain
 * explanation survives; everything else is left in the console, where the log already has it.
 */
export function failureDetail(error: string | null): string | null {
  const text = error?.trim() ?? '';
  if (!text || text.length > DETAIL_LIMIT) return null;
  if (NOT_FOR_OPERATORS.test(text)) return null;
  return text;
}

/** The raw text of what the action threw, for the claim to hold. Nothing is invented when there is none. */
export function failureText(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return null;
}

/**
 * The notice a failed claim shows, as data: the lines in order, and the label of the one action offered
 * under them. It lives here rather than in the component so that what an operator is told is decided by
 * the contract and not by a screen — `ClaimFailureNotice` renders exactly these lines, and
 * `tests/change-lock-ux-contract.test.ts` reads them from this function.
 */
export interface ClaimFailureView {
  readonly lines: readonly string[];
  readonly action: { readonly label: string };
}

export function failureNoticeView(claim: ChangeLockClaim): ClaimFailureView | null {
  if (claim.phase !== 'failed') return null;
  const { message, remedy, detail } = claimNotice(claim);
  const lines = [message, detail, remedy].filter((line): line is string => Boolean(line));
  return { lines, action: { label: t('lock.claimRetry') } };
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
      return { ...claim, phase: 'failed', state: null, error: event.error, queued: false };
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
      // Only a failed claim can be retried, and the retry starts a fresh claim: no stale grant, no
      // kept press, and nothing that was dropped by the failure comes back. Repeated requests while the
      // retry is in flight land in `pending`, where this case does nothing at all.
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
