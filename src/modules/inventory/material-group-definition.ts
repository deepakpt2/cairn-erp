import { and, count, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { material, materialGroup } from './schema';

/**
 * Material group definition (SCR-049 / OMSF; R-97).
 *
 * The material group table stands from the materials build; this is
 * the service that maintains it, at the contract's parity: keys of at
 * most nine letters or digits, a required short description of at most
 * 20 characters with an optional long description of at most 60 on the
 * row, and classification-only scope — no numbering, valuation or
 * period behaviour attaches to a group. The key is never renamed;
 * deletion is hard and refused while materials carry the group, with
 * deactivation standing beside it. One change document per write, a
 * reason on every write.
 */

export const ACTIVITY = 'CFG.INV.MATERIALGROUP.DEFINE';

export class MaterialGroupError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'MaterialGroupError';
  }
}

const OBJECT_CLASS = 'material_group';
const PRODUCTION = process.env.NODE_ENV === 'production';

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new MaterialGroupError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new MaterialGroupError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new MaterialGroupError(
      'A reason is required for every material group change.',
      'State why this change is being made.',
    );
  }
  return value;
}

// ── Reads ────────────────────────────────────────────────────────────────

export interface MaterialGroupRow {
  materialGroup: string;
  name: string;
  longDescription: string | null;
  isActive: boolean;
  materialCount: number;
}

export async function listMaterialGroups(client: string): Promise<MaterialGroupRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const groups = await tx
      .select()
      .from(materialGroup)
      .where(eq(materialGroup.client, tenant))
      .orderBy(materialGroup.materialGroup);
    const out: MaterialGroupRow[] = [];
    for (const g of groups) {
      const [row] = await tx
        .select({ n: count() })
        .from(material)
        .where(and(eq(material.client, tenant), eq(material.materialGroup, g.materialGroup)));
      out.push({ ...g, materialCount: Number(row?.n ?? 0) });
    }
    return out;
  });
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface MaterialGroupInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  materialGroup: string;
  name: string;
  longDescription: string;
  reason: string;
}

export async function saveMaterialGroup(input: MaterialGroupInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = (input.materialGroup ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,9}$/.test(key)) {
    throw new MaterialGroupError(
      'Material group must be one to 9 uppercase letters or digits.',
      'Correct the group key and save again.',
    );
  }
  const name = (input.name ?? '').trim();
  if (!name || name.length > 20) {
    throw new MaterialGroupError(
      'The short description is required and may be at most 20 characters.',
      'Enter a short description within the limit and save again.',
    );
  }
  const longDescription = (input.longDescription ?? '').trim();
  if (longDescription.length > 60) {
    throw new MaterialGroupError(
      'The long description may be at most 60 characters.',
      'Shorten the long description and save again.',
    );
  }

  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialGroup)
      .where(and(eq(materialGroup.client, client), eq(materialGroup.materialGroup, key)))
      .for('update');
    const values = { name, longDescription: longDescription || null };

    if (input.mode === 'CREATE') {
      if (existing) {
        throw new MaterialGroupError(
          `Material group ${key} already stands.`,
          'Change the standing group, or choose a new key.',
        );
      }
      await tx.insert(materialGroup).values({
        ...values,
        client,
        materialGroup: key,
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
        after: { materialGroup: key, ...values },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { materialGroup: key, changed: true };
    }

    if (!existing) {
      throw new MaterialGroupError(
        `Material group ${key} does not stand.`,
        'Create it first, then change it.',
      );
    }
    if (existing.name === values.name && existing.longDescription === values.longDescription) {
      return { materialGroup: key, changed: false };
    }
    await tx
      .update(materialGroup)
      .set({ ...values, changedBy, changedAt: new Date() })
      .where(and(eq(materialGroup.client, client), eq(materialGroup.materialGroup, key)));
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
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { materialGroup: key, changed: true };
  });
}

export interface MaterialGroupKeyInput {
  client: string;
  changedBy: string;
  materialGroup: string;
  reason: string;
}

export async function setMaterialGroupActive(
  input: MaterialGroupKeyInput & { active: boolean },
) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = (input.materialGroup ?? '').trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialGroup)
      .where(and(eq(materialGroup.client, client), eq(materialGroup.materialGroup, key)))
      .for('update');
    if (!existing) throw new MaterialGroupError(`Material group ${key} does not stand.`);
    if (existing.isActive === input.active) return { materialGroup: key, changed: false };
    await tx
      .update(materialGroup)
      .set({ isActive: input.active, changedBy, changedAt: new Date() })
      .where(and(eq(materialGroup.client, client), eq(materialGroup.materialGroup, key)));
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
    return { materialGroup: key, changed: true };
  });
}

export async function deleteMaterialGroup(input: MaterialGroupKeyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = (input.materialGroup ?? '').trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialGroup)
      .where(and(eq(materialGroup.client, client), eq(materialGroup.materialGroup, key)))
      .for('update');
    if (!existing) throw new MaterialGroupError(`Material group ${key} does not stand.`);
    const [usage] = await tx
      .select({ n: count() })
      .from(material)
      .where(and(eq(material.client, client), eq(material.materialGroup, key)));
    const used = Number(usage?.n ?? 0);
    if (used > 0) {
      throw new MaterialGroupError(
        `Material group ${key} cannot be deleted: ${used} material${used === 1 ? '' : 's'} carr${used === 1 ? 'ies' : 'y'} it.`,
        'Reclassify those materials or deactivate the group instead; it stops new materials while its materials stand.',
      );
    }
    await tx
      .delete(materialGroup)
      .where(and(eq(materialGroup.client, client), eq(materialGroup.materialGroup, key)));
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
    return { materialGroup: key, changed: true };
  });
}
