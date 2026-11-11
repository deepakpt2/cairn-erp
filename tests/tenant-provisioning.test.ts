import { describe, expect, it, vi } from 'vitest';
import { assertProvisioningToken, authorizeProvisioning } from '../src/platform/tenancy/provisioning';
import type { Tx } from '../src/platform/db/client';

const TOKEN = 'OwnerTokenForTestsOnly'.repeat(3);

function transaction() {
  const execute = vi.fn().mockResolvedValue([]);
  return { execute, tx: { execute } as unknown as Tx };
}

describe('deployment-owner tenant admission', () => {
  it('rejects anonymous production POSTs without the token', () => {
    expect(() => assertProvisioningToken('production', TOKEN, '')).toThrow('restricted');
  });
  it('fails closed when no token is configured', () => {
    expect(() => assertProvisioningToken('production', undefined, TOKEN)).toThrow('restricted');
  });
  it('rejects a weak configured token', () => {
    expect(() => assertProvisioningToken('production', 'weak', 'weak')).toThrow('restricted');
  });
  it('rejects a wrong token regardless of equal length', () => {
    expect(() => assertProvisioningToken('production', TOKEN, 'x'.repeat(TOKEN.length))).toThrow('restricted');
  });
  it('accepts only the exact configured token in production', () => {
    expect(() => assertProvisioningToken('production', TOKEN, TOKEN)).not.toThrow();
  });
  it('does not treat missing/unknown environment as development', () => {
    expect(() => assertProvisioningToken(undefined, undefined, '')).toThrow('restricted');
    expect(() => assertProvisioningToken('other', undefined, '')).toThrow('restricted');
  });
  it('allows the explicit development fixture path', () => {
    expect(() => assertProvisioningToken('development', undefined, '')).not.toThrow();
  });

  it('takes the global provisioning lock for a production tenant creation', async () => {
    const { tx, execute } = transaction();
    await expect(
      authorizeProvisioning(tx, { environment: 'production', configuredToken: TOKEN, suppliedToken: TOKEN }),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('admits a later tenant on the same token that admitted the first, and nothing else', async () => {
    const first = transaction();
    await expect(
      authorizeProvisioning(first.tx, { environment: 'production', configuredToken: TOKEN, suppliedToken: TOKEN }),
    ).resolves.toBeUndefined();
    const later = transaction();
    await expect(
      authorizeProvisioning(later.tx, { environment: 'production', configuredToken: TOKEN, suppliedToken: TOKEN }),
    ).resolves.toBeUndefined();
  });

  it('refuses before the lock is taken when the token is wrong', async () => {
    const { tx, execute } = transaction();
    await expect(
      authorizeProvisioning(tx, { environment: 'production', configuredToken: TOKEN, suppliedToken: '' }),
    ).rejects.toThrow('restricted');
    expect(execute).not.toHaveBeenCalled();
  });

  it('takes no lock on the development fixture path', async () => {
    const { tx, execute } = transaction();
    await expect(
      authorizeProvisioning(tx, { environment: 'development', configuredToken: undefined, suppliedToken: '' }),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
