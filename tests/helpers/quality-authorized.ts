/**
 * A signed-in, plant-scoped inspector for the quality-management service tests.
 *
 * The quality services ask who is acting: opening a lot, recording a result and
 * deciding what the goods are each name a plant — the plant the goods stand in,
 * read from the receipt line the lot points at — and an inspector whose reach
 * covers it. A test that calls them therefore needs a real identity: a row in
 * `app_user`, a role carrying the authorities, restriction rows for the plant,
 * and a live session whose id it can hand over.
 *
 * The exports carry the same names as the services', so a test changes its
 * import and nothing else. The plant is never guessed by the test: it is read
 * from the document or the lot the call names, which is the same place the
 * service reads it from.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { createSession } from '../../src/platform/auth/session';
import { hashPassword } from '../../src/platform/auth/password';
import {
  appUser, authOrgRestriction, capability, role, roleCapability, userRole,
} from '../../src/platform/tables/security';
import { plant } from '../../src/modules/foundation/schema';
import { TRANSFER_POST_CAPABILITY } from '../../src/modules/inventory/transfer-posting';
import {
  LOT_CAPABILITY,
  openLot as openService,
} from '../../src/modules/quality/lot';
import {
  INSPECTION_RESULT_CAPABILITY,
  recordInspectionResult as recordResultService,
} from '../../src/modules/quality/inspection-results';
import {
  USAGE_DECISION_CAPABILITY,
  USAGE_DECISION_STOCK_CAPABILITY,
  recordUsageDecision as recordDecisionService,
  postUsageDecisionWithStock as postDecisionService,
} from '../../src/modules/quality/usage-decision';

interface TestAuthorization {
  userId: string;
  sessionId: string;
}

const actors = new Map<string, Promise<TestAuthorization>>();
const TEST_ROLE = 'TEST_QM_AUTHZ';

/**
 * The authorities an inspector needs, and the reason each is on the list.
 *
 * The last one is the transfer authority, and it is there because a decision
 * that moves stock posts a movement: the same rule an issue to a production
 * order lives under, where the mover holds the movement authority as well as
 * the production one.
 */
const CAPABILITIES: ReadonlyArray<{ code: string; description: string }> = [
  { code: LOT_CAPABILITY, description: 'Test inspection lot authority' },
  { code: INSPECTION_RESULT_CAPABILITY, description: 'Test inspection result authority' },
  { code: USAGE_DECISION_CAPABILITY, description: 'Test usage decision authority' },
  { code: USAGE_DECISION_STOCK_CAPABILITY, description: 'Test quality stock posting authority' },
  { code: TRANSFER_POST_CAPABILITY, description: 'Test transfer posting authority' },
];

async function createTestActor(client: string, createdBy: string): Promise<TestAuthorization> {
  const userId = randomUUID();
  const passwordHash = await hashPassword('QualityTestPassword123!');
  return withTenant(client, async (tx) => {
    for (const entry of CAPABILITIES) {
      await tx.insert(capability).values({
        code: entry.code,
        module: entry.code.split('.')[0],
        description: entry.description,
        action: 'POST',
      }).onConflictDoNothing();
    }
    await tx.insert(role).values({
      client,
      code: TEST_ROLE,
      name: 'Quality test authorisation',
      description: 'Disposable authorised fixture for quality management service tests',
      isSystemRole: false,
      isReadOnly: false,
      createdBy,
    }).onConflictDoNothing();
    for (const entry of CAPABILITIES) {
      await tx.insert(roleCapability).values({
        client, roleCode: TEST_ROLE, capabilityCode: entry.code, createdBy,
      }).onConflictDoNothing();
    }
    await tx.insert(appUser).values({
      id: userId,
      client,
      username: `test.qm.${client}.${userId.slice(0, 8)}`,
      fullName: 'Quality test authorisation',
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
    if (!sessions[0]) throw new Error('Quality test session was not persisted.');
    return { userId, sessionId: sessions[0].id };
  });
}

/**
 * Every plant the tenant has.
 *
 * The fallback when a call names goods that do not stand — a test proving that a lot
 * which does not exist is refused, for instance. The reach is still an explicit one and
 * still narrower than the tenant, and the refusal the test is looking for is the
 * service's, not the fixture's.
 */
async function allPlants(client: string): Promise<string[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({ plantCode: plant.plant }).from(plant)
      .where(eq(plant.client, client));
    return rows.map((row) => row.plantCode);
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
      throw new Error('Quality test authorisation requires at least one requested plant.');
    }
    const plantRows = await tx.select({ plantCode: plant.plant, companyCode: plant.companyCode })
      .from(plant).where(and(eq(plant.client, client), inArray(plant.plant, requestedPlants)));
    const standingPlants = new Set(plantRows.map((row) => row.plantCode));
    const missingPlants = requestedPlants.filter((code) => !standingPlants.has(code));
    if (missingPlants.length > 0 || plantRows.some((row) => !row.companyCode?.trim())) {
      throw new Error(`Quality test authorisation requires persisted plant/company fixtures for ${missingPlants.join(', ') || requestedPlants.join(', ')} in client ${client}.`);
    }
    const companyScopes = new Set(plantRows.map((row) => row.companyCode!.trim()));
    const plantScopes = new Set(plantRows.map((row) => row.plantCode.trim()));

    const existing = await tx.select({
      scopeType: authOrgRestriction.scopeType,
      scopeValue: authOrgRestriction.scopeValue,
    }).from(authOrgRestriction).where(and(
      eq(authOrgRestriction.client, client),
      eq(authOrgRestriction.userId, actor.userId),
    ));
    const present = new Set(existing.map((row) => `${row.scopeType} ${row.scopeValue}`));
    const additions = [
      ...[...companyScopes].map((scopeValue) => ({ scopeType: 'COMPANY_CODE', scopeValue })),
      ...[...plantScopes].map((scopeValue) => ({ scopeType: 'PLANT', scopeValue })),
    ].filter((scope) => !present.has(`${scope.scopeType} ${scope.scopeValue}`));
    if (additions.length > 0) {
      await tx.insert(authOrgRestriction).values(additions.map((scope) => ({
        id: randomUUID(), client, userId: actor.userId, ...scope, createdBy,
      })));
    }
  });
  return actor;
}

/** The plant a receipt line stands in — the plant a lot opened against it would name. */
async function plantOfLine(
  client: string, materialDocumentNumber: string, lineNumber: number,
): Promise<string[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select plant from material_document_line
       where client = ${client} and material_document_number = ${materialDocumentNumber}
         and line_number = ${lineNumber}
       limit 1
    `) as unknown as Array<{ plant: string }>;
    return rows.map((row) => row.plant);
  });
}

/** The plant a lot's goods stand in, read from the line the lot names. */
async function plantOfLot(client: string, lotNumber: string): Promise<string[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select l.plant as plant
        from quality_lot q
        join material_document_line l
          on l.client = q.client
         and l.material_document_number = q.material_document_number
         and l.line_number = q.material_document_line
       where q.client = ${client} and q.lot_number = ${lotNumber}
       limit 1
    `) as unknown as Array<{ plant: string }>;
    return rows.map((row) => row.plant);
  });
}

/** Open a lot as a persisted, scoped inspector. */
export async function openLot(input: Parameters<typeof openService>[0]) {
  const named = await plantOfLine(
    input.client, input.materialDocumentNumber, input.lineNumber,
  );
  const authorization = await ensureTestAuthorization(
    input.client, input.changedBy, named.length > 0 ? named : await allPlants(input.client),
  );
  return openService(input, { authorization });
}

/** Record an inspection result as a persisted, scoped inspector. */
export async function recordInspectionResult(
  input: Parameters<typeof recordResultService>[0],
) {
  const named = await plantOfLot(input.client, input.lotNumber);
  const authorization = await ensureTestAuthorization(
    input.client, input.changedBy, named.length > 0 ? named : await allPlants(input.client),
  );
  return recordResultService(input, { authorization });
}

/** Record a usage decision that posts no stock, as a persisted, scoped inspector. */
export async function recordUsageDecision(
  input: Parameters<typeof recordDecisionService>[0],
) {
  const named = await plantOfLot(input.client, input.lotNumber);
  const authorization = await ensureTestAuthorization(
    input.client, input.changedBy, named.length > 0 ? named : await allPlants(input.client),
  );
  return recordDecisionService(input, { authorization });
}

/** Record a usage decision and post its stock movement, as a persisted, scoped inspector. */
export async function postUsageDecisionWithStock(
  input: Parameters<typeof postDecisionService>[0],
) {
  const named = await plantOfLot(input.client, input.lotNumber);
  const authorization = await ensureTestAuthorization(
    input.client, input.changedBy, named.length > 0 ? named : await allPlants(input.client),
  );
  return postDecisionService(input, { authorization });
}
