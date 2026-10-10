import { describe, expect, it, vi } from 'vitest';
import { assertProvisioningToken, assertProvisioningSession, authorizeProvisioning } from '../src/platform/tenancy/provisioning';
import type { SessionContext } from '../src/platform/auth/session';
import type { Tx } from '../src/platform/db/client';
const TOKEN = 'OwnerTokenForTestsOnly'.repeat(3);
const admin = { user: { username: 'owner.admin', capabilities: ['*'] } } as SessionContext;
const viewer = { user: { username: 'viewer', capabilities: ['INV.*'] } } as SessionContext;

function transaction(initialized: boolean) {
  const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ initialized }]);
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
  it('permits first setup without a session only after token verification', () => {
    expect(() => assertProvisioningSession('production', false, null)).not.toThrow();
  });
  it('rejects later anonymous setup even with a valid owner token', async () => {
    const { tx, execute } = transaction(true);
    await expect(authorizeProvisioning(tx, { environment: 'production', configuredToken: TOKEN, suppliedToken: TOKEN, session: null })).rejects.toThrow('restricted');
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('rejects later authenticated users without the provisioning capability', () => {
    expect(() => assertProvisioningSession('production', true, viewer)).toThrow('restricted');
  });
  it('allows later authorized admins only with the separately checked token', async () => {
    const { tx } = transaction(true);
    await expect(authorizeProvisioning(tx, { environment: 'production', configuredToken: TOKEN, suppliedToken: TOKEN, session: admin })).resolves.toBeUndefined();
    const invalid = transaction(true);
    await expect(authorizeProvisioning(invalid.tx, { environment: 'production', configuredToken: TOKEN, suppliedToken: '', session: admin })).rejects.toThrow('restricted');
    expect(invalid.execute).not.toHaveBeenCalled();
  });
  it('rechecks initialization after the global lock; a stale first-setup page cannot admit a second anonymous tenant', async () => {
    const first = transaction(false);
    await expect(authorizeProvisioning(first.tx, { environment: 'production', configuredToken: TOKEN, suppliedToken: TOKEN, session: null })).resolves.toBeUndefined();
    expect(first.execute).toHaveBeenCalledTimes(2);
    const afterFirstCommit = transaction(true);
    await expect(authorizeProvisioning(afterFirstCommit.tx, { environment: 'production', configuredToken: TOKEN, suppliedToken: TOKEN, session: null })).rejects.toThrow('restricted');
  });
});
