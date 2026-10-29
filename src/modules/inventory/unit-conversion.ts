/**
 * Unit conversion — SCR-144 / INV.STOCK.UOM.
 *
 * Everything in canon stored `entry_quantity = base_quantity` and the entry unit was
 * decorative. A conversion is an exact ratio, not a float multiplier, so a CASE of 12 is
 * twelve base units on every machine and in every currency.
 */
import { and, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { unitOfMeasure } from '../../platform/tables/reference';
import { materialUomConversion, material } from './schema';

export const UOM_CAPABILITY = 'INV.STOCK.UOM';

export class UnitConversionError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'UnitConversionError';
    this.remedy = remedy;
  }
}

/** The decimals of a unit, so rounding is the unit's rule rather than a constant. */
async function decimalsOf(tx: Tx, code: string): Promise<number> {
  const [row] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces })
    .from(unitOfMeasure).where(eq(unitOfMeasure.code, code));
  return row?.decimalPlaces ?? 3;
}

export interface Conversion {
  baseQuantity: number;
  baseUnit: string;
  /** The factor actually applied, for display and for the ledger's price-per-unit arithmetic. */
  factor: string;
}

/**
 * Convert an entered quantity to the material's base unit.
 *
 * A movement in the base unit converts at 1:1 and needs no row. Anything else needs a
 * conversion row and is otherwise **refused by name** — a silent 1:1 fallback would mis-post
 * stock, which is the one thing this table exists to prevent.
 */
export async function toBaseQuantity(
  tx: Tx,
  client: string,
  input: { materialNumber: string; quantity: number; entryUnit?: string | null },
): Promise<Conversion> {
  const [master] = await tx.select({ baseUnit: material.baseUnit }).from(material).where(and(
    eq(material.client, client), eq(material.materialNumber, input.materialNumber),
  ));
  if (!master?.baseUnit) {
    throw new UnitConversionError(
      `Material ${input.materialNumber} carries no base unit.`,
      'Maintain the material base unit, then post the movement.',
    );
  }
  const baseUnit = master.baseUnit;
  // Unit codes are uppercase in the catalogue; a form may submit them in any case.
  const entryUnit = (input.entryUnit ?? '').trim().toUpperCase() || baseUnit;

  if (entryUnit === baseUnit) {
    return { baseQuantity: input.quantity, baseUnit, factor: '1/1' };
  }

  const [conversion] = await tx.select().from(materialUomConversion).where(and(
    eq(materialUomConversion.client, client),
    eq(materialUomConversion.materialNumber, input.materialNumber),
    eq(materialUomConversion.alternativeUnit, entryUnit),
  ));
  if (!conversion) {
    throw new UnitConversionError(
      `Material ${input.materialNumber} carries no conversion from ${entryUnit} to its base unit ${baseUnit}.`,
      `Maintain the conversion (${UOM_CAPABILITY}), or post the quantity in ${baseUnit}.`,
    );
  }

  const decimals = await decimalsOf(tx, baseUnit);
  const exact = (input.quantity * conversion.numerator) / conversion.denominator;
  const factor = (conversion.numerator / conversion.denominator).toString();
  return { baseQuantity: roundTo(exact, decimals), baseUnit, factor };
}

/**
 * The reciprocal of `toBaseQuantity`: a quantity held in the material's base unit, spoken in one
 * of its alternative units. The same row gives the way back, because a conversion is an exact
 * ratio and not a rate that drifts — so nothing is re-derived here and nothing is rounded twice
 * through a float. A material with no base unit, or with no rule for the unit asked for, is
 * refused by name exactly as the forward direction refuses.
 */
export async function fromBaseQuantity(
  tx: Tx,
  client: string,
  input: { materialNumber: string; baseQuantity: number; targetUnit: string },
): Promise<number> {
  const [master] = await tx.select({ baseUnit: material.baseUnit }).from(material).where(and(
    eq(material.client, client), eq(material.materialNumber, input.materialNumber),
  ));
  if (!master?.baseUnit) {
    throw new UnitConversionError(
      `Material ${input.materialNumber} carries no base unit.`,
      'Maintain the material base unit, then read the quantity in it.',
    );
  }
  const targetUnit = (input.targetUnit ?? '').trim().toUpperCase();
  if (targetUnit === '' || targetUnit === master.baseUnit) return input.baseQuantity;

  const [conversion] = await tx.select().from(materialUomConversion).where(and(
    eq(materialUomConversion.client, client),
    eq(materialUomConversion.materialNumber, input.materialNumber),
    eq(materialUomConversion.alternativeUnit, targetUnit),
  ));
  if (!conversion) {
    throw new UnitConversionError(
      `Material ${input.materialNumber} carries no conversion between ${targetUnit} and its base unit ${master.baseUnit}.`,
      `Maintain the conversion (${UOM_CAPABILITY}) to state ${input.baseQuantity} ${master.baseUnit} in ${targetUnit}.`,
    );
  }
  const decimals = await decimalsOf(tx, targetUnit);
  return roundTo((input.baseQuantity * conversion.denominator) / conversion.numerator, decimals);
}

export function roundTo(value: number, decimals: number): number {
  const shift = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * shift) / shift;
}

/** Maintain a conversion. One per material and alternative unit — a second is refused. */
export async function defineUomConversion(input: {
  client: string;
  changedBy: string;
  materialNumber: string;
  alternativeUnit: string;
  numerator: number;
  denominator: number;
}): Promise<void> {
  const alternativeUnit = input.alternativeUnit.trim().toUpperCase();
  if (!Number.isInteger(input.numerator) || !Number.isInteger(input.denominator)
    || input.numerator <= 0 || input.denominator <= 0) {
    throw new UnitConversionError(
      'A conversion needs a positive whole numerator and denominator.',
      'Enter whole numbers, for example 12 / 1 for a dozen.',
    );
  }
  await withTenant(input.client, async (tx) => {
    const [master] = await tx.select({ baseUnit: material.baseUnit }).from(material).where(and(
      eq(material.client, input.client), eq(material.materialNumber, input.materialNumber),
    ));
    if (!master?.baseUnit) {
      throw new UnitConversionError(
        `Material ${input.materialNumber} does not exist or carries no base unit.`,
        'Maintain the material first.',
      );
    }
    if (alternativeUnit === master.baseUnit) {
      throw new UnitConversionError(
        `${alternativeUnit} is the base unit of ${input.materialNumber}; a unit cannot convert to itself.`,
        'Name the alternative unit, not the base unit.',
      );
    }
    const [unit] = await tx.select({ code: unitOfMeasure.code }).from(unitOfMeasure)
      .where(eq(unitOfMeasure.code, alternativeUnit));
    if (!unit) {
      throw new UnitConversionError(
        `Unit of measure ${alternativeUnit} does not exist.`,
        'Choose a unit the reference catalogue carries.',
      );
    }
    await tx.insert(materialUomConversion).values({
      client: input.client,
      materialNumber: input.materialNumber,
      alternativeUnit,
      baseUnit: master.baseUnit!,
      numerator: input.numerator,
      denominator: input.denominator,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [
        materialUomConversion.client,
        materialUomConversion.materialNumber,
        materialUomConversion.alternativeUnit,
      ],
      set: {
        numerator: input.numerator,
        denominator: input.denominator,
        changedBy: input.changedBy,
        changedAt: new Date(),
      },
    });
  });
}

export interface UomConversionRow {
  materialNumber: string;
  materialDescription: string;
  baseUnit: string;
  alternativeUnit: string;
  numerator: number;
  denominator: number;
  factor: string;
}

/**
 * The conversions a material carries, for the maintenance screen. Read-only: one select,
 * ordered so a reader sees a material's units together.
 */
export async function listUomConversions(
  client: string,
  filter: { materialNumber?: string } = {},
): Promise<UomConversionRow[]> {
  return withTenant(client, async (tx) => {
    const where = filter.materialNumber
      ? and(eq(materialUomConversion.client, client),
        eq(materialUomConversion.materialNumber, filter.materialNumber))
      : eq(materialUomConversion.client, client);
    const rows = await tx.select({
      materialNumber: materialUomConversion.materialNumber,
      materialDescription: material.description,
      baseUnit: material.baseUnit,
      alternativeUnit: materialUomConversion.alternativeUnit,
      numerator: materialUomConversion.numerator,
      denominator: materialUomConversion.denominator,
    })
      .from(materialUomConversion)
      .innerJoin(material, and(
        eq(material.client, materialUomConversion.client),
        eq(material.materialNumber, materialUomConversion.materialNumber),
      ))
      .where(where)
      .orderBy(materialUomConversion.materialNumber, materialUomConversion.alternativeUnit);

    return rows.map((row) => ({
      materialNumber: row.materialNumber,
      materialDescription: row.materialDescription ?? '',
      baseUnit: row.baseUnit ?? '',
      alternativeUnit: row.alternativeUnit,
      numerator: row.numerator,
      denominator: row.denominator,
      factor: `${row.numerator}/${row.denominator}`,
    }));
  });
}

/** The units the catalogue knows, so the form refuses a typo before the service does. */
export async function listUnitsOfMeasure(client: string): Promise<Array<{ code: string; name: string; decimals: number }>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      code: unitOfMeasure.code, name: unitOfMeasure.name, decimals: unitOfMeasure.decimalPlaces,
    }).from(unitOfMeasure).orderBy(unitOfMeasure.code);
    return rows.map((row) => ({ code: row.code, name: row.name, decimals: row.decimals }));
  });
}

/**
 * Remove one alternative unit. The material then accepts its base unit only, and any posting
 * that names the removed unit is refused by name — which is why this returns what it removed.
 */
export async function removeUomConversion(input: {
  client: string;
  changedBy: string;
  materialNumber: string;
  alternativeUnit: string;
}): Promise<void> {
  const alternativeUnit = input.alternativeUnit.trim().toUpperCase();
  await withTenant(input.client, async (tx) => {
    const removed = await tx.delete(materialUomConversion).where(and(
      eq(materialUomConversion.client, input.client),
      eq(materialUomConversion.materialNumber, input.materialNumber.trim()),
      eq(materialUomConversion.alternativeUnit, alternativeUnit),
    )).returning({ alternativeUnit: materialUomConversion.alternativeUnit });
    if (removed.length === 0) {
      throw new UnitConversionError(
        `Material ${input.materialNumber} carries no conversion from ${alternativeUnit}.`,
        'Reload the list; the conversion may already have been removed.',
      );
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'MATERIAL_UOM_CONVERSION',
      objectKey: `${input.materialNumber.trim()}/${alternativeUnit}`,
      changeType: 'DELETE',
      changedBy: input.changedBy,
      transactionCode: UOM_CAPABILITY,
      before: { alternativeUnit },
    });
  });
}
