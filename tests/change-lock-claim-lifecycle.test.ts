import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { observeChangeLockClaim } from '../src/ui/lock/claim-lifecycle';

const hook = readFileSync('src/ui/lock/ChangeLock.tsx', 'utf8');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const granted = { mode: 'CHANGE' as const, message: null, remedy: null };

describe('change-lock request lifecycle', () => {
  it('wires cleanup serialization and cancellation into the shared hook without changing its callers', () => {
    expect(hook).toContain('const request = cleanupChain.current.then(() => openChangeLockAction(');
    expect(hook).toContain('const lifecycle = observeChangeLockClaim(');
    expect(hook).toContain('cleanupChain.current = lifecycle.cancel();');
    expect(hook).toContain('export function useChangeLock(');
    expect(hook).toContain('return projectClaim(claim);');
  });

  it('does not release on unmount until the pending acquisition settles', async () => {
    const request = deferred<typeof granted>();
    const order: string[] = [];
    const lifecycle = observeChangeLockClaim(
      request.promise,
      () => order.push('answer'),
      () => order.push('failure'),
      async () => { order.push('release'); },
    );

    const cleanup = lifecycle.cancel();
    expect(order).toEqual([]);
    request.resolve(granted);
    await cleanup;
    expect(order).toEqual(['release']);
  });

  it('suppresses a late grant after cancellation and removes the lock after that response', async () => {
    const request = deferred<typeof granted>();
    let delivered = 0;
    let released = 0;
    const lifecycle = observeChangeLockClaim(
      request.promise,
      () => { delivered += 1; },
      () => { delivered += 1; },
      async () => { released += 1; },
    );

    const cleanup = lifecycle.cancel();
    request.resolve(granted);
    await cleanup;
    expect(delivered).toBe(0);
    expect(released).toBe(1);
    // Repeated cleanup cannot issue a second release.
    await lifecycle.cancel();
    expect(released).toBe(1);
  });

  it('releases after a rejected response too, covering a lost response after a possible commit', async () => {
    const request = deferred<typeof granted>();
    const order: string[] = [];
    const lifecycle = observeChangeLockClaim(
      request.promise,
      () => order.push('grant'),
      () => order.push('failure'),
      async () => { order.push('release'); },
    );

    request.reject(new Error('transport disconnected'));
    await Promise.resolve();
    expect(order).toEqual(['failure']);
    const cleanup = lifecycle.cancel();
    await cleanup;
    expect(order).toEqual(['failure', 'release']);
  });

  it('lets a replacement acquisition wait until the cancelled claim has been released', async () => {
    const request = deferred<typeof granted>();
    const order: string[] = [];
    const lifecycle = observeChangeLockClaim(
      request.promise,
      () => order.push('stale grant ignored'),
      () => order.push('stale failure ignored'),
      async () => { order.push('release old claim'); },
    );

    const cleanup = lifecycle.cancel();
    const replacement = cleanup.then(() => {
      order.push('open replacement');
      return granted;
    });
    request.resolve(granted);
    await replacement;
    expect(order).toEqual(['release old claim', 'open replacement']);
  });

  it('allows an answered acquisition to be observed, then releases once on later unmount', async () => {
    let released = 0;
    let observed = 0;
    const lifecycle = observeChangeLockClaim(
      Promise.resolve(granted),
      (state) => { if (state.mode === 'CHANGE') observed += 1; },
      () => { observed += 100; },
      async () => { released += 1; },
    );

    await Promise.resolve();
    expect(observed).toBe(1);
    expect(released).toBe(0);
    await lifecycle.cancel();
    expect(released).toBe(1);
  });
});
