/**
 * Serial numbers — §5.5b.
 *
 * A batch is a kind of goods; a serial is one thing. Where batch determination answers "which boxes
 * come off the shelf", a serial answers "which one of these", and it keeps its identity afterwards —
 * which customer holds it, and which one came back.
 *
 * Until now this canon has had no serial-number master at all, and three places said so by name:
 * `transfer-posting.ts` refused a movement requiring serials, `physical-inventory-posting.ts`
 * refused the same, and `material-document-list.ts` answered that a serial number is not on the
 * material document. What stands here is the master they were telling the truth about the absence of.
 *
 * Two things this deliberately is not:
 *
 * **It is not the stock ledger.** A serialised material counted as three with three serial rows
 * standing in the store can disagree, and nothing here reconciles them. Making the serial the unit
 * of stock would mean every goods movement in the system writing a serial row it has no place to be
 * given one — a receipt, a transfer, an inventory difference. That is a larger piece of work than
 * this increment, and it is not faked.
 *
 * **It carries no serial number profile** (SAP OMS1 / MARC-SERNP). The switch a material needs is
 * `material.requires_serial`, which the material master already asks. A profile is a second answer to
 * the same question.
 *
 * A serial that has gone out and come back is put back in stock with nothing written against it,
 * because goods that came back are goods that never went.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type Tx, withTenant } from '../../platform/db/client';
import { deliveryPickingSerial } from '../sales/schema';
import { material, serialNumber } from './schema';
import { SERIAL_STATUSES, type SerialStatus } from './serial-status';

export const SERIAL_ROUTE = '/inventory/serial-numbers';
export const SERIAL_CAPABILITY = 'INV.SERIAL.MAINTAIN';

// The statuses a delivery moves a unit between, and what each of them means, live in their own file
// so a client component can import them without taking the database driver with them.
export { SERIAL_STATUSES, SERIAL_STATUS_MEANING, type SerialStatus } from './serial-status';

export class SerialNumberError extends Error {
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'SerialNumberError';
    this.remedy = remedy;
  }
}

const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().max(max));

export const serialNumberInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  materialNumber: key(40),
  serialNumber: key(40),
  /** Blank puts the unit away in no store: created, and not yet on a shelf. */
  plant: key(10).optional(),
  storageLocation: z.string().trim().max(10).optional(),
  stockType: z.string().trim().max(16).optional(),
  batchNumber: z.string().trim().max(40).optional(),
  status: z.enum(SERIAL_STATUSES).optional(),
  requestKey: z.string().trim().max(64).optional(),
});

export type SerialNumberInput = z.input<typeof serialNumberInput>;

export interface SerialView {
  materialNumber: string;
  serialNumber: string;
  plant: string;
  storageLocation: string;
  stockType: string;
  batchNumber: string;
  status: SerialStatus;
  deliveryNumber: string;
  orderNumber: string;
  customerNumber: string;
}

export interface SerialFilter {
  materialNumber?: string;
  customerNumber?: string;
  deliveryNumber?: string;
  status?: SerialStatus;
  /** What the unit's number begins with, so a clerk can find one they are holding. */
  startsWith?: string;
  limit?: number;
}

function normaliseSerials(values: readonly string[]): string[] {
  return values.map((value) => value.trim().toUpperCase()).filter((value) => value !== '');
}

/**
 * Whether a material is counted in serials at all. Read from the material master, which is the only
 * place the question is asked: there is no serial number profile to consult as well.
 */
export async function requiresSerialFor(
  tx: Tx,
  client: string,
  materialNumbers: readonly string[],
): Promise<Map<string, boolean>> {
  const distinct = [...new Set(materialNumbers.map((value) => value.trim().toUpperCase()))];
  if (distinct.length === 0) return new Map();
  const rows = await tx.select({
    materialNumber: material.materialNumber, serialManaged: material.serialManaged,
  }).from(material).where(and(
    eq(material.client, client), inArray(material.materialNumber, distinct),
  ));
  const found = new Map(rows.map((row) => [row.materialNumber, row.serialManaged]));
  // A material that is not in the master is not counted in serials, and saying so is better than
  // refusing a pick for a material nobody has maintained.
  return new Map(distinct.map((number) => [number, found.get(number) ?? false]));
}

/** Create one serialised unit, or move one that stands. */
export async function saveSerialNumber(input: SerialNumberInput): Promise<SerialView> {
  const parsed = serialNumberInput.parse(input);
  return withTenant(parsed.client, async (tx) => {
    const [existing] = await tx.select().from(serialNumber).where(and(
      eq(serialNumber.client, parsed.client),
      eq(serialNumber.materialNumber, parsed.materialNumber),
      eq(serialNumber.serialNumber, parsed.serialNumber),
    )).limit(1);

    const status = parsed.status ?? existing?.status ?? 'AVAILABLE';
    const plant = (parsed.plant ?? existing?.plant ?? '').trim().toUpperCase();
    if (status !== 'AVAILABLE' && plant === '') {
      throw new SerialNumberError(
        `Serial ${parsed.serialNumber} of ${parsed.materialNumber} is ${status}, and ${status.toLowerCase()} names no plant.`,
        'A unit that is anywhere is in a plant. Either name the plant, or record the unit as AVAILABLE — created, and not yet put away.',
      );
    }
    if (status === 'DELIVERED' && (existing?.deliveryNumber ?? '') === '') {
      throw new SerialNumberError(
        `Serial ${parsed.serialNumber} of ${parsed.materialNumber} cannot be recorded as delivered: no delivery is written against it.`,
        'A unit goes out on a pick, and the pick writes the delivery. Capture the serial on a delivery pick rather than recording it delivered by hand.',
      );
    }

    if (existing) {
      if (parsed.requestKey && existing.requestKey === parsed.requestKey) {
        return toView(existing);
      }
      const [row] = await tx.update(serialNumber).set({
        plant: plant || null,
        storageLocation: (parsed.storageLocation ?? existing.storageLocation ?? '').trim().toUpperCase(),
        stockType: (parsed.stockType ?? existing.stockType ?? 'UNRESTRICTED').trim().toUpperCase(),
        batchNumber: (parsed.batchNumber ?? existing.batchNumber ?? '').trim().toUpperCase(),
        status,
        changedBy: parsed.changedBy,
        changedAt: sql`now()`,
        version: sql`${serialNumber.version} + 1`,
      }).where(and(
        eq(serialNumber.client, parsed.client),
        eq(serialNumber.materialNumber, parsed.materialNumber),
        eq(serialNumber.serialNumber, parsed.serialNumber),
      )).returning();
      return toView(row);
    }

    const [row] = await tx.insert(serialNumber).values({
      client: parsed.client,
      materialNumber: parsed.materialNumber,
      serialNumber: parsed.serialNumber,
      plant: plant || null,
      storageLocation: (parsed.storageLocation ?? '').trim().toUpperCase(),
      stockType: (parsed.stockType ?? 'UNRESTRICTED').trim().toUpperCase(),
      batchNumber: (parsed.batchNumber ?? '').trim().toUpperCase(),
      status,
      createdBy: parsed.changedBy,
      changedBy: parsed.changedBy,
      ...(parsed.requestKey ? { requestKey: parsed.requestKey } : {}),
    }).returning();
    return toView(row);
  });
}

export async function listSerialNumbers(client: string, filter: SerialFilter = {}): Promise<SerialView[]> {
  return withTenant(client, async (tx) => {
    const conditions = [eq(serialNumber.client, client)];
    if (filter.materialNumber) conditions.push(eq(serialNumber.materialNumber, filter.materialNumber.trim().toUpperCase()));
    if (filter.customerNumber) conditions.push(eq(serialNumber.customerNumber, filter.customerNumber.trim().toUpperCase()));
    if (filter.deliveryNumber) conditions.push(eq(serialNumber.deliveryNumber, filter.deliveryNumber.trim().toUpperCase()));
    if (filter.status) conditions.push(eq(serialNumber.status, filter.status));
    if (filter.startsWith) conditions.push(sql`${serialNumber.serialNumber} like ${`${filter.startsWith.trim().toUpperCase()}%`}`);
    const rows = await tx.select().from(serialNumber).where(and(...conditions))
      .orderBy(asc(serialNumber.materialNumber), asc(serialNumber.serialNumber))
      .limit(filter.limit ?? 500);
    return rows.map(toView);
  });
}

export interface CaptureSerialsInput {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant: string;
  deliveryNumber: string;
  orderNumber: string;
  customerNumber: string;
  lineNumber: number;
  pickNumber: number;
  /** Units going out. */
  quantity: number;
  serials: readonly string[];
  storageLocation?: string;
}

/**
 * Put units into a customer's hands, inside the transaction that writes the pick.
 *
 * The count has to be exact. A serialised item is counted in whole units, so naming four for six
 * leaves two unaccounted for, and the only honest answer to "which two" is the one the picker did
 * not give. Nor can a unit be handed over twice: a serial already out is out, and a serial that was
 * scrapped is not in anybody's store.
 */
export async function capturePickSerialsOn(tx: Tx, input: CaptureSerialsInput): Promise<void> {
  const serials = normaliseSerials(input.serials);
  const wanted = Math.round(input.quantity);
  if (serials.length !== wanted) {
    throw new SerialNumberError(
      `${input.materialNumber} is counted in serials, and this pick takes ${wanted} unit${wanted === 1 ? '' : 's'} but names ${serials.length}.`,
      wanted === 1
        ? 'Name the one unit that came off the shelf. A serialised item is counted in whole units, so the pick has to say which.'
        : `Name all ${wanted} units that came off the shelf. Naming some of them leaves the rest unaccounted for, and the books cannot say which.`,
    );
  }
  if (new Set(serials).size !== serials.length) {
    const seen = new Set<string>();
    const repeat = serials.find((value) => seen.has(value) || (seen.add(value), false));
    throw new SerialNumberError(
      `Serial ${repeat} is named twice on this pick.`,
      'One unit goes out once. Name each unit once.',
    );
  }

  const rows = await tx.select().from(serialNumber).where(and(
    eq(serialNumber.client, input.client),
    eq(serialNumber.materialNumber, input.materialNumber),
    inArray(serialNumber.serialNumber, serials),
  ));
  const bySerial = new Map(rows.map((row) => [row.serialNumber, row]));

  for (const value of serials) {
    const row = bySerial.get(value);
    if (!row) {
      throw new SerialNumberError(
        `No serial ${value} is recorded for ${input.materialNumber}.`,
        'Record the unit on the serial master first. A unit nobody has recorded is not a unit this pick can hand over.',
      );
    }
    if ((row.plant ?? '').trim().toUpperCase() !== input.plant.trim().toUpperCase()) {
      throw new SerialNumberError(
        `Serial ${value} of ${input.materialNumber} stands in plant ${row.plant ?? '(none)'}, and this pick is from ${input.plant}.`,
        'Pick a unit that stands in the plant this delivery is issued from, or move the unit first.',
      );
    }
    if (row.status === 'DELIVERED') {
      throw new SerialNumberError(
        `Serial ${value} of ${input.materialNumber} has already gone out on delivery ${row.deliveryNumber}.`,
        'One unit goes out once. If the goods came back, take them back on a correction or a returns delivery first.',
      );
    }
    if (row.status === 'SCRAPPED') {
      throw new SerialNumberError(
        `Serial ${value} of ${input.materialNumber} is scrapped.`,
        'A scrapped unit is not coming back. Pick a unit that stands.',
      );
    }
    if (row.status !== 'IN_STOCK') {
      throw new SerialNumberError(
        `Serial ${value} of ${input.materialNumber} is ${row.status}, and a unit that is not standing in a store cannot be picked.`,
        'Put the unit away in a store first. A unit that has been created and not binned is not on a shelf.',
      );
    }
  }

  for (const value of serials) {
    await tx.update(serialNumber).set({
      status: 'DELIVERED',
      deliveryNumber: input.deliveryNumber,
      orderNumber: input.orderNumber,
      customerNumber: input.customerNumber,
      changedBy: input.changedBy,
      changedAt: sql`now()`,
      version: sql`${serialNumber.version} + 1`,
    }).where(and(
      eq(serialNumber.client, input.client),
      eq(serialNumber.materialNumber, input.materialNumber),
      eq(serialNumber.serialNumber, value),
    ));
    await tx.insert(deliveryPickingSerial).values({
      client: input.client,
      deliveryNumber: input.deliveryNumber,
      lineNumber: input.lineNumber,
      pickNumber: input.pickNumber,
      serialNumber: value,
      materialNumber: input.materialNumber,
      createdBy: input.changedBy,
      changedBy: input.changedBy,
    });
  }
}

export interface ReleaseSerialsInput {
  client: string;
  changedBy: string;
  materialNumber: string;
  deliveryNumber: string;
  lineNumber: number;
  pickNumber: number;
  /** Units coming back, as a positive count; the pick row itself carries the negative. */
  quantity: number;
  serials: readonly string[];
}

/**
 * Take units back, inside the transaction that writes the correction.
 *
 * A correction has to say *which* units are coming back. Putting goods back by number alone would
 * leave the master claiming a customer holds two units it does not hold, and the master is the only
 * place in this canon that can name the customer holding a particular piece of an order. So a
 * correction that names nothing is refused, and the refusal says why.
 */
export async function releasePickSerialsOn(tx: Tx, input: ReleaseSerialsInput): Promise<void> {
  const serials = normaliseSerials(input.serials);
  const wanted = Math.round(Math.abs(input.quantity));
  if (serials.length !== wanted) {
    throw new SerialNumberError(
      `${input.materialNumber} is counted in serials, and this correction takes back ${wanted} unit${wanted === 1 ? '' : 's'} but names ${serials.length}.`,
      wanted === 1
        ? 'Name the one unit that is coming back. The master is the only place that can say which customer holds which unit, so a correction that names none cannot put one back.'
        : `Name all ${wanted} units that are coming back. Putting them back by number alone would leave the master claiming a customer holds units it does not hold.`,
    );
  }

  const rows = await tx.select().from(serialNumber).where(and(
    eq(serialNumber.client, input.client),
    eq(serialNumber.materialNumber, input.materialNumber),
    inArray(serialNumber.serialNumber, serials),
  ));
  const bySerial = new Map(rows.map((row) => [row.serialNumber, row]));

  for (const value of serials) {
    const row = bySerial.get(value);
    if (!row) {
      throw new SerialNumberError(
        `No serial ${value} is recorded for ${input.materialNumber}.`,
        'Name a unit that is recorded. A correction cannot take back a unit that never went out.',
      );
    }
    if (row.status !== 'DELIVERED') {
      throw new SerialNumberError(
        `Serial ${value} of ${input.materialNumber} is ${row.status}, and only a unit that has gone out can come back.`,
        'Name a unit this delivery took out.',
      );
    }
    if (row.deliveryNumber.trim().toUpperCase() !== input.deliveryNumber.trim().toUpperCase()) {
      throw new SerialNumberError(
        `Serial ${value} of ${input.materialNumber} went out on delivery ${row.deliveryNumber}, not on ${input.deliveryNumber}.`,
        'Take the unit back on the delivery that took it out.',
      );
    }
  }

  for (const value of serials) {
    await tx.update(serialNumber).set({
      status: 'IN_STOCK',
      // Goods that came back are goods that never went, so nothing is written against the unit.
      deliveryNumber: '',
      orderNumber: '',
      customerNumber: '',
      changedBy: input.changedBy,
      changedAt: sql`now()`,
      version: sql`${serialNumber.version} + 1`,
    }).where(and(
      eq(serialNumber.client, input.client),
      eq(serialNumber.materialNumber, input.materialNumber),
      eq(serialNumber.serialNumber, value),
    ));
    await tx.insert(deliveryPickingSerial).values({
      client: input.client,
      deliveryNumber: input.deliveryNumber,
      lineNumber: input.lineNumber,
      pickNumber: input.pickNumber,
      serialNumber: value,
      materialNumber: input.materialNumber,
      createdBy: input.changedBy,
      changedBy: input.changedBy,
    });
  }
}

/** What one pick row took, so the pick history can say which units and not merely how many. */
export async function serialsOfPick(
  client: string,
  deliveryNumber: string,
  lineNumber?: number,
): Promise<Array<{ lineNumber: number; pickNumber: number; serialNumber: string }>> {
  return withTenant(client, async (tx) => {
    const conditions = [eq(deliveryPickingSerial.client, client), eq(deliveryPickingSerial.deliveryNumber, deliveryNumber)];
    if (lineNumber !== undefined) conditions.push(eq(deliveryPickingSerial.lineNumber, lineNumber));
    const rows = await tx.select({
      lineNumber: deliveryPickingSerial.lineNumber,
      pickNumber: deliveryPickingSerial.pickNumber,
      serialNumber: deliveryPickingSerial.serialNumber,
    }).from(deliveryPickingSerial).where(and(...conditions))
      .orderBy(asc(deliveryPickingSerial.lineNumber), asc(deliveryPickingSerial.pickNumber), asc(deliveryPickingSerial.serialNumber));
    return rows;
  });
}

function toView(row: typeof serialNumber.$inferSelect): SerialView {
  return {
    materialNumber: row.materialNumber,
    serialNumber: row.serialNumber,
    plant: row.plant ?? '',
    storageLocation: row.storageLocation,
    stockType: row.stockType,
    batchNumber: row.batchNumber,
    status: row.status as SerialStatus,
    deliveryNumber: row.deliveryNumber,
    orderNumber: row.orderNumber,
    customerNumber: row.customerNumber,
  };
}
