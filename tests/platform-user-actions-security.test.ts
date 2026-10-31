import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  session: {
    user: { client: 'T123', userId: 'admin-user', username: 'TRUSTED.ADMIN', capabilities: [] as string[] },
  },
  requireSession: vi.fn(),
  can: vi.fn(),
  createUser: vi.fn(),
  changeUser: vi.fn(),
  initiatePasswordReset: vi.fn(),
  listUsers: vi.fn(),
  requestPasswordReset: vi.fn(),
  completePasswordReset: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/platform/auth/current', () => ({
  requireSession: fixture.requireSession,
  can: fixture.can,
}));
vi.mock('@/modules/platform/user-admin', () => ({
  createUser: fixture.createUser,
  changeUser: fixture.changeUser,
  initiatePasswordReset: fixture.initiatePasswordReset,
  listUsers: fixture.listUsers,
  requestPasswordReset: fixture.requestPasswordReset,
  completePasswordReset: fixture.completePasswordReset,
  UserAdminError: class UserAdminError extends Error { remedy = 'not authorised'; },
}));
vi.mock('next/cache', () => ({ revalidatePath: fixture.revalidatePath }));

import {
  changeUserAction,
  createUserAction,
  initiatePasswordResetAction,
} from '@/app/platform/users/actions';

const ADMIN_CAPS = ['CFG.PLT.USER.CREATE', 'CFG.PLT.USER.MAINTAIN', 'CFG.PLT.USER.PASSWORD_RESET'];
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.session.user.capabilities = [];
  fixture.requireSession.mockResolvedValue(fixture.session);
  fixture.can.mockImplementation((session: typeof fixture.session, capability: string) =>
    session.user.capabilities.includes(capability),
  );
  fixture.createUser.mockResolvedValue({ id: 'created' });
  fixture.changeUser.mockResolvedValue({ id: 'changed' });
  fixture.initiatePasswordReset.mockResolvedValue({ userId: 'target', username: 'TARGET', token: 'out-of-band', expiresAt: 'later' });
});

describe('central user-administration server actions', () => {
  it('denies direct create, change, and reset calls when the authenticated session lacks authority', async () => {
    const forged = form({
      client: 'EVIL',
      userId: 'another-client-user',
      username: 'injected',
      sessionCapabilities: ADMIN_CAPS.join(','),
    });

    const create = await createUserAction({ ok: false }, forged);
    const change = await changeUserAction({ ok: false }, forged);
    const reset = await initiatePasswordResetAction({ ok: false }, forged);

    expect(create.ok).toBe(false);
    expect(create.message).toContain('CFG.PLT.USER.CREATE');
    expect(change.ok).toBe(false);
    expect(change.message).toContain('CFG.PLT.USER.MAINTAIN');
    expect(reset.ok).toBe(false);
    expect(reset.message).toContain('CFG.PLT.USER.PASSWORD_RESET');
    expect(fixture.createUser).not.toHaveBeenCalled();
    expect(fixture.changeUser).not.toHaveBeenCalled();
    expect(fixture.initiatePasswordReset).not.toHaveBeenCalled();
  });

  it('derives client, actor and capabilities from the authenticated session, not submitted fields', async () => {
    fixture.session.user.capabilities = ADMIN_CAPS;
    const result = await createUserAction({ ok: false }, form({
      client: 'EVIL',
      changedBy: 'FORGED.ACTOR',
      username: 'new.user',
      fullName: 'New User',
      password: 'StrongPassword123!',
      sessionCapabilities: ADMIN_CAPS.join(','),
    }));

    expect(result.ok).toBe(true);
    expect(fixture.createUser).toHaveBeenCalledWith(expect.objectContaining({
      client: 'T123',
      changedBy: 'TRUSTED.ADMIN',
      username: 'new.user',
    }), ADMIN_CAPS);
  });

  it('keeps account maintenance and administrator reset within the session client', async () => {
    fixture.session.user.capabilities = ADMIN_CAPS;
    await changeUserAction({ ok: false }, form({
      client: 'EVIL', userId: 'target-user', fullName: 'Target', changedBy: 'FORGED.ACTOR',
    }));
    await initiatePasswordResetAction({ ok: false }, form({
      client: 'EVIL', userId: 'target-user', changedBy: 'FORGED.ACTOR',
    }));

    expect(fixture.changeUser).toHaveBeenCalledWith(expect.objectContaining({
      client: 'T123', userId: 'target-user', changedBy: 'TRUSTED.ADMIN',
    }), ADMIN_CAPS);
    expect(fixture.initiatePasswordReset).toHaveBeenCalledWith(expect.objectContaining({
      client: 'T123', userId: 'target-user', changedBy: 'TRUSTED.ADMIN',
    }), ADMIN_CAPS);
  });
});
