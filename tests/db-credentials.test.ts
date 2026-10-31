import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const state = {
    exists: true,
    manages: true,
    elevated: false,
    tables: ['app_user', 'user_session', 'password_reset_token'],
    memberships: [] as string[],
  };
  const unsafe = vi.fn().mockResolvedValue([]);
  const tag = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('rolcreaterole')) return [{ manage: state.manages }];
    if (text.includes('select 1 from pg_roles')) return state.exists ? [{ value: 1 }] : [];
    if (text.includes('from pg_auth_members')) return state.memberships.map((role_name) => ({ role_name }));
    if (text.includes('to_regclass')) return [{ present: state.tables.includes(String(values[0]).replace('public.', '')) }];
    if (text.includes('pg_catalog.format') && text.includes('GRANT CONNECT')) return [{ statement: 'GRANT CONNECT ON DATABASE cairn TO cairn_app' }];
    if (text.includes('pg_catalog.format') && text.includes('REVOKE %I')) return [{ statement: `REVOKE ${values[0]} FROM cairn_app` }];
    if (text.includes('pg_catalog.format') && String(values[0]).includes('ROLE cairn_app')) return [{ statement: 'SAFE_FORMATTED_ROLE_COMMAND' }];
    throw new Error(`Unexpected owner query: ${text}`);
  });
  const tx = Object.assign(tag, { unsafe });
  const ownerEnd = vi.fn().mockResolvedValue(undefined);
  const appEnd = vi.fn().mockResolvedValue(undefined);
  const app = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (text.includes('from pg_roles r')) {
      return [{
        role: 'cairn_app', database: 'cairn', superuser: state.elevated,
        bypassrls: false, inherit: false, connect: true, schema_usage: true,
        schema_create: false, memberships: 0,
      }];
    }
    if (text.includes('from pg_class c')) {
      return state.tables.map((relname) => ({
        relname, can_select: true, can_insert: true, can_update: true,
        can_delete: false, can_truncate: false, can_references: false, can_trigger: false,
      }));
    }
    throw new Error(`Unexpected runtime query: ${text}`);
  }), { end: appEnd });
  const owner = { begin: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)), end: ownerEnd };
  const connect = vi.fn((url: string) => new URL(url).username === 'cairn_app' ? app : owner);
  return { state, unsafe, tag, ownerEnd, appEnd, app, connect };
});

vi.mock('postgres', () => ({ default: fixture.connect }));
import { credentialSettings, synchronizeApplicationRole } from '../scripts/sync-db-app-role';

const APP = 'postgresql://cairn_app:SampleAppPassword@db:5432/cairn';
const OWNER = 'postgresql://cairn:SampleOwnerPassword@db:5432/cairn';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fixture.state, {
    exists: true, manages: true, elevated: false,
    tables: ['app_user', 'user_session', 'password_reset_token'],
    memberships: [],
  });
});

describe('managed deployment credential validation', () => {
  it('reads the app password from the actual runtime URL', () => {
    expect(credentialSettings(APP, OWNER).password).toBe('SampleAppPassword');
  });
  it('decodes URL-encoded passwords without interpolating them into SQL', () => {
    expect(credentialSettings(APP.replace('SampleAppPassword', 'Sample%27Password'), OWNER).password).toBe("Sample'Password");
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
    expect(() => credentialSettings(APP.replace('SampleAppPassword', ''), OWNER)).toThrow('must not be empty');
  });
  it('rejects invalid URLs without including their values', () => {
    expect(() => credentialSettings('not-a-url', OWNER)).toThrow('values are withheld');
  });
});

describe('safe managed application role synchronization', () => {
  it('aligns role attributes and restores exact central-auth ACLs before runtime verification', async () => {
    await synchronizeApplicationRole(APP, OWNER);
    const call = fixture.tag.mock.calls.find(([, command]) => String(command).includes('ROLE cairn_app'))!;
    expect(call[1]).toMatch(/^ALTER ROLE cairn_app/);
    expect(call[1]).toContain('NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT');
    expect(call[2]).toBe('SampleAppPassword');
    expect(fixture.unsafe).toHaveBeenCalledWith('SAFE_FORMATTED_ROLE_COMMAND');
    for (const table of ['app_user', 'user_session', 'password_reset_token']) {
      expect(fixture.unsafe).toHaveBeenCalledWith(`REVOKE ALL PRIVILEGES ON TABLE public.${table} FROM cairn_app`);
      expect(fixture.unsafe).toHaveBeenCalledWith(`GRANT SELECT, INSERT, UPDATE ON TABLE public.${table} TO cairn_app`);
    }
    expect(fixture.unsafe).toHaveBeenCalledWith('GRANT USAGE ON SCHEMA public TO cairn_app');
    expect(fixture.unsafe).toHaveBeenCalledWith('REVOKE CREATE ON SCHEMA public FROM cairn_app');
    expect(fixture.connect.mock.calls.map(([url]) => url)).toEqual([OWNER, APP]);
    expect(fixture.ownerEnd).toHaveBeenCalledOnce();
    expect(fixture.appEnd).toHaveBeenCalledOnce();
  });

  it('creates a missing role with the configured password, never a development fallback', async () => {
    fixture.state.exists = false;
    await synchronizeApplicationRole(APP, OWNER);
    const call = fixture.tag.mock.calls.find(([, command]) => String(command).includes('ROLE cairn_app'))!;
    expect(call[1]).toMatch(/^CREATE ROLE cairn_app/);
    expect(call[1]).not.toContain('cairn_app_dev');
  });

  it('removes inherited role memberships before verifying the runtime login', async () => {
    fixture.state.memberships = ['unexpected_role'];
    await synchronizeApplicationRole(APP, OWNER);
    expect(fixture.unsafe).toHaveBeenCalledWith('REVOKE unexpected_role FROM cairn_app');
  });

  it('permits the pre-migration call to skip auth tables that do not exist yet', async () => {
    fixture.state.tables = [];
    await synchronizeApplicationRole(APP, OWNER);
    expect(fixture.unsafe.mock.calls.some(([command]) => String(command).includes('ON TABLE public.'))).toBe(false);
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
