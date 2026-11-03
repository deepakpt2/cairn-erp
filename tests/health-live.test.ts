import { afterEach, describe, expect, it, vi } from 'vitest';
import * as healthLive from '../src/app/api/health/live/route';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/health/live', () => {
  it('returns HTTP 200 with a minimal liveness response', async () => {
    const response = healthLive.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('exposes GET without application handlers for unsupported write methods', () => {
    const handlers = healthLive as unknown as Record<string, unknown>;
    expect(typeof handlers.GET).toBe('function');
    expect(handlers.POST).toBeUndefined();
    expect(handlers.PUT).toBeUndefined();
    expect(handlers.PATCH).toBeUndefined();
    expect(handlers.DELETE).toBeUndefined();
  });

  it('uses the Node.js route runtime and forces dynamic handling', () => {
    expect(healthLive.runtime).toBe('nodejs');
    expect(healthLive.dynamic).toBe('force-dynamic');
  });

  it('prevents intermediary caching', () => {
    const response = healthLive.GET();

    expect(response.headers.get('cache-control')).toBe(
      'no-store, no-cache, must-revalidate, max-age=0',
    );
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBe('0');
  });

  it('does not expose environment, tenant, path, database, or error details', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://dummy:db-marker@invalid/db-marker');
    vi.stubEnv('SESSION_SECRET', 'session-marker');
    vi.stubEnv('CAIRN_PROVISIONING_TOKEN', 'provisioning-marker');

    const response = healthLive.GET();
    const body = await response.text();

    expect(body).toBe('{"status":"ok"}');
    for (const marker of [
      'db-marker',
      'session-marker',
      'provisioning-marker',
      'tenant-marker',
      '/private/path',
      'internal error',
    ]) {
      expect(body).not.toContain(marker);
    }
  });
});
