/**
 * Maintaining shipping points, shipping conditions, and the table that puts them together.
 *
 * This is the screen SAP calls OVL2, together with the two masters it reads. Nothing here is
 * inferred: a plant that has never been assigned a dock has none, and a delivery raised against it
 * says so and points here. That is the whole reason the configuration exists — a shipping point
 * nobody chose is not a shipping point, and the alternative to maintaining the table is a system
 * that quietly invents one.
 *
 * There is no delete anywhere in this file. A row here is the rule a delivery was raised under, and
 * a tenant that wants a combination to stop answering withdraws the row instead: the refusal stands,
 * and it names this screen, which a deletion could not do.
 */
import { and, asc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { customerSalesArea } from '../foundation/customer-sales-area-schema';
import { plant } from '../foundation/schema';
import { materialSales } from '../inventory/schema';
import { SHIPPING_POINT_ROUTE } from './shipping-point';
import { shippingCondition, shippingPoint, shippingPointDetermination } from './schema';

export const SHIPPING_POINT_CAPABILITY = 'CFG.SALES.SHIPPING_POINT.DEFINE';
export const SHIPPING_POINT_OBJECT_CLASS = 'shipping_point';
export const SHIPPING_CONDITION_OBJECT_CLASS = 'shipping_condition';
export const SHIPPING_POINT_DETERMINATION_OBJECT_CLASS = 'shipping_point_determination';

const POINT = /^[A-Z0-9]{1,4}$/;
const CONDITION = /^[A-Z0-9]{1,2}$/;
const GROUP = /^[A-Z0-9]{0,4}$/;
const NAME = /^.{1,40}$/;

export class ShippingPointMaintenanceError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ShippingPointMaintenanceError';
    this.remedy = remedy;
  }
}

export interface ShippingPointRow {
  shippingPoint: string;
  name: string;
  isActive: boolean;
  /** How many determination rows name it, active or not. */
  assignments: number;
}

export interface ShippingConditionRow {
  shippingCondition: string;
  description: string;
  isActive: boolean;
  /** How many customers carry it. */
  carriers: number;
}

export interface ShippingPointAssignmentRow {
  deliveringPlant: string;
  shippingCondition: string;
  loadingGroup: string;
  shippingPoint: string;
  isActive: boolean;
  /** What the shipping point is called, so the table reads as places rather than codes. */
  shippingPointName: string | null;
  /** Whether the shipping point it names still stands and is not withdrawn. */
  pointStands: boolean;
}

export interface ShippingPointConfiguration {
  points: ShippingPointRow[];
  conditions: ShippingConditionRow[];
  assignments: ShippingPointAssignmentRow[];
  plants: Array<{ plant: string; name: string | null }>;
  /** The loading groups materials actually carry, offered so a row is not typed from memory. */
  loadingGroups: string[];
  /** How many customer sales areas carry no condition at all: the ones the blank rows answer for. */
  customersWithoutCondition: number;
}

/** The whole configuration as it stands, in the three pieces the screen shows. */
export async function listShippingPointConfiguration(client: string): Promise<ShippingPointConfiguration> {
  return withTenant(client, async (tx) => {
    const points = await tx.select().from(shippingPoint)
      .where(eq(shippingPoint.client, client)).orderBy(asc(shippingPoint.shippingPoint));
    const conditions = await tx.select().from(shippingCondition)
      .where(eq(shippingCondition.client, client)).orderBy(asc(shippingCondition.shippingCondition));
    const assignments = await tx.select().from(shippingPointDetermination)
      .where(eq(shippingPointDetermination.client, client))
      .orderBy(
        asc(shippingPointDetermination.deliveringPlant),
        asc(shippingPointDetermination.shippingCondition),
        asc(shippingPointDetermination.loadingGroup),
      );
    const pointNames = new Map(points.map((row) => [row.shippingPoint, row]));
    const views = await tx.select({ loadingGroup: materialSales.loadingGroup })
      .from(materialSales).where(eq(materialSales.client, client));
    const areas = await tx.select({
      partnerNumber: customerSalesArea.partnerNumber,
      shippingCondition: customerSalesArea.shippingCondition,
    }).from(customerSalesArea).where(eq(customerSalesArea.client, client));
    const carries = (condition: string) => areas
      .filter((row) => (row.shippingCondition ?? '').trim().toUpperCase() === condition).length;

    return {
      points: points.map((row) => ({
        shippingPoint: row.shippingPoint,
        name: row.name,
        isActive: row.isActive,
        assignments: assignments.filter((row2) => row2.shippingPoint === row.shippingPoint).length,
      })),
      conditions: conditions.map((row) => ({
        shippingCondition: row.shippingCondition,
        description: row.description,
        isActive: row.isActive,
        carriers: carries(row.shippingCondition),
      })),
      assignments: assignments.map((row) => ({
        deliveringPlant: row.deliveringPlant,
        shippingCondition: row.shippingCondition,
        loadingGroup: row.loadingGroup,
        shippingPoint: row.shippingPoint,
        isActive: row.isActive,
        shippingPointName: pointNames.get(row.shippingPoint)?.name ?? null,
        pointStands: (pointNames.get(row.shippingPoint)?.isActive ?? false),
      })),
      plants: (await tx.select({ plant: plant.plant, name: plant.name }).from(plant)
        .where(and(eq(plant.client, client), eq(plant.isActive, true)))
        .orderBy(asc(plant.plant))),
      loadingGroups: [...new Set(views
        .map((row) => (row.loadingGroup ?? '').trim().toUpperCase())
        .filter((group) => group.length > 0))].sort(),
      customersWithoutCondition: areas
        .filter((row) => !(row.shippingCondition ?? '').trim()).length,
    };
  });
}

/**
 * Name a shipping point: the dock, the depot, the gate. It carries no plant of its own — which plant
 * it loads from is what the assignment below says, and a dock can serve more than one.
 */
export async function defineShippingPoint(input: {
  client: string; changedBy: string; shippingPoint: string; name: string;
}): Promise<void> {
  const point = input.shippingPoint.trim().toUpperCase();
  const name = input.name.trim();
  if (!POINT.test(point)) {
    throw new ShippingPointMaintenanceError(
      `Shipping point ${input.shippingPoint} is not a shipping point code.`,
      'Name it in up to four capital letters or digits, the way a plant or a storage location is named.',
    );
  }
  if (!NAME.test(name)) {
    throw new ShippingPointMaintenanceError(
      'A shipping point is named by the place it is: a dock, a depot, a gate.',
      'Name it in up to forty characters, so a reader knows where the goods are loaded.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const inserted = await tx.insert(shippingPoint).values({
      client: input.client, shippingPoint: point, name, isActive: true, createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ shippingPoint: shippingPoint.shippingPoint });
    if (inserted.length === 0) {
      throw new ShippingPointMaintenanceError(
        `Shipping point ${point} already stands.`,
        `Change the standing one at ${SHIPPING_POINT_ROUTE} rather than redefining it: a delivery already raised names the code it was raised with.`,
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: SHIPPING_POINT_OBJECT_CLASS, objectKey: point,
      changeType: 'CREATE', changedBy: input.changedBy, after: { name },
      securityRelevantFields: ['name'],
    });
  });
}

/** Withdraw a shipping point, or restore one. A withdrawn point stops loading. */
export async function changeShippingPointStatus(input: {
  client: string; changedBy: string; shippingPoint: string; isActive: boolean;
}): Promise<void> {
  const point = input.shippingPoint.trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(shippingPoint).where(and(
      eq(shippingPoint.client, input.client), eq(shippingPoint.shippingPoint, point),
    )).limit(1);
    if (!standing) {
      throw new ShippingPointMaintenanceError(
        `Shipping point ${point} does not stand, so there is nothing to change.`,
        `Define it at ${SHIPPING_POINT_ROUTE} first.`,
      );
    }
    await tx.update(shippingPoint)
      .set({ isActive: input.isActive, changedBy: input.changedBy, changedAt: new Date() })
      .where(and(eq(shippingPoint.client, input.client), eq(shippingPoint.shippingPoint, point)));
    await recordChange(tx, {
      client: input.client, objectClass: SHIPPING_POINT_OBJECT_CLASS, objectKey: point,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { isActive: standing.isActive }, after: { isActive: input.isActive },
      securityRelevantFields: ['isActive'],
    });
  });
}

/**
 * Name a shipping condition: a way of wanting goods to arrive.
 *
 * The description is the whole point of the master — a two-character code on a customer's sales area
 * tells a reader nothing, and the code is what determination matches on.
 */
export async function defineShippingCondition(input: {
  client: string; changedBy: string; shippingCondition: string; description: string;
}): Promise<void> {
  const condition = input.shippingCondition.trim().toUpperCase();
  const description = input.description.trim();
  if (!CONDITION.test(condition)) {
    throw new ShippingPointMaintenanceError(
      `Shipping condition ${input.shippingCondition} is not a shipping condition code.`,
      'Name it in one or two capital letters or digits, as SAP carries them.',
    );
  }
  if (!NAME.test(description)) {
    throw new ShippingPointMaintenanceError(
      'A shipping condition is described by what the customer wants: express, standard, collect.',
      'Describe it in up to forty characters, so a reader knows what the code on a customer means.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const inserted = await tx.insert(shippingCondition).values({
      client: input.client, shippingCondition: condition, description, isActive: true,
      createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ shippingCondition: shippingCondition.shippingCondition });
    if (inserted.length === 0) {
      throw new ShippingPointMaintenanceError(
        `Shipping condition ${condition} already stands.`,
        `Change the standing one at ${SHIPPING_POINT_ROUTE}: a customer already carries this code, and a second meaning behind one code is a determination nobody can read.`,
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: SHIPPING_CONDITION_OBJECT_CLASS, objectKey: condition,
      changeType: 'CREATE', changedBy: input.changedBy, after: { description },
      securityRelevantFields: ['description'],
    });
  });
}

/** Withdraw a shipping condition, or restore one. */
export async function changeShippingConditionStatus(input: {
  client: string; changedBy: string; shippingCondition: string; isActive: boolean;
}): Promise<void> {
  const condition = input.shippingCondition.trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(shippingCondition).where(and(
      eq(shippingCondition.client, input.client), eq(shippingCondition.shippingCondition, condition),
    )).limit(1);
    if (!standing) {
      throw new ShippingPointMaintenanceError(
        `Shipping condition ${condition} does not stand, so there is nothing to change.`,
        `Define it at ${SHIPPING_POINT_ROUTE} first.`,
      );
    }
    await tx.update(shippingCondition)
      .set({ isActive: input.isActive, changedBy: input.changedBy, changedAt: new Date() })
      .where(and(
        eq(shippingCondition.client, input.client),
        eq(shippingCondition.shippingCondition, condition),
      ));
    await recordChange(tx, {
      client: input.client, objectClass: SHIPPING_CONDITION_OBJECT_CLASS, objectKey: condition,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { isActive: standing.isActive }, after: { isActive: input.isActive },
      securityRelevantFields: ['isActive'],
    });
  });
}

/**
 * Assign a shipping point to a plant for a shipping condition and a loading group.
 *
 * Blank is a value: a row naming no condition answers every customer, however they want their goods,
 * and a row naming no loading group answers every material. The two judgements made here are that the
 * shipping point and the plant both stand — a row pointing at a plant that is gone is a row that can
 * never answer — and that two rows cannot answer for one combination, which would leave the engine to
 * choose between them.
 */
export async function assignShippingPoint(input: {
  client: string; changedBy: string; deliveringPlant: string;
  shippingCondition?: string; loadingGroup?: string; shippingPoint: string;
}): Promise<void> {
  const deliveringPlant = input.deliveringPlant.trim().toUpperCase();
  const condition = (input.shippingCondition ?? '').trim().toUpperCase();
  const group = (input.loadingGroup ?? '').trim().toUpperCase();
  const point = input.shippingPoint.trim().toUpperCase();
  if (!CONDITION.test(condition) && condition !== '') {
    throw new ShippingPointMaintenanceError(
      `Shipping condition ${input.shippingCondition} is not a shipping condition code.`,
      'Leave it blank to have the row answer for every customer, or name a standing condition.',
    );
  }
  if (!GROUP.test(group)) {
    throw new ShippingPointMaintenanceError(
      `Loading group ${input.loadingGroup} is not a loading group.`,
      'Leave it blank to have the row answer for every material, or name the group in up to four capital letters or digits.',
    );
  }
  if (!POINT.test(point)) {
    throw new ShippingPointMaintenanceError(
      `Shipping point ${input.shippingPoint} is not a shipping point code.`,
      `Name a shipping point that stands at ${SHIPPING_POINT_ROUTE}.`,
    );
  }
  return withTenant(input.client, async (tx) => {
    const [site] = await tx.select().from(plant).where(and(
      eq(plant.client, input.client), eq(plant.plant, deliveringPlant),
    )).limit(1);
    if (!site) {
      throw new ShippingPointMaintenanceError(
        `Plant ${deliveringPlant} does not stand for this tenant.`,
        'Assign a shipping point to a plant that stands; a row naming a plant nobody has cannot answer a delivery.',
      );
    }
    const [standing] = await tx.select().from(shippingPoint).where(and(
      eq(shippingPoint.client, input.client), eq(shippingPoint.shippingPoint, point),
    )).limit(1);
    if (!standing) {
      throw new ShippingPointMaintenanceError(
        `Shipping point ${point} does not stand for this tenant.`,
        `Define it at ${SHIPPING_POINT_ROUTE} before assigning it to a plant.`,
      );
    }
    if (condition) {
      const [conditionRow] = await tx.select().from(shippingCondition).where(and(
        eq(shippingCondition.client, input.client), eq(shippingCondition.shippingCondition, condition),
      )).limit(1);
      if (!conditionRow) {
        throw new ShippingPointMaintenanceError(
          `Shipping condition ${condition} does not stand for this tenant.`,
          `Define it at ${SHIPPING_POINT_ROUTE} before maintaining a row for it, or leave the condition blank.`,
        );
      }
    }
    const inserted = await tx.insert(shippingPointDetermination).values({
      client: input.client, deliveringPlant, shippingCondition: condition, loadingGroup: group,
      shippingPoint: point, isActive: true, createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ shippingPoint: shippingPointDetermination.shippingPoint });
    if (inserted.length === 0) {
      throw new ShippingPointMaintenanceError(
        `A shipping point already stands for plant ${deliveringPlant} with shipping condition ${condition || 'any'} and loading group ${group || 'any'}.`,
        `Two rows cannot answer for one combination: the engine would have to choose, and a dock nobody can name the rule for is not a dock. Change the standing row at ${SHIPPING_POINT_ROUTE}.`,
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: SHIPPING_POINT_DETERMINATION_OBJECT_CLASS,
      objectKey: `${deliveringPlant}/${condition || '*'}/${group || '*'}`,
      changeType: 'CREATE', changedBy: input.changedBy, after: { shippingPoint: point },
      securityRelevantFields: ['shippingPoint'],
    });
  });
}

/** Withdraw an assignment, or restore one. */
export async function changeShippingPointAssignmentStatus(input: {
  client: string; changedBy: string; deliveringPlant: string;
  shippingCondition: string; loadingGroup: string; isActive: boolean;
}): Promise<void> {
  const where = and(
    eq(shippingPointDetermination.client, input.client),
    eq(shippingPointDetermination.deliveringPlant, input.deliveringPlant),
    eq(shippingPointDetermination.shippingCondition, input.shippingCondition),
    eq(shippingPointDetermination.loadingGroup, input.loadingGroup),
  );
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(shippingPointDetermination).where(where).limit(1);
    if (!standing) {
      throw new ShippingPointMaintenanceError(
        'No shipping point is assigned to that plant for that condition and loading group, so there is nothing to change.',
        `Assign one at ${SHIPPING_POINT_ROUTE} first.`,
      );
    }
    await tx.update(shippingPointDetermination)
      .set({ isActive: input.isActive, changedBy: input.changedBy, changedAt: new Date() })
      .where(where);
    await recordChange(tx, {
      client: input.client, objectClass: SHIPPING_POINT_DETERMINATION_OBJECT_CLASS,
      objectKey: `${input.deliveringPlant}/${input.shippingCondition || '*'}/${input.loadingGroup || '*'}`,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { isActive: standing.isActive }, after: { isActive: input.isActive },
      securityRelevantFields: ['isActive'],
    });
  });
}
