/**
 * Pure request-lifecycle logic for the reissue panel: a monotonically increasing preview generation, an input
 * signature, and retention of one idempotency key per identical logical submission.
 *
 * Keeping this free of React makes the stale-response and ambiguous-retry rules testable without a DOM: a late
 * preview response is accepted only when its generation AND input signature still match; a retry of the same
 * payload reuses its key, while a changed payload gets a fresh key and abandons the prior one.
 */

export interface PreviewInputs {
  source: string;
  selection: 'ALL' | 'SELECTED';
  selected: readonly string[];
  date: string;
}

/** A stable signature: order-independent over the selected employees, exact on the rest. */
export function previewSignature(inputs: PreviewInputs): string {
  return JSON.stringify({ source: inputs.source, selection: inputs.selection, selected: [...inputs.selected].sort(), date: inputs.date });
}

export class PreviewGeneration {
  private generation = 0;
  /** Invalidate every in-flight preview (an input changed); returns the new generation. */
  bump(): number {
    this.generation += 1;
    return this.generation;
  }
  current(): number {
    return this.generation;
  }
  /** Capture before an async preview; accept the response only if still current. */
  begin(): number {
    return this.generation;
  }
  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}

/** A response is acceptable only if BOTH its generation and its input signature match the current state. */
export function acceptsPreview(token: number, generation: PreviewGeneration, sentSignature: string, currentSignature: () => string): boolean {
  return generation.isCurrent(token) && sentSignature === currentSignature();
}

/**
 * Retains one key per identical payload. A retry with the same canonical payload returns the SAME key; a changed
 * payload returns a new key and replaces the retained one. Independent of the network outcome.
 */
export class SubmissionKey {
  private retained: { signature: string; key: string } | null = null;
  constructor(private readonly mint: () => string) {}
  /** The key to use for this payload (existing if identical, otherwise a freshly minted one). */
  keyFor(payload: string): string {
    if (this.retained?.signature === payload) return this.retained.key;
    this.retained = { signature: payload, key: this.mint() };
    return this.retained.key;
  }
  /** Called only after the server confirmed success; the next logical submission gets a fresh key. */
  clear(): void {
    this.retained = null;
  }
  retainedKey(): string | null {
    return this.retained?.key ?? null;
  }
}
