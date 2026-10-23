import { and, count, eq, inArray, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { changeDocument } from '../../platform/tables/audit-trail';
import { markActivityComplete } from '../../platform/tenancy';
import { accountDetermination } from '../foundation/schema';
import {
  accountCategoryReference,
  material,
  materialType,
  materialValuation,
  valuationClass,
  valuationClassReference,
} from './schema';
import { classPermittedForType, namedMaterialTypes } from './valuation-class-permission';

/**
 * Valuation classes (OMSK as a search alias only).
 *
 * The account category reference and the valuation class already stand.
 * This service maintains those rows and the assignment between them. It
 * does not store a G/L account, post a journal, or consult a posting
 * period. A change must send the version it opened. A transport and an
 * approval are refused by name: this product has no target landscape,
 * and the change document is the recorded change set. A material's
 * valuation class is not rewritten when the configuration changes, and
 * a posted document is left as it was. A posting judges the class again.
 */

export const ACTIVITY = 'CFG.INV.VALCLASS.DEFINE';
export const ROUTE = '/config/valuation-classes';

export class ValuationClassError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'ValuationClassError';
  }
}

const CLASS_OBJECT = 'valuation_class';
const REFERENCE_OBJECT = 'account_category_reference';
const PRODUCTION = process.env.NODE_ENV === 'production';

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new ValuationClassError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new ValuationClassError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new ValuationClassError(
      'A reason is required for every valuation configuration change.',
      'State why this change is being made.',
    );
  }
  return value;
}

function referenceKey(value: string): string {
  const key = (value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(key)) {
    throw new ValuationClassError(
      'Account category reference must be one to four letters or digits.',
      'Correct the reference and save again. A leading zero is kept.',
    );
  }
  return key;
}

function classKey(value: string): string {
  const key = (value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,20}$/.test(key)) {
    throw new ValuationClassError(
      'Valuation class must be one to twenty letters, digits or underscores.',
      'Correct the class and save again. A leading zero is kept; the key is not a number.',
    );
  }
  return key;
}

function descriptionOf(value: string, label: string, max: number): string {
  const name = (value ?? '').trim();
  if (!name || name.length > max) {
    throw new ValuationClassError(
      `${label} is required and may be at most ${max} characters.`,
      'Enter a description within the limit and save again.',
    );
  }
  return name;
}

function requestKeyOf(value: string | undefined): string | null {
  const key = (value ?? '').trim();
  if (!key) return null;
  if (key.length > 64) {
    throw new ValuationClassError('The request key is longer than 64 characters.', 'Use a shorter key.');
  }
  return key;
}

function refuseAbsent(input: {
  generalLedgerAccount?: string;
  companyCode?: string;
  postingPeriod?: string;
  transportRequest?: string;
  approval?: string;
  version?: string;
  configurationVersion?: string;
  status?: string;
}): void {
  const named: Array<[string | undefined, string, string]> = [
    [input.generalLedgerAccount, 'A G/L account', 'Account determination derives the account when a posting runs. It is not stored on the valuation class.'],
    [input.companyCode, 'A company code', 'A valuation class stands for the tenant. It is not maintained per company code.'],
    [input.postingPeriod, 'A posting period', 'Configuration is not a posting. A closed period does not block this screen.'],
    [input.transportRequest, 'A transport', 'The change document is the history. This screen does not transport configuration.'],
    [input.approval, 'An approval', 'A valuation-class change is not an approval workflow.'],
    [input.status, 'A status code', 'The class is active or it is not. A status code is not stored.'],
  ];
  for (const [value, label, remedy] of named) {
    if (value?.trim()) {
      throw new ValuationClassError(`${label} is not stored on a valuation class.`, remedy);
    }
  }
}

function assertOpenedVersion(current: number, expected: number | undefined, label: string): void {
  if (expected === undefined || !Number.isInteger(expected) || expected !== current) {
    throw new ValuationClassError(
      `${label} changed after it was opened.`,
      'Reload the current version before saving.',
    );
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function priorRequest(tx: Tx, client: string, objectClass: string, requestKey: string | null) {
  if (!requestKey) return null;
  const [prior] = await tx
    .select()
    .from(changeDocument)
    .where(and(
      eq(changeDocument.client, client),
      eq(changeDocument.objectClass, objectClass),
      eq(changeDocument.correlationId, requestKey),
    ))
    .limit(1);
  return prior ?? null;
}

// ── Reads ────────────────────────────────────────────────────────────────

export interface ValuationReferenceRow {
  reference: string;
  name: string;
  isActive: boolean;
  version: number;
  typeCount: number;
  classCount: number;
}

export async function listValuationReferences(client: string): Promise<ValuationReferenceRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(accountCategoryReference)
      .where(eq(accountCategoryReference.client, tenant))
      .orderBy(accountCategoryReference.reference);
    const out: ValuationReferenceRow[] = [];
    for (const row of rows) {
      const [types] = await tx
        .select({ n: count() })
        .from(materialType)
        .where(and(eq(materialType.client, tenant), eq(materialType.accountCategoryReference, row.reference)));
      const [classes] = await tx
        .select({ n: count() })
        .from(valuationClassReference)
        .where(and(eq(valuationClassReference.client, tenant), eq(valuationClassReference.reference, row.reference)));
      out.push({
        reference: row.reference,
        name: row.name,
        isActive: row.isActive,
        version: row.version,
        typeCount: Number(types?.n ?? 0),
        classCount: Number(classes?.n ?? 0),
      });
    }
    return out;
  });
}

export interface ValuationClassRow {
  valuationClass: string;
  name: string;
  isActive: boolean;
  version: number;
  allowedMaterialTypes: string;
  references: string[];
  materialCount: number;
  determinationCount: number;
}

async function usageOf(tx: Tx, client: string, key: string) {
  const [materials] = await tx
    .select({ n: count() })
    .from(materialValuation)
    .where(and(eq(materialValuation.client, client), eq(materialValuation.valuationClass, key)));
  const [determinations] = await tx
    .select({ n: count() })
    .from(accountDetermination)
    .where(and(eq(accountDetermination.client, client), eq(accountDetermination.valuationClass, key)));
  return {
    materials: Number(materials?.n ?? 0),
    determinations: Number(determinations?.n ?? 0),
  };
}

export async function listValuationClasses(client: string): Promise<ValuationClassRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(valuationClass)
      .where(eq(valuationClass.client, tenant))
      .orderBy(valuationClass.valuationClass);
    const assignments = await tx
      .select()
      .from(valuationClassReference)
      .where(eq(valuationClassReference.client, tenant));
    const out: ValuationClassRow[] = [];
    for (const row of rows) {
      const usage = await usageOf(tx, tenant, row.valuationClass);
      out.push({
        valuationClass: row.valuationClass,
        name: row.name,
        isActive: row.isActive,
        version: row.version,
        allowedMaterialTypes: row.allowedMaterialTypes,
        references: assignments
          .filter((assignment) => assignment.valuationClass === row.valuationClass)
          .map((assignment) => assignment.reference)
          .sort(),
        materialCount: usage.materials,
        determinationCount: usage.determinations,
      });
    }
    return out;
  });
}

export interface TypeReferenceRow {
  materialType: string;
  name: string;
  accountCategoryReference: string;
  referenceActive: boolean;
  materialCount: number;
}

export async function listTypeReferences(client: string): Promise<TypeReferenceRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const types = await tx
      .select()
      .from(materialType)
      .where(eq(materialType.client, tenant))
      .orderBy(materialType.materialType);
    const references = await tx
      .select()
      .from(accountCategoryReference)
      .where(eq(accountCategoryReference.client, tenant));
    const active = new Map(references.map((row) => [row.reference, row.isActive]));
    const out: TypeReferenceRow[] = [];
    for (const type of types) {
      const [usage] = await tx
        .select({ n: count() })
        .from(material)
        .where(and(eq(material.client, tenant), eq(material.materialType, type.materialType)));
      out.push({
        materialType: type.materialType,
        name: type.name,
        accountCategoryReference: type.accountCategoryReference,
        referenceActive: active.get(type.accountCategoryReference) ?? false,
        materialCount: Number(usage?.n ?? 0),
      });
    }
    return out;
  });
}

export async function listValuationGaps(client: string): Promise<string[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const gaps: string[] = [];
    const types = await tx.select().from(materialType).where(eq(materialType.client, tenant));
    const references = await tx.select().from(accountCategoryReference).where(eq(accountCategoryReference.client, tenant));
    const byReference = new Map(references.map((row) => [row.reference, row]));
    for (const type of types) {
      const reference = byReference.get(type.accountCategoryReference);
      if (!reference) {
        gaps.push(`Material type ${type.materialType} names account category reference ${type.accountCategoryReference}, which does not stand.`);
      } else if (!reference.isActive) {
        gaps.push(`Material type ${type.materialType} names inactive account category reference ${type.accountCategoryReference}.`);
      }
    }
    const classes = await tx.select().from(valuationClass).where(eq(valuationClass.client, tenant));
    const assignments = await tx.select().from(valuationClassReference).where(eq(valuationClassReference.client, tenant));
    for (const row of classes) {
      if (!row.isActive) continue;
      const assigned = assignments.some((assignment) => assignment.valuationClass === row.valuationClass);
      if (!assigned) {
        gaps.push(`Valuation class ${row.valuationClass} is active and assigned to no account category reference.`);
      }
    }
    const carried = await tx
      .select({
        materialNumber: material.materialNumber,
        materialType: material.materialType,
        valuationClass: materialValuation.valuationClass,
        valuationArea: materialValuation.valuationArea,
      })
      .from(materialValuation)
      .innerJoin(material, and(
        eq(material.client, materialValuation.client),
        eq(material.materialNumber, materialValuation.materialNumber),
      ))
      .where(and(
        eq(materialValuation.client, tenant),
        sql`${materialValuation.valuationClass} is not null and ${materialValuation.valuationClass} <> ''`,
      ));
    const classByKey = new Map(classes.map((row) => [row.valuationClass, row]));
    const typeByKey = new Map(types.map((row) => [row.materialType, row]));
    for (const row of carried) {
      const key = row.valuationClass ?? '';
      const type = typeByKey.get(row.materialType);
      const standing = classByKey.get(key);
      const reference = type ? byReference.get(type.accountCategoryReference) : undefined;
      const assigned = assignments.some((assignment) =>
        assignment.valuationClass === key && assignment.reference === type?.accountCategoryReference);
      const permitted = classPermittedForType({
        materialType: row.materialType,
        reference: type?.accountCategoryReference,
        referenceActive: reference?.isActive ?? false,
        classActive: standing?.isActive ?? false,
        allowedMaterialTypes: standing?.allowedMaterialTypes ?? '',
        assignedToReference: assigned,
      });
      if (!permitted) {
        gaps.push(`Material ${row.materialNumber} at ${row.valuationArea} carries valuation class ${key}, which is not permitted for material type ${row.materialType}.`);
      }
    }
    const determinations = await tx
      .select({ valuationClass: accountDetermination.valuationClass })
      .from(accountDetermination)
      .where(and(eq(accountDetermination.client, tenant), sql`${accountDetermination.valuationClass} <> ''`));
    const named = new Set(determinations.map((row) => row.valuationClass));
    for (const key of [...named].sort()) {
      const standing = classByKey.get(key);
      if (!standing) gaps.push(`Account determination names valuation class ${key}, which does not stand.`);
      else if (!standing.isActive) gaps.push(`Account determination names inactive valuation class ${key}.`);
    }
    return gaps;
  });
}

export async function valuationClassRefusal(
  tx: Tx,
  client: string,
  materialTypeKey: string,
  valuationClassKey: string,
): Promise<string | null> {
  const key = classKey(valuationClassKey);
  const [type] = await tx
    .select()
    .from(materialType)
    .where(and(eq(materialType.client, client), eq(materialType.materialType, materialTypeKey)));
  if (!type) return `Material type ${materialTypeKey} does not stand.`;
  const [reference] = await tx
    .select()
    .from(accountCategoryReference)
    .where(and(
      eq(accountCategoryReference.client, client),
      eq(accountCategoryReference.reference, type.accountCategoryReference),
    ));
  const [standing] = await tx
    .select()
    .from(valuationClass)
    .where(and(eq(valuationClass.client, client), eq(valuationClass.valuationClass, key)));
  if (!standing) {
    return `Valuation class ${key} does not stand.`;
  }
  const [assignment] = await tx
    .select({ reference: valuationClassReference.reference })
    .from(valuationClassReference)
    .where(and(
      eq(valuationClassReference.client, client),
      eq(valuationClassReference.reference, type.accountCategoryReference),
      eq(valuationClassReference.valuationClass, key),
    ));
  const permitted = classPermittedForType({
    materialType: materialTypeKey,
    reference: type.accountCategoryReference,
    referenceActive: reference?.isActive ?? false,
    classActive: standing.isActive,
    allowedMaterialTypes: standing.allowedMaterialTypes,
    assignedToReference: !!assignment,
  });
  if (permitted) return null;
  if (!standing.isActive) return `Valuation class ${key} is not active.`;
  if (!reference?.isActive) {
    return `Account category reference ${type.accountCategoryReference} is not active, so valuation class ${key} is not allowed for material type ${materialTypeKey}.`;
  }
  return `Valuation class ${key} is not allowed for material type ${materialTypeKey}.`;
}

/** Posting-time judgement. A missing or unpermitted class is a message, not a substituted account. */
export async function postingValuationRefusal(
  tx: Tx,
  client: string,
  materialNumber: string,
  valuationClassKey: string,
): Promise<string | null> {
  const number = (materialNumber ?? '').trim();
  const [row] = await tx
    .select({ materialType: material.materialType })
    .from(material)
    .where(and(eq(material.client, client), eq(material.materialNumber, number)));
  if (!row) return `Material ${number} does not stand.`;
  try {
    return await valuationClassRefusal(tx, client, row.materialType, valuationClassKey);
  } catch (error) {
    if (error instanceof ValuationClassError) return error.message;
    throw error;
  }
}

export async function referenceChangeBlock(
  tx: Tx,
  client: string,
  materialTypeKey: string,
  newReference: string,
): Promise<string | null> {
  const rows = await tx
    .select({
      materialNumber: material.materialNumber,
      valuationClass: materialValuation.valuationClass,
    })
    .from(materialValuation)
    .innerJoin(material, and(
      eq(material.client, materialValuation.client),
      eq(material.materialNumber, materialValuation.materialNumber),
    ))
    .where(and(
      eq(material.client, client),
      eq(material.materialType, materialTypeKey),
      sql`${materialValuation.valuationClass} is not null and ${materialValuation.valuationClass} <> ''`,
    ));
  if (rows.length === 0) return null;
  const keys = uniqueSorted(rows.map((row) => row.valuationClass).filter((key): key is string => !!key));
  const classes = keys.length === 0 ? [] : await tx
    .select()
    .from(valuationClass)
    .where(and(eq(valuationClass.client, client), inArray(valuationClass.valuationClass, keys)));
  const assignments = keys.length === 0 ? [] : await tx
    .select()
    .from(valuationClassReference)
    .where(and(
      eq(valuationClassReference.client, client),
      eq(valuationClassReference.reference, newReference),
      inArray(valuationClassReference.valuationClass, keys),
    ));
  const [reference] = await tx
    .select({ isActive: accountCategoryReference.isActive })
    .from(accountCategoryReference)
    .where(and(eq(accountCategoryReference.client, client), eq(accountCategoryReference.reference, newReference)));
  const byClass = new Map(classes.map((row) => [row.valuationClass, row]));
  const assigned = new Set(assignments.map((row) => row.valuationClass));
  const blocked = new Set<string>();
  for (const row of rows) {
    const key = row.valuationClass;
    if (!key) continue;
    const standing = byClass.get(key);
    const permitted = classPermittedForType({
      materialType: materialTypeKey,
      reference: newReference,
      referenceActive: reference?.isActive ?? false,
      classActive: standing?.isActive ?? false,
      allowedMaterialTypes: standing?.allowedMaterialTypes ?? '',
      assignedToReference: assigned.has(key),
    });
    if (!permitted) blocked.add(row.materialNumber);
  }
  if (blocked.size === 0) return null;
  const sample = [...blocked].sort().slice(0, 5).join(', ');
  return `Account category reference ${newReference} cannot be assigned to material type ${materialTypeKey}: ${blocked.size} material${blocked.size === 1 ? '' : 's'} would no longer be allowed their valuation class (${sample}).`;
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface ReferenceInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  reference: string;
  name: string;
  isActive: boolean;
  reason: string;
  requestKey?: string;
  /** The version the caller opened. Required on a change. */
  expectedVersion?: number;
  generalLedgerAccount?: string;
  companyCode?: string;
  postingPeriod?: string;
  transportRequest?: string;
  approval?: string;
  version?: string;
  configurationVersion?: string;
  status?: string;
}

export async function saveValuationReference(input: ReferenceInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = referenceKey(input.reference);
  const name = descriptionOf(input.name, 'The description', 60);
  const requestKey = requestKeyOf(input.requestKey);
  refuseAbsent(input);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(accountCategoryReference)
      .where(and(eq(accountCategoryReference.client, client), eq(accountCategoryReference.reference, key)))
      .for('update');
    const prior = await priorRequest(tx, client, REFERENCE_OBJECT, requestKey);
    if (prior) {
      if (prior.objectKey !== key) {
        throw new ValuationClassError(
          `This request key already recorded a change to account category reference ${prior.objectKey}.`,
          'Use a new request key for a different reference.',
        );
      }
      return { reference: key, changed: false, replayed: true };
    }
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new ValuationClassError(
          `Account category reference ${key} already stands.`,
          'Change the standing reference, or choose a new key.',
        );
      }
      await tx.insert(accountCategoryReference).values({
        client,
        reference: key,
        name,
        isActive: input.isActive,
        version: 1,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: REFERENCE_OBJECT,
        objectKey: key,
        changeType: 'CREATE',
        changedBy,
        reason,
        transactionCode: ACTIVITY,
        correlationId: requestKey ?? undefined,
        after: { reference: key, name, isActive: input.isActive, version: 1 },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { reference: key, changed: true, replayed: false, version: 1 };
    }
    if (!existing) {
      throw new ValuationClassError(
        `Account category reference ${key} does not stand.`,
        'Create it first, then change it.',
      );
    }
    if (!input.isActive && existing.isActive) {
      const [usage] = await tx
        .select({ n: count() })
        .from(materialType)
        .where(and(eq(materialType.client, client), eq(materialType.accountCategoryReference, key)));
      const used = Number(usage?.n ?? 0);
      if (used > 0) {
        throw new ValuationClassError(
          `Account category reference ${key} cannot be deactivated: ${used} material type${used === 1 ? '' : 's'} name${used === 1 ? 's' : ''} it.`,
          'Reassign those types to another reference first. Existing materials are not rewritten.',
        );
      }
    }
    if (existing.name === name && existing.isActive === input.isActive) {
      return { reference: key, changed: false, replayed: false, version: existing.version };
    }
    const version = existing.version + 1;
    await tx
      .update(accountCategoryReference)
      .set({ name, isActive: input.isActive, version, changedBy, changedAt: new Date() })
      .where(and(eq(accountCategoryReference.client, client), eq(accountCategoryReference.reference, key)));
    await recordChange(tx, {
      client,
      objectClass: REFERENCE_OBJECT,
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      correlationId: requestKey ?? undefined,
      before: { name: existing.name, isActive: existing.isActive, version: existing.version },
      after: { name, isActive: input.isActive, version: existing.version + 1 },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { reference: key, changed: true, replayed: false, version: existing.version + 1 };
  });
}

export async function deleteValuationReference(input: {
  client: string;
  changedBy: string;
  reference: string;
  reason: string;
  requestKey?: string;
  expectedVersion?: number;
}) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = referenceKey(input.reference);
  const requestKey = requestKeyOf(input.requestKey);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(accountCategoryReference)
      .where(and(eq(accountCategoryReference.client, client), eq(accountCategoryReference.reference, key)))
      .for('update');
    const prior = await priorRequest(tx, client, REFERENCE_OBJECT, requestKey);
    if (prior?.changeType === 'DELETE' && prior.objectKey === key) {
      return { reference: key, changed: false, replayed: true };
    }
    if (!existing) throw new ValuationClassError(`Account category reference ${key} does not stand.`);
    assertOpenedVersion(existing.version, input.expectedVersion, `Account category reference ${key}`);
    const [types] = await tx
      .select({ n: count() })
      .from(materialType)
      .where(and(eq(materialType.client, client), eq(materialType.accountCategoryReference, key)));
    const typeCount = Number(types?.n ?? 0);
    if (typeCount > 0) {
      throw new ValuationClassError(
        `Account category reference ${key} cannot be deleted: ${typeCount} material type${typeCount === 1 ? '' : 's'} name${typeCount === 1 ? 's' : ''} it.`,
        'Reassign the types first. Deletion does not rewrite materials.',
      );
    }
    const [classes] = await tx
      .select({ n: count() })
      .from(valuationClassReference)
      .where(and(eq(valuationClassReference.client, client), eq(valuationClassReference.reference, key)));
    const classCount = Number(classes?.n ?? 0);
    if (classCount > 0) {
      throw new ValuationClassError(
        `Account category reference ${key} cannot be deleted: ${classCount} valuation class${classCount === 1 ? '' : 'es'} ${classCount === 1 ? 'is' : 'are'} assigned to it.`,
        'Remove those assignments first.',
      );
    }
    await tx
      .delete(accountCategoryReference)
      .where(and(eq(accountCategoryReference.client, client), eq(accountCategoryReference.reference, key)));
    await recordChange(tx, {
      client,
      objectClass: REFERENCE_OBJECT,
      objectKey: key,
      changeType: 'DELETE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      correlationId: requestKey ?? undefined,
      before: { reference: key, name: existing.name, isActive: existing.isActive },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { reference: key, changed: true, replayed: false };
  });
}

export interface ClassInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  valuationClass: string;
  name: string;
  isActive: boolean;
  references: string[];
  materialTypes: string[];
  reason: string;
  requestKey?: string;
  /** The version the caller opened. Required on a change. */
  expectedVersion?: number;
  generalLedgerAccount?: string;
  companyCode?: string;
  postingPeriod?: string;
  transportRequest?: string;
  approval?: string;
  version?: string;
  configurationVersion?: string;
  status?: string;
}

function snapshotOf(name: string, isActive: boolean, references: string[], materialTypes: string[]) {
  return {
    name,
    isActive,
    references: references.join(','),
    allowedMaterialTypes: materialTypes.join(','),
  };
}

async function proposedClassState(
  tx: Tx,
  client: string,
  references: string[],
  materialTypes: string[],
  existingReferences: Set<string>,
) {
  const referenceKeys = uniqueSorted(references.map(referenceKey));
  if (referenceKeys.length === 0) {
    throw new ValuationClassError(
      'A valuation class must be assigned to at least one account category reference.',
      'Choose a reference that already stands, then save again.',
    );
  }
  const standing = await tx
    .select()
    .from(accountCategoryReference)
    .where(and(eq(accountCategoryReference.client, client), inArray(accountCategoryReference.reference, referenceKeys)));
  const byKey = new Map(standing.map((row) => [row.reference, row]));
  for (const key of referenceKeys) {
    const row = byKey.get(key);
    if (!row) {
      throw new ValuationClassError(
        `Account category reference ${key} does not stand.`,
        'Create the reference first, then assign the class.',
      );
    }
    if (!row.isActive && !existingReferences.has(key)) {
      throw new ValuationClassError(
        `Account category reference ${key} is not active.`,
        'Activate the reference, or assign the class to an active reference.',
      );
    }
  }
  const typeKeys = uniqueSorted(materialTypes.map((value) => {
    const key = (value ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,4}$/.test(key)) {
      throw new ValuationClassError(
        `Material type ${value || '—'} is not a type key.`,
        'Choose a material type that already stands.',
      );
    }
    return key;
  }));
  if (typeKeys.length === 0) return { referenceKeys, typeKeys, allowedMaterialTypes: '' };
  const types = await tx
    .select()
    .from(materialType)
    .where(and(eq(materialType.client, client), inArray(materialType.materialType, typeKeys)));
  const typeByKey = new Map(types.map((row) => [row.materialType, row]));
  for (const key of typeKeys) {
    const type = typeByKey.get(key);
    if (!type) {
      throw new ValuationClassError(
        `Material type ${key} does not stand.`,
        'Define the type first, then name it on the class.',
      );
    }
    if (!referenceKeys.includes(type.accountCategoryReference)) {
      throw new ValuationClassError(
        `Material type ${key} uses account category reference ${type.accountCategoryReference}, which is not assigned to this class.`,
        'Assign that reference, or leave the type unnamed.',
      );
    }
  }
  return { referenceKeys, typeKeys, allowedMaterialTypes: typeKeys.join(',') };
}

async function classWouldInvalidate(
  tx: Tx,
  client: string,
  key: string,
  isActive: boolean,
  referenceKeys: string[],
  allowedMaterialTypes: string,
): Promise<string | null> {
  const rows = await tx
    .select({
      materialNumber: material.materialNumber,
      materialType: material.materialType,
    })
    .from(materialValuation)
    .innerJoin(material, and(
      eq(material.client, materialValuation.client),
      eq(material.materialNumber, materialValuation.materialNumber),
    ))
    .where(and(eq(materialValuation.client, client), eq(materialValuation.valuationClass, key)));
  if (rows.length === 0) return null;
  const typeKeys = uniqueSorted(rows.map((row) => row.materialType));
  const types = await tx
    .select()
    .from(materialType)
    .where(and(eq(materialType.client, client), inArray(materialType.materialType, typeKeys)));
  const typeByKey = new Map(types.map((row) => [row.materialType, row]));
  const referenceKeysSet = new Set(referenceKeys);
  const references = referenceKeys.length === 0 ? [] : await tx
    .select()
    .from(accountCategoryReference)
    .where(and(eq(accountCategoryReference.client, client), inArray(accountCategoryReference.reference, referenceKeys)));
  const referenceActive = new Map(references.map((row) => [row.reference, row.isActive]));
  const blocked = new Set<string>();
  for (const row of rows) {
    const type = typeByKey.get(row.materialType);
    const reference = type?.accountCategoryReference;
    const permitted = classPermittedForType({
      materialType: row.materialType,
      reference,
      referenceActive: reference ? (referenceActive.get(reference) ?? false) : false,
      classActive: isActive,
      allowedMaterialTypes,
      assignedToReference: !!reference && referenceKeysSet.has(reference),
    });
    if (!permitted) blocked.add(row.materialNumber);
  }
  if (blocked.size === 0) return null;
  const sample = [...blocked].sort().slice(0, 5).join(', ');
  return `Valuation class ${key} cannot be changed this way: ${blocked.size} material${blocked.size === 1 ? '' : 's'} would no longer be allowed to carry it (${sample}).`;
}

export async function saveValuationClass(input: ClassInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = classKey(input.valuationClass);
  const name = descriptionOf(input.name, 'The description', 60);
  const requestKey = requestKeyOf(input.requestKey);
  refuseAbsent(input);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(valuationClass)
      .where(and(eq(valuationClass.client, client), eq(valuationClass.valuationClass, key)))
      .for('update');
    const prior = await priorRequest(tx, client, CLASS_OBJECT, requestKey);
    if (prior) {
      if (prior.objectKey !== key) {
        throw new ValuationClassError(
          `This request key already recorded a change to valuation class ${prior.objectKey}.`,
          'Use a new request key for a different class.',
        );
      }
      return { valuationClass: key, changed: false, replayed: true };
    }
    const currentAssignments = existing
      ? await tx
        .select({ reference: valuationClassReference.reference })
        .from(valuationClassReference)
        .where(and(eq(valuationClassReference.client, client), eq(valuationClassReference.valuationClass, key)))
      : [];
    const existingReferences = new Set(currentAssignments.map((row) => row.reference));
    const proposed = await proposedClassState(tx, client, input.references, input.materialTypes, existingReferences);
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new ValuationClassError(
          `Valuation class ${key} already stands.`,
          'Change the standing class, or choose a new key.',
        );
      }
      await tx.insert(valuationClass).values({
        client,
        valuationClass: key,
        name,
        allowedMaterialTypes: proposed.allowedMaterialTypes,
        isActive: input.isActive,
        version: 1,
        createdBy: changedBy,
      });
      for (const reference of proposed.referenceKeys) {
        await tx.insert(valuationClassReference).values({
          client,
          reference,
          valuationClass: key,
          createdBy: changedBy,
        });
      }
      await recordChange(tx, {
        client,
        objectClass: CLASS_OBJECT,
        objectKey: key,
        changeType: 'CREATE',
        changedBy,
        reason,
        transactionCode: ACTIVITY,
        correlationId: requestKey ?? undefined,
        after: { ...snapshotOf(name, input.isActive, proposed.referenceKeys, proposed.typeKeys), version: 1 },
        securityRelevantFields: ['isActive', 'references', 'allowedMaterialTypes'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { valuationClass: key, changed: true, replayed: false, version: 1 };
    }
    if (!existing) {
      throw new ValuationClassError(
        `Valuation class ${key} does not stand.`,
        'Create it first, then change it.',
      );
    }
    assertOpenedVersion(existing.version, input.expectedVersion, `Valuation class ${key}`);
    const same = existing.name === name
      && existing.isActive === input.isActive
      && existing.allowedMaterialTypes === proposed.allowedMaterialTypes
      && uniqueSorted([...existingReferences]).join(',') === proposed.referenceKeys.join(',');
    if (same) return { valuationClass: key, changed: false, replayed: false, version: existing.version };
    if (!input.isActive && existing.isActive) {
      const usage = await usageOf(tx, client, key);
      if (usage.determinations > 0) {
        throw new ValuationClassError(
          `Valuation class ${key} cannot be deactivated: account determination names it ${usage.determinations} time${usage.determinations === 1 ? '' : 's'}.`,
          'Remove those account-determination rows first. A posting will not substitute another account.',
        );
      }
    }
    const blocked = await classWouldInvalidate(
      tx,
      client,
      key,
      input.isActive,
      proposed.referenceKeys,
      proposed.allowedMaterialTypes,
    );
    if (blocked) {
      throw new ValuationClassError(blocked, 'Leave the class permitted for those materials, or move them by an explicit material change. This screen does not rewrite them.');
    }
    const version = existing.version + 1;
    await tx
      .update(valuationClass)
      .set({
        name,
        isActive: input.isActive,
        allowedMaterialTypes: proposed.allowedMaterialTypes,
        version,
        changedBy,
        changedAt: new Date(),
      })
      .where(and(eq(valuationClass.client, client), eq(valuationClass.valuationClass, key)));
    const removed = [...existingReferences].filter((reference) => !proposed.referenceKeys.includes(reference));
    const added = proposed.referenceKeys.filter((reference) => !existingReferences.has(reference));
    if (removed.length > 0) {
      await tx
        .delete(valuationClassReference)
        .where(and(
          eq(valuationClassReference.client, client),
          eq(valuationClassReference.valuationClass, key),
          inArray(valuationClassReference.reference, removed),
        ));
    }
    for (const reference of added) {
      await tx.insert(valuationClassReference).values({
        client,
        reference,
        valuationClass: key,
        createdBy: changedBy,
      });
    }
    await recordChange(tx, {
      client,
      objectClass: CLASS_OBJECT,
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      correlationId: requestKey ?? undefined,
      before: {
        ...snapshotOf(
          existing.name,
          existing.isActive,
          uniqueSorted([...existingReferences]),
          namedMaterialTypes(existing.allowedMaterialTypes),
        ),
        version: existing.version,
      },
      after: { ...snapshotOf(name, input.isActive, proposed.referenceKeys, proposed.typeKeys), version: existing.version + 1 },
      securityRelevantFields: ['isActive', 'references', 'allowedMaterialTypes'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { valuationClass: key, changed: true, replayed: false, version: existing.version + 1 };
  });
}

export async function deleteValuationClass(input: {
  client: string;
  changedBy: string;
  valuationClass: string;
  reason: string;
  requestKey?: string;
  expectedVersion?: number;
}) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = classKey(input.valuationClass);
  const requestKey = requestKeyOf(input.requestKey);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(valuationClass)
      .where(and(eq(valuationClass.client, client), eq(valuationClass.valuationClass, key)))
      .for('update');
    const prior = await priorRequest(tx, client, CLASS_OBJECT, requestKey);
    if (prior?.changeType === 'DELETE' && prior.objectKey === key) {
      return { valuationClass: key, changed: false, replayed: true };
    }
    if (!existing) throw new ValuationClassError(`Valuation class ${key} does not stand.`);
    assertOpenedVersion(existing.version, input.expectedVersion, `Valuation class ${key}`);
    const usage = await usageOf(tx, client, key);
    if (usage.materials > 0) {
      throw new ValuationClassError(
        `Valuation class ${key} cannot be deleted: ${usage.materials} material valuation${usage.materials === 1 ? '' : 's'} carr${usage.materials === 1 ? 'ies' : 'y'} it.`,
        'Deactivate is also refused while those materials stand. The materials are not rewritten.',
      );
    }
    if (usage.determinations > 0) {
      throw new ValuationClassError(
        `Valuation class ${key} cannot be deleted: account determination names it ${usage.determinations} time${usage.determinations === 1 ? '' : 's'}.`,
        'Remove those rows first. A posting will not substitute another account.',
      );
    }
    await tx
      .delete(valuationClassReference)
      .where(and(eq(valuationClassReference.client, client), eq(valuationClassReference.valuationClass, key)));
    await tx
      .delete(valuationClass)
      .where(and(eq(valuationClass.client, client), eq(valuationClass.valuationClass, key)));
    await recordChange(tx, {
      client,
      objectClass: CLASS_OBJECT,
      objectKey: key,
      changeType: 'DELETE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      correlationId: requestKey ?? undefined,
      before: { valuationClass: key, name: existing.name, isActive: existing.isActive, allowedMaterialTypes: existing.allowedMaterialTypes },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { valuationClass: key, changed: true, replayed: false };
  });
}

export async function assignMaterialTypeReference(input: {
  client: string;
  changedBy: string;
  materialType: string;
  reference: string;
  reason: string;
  requestKey?: string;
  postingPeriod?: string;
  transportRequest?: string;
}) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const typeKey = (input.materialType ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(typeKey)) {
    throw new ValuationClassError('Material type must be one to four letters or digits.');
  }
  const reference = referenceKey(input.reference);
  const requestKey = requestKeyOf(input.requestKey);
  refuseAbsent(input);
  return withTenant(client, async (tx) => {
    const [type] = await tx
      .select()
      .from(materialType)
      .where(and(eq(materialType.client, client), eq(materialType.materialType, typeKey)))
      .for('update');
    const prior = await priorRequest(tx, client, 'material_type', requestKey);
    if (prior) {
      if (prior.objectKey !== typeKey) {
        throw new ValuationClassError(
          `This request key already recorded a change to material type ${prior.objectKey}.`,
          'Use a new request key for a different type.',
        );
      }
      return { materialType: typeKey, changed: false, replayed: true };
    }
    if (!type) throw new ValuationClassError(`Material type ${typeKey} does not stand.`);
    const [referenceRow] = await tx
      .select()
      .from(accountCategoryReference)
      .where(and(eq(accountCategoryReference.client, client), eq(accountCategoryReference.reference, reference)));
    if (!referenceRow) {
      throw new ValuationClassError(
        `Account category reference ${reference} does not stand.`,
        'Create the reference first.',
      );
    }
    if (!referenceRow.isActive) {
      throw new ValuationClassError(
        `Account category reference ${reference} is not active.`,
        'Activate it, or choose an active reference.',
      );
    }
    if (type.accountCategoryReference === reference) {
      return { materialType: typeKey, changed: false, replayed: false };
    }
    const blocked = await referenceChangeBlock(tx, client, typeKey, reference);
    if (blocked) {
      throw new ValuationClassError(blocked, 'Assign the classes those materials carry to the new reference first. This screen does not rewrite the materials.');
    }
    await tx
      .update(materialType)
      .set({ accountCategoryReference: reference, changedBy, changedAt: new Date() })
      .where(and(eq(materialType.client, client), eq(materialType.materialType, typeKey)));
    await recordChange(tx, {
      client,
      objectClass: 'material_type',
      objectKey: typeKey,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      correlationId: requestKey ?? undefined,
      before: { accountCategoryReference: type.accountCategoryReference },
      after: { accountCategoryReference: reference },
      securityRelevantFields: ['accountCategoryReference'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { materialType: typeKey, changed: true, replayed: false };
  });
}
