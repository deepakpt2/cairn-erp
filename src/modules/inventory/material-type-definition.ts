import { and, count, eq } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { numberRange } from '../../platform/tables/numbering';
import { markActivityComplete } from '../../platform/tenancy';
import { plant } from '../foundation/schema';
import {
  accountCategoryReference,
  material,
  materialPlant,
  materialType,
  materialTypeValuation,
  materialNumberRangeGroup,
  valuationClassReference,
} from './schema';
import { referenceChangeBlock } from './valuation-class-definition';

/**
 * Material type definition (SCR-048 / OMS2; R-96).
 *
 * The material type table stands from the materials build; this is the
 * service that maintains it, at the parity the contract settles: keys of
 * at most four letters or digits, names of at most 25, the price-control
 * default stored as its reference letter and shown as words, both
 * number-range keys judged against the number-range engine (a range
 * standing for object MATERIAL under the key), the account category
 * reference judged against its master, procurement indicators from the
 * 0/1/2 domain, and quantity/value updating on the per-plant rows —
 * guarded, while materials of the type stand at the plant, against
 * being flipped. A type is deleted only while no material carries it.
 * One change document per write, a reason on every write, and the
 * valuation-relevant fields are security-relevant in the trail.
 */

export const ACTIVITY = 'CFG.INV.MATERIALTYPE.DEFINE';

export class MaterialTypeError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'MaterialTypeError';
  }
}

const OBJECT_CLASS = 'material_type';
const PRODUCTION = process.env.NODE_ENV === 'production';

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new MaterialTypeError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new MaterialTypeError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new MaterialTypeError(
      'A reason is required for every material type change.',
      'State why this change is being made.',
    );
  }
  return value;
}

function normaliseKey(value: string, label: string, max: number): string {
  const key = (value ?? '').trim().toUpperCase();
  if (!new RegExp(`^[A-Z0-9]{1,${max}}$`).test(key)) {
    throw new MaterialTypeError(
      `${label} must be one to ${max} uppercase letters or digits.`,
      `Correct the ${label.toLowerCase()} and save again.`,
    );
  }
  return key;
}

function normaliseName(value: string, max: number): string {
  const name = (value ?? '').trim();
  if (!name || name.length > max) {
    throw new MaterialTypeError(
      `The description is required and may be at most ${max} characters.`,
      'Enter a description within the limit and save again.',
    );
  }
  return name;
}

async function judgeNumberRange(
  tx: Tx,
  client: string,
  key: string | null,
  external: boolean,
  label: string,
): Promise<string | null> {
  if (!key) {
    throw new MaterialTypeError(
      `The ${label} number range key is required.`,
      'Enter the two-character range key; the range itself is defined on the number ranges screen.',
    );
  }
  const rangeKey = normaliseKey(key, `${label} number range`, 2);
  if (rangeKey.length !== 2) {
    throw new MaterialTypeError(
      `The ${label} number range key is exactly two characters.`,
      'Correct the key and save again.',
    );
  }
  const [range] = await tx
    .select({ isExternal: numberRange.isExternal, status: numberRange.status })
    .from(numberRange)
    .where(
      and(
        eq(numberRange.client, client),
        eq(numberRange.objectCode, 'MATERIALNR'),
        eq(numberRange.subObject, rangeKey),
      ),
    );
  if (!range || range.status !== 'ACTIVE' || range.isExternal !== external) {
    throw new MaterialTypeError(
      `No ${external ? 'external' : 'internal'} material number range ${rangeKey} stands.`,
      `Define an ${external ? 'external' : 'internal'} number range for object MATERIAL under key ${rangeKey} on the number ranges screen, then save again.`,
    );
  }
  return rangeKey;
}

// ── Reads ────────────────────────────────────────────────────────────────

export interface MaterialTypeRow {
  materialType: string;
  name: string;
  defaultProcurementType: string;
  defaultPriceControl: string;
  internalNumberRange: string | null;
  externalNumberRange: string | null;
  /** The MMNR group text when the type's key pair stands as a group (SCR-051). */
  rangeGroup: string | null;
  accountCategoryReference: string;
  externalPurchaseOrders: string;
  internalPurchaseOrders: string;
  isConfigurable: boolean;
  isActive: boolean;
  materialCount: number;
}

export async function listMaterialTypes(client: string): Promise<MaterialTypeRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const types = await tx
      .select()
      .from(materialType)
      .where(eq(materialType.client, tenant))
      .orderBy(materialType.materialType);
    const groupRows = await tx
      .select()
      .from(materialNumberRangeGroup)
      .where(eq(materialNumberRangeGroup.client, tenant));
    const out: MaterialTypeRow[] = [];
    for (const t of types) {
      const [row] = await tx
        .select({ n: count() })
        .from(material)
        .where(and(eq(material.client, tenant), eq(material.materialType, t.materialType)));
      const group = groupRows.find(
        (g) =>
          g.internalRangeKey === t.internalNumberRange &&
          g.externalRangeKey === t.externalNumberRange,
      );
      out.push({ ...t, rangeGroup: group?.description ?? null, materialCount: Number(row?.n ?? 0) });
    }
    return out;
  });
}

export interface AccountCategoryReferenceRow {
  reference: string;
  name: string;
  isActive: boolean;
  typeCount: number;
}

export async function listAccountCategoryReferences(
  client: string,
): Promise<AccountCategoryReferenceRow[]> {
  const tenant = requireClient(client);
  const rows = await withTenant(tenant, (tx) =>
    tx
      .select()
      .from(accountCategoryReference)
      .where(eq(accountCategoryReference.client, tenant))
      .orderBy(accountCategoryReference.reference),
  );
  const out: AccountCategoryReferenceRow[] = [];
  for (const r of rows) {
    const usage = await withTenant(tenant, async (tx) => {
      const [row] = await tx
        .select({ n: count() })
        .from(materialType)
        .where(
          and(
            eq(materialType.client, tenant),
            eq(materialType.accountCategoryReference, r.reference),
          ),
        );
      return Number(row?.n ?? 0);
    });
    out.push({ reference: r.reference, name: r.name, isActive: r.isActive, typeCount: usage });
  }
  return out;
}

export interface TypeValuationRow {
  materialType: string;
  plant: string;
  plantName: string;
  quantityUpdating: boolean;
  valueUpdating: boolean;
  stands: boolean;
  materialCount: number;
}

export async function listTypeValuation(client: string): Promise<TypeValuationRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const types = await tx
      .select({ materialType: materialType.materialType })
      .from(materialType)
      .where(eq(materialType.client, tenant))
      .orderBy(materialType.materialType);
    const plants = await tx
      .select({ plant: plant.plant, name: plant.name })
      .from(plant)
      .where(eq(plant.client, tenant))
      .orderBy(plant.plant);
    const rows = await tx
      .select()
      .from(materialTypeValuation)
      .where(eq(materialTypeValuation.client, tenant));
    const out: TypeValuationRow[] = [];
    for (const ty of types) {
      for (const pl of plants) {
        const row = rows.find(
          (r) => r.materialType === ty.materialType && r.valuationArea === pl.plant,
        );
        const [standing] = await tx
          .select({ n: count() })
          .from(materialPlant)
          .innerJoin(
            material,
            and(
              eq(material.client, materialPlant.client),
              eq(material.materialNumber, materialPlant.materialNumber),
            ),
          )
          .where(
            and(
              eq(materialPlant.client, tenant),
              eq(materialPlant.plant, pl.plant),
              eq(material.materialType, ty.materialType),
            ),
          );
        out.push({
          materialType: ty.materialType,
          plant: pl.plant,
          plantName: pl.name,
          quantityUpdating: row?.quantityUpdating ?? true,
          valueUpdating: row?.valueUpdating ?? true,
          stands: !!row,
          materialCount: Number(standing?.n ?? 0),
        });
      }
    }
    return out;
  });
}

/** Standing plants for the screen's updating grid. */
export async function listValuationPlants(client: string) {
  const tenant = requireClient(client);
  return withTenant(tenant, (tx) =>
    tx
      .select({ plant: plant.plant, name: plant.name })
      .from(plant)
      .where(eq(plant.client, tenant))
      .orderBy(plant.plant),
  );
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface MaterialTypeInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  materialType: string;
  name: string;
  defaultProcurementType: string;
  defaultPriceControl: string;
  internalNumberRange: string;
  externalNumberRange: string;
  accountCategoryReference: string;
  externalPurchaseOrders: string;
  internalPurchaseOrders: string;
  isConfigurable: boolean;
  reason: string;
}

const PROCUREMENT_DEFAULTS = ['BUY', 'MAKE', 'BOTH'] as const;

export async function saveMaterialType(input: MaterialTypeInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = normaliseKey(input.materialType, 'Material type', 4);
  const name = normaliseName(input.name, 25);
  if (!(PROCUREMENT_DEFAULTS as readonly string[]).includes(input.defaultProcurementType)) {
    throw new MaterialTypeError('The internal procurement default is not one of the standing values.');
  }
  if (!['S', 'V'].includes(input.defaultPriceControl)) {
    throw new MaterialTypeError('The price-control default is S (standard price) or V (moving average price).');
  }
  for (const [value, label] of [
    [input.externalPurchaseOrders, 'External purchase orders'],
    [input.internalPurchaseOrders, 'Internal purchase orders'],
  ] as const) {
    if (!['0', '1', '2'].includes(value)) {
      throw new MaterialTypeError(`${label} takes 0 (not allowed), 1 (allowed with warning) or 2 (allowed).`);
    }
  }
  const reference = normaliseKey(input.accountCategoryReference, 'Account category reference', 4);

  return withTenant(client, async (tx) => {
    const [referenceRow] = await tx
      .select({
        reference: accountCategoryReference.reference,
        isActive: accountCategoryReference.isActive,
      })
      .from(accountCategoryReference)
      .where(
        and(
          eq(accountCategoryReference.client, client),
          eq(accountCategoryReference.reference, reference),
        ),
      );
    if (!referenceRow) {
      throw new MaterialTypeError(
        `Account category reference ${reference} does not stand.`,
        'Define the reference in the section below, then save the type again.',
      );
    }
    if (!referenceRow.isActive) {
      throw new MaterialTypeError(
        `Account category reference ${reference} is not active.`,
        'Activate it on the valuation classes screen, or choose an active reference.',
      );
    }
    const internalRange = await judgeNumberRange(tx, client, input.internalNumberRange, false, 'internal');
    const externalRange = await judgeNumberRange(tx, client, input.externalNumberRange, true, 'external');

    const [existing] = await tx
      .select()
      .from(materialType)
      .where(and(eq(materialType.client, client), eq(materialType.materialType, key)))
      .for('update');

    const values = {
      name,
      defaultProcurementType: input.defaultProcurementType,
      defaultPriceControl: input.defaultPriceControl,
      internalNumberRange: internalRange,
      externalNumberRange: externalRange,
      accountCategoryReference: reference,
      externalPurchaseOrders: input.externalPurchaseOrders,
      internalPurchaseOrders: input.internalPurchaseOrders,
      isConfigurable: input.isConfigurable,
    };

    if (input.mode === 'CREATE') {
      if (existing) {
        throw new MaterialTypeError(
          `Material type ${key} already stands.`,
          'Change the standing type, or choose a new key.',
        );
      }
      await tx.insert(materialType).values({
        ...values,
        client,
        materialType: key,
        isActive: true,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: key,
        changeType: 'CREATE',
        changedBy,
        reason,
        transactionCode: ACTIVITY,
        after: { materialType: key, ...values },
        securityRelevantFields: [
          'defaultPriceControl',
          'internalNumberRange',
          'externalNumberRange',
          'accountCategoryReference',
        ],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { materialType: key, changed: true };
    }

    if (!existing) {
      throw new MaterialTypeError(
        `Material type ${key} does not stand.`,
        'Create it first, then change it.',
      );
    }
    if (existing.accountCategoryReference !== reference) {
      const blocked = await referenceChangeBlock(tx, client, key, reference);
      if (blocked) {
        throw new MaterialTypeError(
          blocked,
          'Assign the classes those materials carry to the new reference first. This screen does not rewrite the materials.',
        );
      }
    }
    const unchanged = (Object.keys(values) as (keyof typeof values)[]).every(
      (f) => existing[f] === values[f],
    );
    if (unchanged) return { materialType: key, changed: false };
    await tx
      .update(materialType)
      .set({ ...values, changedBy, changedAt: new Date() })
      .where(and(eq(materialType.client, client), eq(materialType.materialType, key)));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { ...existing },
      after: { ...values },
      securityRelevantFields: [
        'defaultPriceControl',
        'internalNumberRange',
        'externalNumberRange',
        'accountCategoryReference',
      ],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { materialType: key, changed: true };
  });
}

export interface MaterialTypeKeyInput {
  client: string;
  changedBy: string;
  materialType: string;
  reason: string;
}

export async function setMaterialTypeActive(input: MaterialTypeKeyInput & { active: boolean }) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = normaliseKey(input.materialType, 'Material type', 4);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialType)
      .where(and(eq(materialType.client, client), eq(materialType.materialType, key)))
      .for('update');
    if (!existing) throw new MaterialTypeError(`Material type ${key} does not stand.`);
    if (existing.isActive === input.active) return { materialType: key, changed: false };
    await tx
      .update(materialType)
      .set({ isActive: input.active, changedBy, changedAt: new Date() })
      .where(and(eq(materialType.client, client), eq(materialType.materialType, key)));
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
    return { materialType: key, changed: true };
  });
}

export async function deleteMaterialType(input: MaterialTypeKeyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = normaliseKey(input.materialType, 'Material type', 4);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialType)
      .where(and(eq(materialType.client, client), eq(materialType.materialType, key)))
      .for('update');
    if (!existing) throw new MaterialTypeError(`Material type ${key} does not stand.`);
    const [usage] = await tx
      .select({ n: count() })
      .from(material)
      .where(and(eq(material.client, client), eq(material.materialType, key)));
    const used = Number(usage?.n ?? 0);
    if (used > 0) {
      throw new MaterialTypeError(
        `Material type ${key} cannot be deleted: ${used} material${used === 1 ? '' : 's'} carr${used === 1 ? 'ies' : 'y'} it.`,
        'Deactivate the type instead; it stops new materials while its materials stand.',
      );
    }
    await tx
      .delete(materialTypeValuation)
      .where(
        and(
          eq(materialTypeValuation.client, client),
          eq(materialTypeValuation.materialType, key),
        ),
      );
    await tx
      .delete(materialType)
      .where(and(eq(materialType.client, client), eq(materialType.materialType, key)));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'DELETE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { ...existing },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { materialType: key, changed: true };
  });
}

export interface AccountCategoryReferenceInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  reference: string;
  name: string;
  reason: string;
}

export async function saveAccountCategoryReference(input: AccountCategoryReferenceInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = normaliseKey(input.reference, 'Account category reference', 4);
  const name = normaliseName(input.name, 60);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(accountCategoryReference)
      .where(
        and(
          eq(accountCategoryReference.client, client),
          eq(accountCategoryReference.reference, key),
        ),
      )
      .for('update');
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new MaterialTypeError(`Account category reference ${key} already stands.`);
      }
      await tx.insert(accountCategoryReference).values({
        client,
        reference: key,
        name,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: 'account_category_reference',
        objectKey: key,
        changeType: 'CREATE',
        changedBy,
        reason,
        transactionCode: ACTIVITY,
        after: { reference: key, name },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { reference: key, changed: true };
    }
    if (!existing) throw new MaterialTypeError(`Account category reference ${key} does not stand.`);
    if (existing.name === name) return { reference: key, changed: false };
    await tx
      .update(accountCategoryReference)
      .set({ name, version: existing.version + 1, changedBy, changedAt: new Date() })
      .where(
        and(
          eq(accountCategoryReference.client, client),
          eq(accountCategoryReference.reference, key),
        ),
      );
    await recordChange(tx, {
      client,
      objectClass: 'account_category_reference',
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { reference: key, name: existing.name },
      after: { reference: key, name },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { reference: key, changed: true };
  });
}

export interface AccountCategoryReferenceKeyInput {
  client: string;
  changedBy: string;
  reference: string;
  reason: string;
}

export async function deleteAccountCategoryReference(input: AccountCategoryReferenceKeyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = normaliseKey(input.reference, 'Account category reference', 4);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(accountCategoryReference)
      .where(
        and(
          eq(accountCategoryReference.client, client),
          eq(accountCategoryReference.reference, key),
        ),
      )
      .for('update');
    if (!existing) throw new MaterialTypeError(`Account category reference ${key} does not stand.`);
    const [usage] = await tx
      .select({ n: count() })
      .from(materialType)
      .where(
        and(eq(materialType.client, client), eq(materialType.accountCategoryReference, key)),
      );
    const used = Number(usage?.n ?? 0);
    if (used > 0) {
      throw new MaterialTypeError(
        `Account category reference ${key} cannot be deleted: ${used} material type${used === 1 ? '' : 's'} name${used === 1 ? 's' : ''} it.`,
        'Reassign the types to another reference first.',
      );
    }
    const [assigned] = await tx
      .select({ n: count() })
      .from(valuationClassReference)
      .where(and(eq(valuationClassReference.client, client), eq(valuationClassReference.reference, key)));
    const classCount = Number(assigned?.n ?? 0);
    if (classCount > 0) {
      throw new MaterialTypeError(
        `Account category reference ${key} cannot be deleted: ${classCount} valuation class${classCount === 1 ? '' : 'es'} ${classCount === 1 ? 'is' : 'are'} assigned to it.`,
        'Remove those assignments on the valuation classes screen first.',
      );
    }
    await tx
      .delete(accountCategoryReference)
      .where(
        and(
          eq(accountCategoryReference.client, client),
          eq(accountCategoryReference.reference, key),
        ),
      );
    await recordChange(tx, {
      client,
      objectClass: 'account_category_reference',
      objectKey: key,
      changeType: 'DELETE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { reference: key, name: existing.name },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { reference: key, changed: true };
  });
}

export interface TypeValuationInput {
  client: string;
  changedBy: string;
  materialType: string;
  plant: string;
  quantityUpdating: boolean;
  valueUpdating: boolean;
  reason: string;
}

export async function saveTypeValuation(input: TypeValuationInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = normaliseKey(input.materialType, 'Material type', 4);
  const plantCode = (input.plant ?? '').trim().toUpperCase();
  if (!plantCode) throw new MaterialTypeError('Choose a plant for the updating row.');
  return withTenant(client, async (tx) => {
    const [type] = await tx
      .select({ materialType: materialType.materialType })
      .from(materialType)
      .where(and(eq(materialType.client, client), eq(materialType.materialType, key)));
    if (!type) throw new MaterialTypeError(`Material type ${key} does not stand.`);
    const [site] = await tx
      .select({ plant: plant.plant })
      .from(plant)
      .where(and(eq(plant.client, client), eq(plant.plant, plantCode)));
    if (!site) throw new MaterialTypeError(`Plant ${plantCode} does not stand.`);

    const [existing] = await tx
      .select()
      .from(materialTypeValuation)
      .where(
        and(
          eq(materialTypeValuation.client, client),
          eq(materialTypeValuation.materialType, key),
          eq(materialTypeValuation.valuationArea, plantCode),
        ),
      )
      .for('update');
    const before = {
      quantityUpdating: existing?.quantityUpdating ?? true,
      valueUpdating: existing?.valueUpdating ?? true,
    };
    const after = {
      quantityUpdating: input.quantityUpdating,
      valueUpdating: input.valueUpdating,
    };
    if (before.quantityUpdating === after.quantityUpdating && before.valueUpdating === after.valueUpdating) {
      return { materialType: key, plant: plantCode, changed: false };
    }
    const [standing] = await tx
      .select({ n: count() })
      .from(materialPlant)
      .innerJoin(
        material,
        and(
          eq(material.client, materialPlant.client),
          eq(material.materialNumber, materialPlant.materialNumber),
        ),
      )
      .where(
        and(
          eq(materialPlant.client, client),
          eq(materialPlant.plant, plantCode),
          eq(material.materialType, key),
        ),
      );
    const used = Number(standing?.n ?? 0);
    if (used > 0) {
      throw new MaterialTypeError(
        `Updating for type ${key} at plant ${plantCode} cannot change: ${used} material${used === 1 ? '' : 's'} of this type stand${used === 1 ? 's' : ''} at the plant.`,
        'Standing materials keep the updating they were created under; the change would rewrite their behaviour silently.',
      );
    }
    if (existing) {
      await tx
        .update(materialTypeValuation)
        .set({ ...after, changedBy, changedAt: new Date() })
        .where(
          and(
            eq(materialTypeValuation.client, client),
            eq(materialTypeValuation.materialType, key),
            eq(materialTypeValuation.valuationArea, plantCode),
          ),
        );
    } else {
      await tx.insert(materialTypeValuation).values({
        client,
        materialType: key,
        valuationArea: plantCode,
        ...after,
        createdBy: changedBy,
      });
    }
    await recordChange(tx, {
      client,
      objectClass: 'material_type_valuation',
      objectKey: `${key}/${plantCode}`,
      changeType: existing ? 'CHANGE' : 'CREATE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before,
      after,
      securityRelevantFields: ['quantityUpdating', 'valueUpdating'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { materialType: key, plant: plantCode, changed: true };
  });
}
