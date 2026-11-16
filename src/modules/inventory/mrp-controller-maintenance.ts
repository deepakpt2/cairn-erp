import { and, count, eq } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { plant as plantTable } from '../foundation/schema';
import { materialPlant, mrpController } from './schema';

/**
 * MRP controller maintenance (OMD0 / SAP T024D).
 *
 * The table stood from the materials build and the material master validates against it, but nothing
 * maintained it. A controller is defined per plant: the key is plant + a code of at most three
 * characters, and the same code may stand independently in two plants. The key is never renamed.
 *
 * Two guards differ from material groups. The material master refuses to save any MRP view whose
 * controller is not active in its plant, so deactivating a controller that materials name would break
 * the next save of every one of them; it is refused here, with the count. Deletion is refused likewise,
 * as a message and not as a foreign-key violation. A reason is required on every write.
 *
 * Not built, deliberately: telephone, mail recipient, planner user id (nothing reads them), mass
 * reassignment of materials, MRP-area controllers, per-controller reporting (MD07). The MRP run does
 * not read this table.
 */

import { ACTIVITY, LOCK_OBJECT, MRP_CONTROLLER_ROUTE, mrpControllerKey, parseMrpControllerKey } from './mrp-controller-key';
export { ACTIVITY, LOCK_OBJECT, MRP_CONTROLLER_ROUTE, mrpControllerKey, parseMrpControllerKey };
const OBJECT_CLASS = 'mrp_controller';
const PRODUCTION = process.env.NODE_ENV === 'production';

export class MrpControllerError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'MrpControllerError';
  }
}

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new MrpControllerError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new MrpControllerError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new MrpControllerError(
      'A reason is required for every MRP controller change.',
      'State why this change is being made.',
    );
  }
  return value;
}

function requireControllerCode(controller: string): string {
  const value = (controller ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,3}$/.test(value)) {
    throw new MrpControllerError(
      'MRP controller must be one to 3 uppercase letters or digits.',
      'Correct the controller code and save again.',
    );
  }
  return value;
}

function requirePlantCode(plant: string): string {
  const value = (plant ?? '').trim().toUpperCase();
  if (!value) throw new MrpControllerError('The plant is required.', 'Choose the plant the controller is defined for.');
  return value;
}

function plural(n: number): string {
  return `${n} material${n === 1 ? '' : 's'}`;
}

// ── Reads ────────────────────────────────────────────────────────────────

export interface MrpControllerRow {
  plant: string;
  plantName: string | null;
  controller: string;
  name: string;
  isActive: boolean;
  materialCount: number;
}

export async function listMrpControllers(client: string): Promise<MrpControllerRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        plant: mrpController.plant,
        plantName: plantTable.name,
        controller: mrpController.controller,
        name: mrpController.name,
        isActive: mrpController.isActive,
      })
      .from(mrpController)
      .leftJoin(plantTable, and(eq(plantTable.client, mrpController.client), eq(plantTable.plant, mrpController.plant)))
      .where(eq(mrpController.client, tenant))
      .orderBy(mrpController.plant, mrpController.controller);
    const usage = await tx
      .select({ plant: materialPlant.plant, controller: materialPlant.mrpController, n: count() })
      .from(materialPlant)
      .where(eq(materialPlant.client, tenant))
      .groupBy(materialPlant.plant, materialPlant.mrpController);
    const used = new Map(usage.map((u) => [`${u.plant}/${u.controller}`, Number(u.n)]));
    return rows.map((r) => ({ ...r, materialCount: used.get(`${r.plant}/${r.controller}`) ?? 0 }));
  });
}

async function materialsNaming(tx: Tx, client: string, plant: string, controller: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(materialPlant)
    .where(and(
      eq(materialPlant.client, client),
      eq(materialPlant.plant, plant),
      eq(materialPlant.mrpController, controller),
    ));
  return Number(row?.n ?? 0);
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface MrpControllerInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  plant: string;
  controller: string;
  name: string;
  reason: string;
}

export async function saveMrpController(
  input: MrpControllerInput,
): Promise<{ plant: string; controller: string; key: string; changed: boolean }> {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const plant = requirePlantCode(input.plant);
  const controller = requireControllerCode(input.controller);
  const name = (input.name ?? '').trim();
  if (!name || name.length > 100) {
    throw new MrpControllerError(
      'The planner name is required and may be at most 100 characters.',
      'Enter a name within the limit and save again.',
    );
  }
  const key = mrpControllerKey(plant, controller);
  const where = and(
    eq(mrpController.client, client),
    eq(mrpController.plant, plant),
    eq(mrpController.controller, controller),
  );

  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(mrpController).where(where).for('update');

    if (input.mode === 'CREATE') {
      if (existing) {
        throw new MrpControllerError(
          `MRP controller ${controller} already stands in plant ${plant}.`,
          'Change the standing controller, or choose a new code.',
        );
      }
      const [standing] = await tx
        .select({ isActive: plantTable.isActive })
        .from(plantTable)
        .where(and(eq(plantTable.client, client), eq(plantTable.plant, plant)));
      if (!standing?.isActive) {
        throw new MrpControllerError(
          `Plant ${plant} does not stand or is not active.`,
          'Choose an active plant, or define the plant first at /config/plants.',
        );
      }
      await tx.insert(mrpController).values({ client, plant, controller, name, isActive: true, createdBy: changedBy });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: key,
        changeType: 'CREATE',
        changedBy,
        reason,
        transactionCode: ACTIVITY,
        after: { plant, controller, name, isActive: true },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { plant, controller, key, changed: true };
    }

    if (!existing) {
      throw new MrpControllerError(
        `MRP controller ${controller} does not stand in plant ${plant}.`,
        'Create it first, then change it.',
      );
    }
    if (existing.name === name) return { plant, controller, key, changed: false };
    await tx.update(mrpController).set({ name, changedBy, changedAt: new Date() }).where(where);
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { name: existing.name },
      after: { name },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { plant, controller, key, changed: true };
  });
}

export interface MrpControllerKeyInput {
  client: string;
  changedBy: string;
  /** The composite from {@link mrpControllerKey}. */
  key: string;
  reason: string;
}

function resolveKey(key: string): { plant: string; controller: string } {
  const parsed = parseMrpControllerKey(key);
  if (!parsed) {
    throw new MrpControllerError('The MRP controller key is malformed.', 'Open the controller from the list and try again.');
  }
  return { plant: parsed.plant.toUpperCase(), controller: parsed.controller.toUpperCase() };
}

export async function setMrpControllerActive(
  input: MrpControllerKeyInput & { active: boolean },
): Promise<{ key: string; changed: boolean }> {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const { plant, controller } = resolveKey(input.key);
  const key = mrpControllerKey(plant, controller);
  const where = and(
    eq(mrpController.client, client),
    eq(mrpController.plant, plant),
    eq(mrpController.controller, controller),
  );
  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(mrpController).where(where).for('update');
    if (!existing) {
      throw new MrpControllerError(`MRP controller ${controller} does not stand in plant ${plant}.`);
    }
    if (existing.isActive === input.active) return { key, changed: false };
    if (!input.active) {
      const used = await materialsNaming(tx, client, plant, controller);
      if (used > 0) {
        throw new MrpControllerError(
          `MRP controller ${controller} cannot be deactivated: ${plural(used)} in plant ${plant} name${used === 1 ? 's' : ''} it.`,
          'Reassign those materials to another controller first, or deactivate nothing.',
        );
      }
    }
    await tx.update(mrpController).set({ isActive: input.active, changedBy, changedAt: new Date() }).where(where);
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { isActive: existing.isActive },
      after: { isActive: input.active },
      securityRelevantFields: ['isActive'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { key, changed: true };
  });
}

export async function deleteMrpController(input: MrpControllerKeyInput): Promise<{ key: string }> {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const { plant, controller } = resolveKey(input.key);
  const key = mrpControllerKey(plant, controller);
  const where = and(
    eq(mrpController.client, client),
    eq(mrpController.plant, plant),
    eq(mrpController.controller, controller),
  );
  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(mrpController).where(where).for('update');
    if (!existing) {
      throw new MrpControllerError(`MRP controller ${controller} does not stand in plant ${plant}.`);
    }
    const used = await materialsNaming(tx, client, plant, controller);
    if (used > 0) {
      throw new MrpControllerError(
        `MRP controller ${controller} cannot be deleted: ${plural(used)} in plant ${plant} name${used === 1 ? 's' : ''} it.`,
        'Reassign those materials to another controller first, or deactivate nothing.',
      );
    }
    await tx.delete(mrpController).where(where);
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'DELETE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { plant: existing.plant, controller: existing.controller, name: existing.name, isActive: existing.isActive },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { key };
  });
}

/**
 * Seeds and fixtures insert directly rather than through the services (see the header of
 * `platform/tenancy/standard-structure.ts`). Idempotent; used by the standard-config seed and by every
 * fixture that assigns a controller to a material, because a controller must stand in the material's plant.
 */
export async function seedMrpController(
  tx: Tx, client: string, plant: string, controller: string, name: string, createdBy: string,
): Promise<void> {
  await tx.insert(mrpController).values({ client, plant, controller, name, createdBy }).onConflictDoNothing();
}
