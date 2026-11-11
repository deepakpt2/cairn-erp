/**
 * Deployment-owner admission gate. No secret or database contents reach the browser.
 *
 * Tenant creation is one owner action with one gate: the configured owner token.
 *
 * It used to carry a second, different rule for later tenants — a signed-in session
 * holding CFG.PLT.CLIENT.ONBOARD. That meant an owner holding the token could still be
 * refused, and that whether they were refused depended on how many tenants happened to
 * exist. The token is the stronger proof, so it is now the only one, and it is the same
 * proof for the first tenant and for every tenant after it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

export class ProvisioningError extends Error {
  readonly remedy = 'Ask the deployment owner for the configured owner token.';
  constructor() {
    super('Tenant creation is restricted to the deployment owner.');
  }
}

export function assertProvisioningToken(
  environment: string | undefined,
  configured: string | undefined,
  supplied: string,
) {
  if (environment === 'development') return;
  if (!configured || configured.length < 32 || !supplied || supplied.length > 256) throw new ProvisioningError();
  const digest = (text: string) => createHash('sha256').update(text).digest();
  if (!timingSafeEqual(digest(configured), digest(supplied))) throw new ProvisioningError();
}

/**
 * Re-verify the token under the global provisioning lock.
 *
 * The callback runs inside the tenant-creation transaction, so the lock is held until
 * that transaction commits and concurrent tenant creations are serialized rather than
 * interleaved.
 */
export async function authorizeProvisioning(
  tx: Tx,
  input: { environment?: string; configuredToken?: string; suppliedToken: string },
) {
  assertProvisioningToken(input.environment, input.configuredToken, input.suppliedToken);
  if (input.environment === 'development') return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('cairn/tenant-provisioning', 0))`);
}
