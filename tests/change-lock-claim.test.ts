/**
 * The shared change-lock claim: its phases, and what every consumer of the projection may rely on.
 *
 * `useChangeLock` returns `ChangeLockState | null` to 143 call sites, and Pass 33 left the gap this
 * file closes: the hook had no rejection handling, and `null` stood for "not asked", "answer owed" and
 * "claim failed" all at once. The lifecycle now lives in `src/ui/lock/claim.ts`, which the hook drives
 * with `useReducer`, so these are assertions about the state machine the shipped hook actually runs —
 * not a second implementation to keep in step.
 *
 * What is proved here, in order: a grant authorises exactly one dispatch; a display-only refusal keeps
 * the notice and the recovery sentence and refuses the press; a rejection is its own phase and never a
 * refusal in disguise; a pending claim cannot be pressed twice into two submissions; a kept press is
 * dropped by a refusal or a failure and can never be replayed later; an answer for a superseded row
 * neither lands nor dispatches; a retry after failure is honoured only by a genuine grant; and the
 * projection keeps every existing consumer's decision identical to what it was before the claim states
 * existed, while a failure reads as no-answer rather than as a grant.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ChangeLockState } from '../src/app/platform/locks/actions';
import { t } from '../src/platform/i18n';
import {
  awaitingClaim,
  changeLockClaim,
  claimKey,
  claimNotice,
  failureDetail,
  failureText,
  IDLE_CLAIM,
  phaseOf,
  projectClaim,
  shouldDispatch,
  type ChangeLockClaim,
  type ClaimEvent,
} from '../src/ui/lock/claim';

const KEY = claimKey('CONTROLLING_AREA_COMPANY', 'M210/M201', 'CFG.COST.CONTROLLINGAREA.DEFINE');
const GRANTED: ChangeLockState = { mode: 'CHANGE', message: null, remedy: null };
const REFUSED: ChangeLockState = {
  mode: 'DISPLAY',
  message: 'CONTROLLING_AREA_COMPANY M210/M201 is being changed by browser.admin in CFG.COST.CONTROLLINGAREA.DEFINE. This opening is display only.',
  remedy: 'This opening does not take the lock back by itself. Re-open the document once that session has left, signed out, or stopped answering: a lock nobody answers is released about three minutes after its last answer, at the next opening. An operator can clear it in the lock monitor, which changes no document.',
};

function run(claim: ChangeLockClaim, ...events: ClaimEvent[]): ChangeLockClaim {
  return events.reduce(changeLockClaim, claim);
}

const begin = (): ClaimEvent => ({ type: 'begin', key: KEY });
const granted = (): ClaimEvent => ({ type: 'resolve', key: KEY, state: GRANTED });
const refused = (): ClaimEvent => ({ type: 'resolve', key: KEY, state: REFUSED });
const rejected = (error = 'Failed to fetch'): ClaimEvent => ({ type: 'reject', key: KEY, error });

describe('the shared change-lock claim', () => {
  it('grants change only from the platform answer, and owes exactly one dispatch for a kept press', () => {
    const open = run(IDLE_CLAIM, begin(), granted());
    expect(open.phase).toBe('open');
    expect(open.state).toBe(GRANTED);
    expect(shouldDispatch(open)).toBe(false);

    // A press that arrives while the answer is owed is kept, and spends itself once.
    const kept = run(IDLE_CLAIM, begin(), { type: 'press' }, granted());
    expect(kept.queued).toBe(true);
    expect(shouldDispatch(kept)).toBe(true);
    const spent = run(kept, { type: 'dispatched' });
    expect(spent.queued).toBe(false);
    expect(shouldDispatch(spent)).toBe(false);
    // A second `dispatched` is a no-op, and a press in the open phase never queues at all.
    expect(run(spent, { type: 'dispatched' })).toBe(spent);
    expect(run(open, { type: 'press' })).toBe(open);
  });

  it('hands the press that opened a row to the claim that row opens, and only to that claim', () => {
    // A row form has no field to focus before its button, so the press arrives in the same interaction
    // that engages the row — before the effect has asked for the claim. That intent belongs to the claim
    // being begun, and is what the grant answers.
    const pressedFirst = run(IDLE_CLAIM, { type: 'press' }, begin());
    expect(pressedFirst.phase).toBe('pending');
    expect(pressedFirst.queued).toBe(true);
    expect(shouldDispatch(pressedFirst)).toBe(false);
    expect(shouldDispatch(run(pressedFirst, granted()))).toBe(true);
    // The whole OX19 sequence: one press, the opening it starts, the dispatch it is owed, spent once.
    const completed = run(run(pressedFirst, granted()), { type: 'dispatched' });
    expect(completed.queued).toBe(false);
    expect(shouldDispatch(completed)).toBe(false);
    // A refusal of that same first press files nothing and leaves nothing owed.
    expect(shouldDispatch(run(pressedFirst, refused()))).toBe(false);
    expect(shouldDispatch(run(pressedFirst, rejected()))).toBe(false);
  });

  it('reads the platform answer into a phase, so no screen has to re-derive it', () => {
    expect(phaseOf(GRANTED)).toBe('open');
    expect(phaseOf(REFUSED)).toBe('refused');
  });

  it('keeps a display-only refusal what it was: the notice, the recovery sentence, and no press', () => {
    const refusedClaim = run(IDLE_CLAIM, begin(), { type: 'press' }, refused());
    expect(refusedClaim.phase).toBe('refused');
    expect(refusedClaim.state).toBe(REFUSED);
    // The recovery guidance travels with the refusal, unchanged.
    expect(claimNotice(refusedClaim)).toEqual({ message: REFUSED.message, remedy: REFUSED.remedy, detail: null });
    // and the projection keeps every existing consumer working: the notice condition, the disabled
    // condition, and the submit gate all read the same value they read before the phases existed.
    expect(projectClaim(refusedClaim)).toBe(REFUSED);
    expect(projectClaim(refusedClaim)?.mode === 'DISPLAY').toBe(true);
    expect(projectClaim(refusedClaim)?.mode !== 'CHANGE').toBe(true);
    // A press kept before the answer is dropped, not deferred.
    expect(refusedClaim.queued).toBe(false);
    expect(shouldDispatch(refusedClaim)).toBe(false);
    expect(run(refusedClaim, { type: 'dispatched' }).queued).toBe(false);
    // A refusal is not a failure, and a failure is not a refusal.
    const failedClaim = run(IDLE_CLAIM, begin(), rejected());
    expect(failedClaim.phase).not.toBe('refused');
    expect(refusedClaim.phase).not.toBe('failed');
    // Refused: nothing is owed, so a later press is refused again rather than queued.
    expect(run(refusedClaim, { type: 'press' })).toBe(refusedClaim);
  });

  it('turns a rejected claim into an explicit failure, never into a grant or a refusal', () => {
    const failedClaim = run(IDLE_CLAIM, begin(), rejected('Network request failed'));
    expect(failedClaim.phase).toBe('failed');
    expect(failedClaim.error).toBe('Network request failed');
    // The screen is told the claim failed, in the catalogue's own words, with the recovery line every
    // operation that wrote nothing already gives. It promises no lock and no saved change.
    expect(claimNotice(failedClaim)).toEqual({
      message: t('lock.claimFailed'),
      remedy: t('lock.claimFailedRecovery'),
      detail: 'Network request failed',
    });
    expect(t('lock.claimFailed')).not.toBe('lock.claimFailed');
    expect(t('lock.claimFailedRecovery')).not.toBe('lock.claimFailedRecovery');
    expect(claimNotice(failedClaim).message).not.toMatch(/lock is yours|has been opened|saved|unassigned/i);
    // A refusal and a failure are told apart by the words on the screen, not only by the phase.
    expect(claimNotice(failedClaim).message).not.toBe(claimNotice(run(IDLE_CLAIM, begin(), refused())).message);
    expect(claimNotice(failedClaim).message).not.toMatch(/is being changed by|display only/i);
    // Nothing may read this as authorised: the projection is "no answer", the same value a pending
    // claim projects, so a gate on `mode !== 'CHANGE'` stays shut and a `held` derivation goes false.
    expect(projectClaim(failedClaim)).toBeNull();
    expect(shouldDispatch(failedClaim)).toBe(false);
    expect(failedClaim.queued).toBe(false);
    // A press that was already kept is cleared by the failure rather than replayed later.
    const keptThenFailed = run(IDLE_CLAIM, begin(), { type: 'press' }, rejected());
    expect(keptThenFailed.queued).toBe(false);
    expect(shouldDispatch(keptThenFailed)).toBe(false);
    // A grant that lands after the failure does not resurrect the dropped press: the operator has to
    // press again, and that press is what the next answer will honour.
    const late = run(keptThenFailed, granted());
    expect(late.phase).toBe('open');
    expect(shouldDispatch(late)).toBe(false);
    // Nothing else in the machine can invent a grant.
    expect(run(IDLE_CLAIM, begin()).phase).toBe('pending');
    expect(run(IDLE_CLAIM, { type: 'press' }, { type: 'retry', key: KEY }).phase).toBe('idle');
    expect(run(IDLE_CLAIM, rejected()).phase, 'a failure for a claim never begun stays idle').toBe('idle');
  });

  it('keeps what the platform threw for the claim, and shows only what an operator may be told', () => {
    expect(failureText(new Error('HTTP 500'))).toBe('HTTP 500');
    expect(failureText('  boom  ')).toBe('boom');
    // Nothing is invented when there is no message: the notice still explains the failure from the catalogue.
    expect(failureText(undefined)).toBeNull();
    expect(failureText(new Error('   '))).toBeNull();
    const bare = run(IDLE_CLAIM, begin(), { type: 'reject', key: KEY, error: null });
    expect(bare.error).toBeNull();
    expect(claimNotice(bare)).toEqual({
      message: t('lock.claimFailed'),
      remedy: t('lock.claimFailedRecovery'),
      detail: null,
    });
  });

  it('does not put a stack trace, a query, a path or a credential on a screen', () => {
    // A rejected action can carry whatever the server logged. The line is shown only when it reads like an
    // explanation; everything else stays in the console, where the log already has it.
    expect(failureDetail('Failed to fetch')).toBe('Failed to fetch');
    expect(failureDetail('HTTP 500')).toBe('HTTP 500');
    expect(failureDetail('  signed out  ')).toBe('signed out');
    for (const unsafe of [
      'TypeError: x is not a function\n    at Object.<anonymous> (/home/cairn/cairn-erp/src/ui/lock/claim.ts:42:11)',
      'select count(*) from change_document where client = $1',
      'update controlling_area_company set is_active = false',
      'connect ECONNREFUSED postgresql://cairn_app:pw@127.0.0.1:5432/cairn',
      'password for cairn was rejected',
      'the token expired at /var/run/secrets/token',
      'read ECONNRESET https://internal.example/api/locks',
      'x'.repeat(240),
      '',
      '   ',
    ]) {
      expect(failureDetail(unsafe), unsafe.slice(0, 48)).toBeNull();
    }
    // and a screen told about a failure never inherits the refusal's claim about who holds the record
    const leaked = run(IDLE_CLAIM, begin(), { type: 'reject', key: KEY, error: 'M210/M201 is being changed by someone' });
    expect(claimNotice(leaked).detail).toBeNull();
  });

  it('names the window in which an answer is owed, so a form can wait without hiding the reason', () => {
    expect(awaitingClaim(IDLE_CLAIM)).toBe(true);
    expect(awaitingClaim(run(IDLE_CLAIM, begin()))).toBe(true);
    expect(awaitingClaim(run(IDLE_CLAIM, begin(), granted()))).toBe(false);
    expect(awaitingClaim(run(IDLE_CLAIM, begin(), refused()))).toBe(false);
    expect(awaitingClaim(run(IDLE_CLAIM, begin(), rejected()))).toBe(false);
    // `awaitingClaim` is what a screen waits on, so a failure is never mistaken for "still loading" and
    // hides the section it should be explaining.
    expect(awaitingClaim(run(IDLE_CLAIM, begin(), rejected()))).toBe(false);
  });

  it('allows one retry in flight, and no second claim from a repeated request', () => {
    const failedClaim = run(IDLE_CLAIM, begin(), rejected());
    const retried = run(failedClaim, { type: 'retry', key: KEY });
    // The retry is a new claim: the answer that never came is not carried into it, and neither is a press.
    expect(retried.state).toBeNull();
    expect(retried.queued).toBe(false);
    expect(retried.error).toBeNull();
    expect(retried.attempt).toBe(failedClaim.attempt + 1);
    // Pressing again while that claim is in flight changes nothing at all — no second claim, no queue.
    expect(run(retried, { type: 'retry', key: KEY })).toBe(retried);
    expect(run(retried, begin())).toBe(retried);
    const pressed = run(retried, { type: 'press' });
    expect(pressed.attempt).toBe(retried.attempt);
    expect(shouldDispatch(pressed)).toBe(false);
    expect(shouldDispatch(run(pressed, granted()))).toBe(true);
    // A grant that arrived late for the failed claim is not a grant for the retry either: the answer is
    // scoped to the claim that asked, so `retry` cannot be answered by a stale result.
    const stale = { type: 'resolve', key: claimKey('CONTROLLING_AREA_COMPANY', 'OTHER/ROW', 'CFG.COST.CONTROLLINGAREA.DEFINE'), state: GRANTED } as const;
    expect(run(retried, stale)).toBe(retried);
    expect(projectClaim(run(retried, stale))).toBeNull();
  });

  it('will not let a pending claim be pressed into two submissions, and does not restart on a re-render', () => {
    const pending = run(IDLE_CLAIM, begin());
    expect(projectClaim(pending)).toBeNull();
    const pressedTwice = run(pending, { type: 'press' }, { type: 'press' });
    expect(pressedTwice.queued).toBe(true);
    expect(shouldDispatch(pressedTwice)).toBe(false);
    // The answer dispatches once, whatever the number of presses kept.
    const answered = run(pressedTwice, granted());
    expect(shouldDispatch(answered)).toBe(true);
    expect(run(answered, { type: 'dispatched' }).queued).toBe(false);
    // A re-render that re-begins the same key cannot restart, release or re-acquire the opening.
    const open = run(pending, granted());
    expect(run(open, begin())).toBe(open);
    expect(run(open, begin(), { type: 'press' })).toBe(run(open, { type: 'press' }));
  });

  it('drops an answer or a dispatch for a superseded row', () => {
    const otherKey = claimKey('CONTROLLING_AREA_COMPANY', 'S210/S201', 'CFG.COST.CONTROLLINGAREA.DEFINE');
    const opened = run(IDLE_CLAIM, begin(), { type: 'press' });
    // The operator moved to another pair before the first answer arrived.
    const switched = run(opened, { type: 'begin', key: otherKey });
    expect(switched.key).toBe(otherKey);
    expect(switched.phase).toBe('pending');
    expect(switched.queued).toBe(false);
    // The old answer, however it ends, cannot land on the new row.
    expect(run(switched, granted())).toBe(switched);
    expect(run(switched, rejected())).toBe(switched);
    // and neither can the press that belonged to it.
    expect(shouldDispatch(run(switched, granted()))).toBe(false);
    // The new row grants normally, and is dispatched on its own merits.
    const fresh = run(switched, { type: 'resolve', key: otherKey, state: GRANTED });
    expect(fresh.phase).toBe('open');
    expect(projectClaim(fresh)).toBe(GRANTED);
  });

  it('retries only after a failure, and only into a genuine grant', () => {
    const failedClaim = run(IDLE_CLAIM, begin(), rejected());
    // A retry on a claim that did not fail is refused: nothing here restarts a healthy opening.
    expect(run(IDLE_CLAIM, begin(), granted(), { type: 'retry', key: KEY }).phase).toBe('open');
    const retried = run(failedClaim, { type: 'retry', key: KEY });
    expect(retried.phase).toBe('pending');
    expect(retried.attempt).toBe(failedClaim.attempt + 1);
    expect(retried.error).toBeNull();
    expect(retried.queued).toBe(false);
    // The retry does not conjure a grant: until the platform answers, nothing is authorised.
    expect(projectClaim(retried)).toBeNull();
    // When the new claim is genuinely granted, the row may act on it — through the operator's press.
    // A press during the retry is kept, because the retried claim owes an answer again; an already
    // open claim needs no queue, which is what the first case of this file asserts.
    const pressedAfterRetry = run(retried, { type: 'press' });
    expect(pressedAfterRetry.queued, 'the retried claim owes an answer, so the press waits for it').toBe(true);
    expect(shouldDispatch(run(pressedAfterRetry, granted()))).toBe(true);
    const grantedAfterRetry = run(retried, granted());
    expect(grantedAfterRetry.phase).toBe('open');
    // A press kept against a failed claim re-claims rather than replaying, and is answered afresh.
    const pressIsRetry = run(failedClaim, { type: 'press' });
    expect(pressIsRetry.phase).toBe('pending');
    expect(pressIsRetry.attempt).toBe(failedClaim.attempt + 1);
    expect(pressIsRetry.queued).toBe(true);
    expect(shouldDispatch(run(pressIsRetry, granted()))).toBe(true);
    expect(shouldDispatch(run(pressIsRetry, refused()))).toBe(false);
  });

  it('resets to nothing owed when the row closes', () => {
    const opened = run(IDLE_CLAIM, begin(), granted(), { type: 'press' });
    const reset = run(opened, { type: 'reset' });
    expect(reset.phase).toBe('idle');
    expect(reset.queued).toBe(false);
    expect(reset.state).toBeNull();
    expect(reset.error).toBeNull();
    // The attempt counter survives, so a re-opened row starts a claim rather than resuming one.
    expect(reset.attempt).toBe(opened.attempt);
    expect(run(IDLE_CLAIM, { type: 'reset' })).toBe(IDLE_CLAIM);
    // Re-opened, the answer is owed again: nothing from the previous opening carries over.
    expect(run(reset, begin()).phase).toBe('pending');
    expect(projectClaim(run(reset, begin()))).toBeNull();
  });

  it('keeps the projection faithful for every consumer pattern the hook serves', () => {
    const phases = {
      idle: IDLE_CLAIM,
      pending: run(IDLE_CLAIM, begin()),
      open: run(IDLE_CLAIM, begin(), granted()),
      refused: run(IDLE_CLAIM, begin(), refused()),
      failed: run(IDLE_CLAIM, begin(), rejected()),
    };
    const states = Object.fromEntries(Object.entries(phases).map(([name, claim]) => [name, projectClaim(claim)]));
    expect(states).toEqual({ idle: null, pending: null, open: GRANTED, refused: REFUSED, failed: null });

    for (const claim of Object.values(phases)) {
      const projected = projectClaim(claim);
      // The submit gate: only a grant lets a protected operation through.
      expect(projected?.mode !== 'CHANGE').toBe(claim.phase !== 'open');
      // The display-only notice and its refusal styling: never lit by a failure.
      expect(projected?.mode === 'DISPLAY').toBe(claim.phase === 'refused');
      // A `held` derivation: false while pending and after a failure, exactly as it is when nothing
      // was asked for. This is the one behaviour a legacy screen gains: no stale grant survives a
      // re-claim, because the projection follows the claim rather than the last answer it happened to see.
      expect(projected?.mode === 'CHANGE').toBe(claim.phase === 'open');
    }
    // The phase a consumer cannot survive confusing is the one the projection keeps distinct.
    expect(states.failed).toBe(states.pending);
    expect(phases.failed.phase).not.toBe(phases.pending.phase);
    expect(phases.failed.error).not.toBeNull();
    expect(phases.pending.error).toBeNull();
  });

  it('is read by every consumer in a form the projection can serve', () => {
    // The 143 call sites were not rewritten, so the contract has to hold for the shapes they use.
    // This walks the whole of `src` and fails if a consumer starts reading the hook in a shape the
    // projection does not answer — a member access other than mode/message/remedy, a bare `switch`,
    // or a place where the returned object itself is treated as the answer.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.tsx') || path.endsWith('.ts')) files.push(path);
      }
    };
    walk('src');
    const consumers = new Map<string, string[]>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/const (\w+) = useChangeLock\(/g)) consumers.set(file, [...(consumers.get(file) ?? []), match[1]]);
      expect(text).not.toMatch(/useChangeLock[A-Za-z]*\([^)]*\)\.mode/);
    }
    const sites = [...consumers.entries()];
    expect(sites.length).toBeGreaterThan(50);
    for (const [file, variables] of sites) {
      const text = readFileSync(file, 'utf8');
      for (const name of variables) {
        for (const match of text.matchAll(new RegExp(`\\b${name}\\??\\.[A-Za-z]+`, 'g'))) {
          expect(['.mode', '.message', '.remedy'], `${file}: ${match[0]}`).toContain(match[0].replace(name, '').replace('?', ''));
        }
        expect(text).not.toMatch(new RegExp(`switch \\(${name}`));
      }
    }
  });
});
