/**
 * Pure request-lifecycle logic for the reissue panel: unique increasing preview tokens, a current-input signature,
 * and retention of an UNRESOLVED submission (key + exact payload) until the server confirms its outcome.
 *
 * Free of React so the ordering and retry rules are testable: every preview request gets a NEW, strictly
 * increasing token, so among overlapping requests (even with identical inputs) only the newest response wins.
 * A response is accepted only if its token is the newest AND the inputs still match. An ambiguous submission
 * keeps its exact key+payload until it is confirmed or explicitly reconciled; editing the form does not discard it.
 */

import { reissueInputSignature, type ReissueInputs } from '@/modules/people/payment-reissue-inputs';

export type PreviewInputs = ReissueInputs;

/** A stable, order-independent signature of the preview/request inputs — the SAME function the service uses. */
export function previewSignature(inputs: PreviewInputs): string {
  return reissueInputSignature(inputs);
}

/**
 * Orders preview requests by a strictly increasing token. `issue()` must be called for EVERY request, so two
 * overlapping same-input requests are individually ordered (the later token wins). `invalidate()` moves the
 * newest token forward so any in-flight response is rejected (source/mode/selection/date changed, or unmount).
 */
export class PreviewGeneration {
  private latest = 0;
  private lastAccepted = 0;
  issue(): number {
    this.latest += 1;
    return this.latest;
  }
  invalidate(): void {
    this.latest += 1;
  }
  newest(): number {
    return this.latest;
  }
  /** The response is the newest issued token (later responses always win, identical inputs or not). */
  isNewest(token: number): boolean {
    return token === this.latest;
  }
  /** Record that a preview was accepted, so a stale/superseded response is never re-applied. */
  accept(token: number): void {
    if (token === this.latest) this.lastAccepted = token;
  }
  accepted(): number {
    return this.lastAccepted;
  }
}

/** A response is acceptable only if it is the newest token AND the current inputs still match what it answered. */
export function acceptsPreview(token: number, generation: PreviewGeneration, sentSignature: string, currentSignature: string): boolean {
  return generation.isNewest(token) && sentSignature === currentSignature;
}

export interface UnresolvedSubmission {
  signature: string;
  key: string;
  payload: Record<string, string>;
}

/**
 * Holds one key per logical submission. A retry of the SAME payload reuses the key. Crucially, while a submission
 * is unresolved (an ambiguous outcome) its key and payload are retained even if the user edits the form; a
 * changed submission is only allowed to mint a new key once the user explicitly reconciles/abandons the prior one.
 */
export class SubmissionKey {
  private retained: { signature: string; key: string; payload: Record<string, string> } | null = null;
  private unresolved: boolean = false;
  constructor(private readonly mint: () => string) {}

  /** Whether an earlier submission's outcome is still unknown. */
  hasUnresolved(): boolean {
    return this.unresolved;
  }

  /** The retained unresolved submission (key + exact payload), for a same-key retry. */
  unresolvedSubmission(): UnresolvedSubmission | null {
    return this.retained && this.unresolved
      ? { signature: this.retained.signature, key: this.retained.key, payload: this.retained.payload }
      : null;
  }

  /**
   * The key to use for this payload. Identical payload → same key. A DIFFERENT payload while an earlier outcome is
   * unresolved is refused: the caller must first reconcile the unresolved request (explicitly abandon it).
   */
  keyFor(payload: string, resolvedPayload: Record<string, string>): string {
    if (this.retained?.signature === payload) return this.retained.key;
    if (this.unresolved) {
      throw new Error('An earlier submission has an unknown outcome; reconcile it before starting a different one.');
    }
    this.retained = { signature: payload, key: this.mint(), payload: resolvedPayload };
    this.unresolved = false;
    return this.retained.key;
  }

  /** Mark that the request's outcome is unknown (network failure) — retain the key and payload. */
  markUnresolved(): void {
    if (this.retained) this.unresolved = true;
  }

  /** The server confirmed the outcome (success or a definite refusal): the next submission may mint a new key. */
  resolve(): void {
    this.retained = null;
    this.unresolved = false;
  }

  /** The user explicitly abandoned an unresolved request; the next submission may proceed. */
  abandon(): void {
    this.retained = null;
    this.unresolved = false;
  }

  retainedKey(): string | null {
    return this.retained?.key ?? null;
  }
}

// ── Minimal, safe reload recovery ─────────────────────────────────────────────
//
// Only a request KEY and the fact that an outcome is unresolved are persisted, so a reload can warn the user and
// offer a same-key retry. Never a bank identifier, an amount or an attestation. sessionStorage is per-tab and not
// shared; if it is unavailable (SSR, private mode) recovery is simply unavailable.

const RECOVERY_KEY = 'cairn.paymentReissue.unresolved';

export interface RecoveryState {
  preparationId: string;
  key: string;
  at: string;
}

export function rememberUnresolved(preparationId: string, key: string, now: Date = new Date()): void {
  try {
    sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ preparationId, key, at: now.toISOString() }));
  } catch {
    // No browser storage: recovery is unavailable, which is safe.
  }
}

export function readUnresolved(preparationId: string): RecoveryState | null {
  try {
    const raw = sessionStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecoveryState;
    return parsed && parsed.preparationId === preparationId && typeof parsed.key === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearUnresolved(): void {
  try {
    sessionStorage.removeItem(RECOVERY_KEY);
  } catch {
    // Nothing to clear.
  }
}
