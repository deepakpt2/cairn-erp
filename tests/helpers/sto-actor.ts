/**
 * Real signed-in actors for the stock transport order tests: an app_user, a role carrying exactly the
 * named capabilities, Company Code and Plant restriction rows for exactly the named plants, and a live
 * session. A test that wants "an actor who may not reach company 2000" asks for one whose plants stop at
 * company 1000, and the service refuses it for real.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { createSession } from '../../src/platform/auth/session';
import { hashPassword } from '../../src/platform/auth/password';
import {
  appUser, authOrgRestriction, capability, role, roleCapability, userRole,
} from '../../src/platform/tables/security';
import { plant } from '../../src/modules/foundation/schema';
import type { ServiceAuthorityContext } from '../../src/platform/auth/service-authority';

export const STO_CAPABILITIES = ['INV.TRANSFER.POST', 'INV.GR.POST', 'INV.REVERSE'];

export async function makeStoActor(
  client: string, name: string, options: { capabilities?: string[]; plants: string[] },
): Promise<ServiceAuthorityContext> {
  const capabilities = options.capabilities ?? STO_CAPABILITIES;
  const userId = randomUUID();
  const roleCode = `T_${name}`.slice(0, 20).toUpperCase();
  const passwordHash = await hashPassword('StoTestPassword123!');
  return withTenant(client, async (tx) => {
    for (const code of capabilities) {
      await tx.insert(capability).values({
        code, module: code.split('.')[0], description: `Test ${code}`, action: 'POST',
      }).onConflictDoNothing();
    }
    await tx.insert(role).values({
      client, code: roleCode, name: `STO test ${name}`, description: 'Disposable STO test role',
      isSystemRole: false, isReadOnly: false, createdBy: 'TEST',
    }).onConflictDoNothing();
    for (const code of capabilities) {
      await tx.insert(roleCapability).values({ client, roleCode, capabilityCode: code, createdBy: 'TEST' }).onConflictDoNothing();
    }
    await tx.insert(appUser).values({
      id: userId, client, username: `sto.${name}.${userId.slice(0, 6)}`.toLowerCase(), fullName: `STO ${name}`,
      passwordHash, isActive: true, createdBy: 'TEST',
    });
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: 'TEST' });
    await createSession(tx, { client, userId });
    const rows = await tx.execute((await import('drizzle-orm')).sql`
      select id from user_session where client = ${client} and user_id = ${userId} order by issued_at desc limit 1
    `) as unknown as Array<{ id: string }>;
    const plants = await tx.select({ code: plant.plant, company: plant.companyCode }).from(plant).where(eq(plant.client, client));
    const wanted = plants.filter((p) => options.plants.includes(p.code));
    const scopes = [
      ...new Set(wanted.map((p) => `COMPANY_CODE|${p.company}`)),
      ...wanted.map((p) => `PLANT|${p.code}`),
    ];
    for (const scope of scopes) {
      const [scopeType, scopeValue] = scope.split('|');
      await tx.insert(authOrgRestriction).values({ id: randomUUID(), client, userId, scopeType, scopeValue, createdBy: 'TEST' });
    }
    void and;
    return { userId, sessionId: rows[0]!.id };
  });
}
