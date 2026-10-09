import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => {
  const state = { exists: true, manages: true, elevated: false };
  const unsafe = vi.fn().mockResolvedValue([]);
  const tag = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('rolcreaterole')) return [{ manage: state.manages }];
    if (text.includes('select 1')) return state.exists ? [{ value: 1 }] : [];
    if (text.includes('pg_catalog.format')) return [{ statement: 'SAFE_FORMATTED_ROLE_COMMAND' }];
    throw new Error('Unexpected owner query');
  });
  const tx = Object.assign(tag, { unsafe });
  const ownerEnd = vi.fn().mockResolvedValue(undefined);
  const appEnd = vi.fn().mockResolvedValue(undefined);
  const app = Object.assign(vi.fn(async () => [{ elevated: state.elevated }]), { end: appEnd });
  const owner = { begin: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)), end: ownerEnd };
  const connect = vi.fn((url: string) => new URL(url).username === 'cairn_app' ? app : owner);
  return { state, unsafe, tag, ownerEnd, appEnd, connect };
});
vi.mock('postgres', () => ({ default: fixture.connect }));
import { credentialSettings, synchronizeApplicationRole } from '../scripts/sync-db-app-role';
const APP = 'postgresql://cairn_app:SampleAppPassword@db:5432/cairn';
const OWNER = 'postgresql://cairn:SampleOwnerPassword@db:5432/cairn';
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fixture.state, { exists: true, manages: true, elevated: false });
});

describe('managed deployment credential validation', () => {
  it('reads the app password from the actual runtime URL', () => {
    expect(credentialSettings(APP, OWNER).password).toBe('SampleAppPassword');
  });
  it('decodes URL-encoded passwords without interpolating them into SQL', () => {
    expect(credentialSettings(APP.replace('SampleAppPassword','Sample%27Password'), OWNER).password).toBe("Sample'Password");
  });
  it('requires both explicitly configured connections', () => {
    expect(() => credentialSettings(APP)).toThrow('must both be set explicitly');
  });
  it('rejects an owner URL as the runtime connection', () => {
    expect(() => credentialSettings(OWNER, OWNER)).toThrow('must be cairn_app');
  });
  it('rejects a runtime URL as the owner connection', () => {
    expect(() => credentialSettings(APP, APP)).toThrow('separate owner');
  });
  it('rejects different databases', () => {
    expect(() => credentialSettings(APP, OWNER.replace(/\/cairn$/, '/other'))).toThrow('same database');
  });
  it('rejects an empty password', () => {
    expect(() => credentialSettings(APP.replace('SampleAppPassword',''), OWNER)).toThrow('must not be empty');
  });
  it('rejects invalid URLs without including their values', () => {
    expect(() => credentialSettings('not-a-url', OWNER)).toThrow('values are withheld');
  });
});

describe('safe managed application role synchronization', () => {
  it('alters an existing role before checking restricted runtime login', async () => {
    await synchronizeApplicationRole(APP, OWNER);
    const call = fixture.tag.mock.calls.find(([strings]) => strings.join('').includes('pg_catalog.format'))!;
    expect(call[1]).toMatch(/^ALTER ROLE cairn_app/);
    expect(call[1]).toContain('NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE');
    expect(call[2]).toBe('SampleAppPassword');
    expect(fixture.unsafe).toHaveBeenCalledWith('SAFE_FORMATTED_ROLE_COMMAND');
    expect(fixture.connect.mock.calls.map(([url]) => url)).toEqual([OWNER, APP]);
    expect(fixture.ownerEnd).toHaveBeenCalledOnce();
    expect(fixture.appEnd).toHaveBeenCalledOnce();
  });
  it('creates a missing role with the configured password, never a development fallback', async () => {
    fixture.state.exists = false;
    await synchronizeApplicationRole(APP, OWNER);
    const call = fixture.tag.mock.calls.find(([strings]) => strings.join('').includes('pg_catalog.format'))!;
    expect(call[1]).toMatch(/^CREATE ROLE cairn_app/);
    expect(call[1]).not.toContain('cairn_app_dev');
  });
  it('fails closed before DDL if the owner cannot manage roles', async () => {
    fixture.state.manages = false;
    await expect(synchronizeApplicationRole(APP, OWNER)).rejects.toThrow('allowed to manage');
    expect(fixture.unsafe).not.toHaveBeenCalled();
    expect(fixture.ownerEnd).toHaveBeenCalledOnce();
  });
  it('rejects an elevated runtime login and closes both connections', async () => {
    fixture.state.elevated = true;
    await expect(synchronizeApplicationRole(APP, OWNER)).rejects.toThrow('runtime connection must be restricted');
    expect(fixture.ownerEnd).toHaveBeenCalledOnce();
    expect(fixture.appEnd).toHaveBeenCalledOnce();
  });
});
