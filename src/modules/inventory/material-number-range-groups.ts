import { and, count, eq } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { numberRange } from '../../platform/tables/numbering';
import { materialNumberRangeGroup, materialType } from './schema';

/**
 * Material number range groups (SCR-051 / MMNR; R-99).
 *
 * A group is a named pair of MATERIALNR intervals: one internal range
 * key and one external range key (the TNRGT shape), the pair itself the
 * group's identity. Intervals stay in the standing number_range engine
 * (object MATERIALNR, company '*', the two-character range number as
 * sub-object, year 0) and material types keep their SCR-048 range keys,
 * so a type's group is derived from its key pair and never stored twice.
 * Group keys are immutable once the group stands — a correction is
 * delete-and-recreate while no type carries the pair — while the
 * description is editable at any time. Deletion is refused while
 * material types carry the pair, the count named. One change document
 * per write, a reason on every write.
 */

export const ACTIVITY = 'CFG.INV.MATERIALRANGE.DEFINE';

export class MaterialRangeGroupError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'MaterialRangeGroupError';
  }
}

const OBJECT_CLASS = 'material_number_range_group';
const PRODUCTION = process.env.NODE_ENV === 'production';

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new MaterialRangeGroupError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new MaterialRangeGroupError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new MaterialRangeGroupError(
      'A reason is required for every material number range group change.',
      'State why this change is being made.',
    );
  }
  return value;
}

function requireRangeKey(raw: string, label: string): string {
  const key = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(key)) {
    throw new MaterialRangeGroupError(
      `The ${label} range key is exactly two uppercase letters or digits.`,
      'Correct the key and save again.',
    );
  }
  return key;
}

// ── Reads ────────────────────────────────────────────────────────────────

export interface MaterialRangeGroupRow {
  internalKey: string;
  externalKey: string;
  description: string;
  internalFrom: number;
  internalTo: number;
  internalCurrent: number;
  internalStatus: string;
  externalFrom: number;
  externalTo: number;
  externalCurrent: number;
  externalStatus: string;
  assignedTypes: string[];
}

export interface UngroupedIntervalRow {
  rangeKey: string;
  isExternal: boolean;
  fromNumber: number;
  toNumber: number;
  currentNumber: number;
  status: string;
}

export interface MaterialRangeGroupOption {
  internalKey: string;
  externalKey: string;
  description: string;
}

async function materialIntervals(
  tx: Tx,
  client: string,
) {
  return tx
    .select()
    .from(numberRange)
    .where(
      and(
        eq(numberRange.client, client),
        eq(numberRange.objectCode, 'MATERIALNR'),
        eq(numberRange.companyCode, '*'),
        eq(numberRange.fiscalYear, 0),
      ),
    );
}

export async function listMaterialNumberRangeGroups(client: string): Promise<{
  groups: MaterialRangeGroupRow[];
  ungrouped: UngroupedIntervalRow[];
}> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const groupRows = await tx
      .select()
      .from(materialNumberRangeGroup)
      .where(eq(materialNumberRangeGroup.client, tenant))
      .orderBy(materialNumberRangeGroup.internalRangeKey, materialNumberRangeGroup.externalRangeKey);
    const intervals = await materialIntervals(tx, tenant);
    const byKey = new Map(intervals.map((r) => [r.subObject, r]));
    const types = await tx
      .select({
        materialType: materialType.materialType,
        internalNumberRange: materialType.internalNumberRange,
        externalNumberRange: materialType.externalNumberRange,
      })
      .from(materialType)
      .where(eq(materialType.client, tenant));

    const groupedKeys = new Set<string>();
    const groups: MaterialRangeGroupRow[] = groupRows.map((g) => {
      groupedKeys.add(g.internalRangeKey);
      groupedKeys.add(g.externalRangeKey);
      const internal = byKey.get(g.internalRangeKey);
      const external = byKey.get(g.externalRangeKey);
      return {
        internalKey: g.internalRangeKey,
        externalKey: g.externalRangeKey,
        description: g.description,
        internalFrom: internal?.fromNumber ?? 0,
        internalTo: internal?.toNumber ?? 0,
        internalCurrent: internal?.currentNumber ?? 0,
        internalStatus: internal?.status ?? 'MISSING',
        externalFrom: external?.fromNumber ?? 0,
        externalTo: external?.toNumber ?? 0,
        externalCurrent: external?.currentNumber ?? 0,
        externalStatus: external?.status ?? 'MISSING',
        assignedTypes: types
          .filter(
            (t) =>
              t.internalNumberRange === g.internalRangeKey &&
              t.externalNumberRange === g.externalRangeKey,
          )
          .map((t) => t.materialType),
      };
    });
    const ungrouped: UngroupedIntervalRow[] = intervals
      .filter((r) => !groupedKeys.has(r.subObject))
      .map((r) => ({
        rangeKey: r.subObject,
        isExternal: r.isExternal,
        fromNumber: r.fromNumber,
        toNumber: r.toNumber,
        currentNumber: r.currentNumber,
        status: r.status,
      }))
      .sort((a, b) => a.rangeKey.localeCompare(b.rangeKey));
    return { groups, ungrouped };
  });
}

/** The pair-and-text list other screens pick from (OMS2 group picker). */
export async function listMaterialRangeGroupOptions(
  client: string,
): Promise<MaterialRangeGroupOption[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(materialNumberRangeGroup)
      .where(eq(materialNumberRangeGroup.client, tenant))
      .orderBy(materialNumberRangeGroup.internalRangeKey, materialNumberRangeGroup.externalRangeKey);
    return rows.map((g) => ({
      internalKey: g.internalRangeKey,
      externalKey: g.externalRangeKey,
      description: g.description,
    }));
  });
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface MaterialRangeGroupInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  internalRangeKey: string;
  externalRangeKey: string;
  description: string;
  reason: string;
}

async function judgeInterval(
  tx: Tx,
  client: string,
  key: string,
  external: boolean,
) {
  const [range] = await tx
    .select()
    .from(numberRange)
    .where(
      and(
        eq(numberRange.client, client),
        eq(numberRange.objectCode, 'MATERIALNR'),
        eq(numberRange.companyCode, '*'),
        eq(numberRange.subObject, key),
        eq(numberRange.fiscalYear, 0),
      ),
    );
  const label = external ? 'external' : 'internal';
  if (!range || range.isExternal !== external) {
    throw new MaterialRangeGroupError(
      `No ${label} material number range ${key} stands.`,
      `Define an ${label} interval for object MATERIALNR under key ${key} on the number ranges screen, then save again.`,
    );
  }
  if (range.status !== 'ACTIVE') {
    throw new MaterialRangeGroupError(
      `The ${label} material number range ${key} is ${range.status.toLowerCase()}.`,
      'Unblock the interval on the number ranges screen, then save again.',
    );
  }
}

export async function saveMaterialNumberRangeGroup(input: MaterialRangeGroupInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const internalKey = requireRangeKey(input.internalRangeKey, 'internal');
  const externalKey = requireRangeKey(input.externalRangeKey, 'external');
  if (internalKey === externalKey) {
    throw new MaterialRangeGroupError(
      'The internal and external range keys must differ.',
      'One interval cannot be both assignments; pick two intervals.',
    );
  }
  const description = (input.description ?? '').trim();
  if (!description || description.length > 20) {
    throw new MaterialRangeGroupError(
      'The group description is required and may be at most 20 characters.',
      'Enter a description within the limit and save again.',
    );
  }
  const objectKey = `${internalKey}/${externalKey}`;

  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialNumberRangeGroup)
      .where(
        and(
          eq(materialNumberRangeGroup.client, client),
          eq(materialNumberRangeGroup.internalRangeKey, internalKey),
          eq(materialNumberRangeGroup.externalRangeKey, externalKey),
        ),
      )
      .for('update');

    if (input.mode === 'CREATE') {
      if (existing) {
        throw new MaterialRangeGroupError(
          `A number range group already stands for intervals ${internalKey} and ${externalKey}.`,
          'Change the standing group, or pair two other intervals.',
        );
      }
      await judgeInterval(tx, client, internalKey, false);
      await judgeInterval(tx, client, externalKey, true);
      await tx.insert(materialNumberRangeGroup).values({
        client,
        internalRangeKey: internalKey,
        externalRangeKey: externalKey,
        description,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey,
        changeType: 'CREATE',
        changedBy,
        reason,
        transactionCode: ACTIVITY,
        after: { internalRangeKey: internalKey, externalRangeKey: externalKey, description },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { internalKey, externalKey, changed: true };
    }

    if (!existing) {
      throw new MaterialRangeGroupError(
        `No number range group stands for intervals ${internalKey} and ${externalKey}.`,
        'Create it first, then change it.',
      );
    }
    if (existing.description === description) {
      return { internalKey, externalKey, changed: false };
    }
    await tx
      .update(materialNumberRangeGroup)
      .set({ description, changedBy, changedAt: new Date() })
      .where(
        and(
          eq(materialNumberRangeGroup.client, client),
          eq(materialNumberRangeGroup.internalRangeKey, internalKey),
          eq(materialNumberRangeGroup.externalRangeKey, externalKey),
        ),
      );
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { description: existing.description },
      after: { description },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { internalKey, externalKey, changed: true };
  });
}

export interface MaterialRangeGroupKeyInput {
  client: string;
  changedBy: string;
  internalRangeKey: string;
  externalRangeKey: string;
  reason: string;
}

export async function deleteMaterialNumberRangeGroup(input: MaterialRangeGroupKeyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const internalKey = requireRangeKey(input.internalRangeKey, 'internal');
  const externalKey = requireRangeKey(input.externalRangeKey, 'external');
  const objectKey = `${internalKey}/${externalKey}`;
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialNumberRangeGroup)
      .where(
        and(
          eq(materialNumberRangeGroup.client, client),
          eq(materialNumberRangeGroup.internalRangeKey, internalKey),
          eq(materialNumberRangeGroup.externalRangeKey, externalKey),
        ),
      )
      .for('update');
    if (!existing) {
      throw new MaterialRangeGroupError(
        `No number range group stands for intervals ${internalKey} and ${externalKey}.`,
      );
    }
    const [usage] = await tx
      .select({ n: count() })
      .from(materialType)
      .where(
        and(
          eq(materialType.client, client),
          eq(materialType.internalNumberRange, internalKey),
          eq(materialType.externalNumberRange, externalKey),
        ),
      );
    const used = Number(usage?.n ?? 0);
    if (used > 0) {
      throw new MaterialRangeGroupError(
        `This number range group cannot be deleted: ${used} material type${used === 1 ? '' : 's'} carr${used === 1 ? 'ies' : 'y'} its intervals.`,
        'Assign those types other ranges on the material types screen first; the group then deletes freely.',
      );
    }
    await tx
      .delete(materialNumberRangeGroup)
      .where(
        and(
          eq(materialNumberRangeGroup.client, client),
          eq(materialNumberRangeGroup.internalRangeKey, internalKey),
          eq(materialNumberRangeGroup.externalRangeKey, externalKey),
        ),
      );
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey,
      changeType: 'DELETE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { ...existing },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { internalKey, externalKey, changed: true };
  });
}
