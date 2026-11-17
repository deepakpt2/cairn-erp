/**
 * Unit conversion — SCR-144 / INV.STOCK.UOM.
 *
 * Everything in canon stored `entry_quantity = base_quantity` and the entry unit was
 * decorative. A conversion is an exact ratio, not a float multiplier, so a CASE of 12 is
 * twelve base units on every machine and in every currency.
 */
import { and, eq, inArray } from 'drizzle-orm';

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

/**
 * Convert a quantity between two units of the same dimension, through the
 * dimension's base unit.
 *
 * It is the global unit master. Material-specific alternative units are a different
 * thing and live in uom_conversion (MARM / SCR-144); do not reach for them here, and
 * do not make this material-aware.
 *
 * The factors are seeded constants. There is no service, action or screen that writes
 * numerator / denominator / exponent after the migration, by design — one hour is sixty
 * minutes in every tenant. Do not go looking for a maintenance screen.
 *
 * A non-base unit still at 1/1/0 has never been seeded; it refuses rather than being
 * added to its dimension as if it were the base unit.
 */
export async function convertUnits(
  tx: Tx,
  input: { quantity: number; fromUnit: string; toUnit: string },
): Promise<{ quantity: number; unit: string }> {
  const fromCode = (input.fromUnit ?? '').trim();
  const toCode = (input.toUnit ?? '').trim();
  if (!fromCode || !toCode) {
    throw new UnitConversionError('UNIT_NOT_FOUND: a conversion needs both a source and a target unit.', 'State both units.');
  }
  const rows = await tx.select().from(unitOfMeasure).where(inArray(unitOfMeasure.code, [fromCode, toCode]));
  const from = rows.find((r) => r.code === fromCode);
  const to = rows.find((r) => r.code === toCode);
  for (const [code, row] of [[fromCode, from], [toCode, to]] as const) {
    if (!row) {
      throw new UnitConversionError(
        `UNIT_NOT_FOUND: \`${code}\` is not a unit of measure.`,
        'Maintain the unit, or convert it before it reaches here.',
      );
    }
  }
  if (fromCode === toCode) return { quantity: input.quantity, unit: toCode };
  if (from!.dimension !== to!.dimension) {
    throw new UnitConversionError(
      `UNIT_DIMENSION_MISMATCH: \`${fromCode}\` (${from!.dimension}) and \`${toCode}\` (${to!.dimension}) do not convert.`,
      'Use two units of the same dimension.',
    );
  }
  const [base] = await tx.select({ code: unitOfMeasure.code }).from(unitOfMeasure)
    .where(and(eq(unitOfMeasure.dimension, from!.dimension), eq(unitOfMeasure.isBaseUnit, true)));
  if (!base) {
    throw new UnitConversionError(
      `UNIT_NO_BASE: \`${from!.dimension}\` has no base unit, so nothing in it can be converted.`,
      'Mark one unit of the dimension as its base unit.',
    );
  }
  for (const u of [from!, to!]) {
    if (u.code !== base.code && u.numerator === 1 && u.denominator === 1 && u.exponent === 0) {
      throw new UnitConversionError(
        `UNIT_FACTOR_MISSING: \`${u.code}\` carries no conversion factor.`,
        `Seed a factor from \`${u.code}\` to \`${base.code}\`, or convert it before it reaches here.`,
      );
    }
  }
  const baseValue = (input.quantity * from!.numerator * 10 ** from!.exponent) / from!.denominator;
  const result = (baseValue * to!.denominator) / (to!.numerator * 10 ** to!.exponent);
  return { quantity: roundTo(result, to!.decimalPlaces), unit: toCode };
}
