import { and, count, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { industrySector, material } from './schema';

/**
 * Industry sector definition (SCR-052 / OMS3; R-100).
 *
 * The one-character sector key a material is created under, maintained
 * as a tenant master in the standing shape: the standard sectors are
 * delivered per tenant, the key is never renamed, deletion is hard and
 * refused while materials carry the sector with the count named, and
 * deactivation stands beside it. One change document per write, a
 * reason on every write.
 */

export const ACTIVITY = 'CFG.INV.INDUSTRYSECTOR.DEFINE';

export class IndustrySectorError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'IndustrySectorError';
  }
}

const OBJECT_CLASS = 'industry_sector';
const PRODUCTION = process.env.NODE_ENV === 'production';

/** The delivered standard sectors (R-100), seeded for every tenant. */
export const INDUSTRY_SECTOR_DEFAULTS = [
  { sector: 'A', name: 'Plant engineering and construction' },
  { sector: 'C', name: 'Chemical industry' },
  { sector: 'M', name: 'Mechanical engineering' },
  { sector: 'P', name: 'Pharmaceuticals' },
  { sector: 'R', name: 'Retail' },
] as const;

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new IndustrySectorError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new IndustrySectorError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new IndustrySectorError(
      'A reason is required for every industry sector change.',
      'State why this change is being made.',
    );
  }
  return value;
}

function requireKey(raw: string): string {
  const key = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]$/.test(key)) {
    throw new IndustrySectorError(
      'The industry sector is exactly one uppercase letter or digit.',
      'Correct the sector key and save again.',
    );
  }
  return key;
}

// ── Reads ────────────────────────────────────────────────────────────────

export interface IndustrySectorRow {
  sector: string;
  name: string;
  isActive: boolean;
  materialCount: number;
}

export async function listIndustrySectors(client: string): Promise<IndustrySectorRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const sectors = await tx
      .select()
      .from(industrySector)
      .where(eq(industrySector.client, tenant))
      .orderBy(industrySector.sector);
    const out: IndustrySectorRow[] = [];
    for (const s of sectors) {
      const [row] = await tx
        .select({ n: count() })
        .from(material)
        .where(and(eq(material.client, tenant), eq(material.industrySector, s.sector)));
      out.push({ ...s, materialCount: Number(row?.n ?? 0) });
    }
    return out;
  });
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface IndustrySectorInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  sector: string;
  name: string;
  reason: string;
}

export async function saveIndustrySector(input: IndustrySectorInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = requireKey(input.sector);
  const name = (input.name ?? '').trim();
  if (!name || name.length > 40) {
    throw new IndustrySectorError(
      'The sector name is required and may be at most 40 characters.',
      'Enter a name within the limit and save again.',
    );
  }

  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(industrySector)
      .where(and(eq(industrySector.client, client), eq(industrySector.sector, key)))
      .for('update');

    if (input.mode === 'CREATE') {
      if (existing) {
        throw new IndustrySectorError(
          `Industry sector ${key} already stands.`,
          'Change the standing sector, or choose a new key.',
        );
      }
      await tx.insert(industrySector).values({
        client,
        sector: key,
        name,
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
        after: { sector: key, name },
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { sector: key, changed: true };
    }

    if (!existing) {
      throw new IndustrySectorError(
        `Industry sector ${key} does not stand.`,
        'Create it first, then change it.',
      );
    }
    if (existing.name === name) return { sector: key, changed: false };
    await tx
      .update(industrySector)
      .set({ name, changedBy, changedAt: new Date() })
      .where(and(eq(industrySector.client, client), eq(industrySector.sector, key)));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { name: existing.name },
      after: { name },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { sector: key, changed: true };
  });
}

export interface IndustrySectorKeyInput {
  client: string;
  changedBy: string;
  sector: string;
  reason: string;
}

export async function setIndustrySectorActive(
  input: IndustrySectorKeyInput & { active: boolean },
) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = requireKey(input.sector);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(industrySector)
      .where(and(eq(industrySector.client, client), eq(industrySector.sector, key)))
      .for('update');
    if (!existing) throw new IndustrySectorError(`Industry sector ${key} does not stand.`);
    if (existing.isActive === input.active) return { sector: key, changed: false };
    await tx
      .update(industrySector)
      .set({ isActive: input.active, changedBy, changedAt: new Date() })
      .where(and(eq(industrySector.client, client), eq(industrySector.sector, key)));
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
    return { sector: key, changed: true };
  });
}

export async function deleteIndustrySector(input: IndustrySectorKeyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = requireKey(input.sector);
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(industrySector)
      .where(and(eq(industrySector.client, client), eq(industrySector.sector, key)))
      .for('update');
    if (!existing) throw new IndustrySectorError(`Industry sector ${key} does not stand.`);
    const [usage] = await tx
      .select({ n: count() })
      .from(material)
      .where(and(eq(material.client, client), eq(material.industrySector, key)));
    const used = Number(usage?.n ?? 0);
    if (used > 0) {
      throw new IndustrySectorError(
        `Industry sector ${key} cannot be deleted: ${used} material${used === 1 ? '' : 's'} carr${used === 1 ? 'ies' : 'y'} it.`,
        'Move those materials to another sector or deactivate this one instead; it stops new materials while its materials stand.',
      );
    }
    await tx
      .delete(industrySector)
      .where(and(eq(industrySector.client, client), eq(industrySector.sector, key)));
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
    return { sector: key, changed: true };
  });
}
