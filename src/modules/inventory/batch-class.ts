/**
 * Batch class — BMC1 create, BMC2 change, BMC3 display.
 *
 * This is not CL01. A batch class is stored in the standing class and
 * class-assignment tables. The class type is derived from the batch
 * level: 022 when the level is plant, 023 when it is material or client.
 * It is not hard-coded to 023, and it is not the house word BATCH.
 *
 * A class does not assign itself to a material or a batch. It does not
 * store a characteristic value, and it does not make batch determination
 * run. Opening this screen writes nothing.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { characteristic, classAssignment, classType, classificationClass } from '../foundation/characteristic-schema';
import { batchLevelConfiguration } from './schema';

export const ACTIVITY = 'INV.BATCHCLASS.MAINTAIN';
export const ROUTE = '/inventory/batch-classes';
export const ALIAS = 'BMC1';
export const CHANGE_ALIAS = 'BMC2';
export const DISPLAY_ALIAS = 'BMC3';
export const LOCK_OBJECT = 'BATCH_CLASS';
const OBJECT_CLASS = 'classification_class';
const PRODUCTION = process.env.NODE_ENV === 'production';

export const PLANT_BATCH_CLASS_TYPE = '022';
export const MATERIAL_BATCH_CLASS_TYPE = '023';
export const BATCH_CLASS_TYPES = [PLANT_BATCH_CLASS_TYPE, MATERIAL_BATCH_CLASS_TYPE] as const;

const TYPE_COPY: Record<string, string> = {
  [PLANT_BATCH_CLASS_TYPE]: 'Batch class at plant level',
  [MATERIAL_BATCH_CLASS_TYPE]: 'Batch class at material or client level',
};

export const NOT_EXECUTED = [
  {
    field: 'OBJEK',
    title: 'Object assignment',
    reason: 'Creating a class does not assign it to a material or a batch.',
  },
  {
    field: 'AUSP',
    title: 'Characteristic value',
    reason: 'A batch value is not stored. This screen does not classify a batch.',
  },
  {
    field: 'KLAH-STATU',
    title: 'Released or locked status',
    reason: 'No released or locked status is invented. The standing class lifecycle is left as it is.',
  },
  {
    field: 'LANGUAGE',
    title: 'Language-dependent description',
    reason: 'One description is stored. A language table is not stored.',
  },
  {
    field: 'DETERMINATION',
    title: 'Batch determination',
    reason: 'A standing class is not consumed by a goods movement. No batch is proposed.',
  },
] as const;

export class BatchClassError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(message: string, code: string, remedy: string) {
    super(message);
    this.name = 'BatchClassError';
    this.code = code;
    this.remedy = remedy;
  }
}

export interface BatchClassAssignment {
  position: number;
  characteristicName: string;
  requiredForClassification: boolean;
  dataFormat: string;
  characteristicStatus: string;
}

export interface BatchClassRow {
  classType: string;
  className: string;
  description: string;
  lifecycleStatus: string;
  currentType: boolean;
  assignments: BatchClassAssignment[];
  version: number;
}

export interface BatchClassChoices {
  batchLevel: string;
  classType: string;
  classTypeDescription: string;
  blocked: string;
  characteristics: Array<{ characteristicName: string; description: string; dataFormat: string; lifecycleStatus: string }>;
  classes: BatchClassRow[];
}

export interface BatchClassInput {
  client: string;
  changedBy: string;
  capabilities?: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  className: string;
  description: string;
  classType?: string;
  assignments: Array<{ characteristicName: string; requiredForClassification: boolean }>;
  expectedVersion: number | null;
  confirmed: boolean;
  reason: string;
  materialNumber?: string;
  batchNumber?: string;
  language?: string;
  lifecycleStatus?: string;
}

function requireText(value: string, code: string, message: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new BatchClassError(message, code, 'Sign in again.');
  return PRODUCTION ? trimmed : trimmed.toUpperCase();
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchClassError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. BMC1 does not use a second permission code.',
    );
  }
}

function classNameOf(raw: string): string {
  const name = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,18}$/.test(name)) {
    throw new BatchClassError(
      'The class name is at most 18 characters of uppercase letters, digits and underscores.',
      'CLASS_NAME',
      'Correct the name and save again.',
    );
  }
  return name;
}

function versionOf(row: { createdAt: Date; changedAt: Date | null }): number {
  return new Date(row.changedAt ?? row.createdAt).getTime();
}

async function derivedType(tx: Tx, client: string): Promise<{ level: string; classType: string } | null> {
  const [row] = await tx.select().from(batchLevelConfiguration)
    .where(eq(batchLevelConfiguration.client, client)).limit(1);
  const level = row?.batchLevel ?? '';
  if (level === '0') return { level, classType: PLANT_BATCH_CLASS_TYPE };
  if (level === '1' || level === '2') return { level, classType: MATERIAL_BATCH_CLASS_TYPE };
  return null;
}

async function ensureType(tx: Tx, client: string, changedBy: string, type: string): Promise<void> {
  await tx.insert(classType).values({
    client,
    classType: type,
    description: TYPE_COPY[type] ?? type,
    objectCategory: 'BATCH',
    isActive: true,
    createdBy: changedBy,
  }).onConflictDoNothing();
}

async function present(tx: Tx, client: string, currentType: string): Promise<BatchClassRow[]> {
  const classes = await tx.select().from(classificationClass).where(and(
    eq(classificationClass.client, client),
    inArray(classificationClass.classType, [...BATCH_CLASS_TYPES]),
  )).orderBy(asc(classificationClass.classType), asc(classificationClass.className));
  const assignments = await tx.select().from(classAssignment).where(and(
    eq(classAssignment.client, client),
    inArray(classAssignment.classType, [...BATCH_CLASS_TYPES]),
  )).orderBy(asc(classAssignment.className), asc(classAssignment.position));
  const chars = await tx.select().from(characteristic).where(eq(characteristic.client, client));
  return classes.map((row) => ({
    classType: row.classType,
    className: row.className,
    description: row.description,
    lifecycleStatus: row.lifecycleStatus,
    currentType: row.classType === currentType,
    version: versionOf(row),
    assignments: assignments
      .filter((item) => item.classType === row.classType && item.className === row.className)
      .map((item) => {
        const char = chars.find((entry) => entry.characteristicName === item.characteristicName);
        return {
          position: item.position,
          characteristicName: item.characteristicName,
          requiredForClassification: item.requiredForClassification,
          dataFormat: char?.dataFormat ?? '',
          characteristicStatus: char?.lifecycleStatus ?? '',
        };
      }),
  }));
}

export async function listBatchClasses(clientKey: string): Promise<BatchClassChoices> {
  const client = requireText(clientKey, 'CLIENT_REQUIRED', 'The tenant is missing.');
  return withTenant(client, async (tx) => {
    const derived = await derivedType(tx, client);
    const chars = await tx.select().from(characteristic)
      .where(eq(characteristic.client, client)).orderBy(asc(characteristic.characteristicName));
    if (!derived) {
      return {
        batchLevel: '',
        classType: '',
        classTypeDescription: '',
        blocked: 'The batch level is not set. A batch class needs 022 or 023, and that type comes from the level. 023 is not assumed.',
        characteristics: [],
        classes: [],
      };
    }
    return {
      batchLevel: derived.level,
      classType: derived.classType,
      classTypeDescription: TYPE_COPY[derived.classType] ?? derived.classType,
      blocked: '',
      characteristics: chars.map((row) => ({
        characteristicName: row.characteristicName,
        description: row.description,
        dataFormat: row.dataFormat,
        lifecycleStatus: row.lifecycleStatus,
      })),
      classes: await present(tx, client, derived.classType),
    };
  });
}

export async function saveBatchClass(input: BatchClassInput): Promise<BatchClassRow> {
  assertAuthority(input.capabilities);
  const client = requireText(input.client, 'CLIENT_REQUIRED', 'The tenant is missing.');
  const changedBy = requireText(input.changedBy, 'ACTOR_REQUIRED', 'The acting user is missing.');
  if (input.confirmed !== true) {
    throw new BatchClassError(
      'The class was not saved. Confirmation is required.',
      'CONFIRM_REQUIRED',
      'Confirm that this saves the class only. It does not assign the class or select a batch.',
    );
  }
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 500) {
    throw new BatchClassError('A reason is required for every batch class change.', 'REASON_REQUIRED', 'State why this change is being made.');
  }
  if ((input.materialNumber ?? '').trim() || (input.batchNumber ?? '').trim()) {
    throw new BatchClassError(
      'A material or a batch cannot be named here. Nothing was saved.',
      'ASSIGNMENT_REFUSED',
      'Create the class only. Assignment is not this screen.',
    );
  }
  if ((input.language ?? '').trim()) {
    throw new BatchClassError(
      'A language is refused. One description is stored.',
      'LANGUAGE_REFUSED',
      'Leave the language blank.',
    );
  }
  if ((input.lifecycleStatus ?? '').trim()) {
    throw new BatchClassError(
      'A released or locked status is refused. Nothing was saved.',
      'STATUS_REFUSED',
      'This screen does not set a status. The standing class lifecycle is left as it is.',
    );
  }
  const name = classNameOf(input.className);
  const description = (input.description ?? '').trim();
  if (!description || description.length > 40) {
    throw new BatchClassError(
      'The description is required and may be at most 40 characters.',
      'DESCRIPTION',
      'Enter one description. A language table is not stored.',
    );
  }
  const seen = new Set<string>();
  const wanted: Array<{ characteristicName: string; requiredForClassification: boolean }> = [];
  for (const assignment of input.assignments ?? []) {
    const key = (assignment.characteristicName ?? '').trim().toUpperCase();
    if (!key) continue;
    if (seen.has(key)) {
      throw new BatchClassError(
        `Characteristic ${key} stands twice in this class.`,
        'DUPLICATE_CHARACTERISTIC',
        'Assign each characteristic at most once.',
      );
    }
    seen.add(key);
    wanted.push({ characteristicName: key, requiredForClassification: assignment.requiredForClassification === true });
  }
  if (wanted.length === 0) {
    throw new BatchClassError(
      'A batch class needs at least one standing characteristic.',
      'CHARACTERISTIC_REQUIRED',
      'Define the characteristic first, then assign it here. This screen does not create a characteristic.',
    );
  }

  return withTenant(client, async (tx) => {
    const derived = await derivedType(tx, client);
    if (!derived) {
      throw new BatchClassError(
        'The batch level is not set. A batch class needs 022 or 023, and that type comes from the level.',
        'LEVEL_REQUIRED',
        'Set the batch level on OMCE, then return. 023 is not assumed.',
      );
    }
    const typed = (input.classType ?? '').trim();
    if (typed && typed !== derived.classType) {
      throw new BatchClassError(
        `Class type ${typed} is refused. The batch level ${derived.level} names ${derived.classType}.`,
        'TYPE_REFUSED',
        'Leave the class type as the level names it. Do not type 023 when the level is plant, or 022 when it is not.',
      );
    }
    await ensureType(tx, client, changedBy, derived.classType);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${client}), hashtext(${`${LOCK_OBJECT}/${derived.classType}/${name}`}))`);
    for (const assignment of wanted) {
      const [char] = await tx.select().from(characteristic).where(and(
        eq(characteristic.client, client),
        eq(characteristic.characteristicName, assignment.characteristicName),
      )).limit(1);
      if (!char) {
        throw new BatchClassError(
          `Characteristic ${assignment.characteristicName} does not stand for this tenant.`,
          'CHARACTERISTIC_UNKNOWN',
          'Define it on the characteristics screen. A characteristic from another tenant is not visible.',
        );
      }
      if (char.lifecycleStatus === 'BLOCKED') {
        throw new BatchClassError(
          `Characteristic ${assignment.characteristicName} is blocked and cannot be newly assigned.`,
          'CHARACTERISTIC_BLOCKED',
          'Reactivate the characteristic, or leave it out of this class.',
        );
      }
    }
    const [existing] = await tx.select().from(classificationClass).where(and(
      eq(classificationClass.client, client),
      eq(classificationClass.classType, derived.classType),
      eq(classificationClass.className, name),
    )).for('update');
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new BatchClassError(
          `Class ${name} already stands under ${derived.classType}.`,
          'CLASS_EXISTS',
          'Change the standing class, or choose a new name.',
        );
      }
      await tx.insert(classificationClass).values({
        client,
        classType: derived.classType,
        className: name,
        description,
        lifecycleStatus: 'DRAFT',
        createdBy: changedBy,
      });
    } else {
      if (!existing) {
        throw new BatchClassError(
          `Class ${name} does not stand under ${derived.classType}.`,
          'CLASS_MISSING',
          'Create it first. A class of the other batch type is not converted here.',
        );
      }
      const version = versionOf(existing);
      if (input.expectedVersion !== version) {
        throw new BatchClassError(
          'This class was saved by someone else. Reload it and enter the change again.',
          'STALE_VERSION',
          'The class type and name stay as they were saved.',
        );
      }
      if (existing.lifecycleStatus === 'BLOCKED') {
        throw new BatchClassError(
          `Class ${name} is blocked; its assignments cannot change while blocked.`,
          'CLASS_BLOCKED',
          'This screen does not invent a released or locked status.',
        );
      }
      await tx.update(classificationClass).set({ description, changedBy, changedAt: new Date() }).where(and(
        eq(classificationClass.client, client),
        eq(classificationClass.classType, derived.classType),
        eq(classificationClass.className, name),
      ));
      await tx.delete(classAssignment).where(and(
        eq(classAssignment.client, client),
        eq(classAssignment.classType, derived.classType),
        eq(classAssignment.className, name),
      ));
    }
    let position = 0;
    for (const assignment of wanted) {
      position += 1;
      await tx.insert(classAssignment).values({
        client,
        classType: derived.classType,
        className: name,
        position,
        characteristicName: assignment.characteristicName,
        requiredForClassification: assignment.requiredForClassification,
        createdBy: changedBy,
      });
    }
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: `${derived.classType}/${name}`,
      changeType: input.mode,
      changedBy,
      reason,
      transactionCode: input.mode === 'CREATE' ? ALIAS : CHANGE_ALIAS,
      after: {
        classType: derived.classType,
        className: name,
        description,
        characteristics: wanted.map((item) => item.characteristicName),
        assignedToMaterial: false,
        assignedToBatch: false,
        determination: 'NOT_EXECUTED',
      },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    const [saved] = (await present(tx, client, derived.classType)).filter((row) => row.classType === derived.classType && row.className === name);
    return saved!;
  });
}

export function evaluateBatchClass(): never {
  throw new BatchClassError(
    'A batch class does not select a batch. Characteristic values are not stored, and batch determination is not executed.',
    'DETERMINATION_NOT_EXECUTED',
    'Creating the class does not assign it to a material or a batch.',
  );
}
