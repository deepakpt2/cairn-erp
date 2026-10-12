import { describe, expect, it, vi } from 'vitest';
import { createPartnerBankProfileReadinessReader } from '../src/modules/foundation/partner-bank-profile-readiness';

describe('read-only partner-bank profile readiness reader', () => {
  it('does not query the global registry for missing or unsupported country input', async () => {
    const lookup = vi.fn(async () => null);
    const read = createPartnerBankProfileReadinessReader(lookup);

    expect(await read(undefined)).toEqual({ status: 'COUNTRY_REQUIRED', ready: false });
    expect(await read('CA')).toEqual({ status: 'PROFILE_UNAVAILABLE', ready: false });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reads the normalized supported country and returns readiness only for its current revision', async () => {
    const lookup = vi.fn(async () => ({ policyRevision: 'D-062', readinessStatus: 'READY' }));
    const read = createPartnerBankProfileReadinessReader(lookup);

    expect(await read(' kw ')).toEqual({
      status: 'PROFILE_READY',
      country: 'KW',
      policyRevision: 'D-062',
      ready: true,
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('KW');
  });

  it.each([
    { policyRevision: 'D-061', readinessStatus: 'READY', reason: 'POLICY_REVISION_MISMATCH' },
    { policyRevision: 'D-062', readinessStatus: 'NOT_READY', reason: 'PROFILE_NOT_ACTIVATED' },
  ] as const)('fails closed for a registry row with reason $reason', async ({ policyRevision, readinessStatus, reason }) => {
    const read = createPartnerBankProfileReadinessReader(async () => ({ policyRevision, readinessStatus }));
    expect(await read('KW')).toMatchObject({ status: 'PROFILE_NOT_READY', reason, ready: false });
  });

  it('fails closed when the supported country has no persisted row', async () => {
    const read = createPartnerBankProfileReadinessReader(async () => null);
    expect(await read('KW')).toMatchObject({
      status: 'PROFILE_NOT_READY',
      reason: 'REGISTRY_ROW_MISSING',
      ready: false,
    });
  });

  it('propagates registry failures instead of treating them as ready', async () => {
    const read = createPartnerBankProfileReadinessReader(async () => {
      throw new Error('synthetic registry failure');
    });
    await expect(read('KW')).rejects.toThrow('synthetic registry failure');
  });
});
