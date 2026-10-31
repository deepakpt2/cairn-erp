import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { createSession } from '../../src/platform/auth/session';
import { hashPassword } from '../../src/platform/auth/password';
import {
  appUser, authOrgRestriction, capability, role, roleCapability, userRole,
} from '../../src/platform/tables/security';
import { plant } from '../../src/modules/foundation/schema';
import {
  GOODS_ISSUE_CAPABILITY,
  postGoodsIssue as postService,
  type PostGoodsIssueInput,
} from '../../src/modules/inventory/goods-issue';

interface TestAuthorization {
  userId: string;
  sessionId: string;
}

const actors = new Map<string, Promise<TestAuthorization>>();
const TEST_ROLE = 'TEST_GI_AUTHZ';

async function createTestActor(client: string, createdBy: string): Promise<TestAuthorization> {
  const userId = randomUUID();
  const passwordHash = await hashPassword('GoodsIssueTestPassword123!');
  return withTenant(client, async (tx) => {
    await tx.insert(capability).values({
      code: GOODS_ISSUE_CAPABILITY,
      module: 'INV',
      description: 'Test goods issue posting authority',
      action: 'POST',
    }).onConflictDoNothing();
    await tx.insert(role).values({
      client,
      code: TEST_ROLE,
      name: 'Goods issue test authorisation',
      description: 'Disposable authorised fixture for goods issue service tests',
      isSystemRole: false,
      isReadOnly: false,
      createdBy,
    }).onConflictDoNothing();
    await tx.insert(roleCapability).values({
      client, roleCode: TEST_ROLE, capabilityCode: GOODS_ISSUE_CAPABILITY, createdBy,
    }).onConflictDoNothing();
    await tx.insert(appUser).values({
      id: userId,
      client,
      username: `test.gi.${client}.${userId.slice(0, 8)}`,
      fullName: 'Goods issue test authorisation',
      passwordHash,
      isActive: true,
      createdBy,
    });
    await tx.insert(userRole).values({ client, userId, roleCode: TEST_ROLE, createdBy });
    await createSession(tx, { client, userId });
    const sessions = await tx.execute(sql`
      select id from user_session where client = ${client} and user_id = ${userId}
      order by issued_at desc limit 1
    `) as unknown as Array<{ id: string }>;
    if (!sessions[0]) throw new Error('Goods issue test session was not persisted.');
    return { userId, sessionId: sessions[0].id };
  });
}

async function ensureTestAuthorization(
  client: string,
  createdBy: string,
  requestedPlantCodes: readonly string[],
): Promise<TestAuthorization> {
  let pending = actors.get(client);
  if (!pending) {
    pending = createTestActor(client, createdBy).catch((error: unknown) => {
      actors.delete(client);
      throw error;
    });
    actors.set(client, pending);
  }
  const actor = await pending;
  await withTenant(client, async (tx) => {
    const requestedPlants = [...new Set(requestedPlantCodes.map((code) => code.trim()).filter(Boolean))];
    if (requestedPlants.length === 0) {
      throw new Error('Goods issue test authorisation requires at least one requested plant.');
    }
    const plantRows = await tx.select({ plantCode: plant.plant, companyCode: plant.companyCode })
      .from(plant).where(and(eq(plant.client, client), inArray(plant.plant, requestedPlants)));
    const standingPlants = new Set(plantRows.map((row) => row.plantCode));
    const missingPlants = requestedPlants.filter((code) => !standingPlants.has(code));
    if (missingPlants.length > 0 || plantRows.some((row) => !row.companyCode?.trim())) {
      throw new Error(`Goods issue test authorisation requires persisted plant/company fixtures for ${missingPlants.join(', ') || requestedPlants.join(', ')} in client ${client}.`);
    }
    const companyScopes = new Set(
      plantRows.map((row) => row.companyCode!.trim()),
    );
    const plantScopes = new Set(plantRows.map((row) => row.plantCode.trim()));

    const existing = await tx.select({
      scopeType: authOrgRestriction.scopeType,
      scopeValue: authOrgRestriction.scopeValue,
    }).from(authOrgRestriction).where(and(
      eq(authOrgRestriction.client, client),
      eq(authOrgRestriction.userId, actor.userId),
    ));
    const present = new Set(existing.map((row) => `${row.scopeType}\u0000${row.scopeValue}`));
    const additions = [
      ...[...companyScopes].map((scopeValue) => ({ scopeType: 'COMPANY_CODE', scopeValue })),
      ...[...plantScopes].map((scopeValue) => ({ scopeType: 'PLANT', scopeValue })),
    ].filter((scope) => !present.has(`${scope.scopeType}\u0000${scope.scopeValue}`));
    if (additions.length > 0) {
      await tx.insert(authOrgRestriction).values(additions.map((scope) => ({
        id: randomUUID(), client, userId: actor.userId, ...scope, createdBy,
      })));
    }
  });
  return actor;
}

/** Posts through the protected service using an actual persisted test user/session and org scope. */
export async function postGoodsIssue(input: PostGoodsIssueInput) {
  const authorization = await ensureTestAuthorization(
    input.client,
    input.changedBy,
    input.lines.map((line) => line.plant),
  );
  return postService(input, 'MB1A', { authorization });
}
