/**
 * Unit conversion — SCR-144 / INV.STOCK.UOM.
 *
 * Everything in canon stored `entry_quantity = base_quantity` and the entry unit was
 * decorative. A conversion is an exact ratio, not a float multiplier, so a CASE of 12 is
 * twelve base units on every machine and in every currency.
 */
import { and, eq } from 'drizzle-orm';

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
  const entryUnit = (input.entryUnit ?? '').trim() || baseUnit;

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
