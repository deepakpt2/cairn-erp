import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../src/platform/auth/session';
import {
  createPartnerBankProfileActivationService,
  type PartnerBankProfileActivationDatabaseInput,
} from '../src/modules/foundation/partner-bank-profile-activation';
import {
  PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY,
  PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE,
} from '../src/platform/security/partner-bank-profile-activation';

const USER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const EVENT_ID = '8bd2f62e-e4b8-4f79-a7f8-8106d9bbf277';

function session(capabilities: string[] = [PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY]): SessionContext {
  return {
    user: {
      client: 'T123',
      userId: USER_ID,
      username: 'profile-admin',
      fullName: 'Profile Administrator',
      email: null,
      mustChangePassword: false,
      capabilities,
    },
    expiresAt: new Date('2026-10-12T00:00:00.000Z'),
    renewed: false,
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    country: 'kw',
    expectedPolicyRevision: 'D-062',
    expectedVersion: 7,
    evidenceCode: PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE,
    ...overrides,
  };
}

describe('partner-bank profile activation service', () => {
  it('refuses missing sessions and missing capability before touching the database', async () => {
    const execute = vi.fn(async () => 'ACTIVATED');
    const service = createPartnerBankProfileActivationService(execute, () => EVENT_ID);

    expect(await service(null, command())).toEqual({ ok: false, code: 'UNAUTHENTICATED' });
    expect(await service(session(['FND.PARTNER.DISPLAY']), command())).toEqual({
      ok: false,
      code: 'CAPABILITY_DENIED',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses Administrator wildcard capability semantics', async () => {
    const execute = vi.fn(async () => 'ACTIVATED');
    const service = createPartnerBankProfileActivationService(execute, () => EVENT_ID);

    expect(await service(session(['*']), command())).toMatchObject({ ok: true, code: 'ACTIVATED' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects injected actor fields, free text, stale policy and invalid versions before database access', async () => {
    const execute = vi.fn(async () => 'ACTIVATED');
    const service = createPartnerBankProfileActivationService(execute, () => EVENT_ID);

    expect(await service(session(), command({ actorClient: 'EVIL' }))).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_FIELDS',
    });
    expect(await service(session(), command({ rationale: 'free text' }))).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_FIELDS',
    });
    expect(await service(session(), command({ expectedPolicyRevision: 'D-061' }))).toMatchObject({
      ok: false,
      code: 'POLICY_REVISION_MISMATCH',
    });
    expect(await service(session(), command({ expectedVersion: 1.5 }))).toMatchObject({
      ok: false,
      code: 'VERSION_INVALID',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('derives actor identity from the verified session and submits only the fixed activation contract', async () => {
    let databaseInput: PartnerBankProfileActivationDatabaseInput | undefined;
    const execute = vi.fn(async (input: PartnerBankProfileActivationDatabaseInput) => {
      databaseInput = input;
      return 'ACTIVATED';
    });
    const service = createPartnerBankProfileActivationService(execute, () => EVENT_ID);

    const result = await service(session(), command({ country: ' kw ' }));
    expect(result).toEqual({
      ok: true,
      code: 'ACTIVATED',
      eventId: EVENT_ID,
      country: 'KW',
      policyRevision: 'D-062',
      version: 8,
    });
    expect(databaseInput).toEqual({
      eventId: EVENT_ID,
      actorClient: 'T123',
      actorUserId: USER_ID,
      country: 'KW',
      expectedPolicyRevision: 'D-062',
      expectedVersion: 7,
      evidenceCode: 'PROFILE_VALIDATION_ACCEPTED',
    });
  });

  it.each(['PROFILE_ALREADY_READY', 'VERSION_MISMATCH', 'PROFILE_UNAVAILABLE'])(
    'returns a controlled database rejection (%s) without claiming success',
    async (outcome) => {
      const service = createPartnerBankProfileActivationService(async () => outcome, () => EVENT_ID);
      expect(await service(session(), command())).toEqual({ ok: false, code: outcome });
    },
  );

  it('fails closed on invalid session identity, generated event ID, or unexpected database outcome', async () => {
    const execute = vi.fn(async () => 'ACTIVATED');
    const service = createPartnerBankProfileActivationService(execute, () => EVENT_ID);
    const invalidActorSession = session();
    invalidActorSession.user.client = '!';
    expect(await service(invalidActorSession, command())).toEqual({
      ok: false,
      code: 'ACTOR_INVALID',
    });
    expect(execute).not.toHaveBeenCalled();

    const badEventIdService = createPartnerBankProfileActivationService(execute, () => 'not-a-uuid');
    expect(await badEventIdService(session(), command())).toEqual({ ok: false, code: 'EVENT_ID_INVALID' });
    expect(execute).not.toHaveBeenCalled();

    const invalidResultService = createPartnerBankProfileActivationService(async () => ({ outcome: 'ACTIVATED' }), () => EVENT_ID);
    expect(await invalidResultService(session(), command())).toEqual({
      ok: false,
      code: 'DATABASE_RESULT_INVALID',
    });
  });
});
