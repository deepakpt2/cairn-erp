/**
 * Reissue panel request lifecycle: stale previews are discarded (generation + signature), and a retried
 * submission reuses its key so an ambiguous outcome cannot create a second draft.
 */
import { describe, expect, it } from 'vitest';

import {
  PreviewGeneration,
  SubmissionKey,
  acceptsPreview,
  previewSignature,
} from '../src/app/people/payroll-runs/reissue-request-lifecycle';

describe('stale preview handling', () => {
  it('accepts a response only when generation and signature still match', () => {
    const gen = new PreviewGeneration();
    const sig = previewSignature({ source: 'A', selection: 'ALL', selected: [], date: '2025-01-01' });
    const token = gen.begin();
    expect(acceptsPreview(token, gen, sig, () => sig)).toBe(true);
  });

  it('discards a response after the date changed (generation bumped)', () => {
    const gen = new PreviewGeneration();
    const sig = previewSignature({ source: 'A', selection: 'ALL', selected: [], date: '2025-01-01' });
    const token = gen.begin();
    gen.bump(); // the user changed the date
    const later = previewSignature({ source: 'A', selection: 'ALL', selected: [], date: '2025-02-01' });
    expect(acceptsPreview(token, gen, sig, () => later)).toBe(false);
  });

  it('discards a response whose signature no longer matches, even without a bump', () => {
    const gen = new PreviewGeneration();
    const sent = previewSignature({ source: 'A', selection: 'SELECTED', selected: ['P2', 'P1'], date: '2025-01-01' });
    const token = gen.begin();
    const now = previewSignature({ source: 'A', selection: 'SELECTED', selected: ['P1'], date: '2025-01-01' });
    expect(acceptsPreview(token, gen, sent, () => now)).toBe(false);
  });

  it('handles out-of-order responses: the newest token wins', () => {
    const gen = new PreviewGeneration();
    const sigA = previewSignature({ source: 'A', selection: 'ALL', selected: [], date: '2025-01-01' });
    const tokenA = gen.begin();
    gen.bump();
    const tokenB = gen.begin();
    // B resolves first and is accepted; A resolves later and is stale.
    expect(acceptsPreview(tokenB, gen, sigA, () => sigA)).toBe(true);
    expect(acceptsPreview(tokenA, gen, sigA, () => sigA)).toBe(false);
  });

  it('treats the selected set as order-independent', () => {
    expect(previewSignature({ source: 'A', selection: 'SELECTED', selected: ['P2', 'P1'], date: 'd' }))
      .toBe(previewSignature({ source: 'A', selection: 'SELECTED', selected: ['P1', 'P2'], date: 'd' }));
  });
});

describe('submission key retention', () => {
  let counter = 0;
  const mint = () => `key-${++counter}`;

  it('reuses one key for an identical retried payload (ambiguous outcome)', () => {
    counter = 0;
    const keys = new SubmissionKey(mint);
    const payload = JSON.stringify({ selection: 'ALL', date: 'd', attestations: [] });
    const k1 = keys.keyFor(payload);
    const k2 = keys.keyFor(payload); // the network failed after commit — retry with the same payload
    expect(k2).toBe(k1);
  });

  it('mints a new key when the payload changes, and abandons the prior one', () => {
    counter = 0;
    const keys = new SubmissionKey(mint);
    const a = keys.keyFor(JSON.stringify({ date: 'd1' }));
    const b = keys.keyFor(JSON.stringify({ date: 'd2' }));
    expect(b).not.toBe(a);
    expect(keys.retainedKey()).toBe(b);
  });

  it('gets a fresh key after a confirmed success', () => {
    counter = 0;
    const keys = new SubmissionKey(mint);
    const p = JSON.stringify({ date: 'd' });
    const a = keys.keyFor(p);
    keys.clear();
    const b = keys.keyFor(p);
    expect(b).not.toBe(a);
  });
});
