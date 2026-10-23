/**
 * Storage location for a stock movement.
 *
 * A typed location is judged as itself and is never replaced by a default.
 * A blank line takes the document's own location (the order item, the
 * reservation item, the component, or the receipt being returned), and only
 * then the plant's default. Either default must be an active location of
 * that plant. A quantity-updating movement with none of those is refused.
 * A whole-plant count and a non-stock material may still omit one.
 */
import { and, eq } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { plant, storageLocation } from '../foundation/schema';
import { material, materialTypeValuation } from './schema';

export class StorageLocationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'StorageLocationError';
    this.remedy = remedy;
  }
}

export interface ResolveStorageLocationInput {
  client: string;
  plant: string;
  /** What was typed. A non-blank value is never replaced. */
  typed?: string | null;
  /** Order item, reservation item, component, or the original receipt line. Used only when typed is blank. */
  documentDefault?: string | null;
  /**
   * Fill a still-blank line from the plant default. A transfer names both
   * sides, so it does not take the default.
   */
  applyPlantDefault?: boolean;
  /** Quantity-updating stock requires a location. A count of the whole plant does not. */
  required: boolean;
  /** Remedy verb, such as "Receive into" or "Issue from". */
  verb?: string;
}

export interface ResolvedStorageLocation {
  /** Empty only when a location is not required and none was resolved. */
  storageLocation: string;
  row: typeof storageLocation.$inferSelect | null;
}

function blank(value: string | null | undefined): string {
  return (value ?? '').trim();
}

async function assignedLocation(tx: Tx, client: string, plantCode: string, code: string) {
  const [row] = await tx.select().from(storageLocation).where(and(
    eq(storageLocation.client, client),
    eq(storageLocation.plant, plantCode),
    eq(storageLocation.storageLocation, code),
  ));
  return row ?? null;
}

function judge(
  row: typeof storageLocation.$inferSelect | null,
  code: string,
  plantCode: string,
  verb: string,
  asDefault: boolean,
): typeof storageLocation.$inferSelect {
  const what = asDefault ? `Plant ${plantCode} default storage location ${code}` : `Storage location ${code}`;
  if (!row) {
    throw new StorageLocationError(
      asDefault
        ? `${what} does not stand in plant ${plantCode}.`
        : `Storage location ${code} does not stand in plant ${plantCode}.`,
      `${verb} a storage location that belongs to plant ${plantCode}.`,
    );
  }
  if (!row.isActive) {
    throw new StorageLocationError(
      asDefault
        ? `${what} is blocked for postings.`
        : `Storage location ${code} in plant ${plantCode} is blocked for postings.`,
      `${verb} an active storage location.`,
    );
  }
  return row;
}

/**
 * Whether a movement of this material in this plant must name a storage location.
 * No updating row means stock is updated, which is the column default.
 */
export async function storageLocationRequired(
  tx: Tx, client: string, materialNumber: string, plantCode: string,
): Promise<boolean> {
  const [mat] = await tx.select({ materialType: material.materialType }).from(material).where(and(
    eq(material.client, client),
    eq(material.materialNumber, materialNumber),
  ));
  if (!mat) return true;
  const [updating] = await tx.select({ quantityUpdating: materialTypeValuation.quantityUpdating })
    .from(materialTypeValuation)
    .where(and(
      eq(materialTypeValuation.client, client),
      eq(materialTypeValuation.materialType, mat.materialType),
      eq(materialTypeValuation.valuationArea, plantCode),
    ));
  return updating?.quantityUpdating ?? true;
}

/** The location a blank line would propose, without judging it. Display only. */
export async function proposeStorageLocation(
  tx: Tx, client: string, plantCode: string, documentDefault?: string | null,
): Promise<string | null> {
  const named = blank(documentDefault);
  if (named) return named;
  const [site] = await tx.select({ defaultStorageLocation: plant.defaultStorageLocation }).from(plant).where(and(
    eq(plant.client, client),
    eq(plant.plant, plantCode),
  ));
  const fallback = blank(site?.defaultStorageLocation);
  return fallback || null;
}

export async function resolveStorageLocation(
  tx: Tx, input: ResolveStorageLocationInput,
): Promise<ResolvedStorageLocation> {
  const plantCode = input.plant.trim();
  const verb = input.verb ?? 'Use';
  const typed = blank(input.typed);
  if (typed) {
    const row = judge(await assignedLocation(tx, input.client, plantCode, typed), typed, plantCode, verb, false);
    return { storageLocation: row.storageLocation, row };
  }

  const fromDocument = blank(input.documentDefault);
  if (fromDocument) {
    const row = judge(
      await assignedLocation(tx, input.client, plantCode, fromDocument),
      fromDocument, plantCode, verb, false,
    );
    return { storageLocation: row.storageLocation, row };
  }

  if (input.applyPlantDefault) {
    const [site] = await tx.select({ defaultStorageLocation: plant.defaultStorageLocation }).from(plant).where(and(
      eq(plant.client, input.client),
      eq(plant.plant, plantCode),
    ));
    if (!site) {
      throw new StorageLocationError(
        `Plant ${plantCode} does not exist.`,
        'Post in a plant the tenant carries.',
      );
    }
    const fallback = blank(site.defaultStorageLocation);
    if (fallback) {
      const row = judge(
        await assignedLocation(tx, input.client, plantCode, fallback),
        fallback, plantCode, verb, true,
      );
      return { storageLocation: row.storageLocation, row };
    }
  }

  if (input.required) {
    throw new StorageLocationError(
      `A storage location is required in plant ${plantCode}.`,
      `Name a storage location of plant ${plantCode}, or set that plant's default storage location.`,
    );
  }
  return { storageLocation: '', row: null };
}
