/** Real web action with request/framework/creation mocked. No database writes. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../src/platform/auth/session';
const f = vi.hoisted(() => ({ session: null as SessionContext | null, initialized: false, writes: 0, calls: [] as Array<Record<string, unknown>>, getSession: vi.fn() }));
vi.mock('@/platform/auth/current', () => ({ getSession: f.getSession }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('REDIRECT_CREATED'); }) }));
vi.mock('@/platform/tenancy', () => ({
  TenancyError: class extends Error {},
  createTenant: vi.fn(async (input: Record<string, unknown>, admit: (tx: unknown) => Promise<void>) => {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ initialized: f.initialized }]);
    await admit({ execute });
    f.writes += 1; f.calls.push(input);
    return { client: '0200', companyCode: '1000', administratorUsername: 'admin' };
  }),
}));
import { createTenantAction } from '../src/app/clients/actions';
const TOKEN = 'PrivateOwnerSetupTokenTestsOnly'.repeat(2);
function form(token = '') { const data = new FormData(); for (const [k,v] of Object.entries({ provisioningToken: token, clientKey: '0200', companyCode: '1000', name: 'Test company', companyName: 'Test company', username: 'admin', password: 'StrongTestPassword123', createdBy: 'FORGED' })) data.set(k,v); return data; }
beforeEach(() => {
  vi.stubEnv('CAIRN_ENV', 'production'); vi.stubEnv('CAIRN_PROVISIONING_TOKEN', TOKEN);
  f.session = null; f.initialized = false; f.writes = 0; f.calls = [];
  f.getSession.mockReset().mockImplementation(async () => f.session);
});
describe('onboarding server-action admission', () => {
  it('refuses unauthenticated direct POST without owner token before any creation', async () => {
    const state = await createTenantAction({ ok: true }, form());
    expect(state.ok).toBe(false); expect(f.writes).toBe(0); expect(f.getSession).not.toHaveBeenCalled();
  });
  it('refuses direct first-setup POST with invalid token', async () => {
    expect((await createTenantAction({ ok: true }, form('invalid'))).ok).toBe(false);
    expect(f.writes).toBe(0);
  });
  it('allows owner-authorized first setup and derives audit actor', async () => {
    await expect(createTenantAction({ ok: true }, form(TOKEN))).rejects.toThrow('REDIRECT_CREATED');
    expect(f.writes).toBe(1); expect(f.calls[0].createdBy).toBe('OWNER_BOOTSTRAP');
  });
  it('rejects an anonymous later tenant even with owner token', async () => {
    f.initialized = true;
    expect((await createTenantAction({ ok: true }, form(TOKEN))).ok).toBe(false);
    expect(f.writes).toBe(0);
  });
  it('rejects later signed-in users without the exact capability', async () => {
    f.initialized = true; f.session = { user: { username: 'buyer', capabilities: ['PROC.*'] } } as SessionContext;
    expect((await createTenantAction({ ok: true }, form(TOKEN))).ok).toBe(false);
    expect(f.writes).toBe(0);
  });
  it('allows a later authorized admin with owner token and session audit actor', async () => {
    f.initialized = true; f.session = { user: { username: 'owner.admin', capabilities: ['CFG.PLT.CLIENT.ONBOARD'] } } as SessionContext;
    await expect(createTenantAction({ ok: true }, form(TOKEN))).rejects.toThrow('REDIRECT_CREATED');
    expect(f.writes).toBe(1); expect(f.calls[0].createdBy).toBe('owner.admin');
  });
});
