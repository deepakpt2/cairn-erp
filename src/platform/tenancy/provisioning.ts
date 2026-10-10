/** Deployment-owner admission gate. No secret or database contents reach the browser. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { hasCapability, type SessionContext } from '../auth/session';

export const PROVISION_CAPABILITY = 'CFG.PLT.CLIENT.ONBOARD';
export class ProvisioningError extends Error {
  readonly remedy = 'Ask the deployment owner for access. First setup requires the configured owner token; later setup also requires an authorised sign-in.';
  constructor() { super('Tenant creation is restricted to the deployment owner.'); }
}
export function assertProvisioningToken(environment: string | undefined, configured: string | undefined, supplied: string) {
  if (environment === 'development') return;
  if (!configured || configured.length < 32 || !supplied || supplied.length > 256) throw new ProvisioningError();
  const digest = (text: string) => createHash('sha256').update(text).digest();
  if (!timingSafeEqual(digest(configured), digest(supplied))) throw new ProvisioningError();
}
export function assertProvisioningSession(environment: string | undefined, initialized: boolean, session: SessionContext | null) {
  if (environment === 'development' || !initialized) return;
  if (!session || !hasCapability(session.user.capabilities, PROVISION_CAPABILITY)) throw new ProvisioningError();
}
/** Recheck under a global transaction lock: two anonymous first-setup requests cannot both win. */
export async function authorizeProvisioning(tx: Tx, input: { environment?: string; configuredToken?: string; suppliedToken: string; session: SessionContext | null }) {
  assertProvisioningToken(input.environment, input.configuredToken, input.suppliedToken);
  if (input.environment === 'development') return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('cairn/tenant-provisioning', 0))`);
  const rows = await tx.execute(sql`select exists(select 1 from public.cairn_list_tenants()) as initialized`);
  const initialized = (rows as unknown as Array<{ initialized: boolean }>)[0]?.initialized;
  if (typeof initialized !== 'boolean') throw new ProvisioningError();
  assertProvisioningSession(input.environment, initialized, input.session);
}
