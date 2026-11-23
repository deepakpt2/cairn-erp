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

  /**
   * Restore an unresolved submission after a reload: seed the SAME key, signature and exact payload, so a retry of
   * that payload reuses the key and a changed payload is refused until the attempt is reconciled or abandoned.
   */
  seed(entry: { key: string; payload: Record<string, string> }): void {
    this.retained = { signature: JSON.stringify(entry.payload), key: entry.key, payload: entry.payload };
    this.unresolved = true;
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

// ── Safe reload recovery ──────────────────────────────────────────────────────
//
// A reload must be able to tell the truth: the SAME logical request is retried with the SAME key and the SAME
// normalized payload. We persist, per-tab, a record keyed by the source preparation id so switching sources in one
// tab never overwrites another source's unresolved attempt. The record holds only the request key and the exact
// form payload — never a bank identifier or a salary-line amount. sessionStorage is per-tab and not shared between
// tabs; if it is unavailable (SSR, private mode) recovery is simply unavailable, which is safe.

const RECOVERY_KEY = 'cairn.paymentReissue.unresolved.v2';

export interface RecoveryState {
  preparationId: string;
  key: string;
  /** The exact request fields that produced `key`, so a same-key retry is byte-for-byte the same logical request. */
  payload: Record<string, string>;
  at: string;
}

type RecoveryMap = Record<string, Omit<RecoveryState, 'preparationId'>>;

function readMap(): RecoveryMap {
  try {
    const raw = sessionStorage.getItem(RECOVERY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as RecoveryMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: RecoveryMap): void {
  try {
    if (Object.keys(map).length === 0) sessionStorage.removeItem(RECOVERY_KEY);
    else sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(map));
  } catch {
    // No browser storage: recovery is unavailable, which is safe.
  }
}

export function rememberUnresolved(preparationId: string, key: string, payload: Record<string, string>, now: Date = new Date()): void {
  if (!preparationId || !key) return;
  const map = readMap();
  map[preparationId] = { key, payload, at: now.toISOString() };
  writeMap(map);
}

export function readUnresolved(preparationId: string): RecoveryState | null {
  if (!preparationId) return null;
  const entry = readMap()[preparationId];
  if (!entry || typeof entry.key !== 'string' || typeof entry.payload !== 'object' || entry.payload === null) return null;
  return { preparationId, key: entry.key, payload: entry.payload, at: entry.at };
}

export function clearUnresolved(preparationId?: string): void {
  if (!preparationId) { writeMap({}); return; }
  const map = readMap();
  delete map[preparationId];
  writeMap(map);
}
