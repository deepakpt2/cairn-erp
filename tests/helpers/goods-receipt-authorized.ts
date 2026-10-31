import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { createSession } from '../../src/platform/auth/session';
import { hashPassword } from '../../src/platform/auth/password';
import {
  appUser, authOrgRestriction, capability, role, roleCapability, userRole,
} from '../../src/platform/tables/security';
import { plant } from '../../src/modules/foundation/schema';
import {
  GR_POST_CAPABILITY,
  postGoodsReceipt as postService,
  reverseGoodsReceipt as reverseService,
  type PostGoodsReceiptInput,
  type ReverseGoodsReceiptInput,
} from '../../src/modules/inventory/goods-receipt';

interface TestAuthorization {
  userId: string;
  sessionId: string;
}

const actors = new Map<string, Promise<TestAuthorization>>();
const TEST_ROLE = 'TEST_GR_AUTHZ';

async function createTestActor(client: string, createdBy: string): Promise<TestAuthorization> {
  const userId = randomUUID();
  const passwordHash = await hashPassword('GoodsReceiptTestPassword123!');
  return withTenant(client, async (tx) => {
    await tx.insert(capability).values({
      code: GR_POST_CAPABILITY,
      module: 'INV',
      description: 'Test goods receipt posting authority',
      action: 'POST',
    }).onConflictDoNothing();
    await tx.insert(role).values({
      client,
      code: TEST_ROLE,
      name: 'Goods receipt test authorisation',
      description: 'Disposable authorised fixture for goods receipt service tests',
      isSystemRole: false,
      isReadOnly: false,
      createdBy,
    }).onConflictDoNothing();
    await tx.insert(roleCapability).values({
      client, roleCode: TEST_ROLE, capabilityCode: GR_POST_CAPABILITY, createdBy,
    }).onConflictDoNothing();
    await tx.insert(appUser).values({
      id: userId,
      client,
      username: `test.gr.${client}.${userId.slice(0, 8)}`,
      fullName: 'Goods receipt test authorisation',
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
    if (!sessions[0]) throw new Error('Goods receipt test session was not persisted.');
    return { userId, sessionId: sessions[0].id };
  });
}

async function ensureTestAuthorization(client: string, createdBy: string): Promise<TestAuthorization> {
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
    const plantRows = await tx.select({ plantCode: plant.plant, companyCode: plant.companyCode })
      .from(plant).where(eq(plant.client, client));
    const companyScopes = new Set(plantRows.map((row) => row.companyCode).filter((code): code is string => Boolean(code?.trim())));
    const plantScopes = new Set(plantRows.map((row) => row.plantCode).filter((code) => Boolean(code.trim())));
    // Keep malformed/minimal fixtures able to reach their intended domain error.
    // These placeholders cannot authorise any real plant/company record.
    if (companyScopes.size === 0) companyScopes.add('TEST-COMPANY');
    if (plantScopes.size === 0) plantScopes.add('TEST-PLANT');

    const existing = await tx.select({ scopeType: authOrgRestriction.scopeType, scopeValue: authOrgRestriction.scopeValue })
      .from(authOrgRestriction)
      .where(and(
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

export async function postGoodsReceipt(input: PostGoodsReceiptInput) {
  const authorization = await ensureTestAuthorization(input.client, input.changedBy);
  return postService(input, { authorization });
}

export async function reverseGoodsReceipt(input: ReverseGoodsReceiptInput) {
  const authorization = await ensureTestAuthorization(input.client, input.changedBy);
  return reverseService(input, { authorization });
}
