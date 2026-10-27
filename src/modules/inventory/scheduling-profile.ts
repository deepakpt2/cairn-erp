/**
 * OPKP — production scheduling profile. The table is TCO43, not T399X.
 *
 * The key is the plant and CO_PRODPRF, stored as typed, at most six characters.
 * The description is PRODPRF_TX in the tenant language. One language row per
 * language key is not stored.
 *
 * Only settings this system can execute are saved:
 * - FLG_REL_CR, domain KREUZ: X releases at creation, blank does not.
 * - KZBCR: blank creates no batch, 1 creates one at order creation, 2 at release.
 *
 * Print, scheduling, availability, capacity, automatic goods receipt,
 * classification, warehouse, document links, and order types are not saved.
 * A checkbox that nothing consumes is not shown.
 */
import { and, asc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { plant as plantTable } from '../foundation/schema';
import { allocateInternalBatchNumber, BatchNumberAssignmentError } from './batch-number-assignment';
import { readLevel } from './batch-master';
import { decideInitialRestrictedUse, InitialBatchStatusError } from './initial-batch-status';
import {
  batch,
  material,
  materialPlant,
  productionSchedulingProfile,
} from './schema';

export const ACTIVITY = 'CFG.PROD.SCHEDPROFILE.DEFINE';
export const ROUTE = '/config/scheduling-profiles';
export const ALIAS = 'OPKP';
export const LOCK_OBJECT = 'SCHEDULING_PROFILE';

export class SchedulingProfileError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SchedulingProfileError';
    this.remedy = remedy;
  }
}

export type ReleaseOnCreate = 'X' | ' ';
export type BatchCreation = ' ' | '1' | '2';

export interface SchedulingProfileRow {
  plant: string;
  plantName: string;
  profile: string;
  description: string;
  releaseOnCreate: ReleaseOnCreate;
  batchCreation: BatchCreation;
  version: number;
}

export interface SchedulingAssignmentRow {
  materialNumber: string;
  plant: string;
  profile: string;
  version: number;
}

function requireProfileKey(raw: string): string {
  if (raw !== raw.trim()) {
    throw new SchedulingProfileError(
      'The profile key has surrounding spaces. They were not removed. Nothing was saved.',
      'Type the key without surrounding spaces. Leading characters are kept.',
    );
  }
  if (raw.length < 1 || raw.length > 6) {
    throw new SchedulingProfileError(
      `The profile key is ${raw.length} characters. It must be 1 to 6. It was not truncated.`,
      'Shorten the key. The stored value is the characters you type.',
    );
  }
  return raw;
}

function requireDescription(raw: string): string {
  const description = raw.trim();
  if (!description || description.length > 40) {
    throw new SchedulingProfileError(
      'The description is required and may be at most 40 characters.',
      'Enter the description in the tenant language.',
    );
  }
  return description;
}

function requireRelease(raw: string): ReleaseOnCreate {
  if (raw === 'X') return 'X';
  if (raw === '' || raw === ' ') return ' ';
  throw new SchedulingProfileError(
    `Release at creation ${raw} is not the character X or blank. Nothing was saved.`,
    'Use X to release at creation, or leave it blank.',
  );
}

function requireBatchCreation(raw: string): BatchCreation {
  if (raw === '' || raw === ' ') return ' ';
  if (raw === '1' || raw === '2') return raw;
  throw new SchedulingProfileError(
    `Batch creation ${raw} is not blank, 1, or 2. Nothing was saved.`,
    'Blank creates no batch. 1 creates one at order creation. 2 creates one at release.',
  );
}

function flag(value: string | null | undefined): ReleaseOnCreate {
  return value?.trim() === 'X' ? 'X' : ' ';
}

function creation(value: string | null | undefined): BatchCreation {
  const code = value?.trim();
  return code === '1' || code === '2' ? code : ' ';
}

export async function listSchedulingProfiles(client: string, plantCode?: string): Promise<{
  profiles: SchedulingProfileRow[];
  assignments: SchedulingAssignmentRow[];
}> {
  return withTenant(client, async (tx) => {
    const plantFilter = plantCode?.trim();
    const profiles = await tx.select({
      plant: productionSchedulingProfile.plant,
      plantName: plantTable.name,
      profile: productionSchedulingProfile.profile,
      description: productionSchedulingProfile.description,
      releaseOnCreate: productionSchedulingProfile.releaseOnCreate,
      batchCreation: productionSchedulingProfile.batchCreation,
      version: productionSchedulingProfile.version,
    }).from(productionSchedulingProfile)
      .innerJoin(plantTable, and(
        eq(plantTable.client, productionSchedulingProfile.client),
        eq(plantTable.plant, productionSchedulingProfile.plant),
      ))
      .where(plantFilter
        ? and(eq(productionSchedulingProfile.client, client), eq(productionSchedulingProfile.plant, plantFilter))
        : eq(productionSchedulingProfile.client, client))
      .orderBy(asc(productionSchedulingProfile.plant), asc(productionSchedulingProfile.profile));
    const assignments = await tx.select({
      materialNumber: materialPlant.materialNumber,
      plant: materialPlant.plant,
      profile: materialPlant.schedulingProfile,
      version: materialPlant.version,
    }).from(materialPlant)
      .where(plantFilter
        ? and(eq(materialPlant.client, client), eq(materialPlant.plant, plantFilter))
        : eq(materialPlant.client, client))
      .orderBy(asc(materialPlant.plant), asc(materialPlant.materialNumber))
      .limit(100);
    return {
      profiles: profiles.map((row) => ({
        plant: row.plant,
        plantName: row.plantName,
        profile: row.profile,
        description: row.description,
        releaseOnCreate: flag(row.releaseOnCreate),
        batchCreation: creation(row.batchCreation),
        version: row.version,
      })),
      assignments: assignments
        .filter((row) => row.profile)
        .map((row) => ({
          materialNumber: row.materialNumber,
          plant: row.plant,
          profile: row.profile ?? '',
          version: row.version,
        })),
    };
  });
}

export async function saveSchedulingProfile(input: {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  plant: string;
  profile: string;
  description: string;
  releaseOnCreate: string;
  batchCreation: string;
  version: number;
  reason: string;
}): Promise<SchedulingProfileRow> {
  const plantCode = input.plant.trim();
  const profile = requireProfileKey(input.profile);
  const description = requireDescription(input.description);
  const releaseOnCreate = requireRelease(input.releaseOnCreate);
  const batchCreation = requireBatchCreation(input.batchCreation);
  const reason = input.reason.trim();
  if (!plantCode) {
    throw new SchedulingProfileError('A plant is required. Nothing was saved.', 'Choose a plant from the plant master.');
  }
  if (!reason) {
    throw new SchedulingProfileError('A reason is required. Nothing was saved.', 'Say why this profile is saved.');
  }

  return withTenant(input.client, async (tx) => {
    const [plantRow] = await tx.select({ name: plantTable.name }).from(plantTable)
      .where(and(eq(plantTable.client, input.client), eq(plantTable.plant, plantCode)));
    if (!plantRow) {
      throw new SchedulingProfileError(
        `Plant ${plantCode} does not stand. Nothing was saved.`,
        'Choose a plant from the plant master. The profile is not a plant.',
      );
    }
    const [existing] = await tx.select().from(productionSchedulingProfile)
      .where(and(
        eq(productionSchedulingProfile.client, input.client),
        eq(productionSchedulingProfile.plant, plantCode),
        eq(productionSchedulingProfile.profile, profile),
      ))
      .for('update');
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new SchedulingProfileError(
          `Profile ${profile} already stands in plant ${plantCode}. Nothing was saved.`,
          'Change the standing profile, or choose another key.',
        );
      }
      await tx.insert(productionSchedulingProfile).values({
        client: input.client,
        plant: plantCode,
        profile,
        description,
        releaseOnCreate,
        batchCreation,
        version: 1,
        createdBy: input.changedBy,
      });
    } else {
      if (!existing) {
        throw new SchedulingProfileError(
          `Profile ${profile} does not stand in plant ${plantCode}. Nothing was saved.`,
          'Create it first.',
        );
      }
      if (existing.version !== input.version) {
        throw new SchedulingProfileError(
          `Profile ${profile} was opened at version ${input.version}, and version ${existing.version} now stands. Nothing was saved.`,
          'Reload the profile and save again.',
        );
      }
      await tx.update(productionSchedulingProfile).set({
        description,
        releaseOnCreate,
        batchCreation,
        version: existing.version + 1,
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(productionSchedulingProfile.client, input.client),
        eq(productionSchedulingProfile.plant, plantCode),
        eq(productionSchedulingProfile.profile, profile),
      ));
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_scheduling_profile',
      objectKey: `${plantCode}/${profile}`,
      changeType: input.mode === 'CREATE' ? 'CREATE' : 'CHANGE',
      changedBy: input.changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: existing ? {
        description: existing.description,
        releaseOnCreate: existing.releaseOnCreate,
        batchCreation: existing.batchCreation,
        version: existing.version,
      } : undefined,
      after: {
        description,
        releaseOnCreate,
        batchCreation,
        version: existing ? existing.version + 1 : 1,
      },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return {
      plant: plantCode,
      plantName: plantRow.name,
      profile,
      description,
      releaseOnCreate,
      batchCreation,
      version: existing ? existing.version + 1 : 1,
    };
  });
}

export async function assignSchedulingProfile(input: {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant: string;
  profile: string;
  expectedVersion: number;
  reason: string;
}): Promise<{ materialNumber: string; plant: string; profile: string; version: number }> {
  const materialNumber = input.materialNumber.trim();
  const plantCode = input.plant.trim();
  const profile = input.profile.trim() === '' ? '' : requireProfileKey(input.profile);
  const reason = input.reason.trim();
  if (!materialNumber || !plantCode) {
    throw new SchedulingProfileError('A material and a plant are required. Nothing was assigned.', 'Name both.');
  }
  if (!reason) {
    throw new SchedulingProfileError('A reason is required. Nothing was assigned.', 'Say why the assignment changes.');
  }

  return withTenant(input.client, async (tx) => {
    const [view] = await tx.select().from(materialPlant)
      .where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, materialNumber),
        eq(materialPlant.plant, plantCode),
      ))
      .for('update');
    if (!view) {
      throw new SchedulingProfileError(
        `Material ${materialNumber} has no plant view in ${plantCode}. Nothing was assigned.`,
        'Create the plant view first. This screen does not create one.',
      );
    }
    if (view.version !== input.expectedVersion) {
      throw new SchedulingProfileError(
        `Material ${materialNumber} in plant ${plantCode} was opened at version ${input.expectedVersion}, and version ${view.version} now stands. Nothing was assigned.`,
        'Reload the assignment and save again.',
      );
    }
    if (profile) {
      const [standing] = await tx.select({ profile: productionSchedulingProfile.profile })
        .from(productionSchedulingProfile)
        .where(and(
          eq(productionSchedulingProfile.client, input.client),
          eq(productionSchedulingProfile.plant, plantCode),
          eq(productionSchedulingProfile.profile, profile),
        ));
      if (!standing) {
        throw new SchedulingProfileError(
          `Profile ${profile} does not stand in plant ${plantCode}. Nothing was assigned.`,
          'Create the profile for this plant. A profile from another plant is not used.',
        );
      }
    }
    const next = profile || null;
    await tx.update(materialPlant).set({
      schedulingProfile: next,
      version: view.version + 1,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(materialPlant.client, input.client),
      eq(materialPlant.materialNumber, materialNumber),
      eq(materialPlant.plant, plantCode),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'material_plant',
      objectKey: `${materialNumber}/${plantCode}`,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { schedulingProfile: view.schedulingProfile ?? '' },
      after: { schedulingProfile: profile },
    });
    return { materialNumber, plant: plantCode, profile, version: view.version + 1 };
  });
}

export interface OrderProfileSnapshot {
  profile: string;
  releaseOnCreate: ReleaseOnCreate;
  batchCreation: BatchCreation;
}

/** The profile on the material plant view, snapshotted by the order. */
export async function readMaterialSchedulingProfile(
  tx: Tx,
  client: string,
  materialNumber: string,
  plantCode: string,
): Promise<OrderProfileSnapshot | null> {
  const [view] = await tx.select({ profile: materialPlant.schedulingProfile }).from(materialPlant)
    .where(and(
      eq(materialPlant.client, client),
      eq(materialPlant.materialNumber, materialNumber),
      eq(materialPlant.plant, plantCode),
    ));
  const profile = view?.profile?.trim() ?? '';
  if (!profile) return null;
  const [row] = await tx.select().from(productionSchedulingProfile)
    .where(and(
      eq(productionSchedulingProfile.client, client),
      eq(productionSchedulingProfile.plant, plantCode),
      eq(productionSchedulingProfile.profile, profile),
    ));
  if (!row) {
    throw new SchedulingProfileError(
      `Profile ${profile} is assigned to ${materialNumber} in plant ${plantCode}, and that profile does not stand. No order was saved.`,
      'Assign a standing profile, or clear the assignment.',
    );
  }
  return {
    profile: row.profile,
    releaseOnCreate: flag(row.releaseOnCreate),
    batchCreation: creation(row.batchCreation),
  };
}

/**
 * Create the order batch when the snapshotted KZBCR asks for it at this moment.
 * A batch already named is kept. Goods movements do not call this.
 */
export async function ensureOrderBatch(tx: Tx, input: {
  client: string;
  materialNumber: string;
  plant: string;
  batchNumber: string;
  batchCreation: BatchCreation;
  moment: 'CREATE' | 'RELEASE';
  changedBy: string;
}): Promise<string> {
  if (input.batchNumber) return input.batchNumber;
  const needed = (input.moment === 'CREATE' && input.batchCreation === '1')
    || (input.moment === 'RELEASE' && input.batchCreation === '2');
  if (!needed) return '';

  const level = await readLevel(tx, input.client);
  if (!level) {
    throw new SchedulingProfileError(
      'No batch level stands. No batch was created.',
      'Set the batch level before a profile creates a batch.',
    );
  }
  const [produced] = await tx.select({
    materialType: material.materialType,
    batchManaged: material.batchManaged,
  }).from(material).where(and(eq(material.client, input.client), eq(material.materialNumber, input.materialNumber)));
  if (!produced) {
    throw new SchedulingProfileError(
      `Material ${input.materialNumber} does not stand. No batch was created.`,
      'Create the material first.',
    );
  }
  let managed = produced.batchManaged;
  if (level === '0') {
    const [plantView] = await tx.select({ batchManaged: materialPlant.batchManaged }).from(materialPlant)
      .where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, input.materialNumber),
        eq(materialPlant.plant, input.plant),
      ));
    managed = plantView?.batchManaged === true;
  }
  if (!managed) {
    throw new SchedulingProfileError(
      `Material ${input.materialNumber} is not batch-managed. No batch was created.`,
      'Set the batch indicator, or clear batch creation on the profile.',
    );
  }
  let batchNumber: string;
  try {
    batchNumber = await allocateInternalBatchNumber(tx, input.client, input.changedBy);
  } catch (caught) {
    if (caught instanceof BatchNumberAssignmentError) {
      throw new SchedulingProfileError(caught.message, caught.remedy);
    }
    throw caught;
  }
  let restrictedUse: 'X' | ' ' | null = null;
  try {
    const decision = await decideInitialRestrictedUse(tx, {
      client: input.client,
      materialType: produced.materialType,
      batchLevel: level,
      plant: input.plant,
    });
    restrictedUse = decision.restrictedUse;
  } catch (caught) {
    if (caught instanceof InitialBatchStatusError) throw new SchedulingProfileError(caught.message, caught.remedy);
    throw caught;
  }
  const plant = level === '0' ? input.plant : null;
  const id = crypto.randomUUID();
  await tx.insert(batch).values({
    id,
    client: input.client,
    batchNumber,
    materialNumber: input.materialNumber,
    plant,
    batchLevelAtCreation: level,
    restrictedUse,
    createdBy: input.changedBy,
    changedBy: input.changedBy,
  });
  await recordChange(tx, {
    client: input.client,
    objectClass: 'batch',
    objectKey: id,
    changeType: 'CREATE',
    changedBy: input.changedBy,
    transactionCode: 'MSC1N',
    reason: `Profile batch at order ${input.moment === 'CREATE' ? 'creation' : 'release'}`,
    after: { materialNumber: input.materialNumber, plant, batchNumber, batchLevel: level },
  });
  return batchNumber;
}

export const NOT_EXECUTED = [
  'print at release',
  'schedule at release',
  'material availability',
  'capacity leveling',
  'finite scheduling',
  'automatic goods receipt',
  'batch classification',
  'warehouse transfer requirement',
  'order type',
] as const;
