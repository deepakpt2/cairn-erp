/**
 * Reservations — SCR-133 / MB21.
 *
 * A reservation is a demand nobody has posted yet: a planned withdrawal of one
 * material from one plant on a required date, charged to the account assignment
 * its movement type demands. It reserves nothing physically — it becomes real the
 * moment a goods issue withdraws against it, and until then it is the element
 * MD04 answers with.
 *
 * The movement type is tenant data (the T156 shape) and carries the account
 * assignment the withdrawal will post to. A reservation that cannot say what it
 * charges is refused before it is written.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { getCompanyCode } from '../../platform/periods';
import { costCenter, plant as plantTable, storageLocation } from '../foundation/schema';
import { material, materialPlant, movementType, reservationHeader, reservationItem } from './schema';

export const RESERVATION_CREATE_CAPABILITY = 'INV.RESERVATION.CREATE';
const RESERVATION_CLASS = 'reservation';

export class ReservationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ReservationError';
    this.remedy = remedy;
  }
}

export interface ReservationScenario {
  /** The three-digit movement type the user enters — an input alias, never a stored code. */
  code: string;
  movementType: string;
  description: string;
  accountAssignment: 'COST_CENTER' | 'ORDER';
}

/** The two reservation movements this canon can name, delivered per tenant. */
export const RESERVATION_SCENARIOS: readonly ReservationScenario[] = [
  {
    code: '201', movementType: 'RESERV_ISSUE_CC',
    description: 'Goods issue for a cost centre', accountAssignment: 'COST_CENTER',
  },
  {
    code: '261', movementType: 'RESERV_ISSUE_ORDER',
    description: 'Goods issue for an order', accountAssignment: 'ORDER',
  },
] as const;

export const DELIVERED_RESERVATION_MOVEMENTS = RESERVATION_SCENARIOS.map((s) => ({
  movementType: s.movementType,
  description: `${s.description} (${s.code})`,
  direction: 'ISSUE',
  referenceCategory: 'RESERVATION',
  accountAssignment: s.accountAssignment,
}));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function ensureMovements(tx: Tx, client: string, changedBy: string) {
  for (const m of DELIVERED_RESERVATION_MOVEMENTS) {
    await tx.insert(movementType).values({ client, ...m, createdBy: changedBy }).onConflictDoNothing();
  }
}

function resolveScenario(code: string): ReservationScenario {
  const found = RESERVATION_SCENARIOS.find((s) => s.code === code);
  if (found) return found;
  throw new ReservationError(
    `Movement type ${code || '(empty)'} is not a reservation movement.`,
    'Reservations stand on 201 (goods issue for a cost centre) or 261 (goods issue for an order).',
  );
}

export interface ReservationItemView {
  itemNumber: number;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  requiredQuantity: string;
  withdrawnQuantity: string;
  openQuantity: string;
  unit: string;
  movementAllowed: boolean;
  isCompleted: boolean;
}

export interface ReservationView {
  reservationNumber: string;
  movementType: string;
  movementCode: string | null;
  baseDate: string;
  costCenter: string | null;
  orderNumber: string | null;
  accountAssignment: string;
  createdAt: string;
  /** True when at least one item still stands open and may be withdrawn. */
  hasOpenItems: boolean;
  items: ReservationItemView[];
}

async function toView(tx: Tx, client: string, header: typeof reservationHeader.$inferSelect): Promise<ReservationView> {
  const items = await tx.select().from(reservationItem).where(and(
    eq(reservationItem.client, client),
    eq(reservationItem.reservationNumber, header.reservationNumber),
  )).orderBy(reservationItem.itemNumber);
  const [movement] = await tx.select().from(movementType).where(and(
    eq(movementType.client, client), eq(movementType.movementType, header.movementType),
  ));
  const scenario = RESERVATION_SCENARIOS.find((s) => s.movementType === header.movementType);
  return {
    reservationNumber: header.reservationNumber,
    movementType: header.movementType,
    movementCode: scenario?.code ?? null,
    baseDate: header.baseDate,
    costCenter: header.costCenter,
    orderNumber: header.orderNumber,
    accountAssignment: movement?.accountAssignment ?? 'NONE',
    createdAt: header.createdAt.toISOString(),
    hasOpenItems: items.some((i) => !i.isCompleted),
    items: items.map((i) => {
      const open = Math.max(0, Number(i.requiredQuantity) - Number(i.withdrawnQuantity));
      return {
        itemNumber: i.itemNumber,
        materialNumber: i.materialNumber,
        plant: i.plant,
        storageLocation: i.storageLocation,
        requiredQuantity: i.requiredQuantity,
        withdrawnQuantity: i.withdrawnQuantity,
        openQuantity: open.toFixed(3),
        unit: i.unitOfMeasure,
        movementAllowed: i.movementAllowed,
        isCompleted: i.isCompleted,
      };
    }),
  };
}

export async function getReservation(client: string, number: string): Promise<ReservationView | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(reservationHeader).where(and(
      eq(reservationHeader.client, client), eq(reservationHeader.reservationNumber, number),
    ));
    if (!header) return null;
    return toView(tx, client, header);
  });
}

export interface CreateReservationItemInput {
  materialNumber: string;
  plant: string;
  requiredQuantity: number;
  storageLocation?: string;
  movementAllowed?: boolean;
}

export interface CreateReservationInput {
  client: string;
  changedBy: string;
  movementTypeCode: string;
  baseDate: string;
  costCenter?: string;
  orderNumber?: string;
  items: CreateReservationItemInput[];
  requestKey: string;
}

async function existingByRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(reservationHeader).where(and(
    eq(reservationHeader.client, client), eq(reservationHeader.requestKey, requestKey),
  ));
  if (!header) return null;
  return toView(tx, client, header);
}

export async function createReservation(input: CreateReservationInput): Promise<ReservationView> {
  if (!ISO_DATE.test(input.baseDate) || Number.isNaN(Date.parse(input.baseDate))) {
    throw new ReservationError(
      `The required date ${input.baseDate || '(empty)'} is not a date.`,
      'Enter the date as YYYY-MM-DD.',
    );
  }
  const scenario = resolveScenario(input.movementTypeCode);
  if (scenario.accountAssignment === 'ORDER') {
    throw new ReservationError(
      `Movement type ${scenario.code} reserves for an order, and this canon carries no order master.`,
      'Production orders are a roadmap capability (PROD.ORDER.CREATE); reserve on 201 against a cost centre until orders exist.',
    );
  }
  if (input.items.length === 0) {
    throw new ReservationError('A reservation needs at least one item.', 'Enter the material and quantity to reserve.');
  }
  const centre = (input.costCenter ?? '').trim();
  if (scenario.accountAssignment === 'COST_CENTER' && !centre) {
    throw new ReservationError(
      `Movement type ${scenario.code} charges a cost centre, and none was named.`,
      'Enter the cost centre that will bear the withdrawal.',
    );
  }

  return withTenant(input.client, async (tx) => {
    const replay = await existingByRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;

    await ensureMovements(tx, input.client, input.changedBy);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/reservation`}, 0))`);

    // Every item is judged before anything is written.
    const prepared: Array<{
      materialNumber: string; plant: string; storageLocation: string | null;
      requiredQuantity: number; unit: string; movementAllowed: boolean;
    }> = [];
    const companies = new Set<string>();
    for (const [index, item] of input.items.entries()) {
      const position = index + 1;
      const materialNumber = item.materialNumber.trim();
      if (!materialNumber) {
        throw new ReservationError(`Item ${position} needs a material.`, 'Enter the material being reserved.');
      }
      if (!(item.requiredQuantity > 0)) {
        throw new ReservationError(
          `Item ${position} requires a positive quantity.`,
          'Enter a quantity greater than zero.',
        );
      }
      const [mat] = await tx.select().from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, materialNumber),
      ));
      if (!mat) throw new ReservationError(`Material ${materialNumber} does not exist.`);
      if (mat.markedForDeletion) {
        throw new ReservationError(
          `Material ${materialNumber} is flagged for deletion.`,
          'Cancel the deletion flag, then reserve it.',
        );
      }
      const [plantRow] = await tx.select().from(plantTable).where(and(
        eq(plantTable.client, input.client), eq(plantTable.plant, item.plant),
      ));
      if (!plantRow) throw new ReservationError(`Plant ${item.plant} does not exist.`);
      if (!plantRow.companyCode) {
        throw new ReservationError(
          `Plant ${item.plant} carries no company code.`,
          'Assign the plant to a company code, then reserve.',
        );
      }
      companies.add(plantRow.companyCode);
      const [ext] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, materialNumber),
        eq(materialPlant.plant, item.plant),
      ));
      if (!ext) {
        throw new ReservationError(
          `Material ${materialNumber} is not extended to plant ${item.plant}.`,
          `Extend the material to plant ${item.plant}, then reserve it.`,
        );
      }
      if (ext.markedForDeletion) {
        throw new ReservationError(
          `Material ${materialNumber} is flagged for deletion in plant ${item.plant}.`,
          'Cancel the plant deletion flag, then reserve it.',
        );
      }
      let location: string | null = null;
      if (item.storageLocation) {
        const [row] = await tx.select().from(storageLocation).where(and(
          eq(storageLocation.client, input.client),
          eq(storageLocation.plant, item.plant),
          eq(storageLocation.storageLocation, item.storageLocation),
        ));
        if (!row) {
          throw new ReservationError(
            `Storage location ${item.storageLocation} does not stand in plant ${item.plant}.`,
            `Enter a storage location that belongs to plant ${item.plant}, or leave it empty.`,
          );
        }
        if (!row.isActive) {
          throw new ReservationError(
            `Storage location ${item.storageLocation} in plant ${item.plant} is blocked.`,
            'Choose an active storage location, or leave it empty.',
          );
        }
        location = row.storageLocation;
      }
      if (!mat.baseUnit) {
        throw new ReservationError(
          `Material ${materialNumber} carries no base unit.`,
          'Complete the material master, then reserve it.',
        );
      }
      prepared.push({
        materialNumber, plant: item.plant, storageLocation: location,
        requiredQuantity: item.requiredQuantity, unit: mat.baseUnit,
        movementAllowed: item.movementAllowed !== false,
      });
    }

    // One controlling area governs the cost centre: every plant must stand in the same company code.
    if (companies.size > 1) {
      throw new ReservationError(
        `The items name plants in ${companies.size} company codes (${[...companies].join(', ')}).`,
        'A reservation charges one cost centre, so its plants must share a company code.',
      );
    }
    const companyCode = [...companies][0]!;
    const company = await getCompanyCode(tx, input.client, companyCode);
    if (!company) throw new ReservationError(`Company code ${companyCode} is not configured.`);
    if (centre) {
      const rows = await tx.select().from(costCenter).where(and(
        eq(costCenter.client, input.client),
        eq(costCenter.companyCode, companyCode),
        eq(costCenter.costCenter, centre),
      ));
      if (rows.length === 0) {
        throw new ReservationError(
          `Cost centre ${centre} does not stand in company code ${companyCode}.`,
          'Create the cost centre in its controlling area, then reserve.',
        );
      }
      const valid = rows.some((r) => r.validFrom <= input.baseDate && (!r.validTo || r.validTo >= input.baseDate));
      if (!valid) {
        throw new ReservationError(
          `Cost centre ${centre} is not valid on ${input.baseDate}.`,
          'Choose a cost centre valid on the required date, or change the date.',
        );
      }
      if (rows.some((r) => r.isPostingLocked)) {
        throw new ReservationError(
          `Cost centre ${centre} is locked for postings.`,
          'Release the posting lock, or charge another cost centre.',
        );
      }
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'RESERV', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    await tx.insert(reservationHeader).values({
      client: input.client,
      reservationNumber: number,
      movementType: scenario.movementType,
      baseDate: input.baseDate,
      costCenter: centre || null,
      controllingArea: centre ? (await tx.select().from(costCenter).where(and(
        eq(costCenter.client, input.client),
        eq(costCenter.companyCode, companyCode),
        eq(costCenter.costCenter, centre),
      )))[0]!.controllingArea : null,
      orderNumber: input.orderNumber ?? null,
      requestKey: input.requestKey,
      createdBy: input.changedBy,
    });

    for (const [index, item] of prepared.entries()) {
      await tx.insert(reservationItem).values({
        client: input.client,
        reservationNumber: number,
        itemNumber: (index + 1) * 10,
        materialNumber: item.materialNumber,
        plant: item.plant,
        storageLocation: item.storageLocation,
        requiredQuantity: String(item.requiredQuantity),
        withdrawnQuantity: '0',
        unitOfMeasure: item.unit,
        movementAllowed: item.movementAllowed,
        isCompleted: false,
        createdBy: input.changedBy,
      });
    }

    await recordChange(tx, {
      client: input.client,
      objectClass: RESERVATION_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: RESERVATION_CREATE_CAPABILITY,
      after: {
        movement: scenario.movementType, baseDate: input.baseDate,
        costCentre: centre || null, items: prepared.length,
      },
    });

    return (await existingByRequestKey(tx, input.client, input.requestKey))!;
  });
}

export interface WithdrawReservationInput {
  client: string;
  changedBy: string;
  reservationNumber: string;
  itemNumber: number;
  quantity: number;
}

/**
 * The withdrawal hook a goods issue calls: it records that stock has left against
 * the reservation, and completes the item when the required quantity is reached.
 * It posts nothing itself — the issue document is the posting, and MB1A/MIGO does
 * not exist in this canon yet.
 */
export async function withdrawReservation(input: WithdrawReservationInput): Promise<ReservationView> {
  if (!(input.quantity > 0)) {
    throw new ReservationError('The withdrawal quantity must be positive.', 'Enter a quantity greater than zero.');
  }
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/reservation/${input.reservationNumber}`}, 0))`);
    const [header] = await tx.select().from(reservationHeader).where(and(
      eq(reservationHeader.client, input.client),
      eq(reservationHeader.reservationNumber, input.reservationNumber),
    ));
    if (!header) throw new ReservationError(`Reservation ${input.reservationNumber} does not exist.`);
    const [item] = await tx.select().from(reservationItem).where(and(
      eq(reservationItem.client, input.client),
      eq(reservationItem.reservationNumber, input.reservationNumber),
      eq(reservationItem.itemNumber, input.itemNumber),
    ));
    if (!item) {
      throw new ReservationError(
        `Item ${input.itemNumber} does not stand on reservation ${input.reservationNumber}.`,
      );
    }
    if (item.isCompleted) {
      throw new ReservationError(
        `Item ${input.itemNumber} of reservation ${input.reservationNumber} is already completed.`,
        'A completed item takes no further withdrawals.',
      );
    }
    if (!item.movementAllowed) {
      throw new ReservationError(
        `Item ${input.itemNumber} does not allow movements.`,
        'Turn the movement-allowed indicator on before withdrawing.',
      );
    }
    const open = Number(item.requiredQuantity) - Number(item.withdrawnQuantity);
    if (input.quantity > open + 1e-9) {
      throw new ReservationError(
        `Withdrawal of ${input.quantity.toFixed(3)} exceeds the ${open.toFixed(3)} still open on item ${input.itemNumber}.`,
        'Withdraw no more than the reservation still holds.',
      );
    }
    const withdrawn = Number(item.withdrawnQuantity) + input.quantity;
    const completed = withdrawn + 1e-9 >= Number(item.requiredQuantity);
    await tx.update(reservationItem).set({
      withdrawnQuantity: String(withdrawn),
      isCompleted: completed,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(reservationItem.client, input.client),
      eq(reservationItem.reservationNumber, input.reservationNumber),
      eq(reservationItem.itemNumber, input.itemNumber),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: RESERVATION_CLASS,
      objectKey: input.reservationNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: RESERVATION_CREATE_CAPABILITY,
      before: { item: input.itemNumber, withdrawn: item.withdrawnQuantity, completed: item.isCompleted },
      after: { item: input.itemNumber, withdrawn: String(withdrawn), completed },
      reason: 'Withdrawal against the reservation',
    });
    return (await toView(tx, input.client, header));
  });
}

/** Completing an item by hand stops it being a demand at once. */
export async function completeReservationItem(input: {
  client: string;
  changedBy: string;
  reservationNumber: string;
  itemNumber: number;
}): Promise<ReservationView> {
  return withTenant(input.client, async (tx) => {
    const [header] = await tx.select().from(reservationHeader).where(and(
      eq(reservationHeader.client, input.client),
      eq(reservationHeader.reservationNumber, input.reservationNumber),
    ));
    if (!header) throw new ReservationError(`Reservation ${input.reservationNumber} does not exist.`);
    const [item] = await tx.select().from(reservationItem).where(and(
      eq(reservationItem.client, input.client),
      eq(reservationItem.reservationNumber, input.reservationNumber),
      eq(reservationItem.itemNumber, input.itemNumber),
    ));
    if (!item) {
      throw new ReservationError(`Item ${input.itemNumber} does not stand on reservation ${input.reservationNumber}.`);
    }
    if (item.isCompleted) return toView(tx, input.client, header);
    await tx.update(reservationItem).set({
      isCompleted: true, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(reservationItem.client, input.client),
      eq(reservationItem.reservationNumber, input.reservationNumber),
      eq(reservationItem.itemNumber, input.itemNumber),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: RESERVATION_CLASS,
      objectKey: input.reservationNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: RESERVATION_CREATE_CAPABILITY,
      before: { item: input.itemNumber, completed: false },
      after: { item: input.itemNumber, completed: true },
      reason: 'Item completed by hand',
    });
    return toView(tx, input.client, header);
  });
}
