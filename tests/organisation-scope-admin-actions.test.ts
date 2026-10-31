import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  can: vi.fn(),
  grantCompanyCodeScope: vi.fn(),
  grantPlantScope: vi.fn(),
  revokeOrganisationScope: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/platform/auth/current', () => ({
  requireSession: mocks.requireSession,
  can: mocks.can,
}));
vi.mock('@/modules/platform/organisation-scope-admin', () => ({
  grantCompanyCodeScope: mocks.grantCompanyCodeScope,
  grantPlantScope: mocks.grantPlantScope,
  revokeOrganisationScope: mocks.revokeOrganisationScope,
  ORGANISATION_SCOPE_ADMIN_CAPABILITY: 'CFG.PLT.USER.MAINTAIN',
  OrganisationScopeAdminError: class OrganisationScopeAdminError extends Error {
    remedy: string;
    constructor(message: string, remedy = 'Fix the input.') {
      super(message);
      this.name = 'OrganisationScopeAdminError';
      this.remedy = remedy;
    }
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import {
  grantCompanyScopeAction,
  grantPlantScopeAction,
  revokeOrganisationScopeAction,
} from '@/app/platform/users/access/actions';

const CAPABILITY = 'CFG.PLT.USER.MAINTAIN';
const session = {
  user: { client: 'T123', userId: 'actor-session-user', username: 'central.admin', capabilities: [CAPABILITY] },
  sessionId: 'persisted-session-id',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(session);
  mocks.can.mockImplementation((_session: typeof session, capability: string) => _session.user.capabilities.includes(capability));
  mocks.grantCompanyCodeScope.mockResolvedValue({ scopeValue: '1000', username: 'affected.user' });
  mocks.grantPlantScope.mockResolvedValue({ scopeValue: 'P100', username: 'affected.user' });
  mocks.revokeOrganisationScope.mockResolvedValue({ revoked: true, assignmentId: 'assignment-1' });
});

describe('central scope administration server actions', () => {
  it('denies without the central maintenance capability and performs no service call', async () => {
    mocks.requireSession.mockResolvedValue({ ...session, user: { ...session.user, capabilities: [] } });
    const form = new FormData();
    form.set('targetUserId', 'target');
    form.set('companyCode', '1000');

    const state = await grantCompanyScopeAction({ ok: false }, form);
    expect(state).toMatchObject({ ok: false, message: expect.stringContaining(CAPABILITY) });
    expect(mocks.grantCompanyCodeScope).not.toHaveBeenCalled();
  });

  it('derives tenant and administrator identity from the verified session, not form fields', async () => {
    const form = new FormData();
    form.set('client', 'EVIL');
    form.set('actorUserId', 'attacker');
    form.set('sessionId', 'forged');
    form.set('targetUserId', 'target-1');
    form.set('companyCode', '1000');

    const state = await grantCompanyScopeAction({ ok: false }, form);
    expect(state).toMatchObject({ ok: true });
    expect(mocks.grantCompanyCodeScope).toHaveBeenCalledWith({
      client: 'T123',
      actor: { userId: 'actor-session-user', sessionId: 'persisted-session-id' },
      targetUserId: 'target-1',
      companyCode: '1000',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/platform/users/access');
  });

  it('routes plant grants and revocations only through session-derived tenant and actor', async () => {
    const plantForm = new FormData();
    plantForm.set('client', 'EVIL');
    plantForm.set('targetUserId', 'target-2');
    plantForm.set('companyCode', '1000');
    plantForm.set('plantCode', 'P100');
    expect(await grantPlantScopeAction({ ok: false }, plantForm)).toMatchObject({ ok: true });
    expect(mocks.grantPlantScope).toHaveBeenCalledWith({
      client: 'T123', actor: { userId: 'actor-session-user', sessionId: 'persisted-session-id' },
      targetUserId: 'target-2', companyCode: '1000', plantCode: 'P100',
    });

    const revokeForm = new FormData();
    revokeForm.set('client', 'EVIL');
    revokeForm.set('targetUserId', 'target-2');
    revokeForm.set('assignmentId', 'assignment-1');
    expect(await revokeOrganisationScopeAction({ ok: false }, revokeForm)).toMatchObject({ ok: true });
    expect(mocks.revokeOrganisationScope).toHaveBeenCalledWith({
      client: 'T123', actor: { userId: 'actor-session-user', sessionId: 'persisted-session-id' },
      targetUserId: 'target-2', assignmentId: 'assignment-1',
    });
  });
});
