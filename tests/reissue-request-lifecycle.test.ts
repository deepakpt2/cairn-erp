/**
 * Reissue panel request lifecycle: newest-wins preview ordering, and a retained unresolved submission that a
 * retry replays with the SAME key while edits cannot silently discard it.
 */
import { describe, expect, it } from 'vitest';

import {
  PreviewGeneration,
  SubmissionKey,
  acceptsPreview,
  previewSignature,
} from '../src/app/people/payroll-runs/reissue-request-lifecycle';
import { reissueInputSignature } from '../src/modules/people/payment-reissue-inputs';

const at = (date: string) => ({ source: 'A', selection: 'ALL' as const, selected: [], date });

describe('stale preview handling', () => {
  it('accepts a response only when it is the newest token and the inputs still match', () => {
    const gen = new PreviewGeneration();
    const sig = previewSignature(at('2025-01-01'));
    const token = gen.issue();
    expect(acceptsPreview(token, gen, sig, sig)).toBe(true);
  });

  it('discards a response after the date changed (invalidate)', () => {
    const gen = new PreviewGeneration();
    const sig = previewSignature(at('2025-01-01'));
    const token = gen.issue();
    gen.invalidate();
    const later = previewSignature(at('2025-02-01'));
    expect(acceptsPreview(token, gen, sig, later)).toBe(false);
  });

  it('discards a response whose signature no longer matches, even without invalidation', () => {
    const gen = new PreviewGeneration();
    const sent = previewSignature({ source: 'A', selection: 'SELECTED', selected: ['P2', 'P1'], date: 'd' });
    const now = previewSignature({ source: 'A', selection: 'SELECTED', selected: ['P1'], date: 'd' });
    const token = gen.issue();
    expect(acceptsPreview(token, gen, sent, now)).toBe(false);
  });

  it('orders two OVERLAPPING identical-input requests: the newer token wins', () => {
    const gen = new PreviewGeneration();
    const sig = previewSignature(at('2025-01-01'));
    const first = gen.issue();
    const second = gen.issue();
    // The first response arrives after the second was issued: it is stale even though the inputs match.
    expect(acceptsPreview(first, gen, sig, sig)).toBe(false);
    expect(acceptsPreview(second, gen, sig, sig)).toBe(true);
  });

  it('ignores a response after unmount/invalidate even if inputs are unchanged', () => {
    const gen = new PreviewGeneration();
    const sig = previewSignature(at('2025-01-01'));
    const token = gen.issue();
    gen.invalidate(); // unmount
    expect(acceptsPreview(token, gen, sig, sig)).toBe(false);
  });

  it('treats the selected set as order-independent and uppercase-normalized', () => {
    expect(previewSignature({ source: 'A', selection: 'SELECTED', selected: ['p2', 'P1'], date: 'd' }))
      .toBe(previewSignature({ source: 'A', selection: 'SELECTED', selected: ['P1', 'P2'], date: 'd' }));
  });

  it('treats ALL as server-derived: the client selection is not part of the signature', () => {
    expect(previewSignature({ source: 'A', selection: 'ALL', selected: [], date: 'd' }))
      .toBe(previewSignature({ source: 'A', selection: 'ALL', selected: ['P1', 'P2'], date: 'd' }));
  });

  it('is exactly the signature the service returns (single source of truth)', () => {
    const inputs = { source: 'A', selection: 'SELECTED' as const, selected: ['P2', 'P1'], date: '2025-01-01' };
    expect(previewSignature(inputs)).toBe(reissueInputSignature(inputs));
  });
});

describe('submission key retention', () => {
  let counter = 0;
  const mint = () => `key-${++counter}`;
  const payload = (over: Record<string, string> = {}) => JSON.stringify({ selection: 'ALL', date: 'd', ...over });

  it('reuses one key for an identical retried payload (ambiguous outcome)', () => {
    counter = 0;
    const keys = new SubmissionKey(mint);
    const k1 = keys.keyFor(payload(), { action: 'request' });
    keys.markUnresolved();
    const k2 = keys.keyFor(payload(), { action: 'request' });
    expect(k2).toBe(k1);
  });

  it('exposes the unresolved submission key and payload for a same-key retry', () => {
    const keys = new SubmissionKey(mint);
    keys.keyFor(payload(), { action: 'request', date: 'd' });
    keys.markUnresolved();
    const unresolved = keys.unresolvedSubmission();
    expect(unresolved?.key).toBe(keys.retainedKey());
    expect(unresolved?.payload.date).toBe('d');
  });

  it('refuses a DIFFERENT payload while an outcome is unresolved', () => {
    const keys = new SubmissionKey(mint);
    keys.keyFor(payload({ date: 'd1' }), { action: 'request' });
    keys.markUnresolved();
    expect(() => keys.keyFor(payload({ date: 'd2' }), { action: 'request' })).toThrow();
  });

  it('allows a different payload after the user explicitly abandons the unresolved request', () => {
    const keys = new SubmissionKey(mint);
    keys.keyFor(payload({ date: 'd1' }), { action: 'request' });
    keys.markUnresolved();
    keys.abandon();
    const fresh = keys.keyFor(payload({ date: 'd2' }), { action: 'request' });
    expect(fresh).toBeTruthy();
    expect(keys.hasUnresolved()).toBe(false);
  });

  it('gets a fresh key after the server confirmed the outcome', () => {
    const keys = new SubmissionKey(mint);
    const a = keys.keyFor(payload(), { action: 'request' });
    keys.resolve();
    const b = keys.keyFor(payload(), { action: 'request' });
    expect(b).not.toBe(a);
  });
});
