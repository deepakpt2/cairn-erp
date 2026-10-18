/**
 * Classes for classification — SCR-058 / R-106 (CL02 create, CL02
 * change, CL03 display in house terms).
 *
 * A class groups standing characteristics under a class type at
 * ordered positions. Name and type are immutable; the lifecycle is
 * the Cairn DRAFT / ACTIVE / BLOCKED shared with characteristics, and
 * deletion stands only for an assignment-less draft. A BLOCKED
 * characteristic cannot be newly assigned; a BLOCKED class takes no
 * assignment changes. Object classification is a later round — this
 * screen defines the classes the release-strategy round consumes.
 * Maintenance is structural master data: no period gate applies.
 */
import { and, asc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { characteristic, classAssignment, classType, classificationClass } from './characteristic-schema';

export const ACTIVITY = 'CFG.PROC.CLASS.DEFINE';
const OBJECT_CLASS = 'classification_class';
const PRODUCTION = process.env.NODE_ENV === 'production';

/** Delivered class-type catalogue (house words; SAP codes are aliases only). */
export const CLASS_TYPE_DEFAULTS = [
  { classType: 'MATERIAL', description: 'Material classes', objectCategory: 'MATERIAL' },
  { classType: 'BATCH', description: 'Batch classes', objectCategory: 'BATCH' },
  { classType: 'EQUIPMENT', description: 'Equipment classes', objectCategory: 'EQUIPMENT' },
  { classType: 'VARIANT', description: 'Variant configuration classes', objectCategory: 'VARIANT' },
  { classType: 'PURCHASE_REQUISITION', description: 'Purchase requisition release classes', objectCategory: 'PURCHASING' },
  { classType: 'PURCHASE_ORDER', description: 'Purchase order release classes', objectCategory: 'PURCHASING' },
] as const;

export class ClassError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ClassError';
    this.remedy = remedy;
  }
}

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new ClassError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new ClassError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new ClassError('A reason is required for every class change.', 'State why this change is being made.');
  }
  return value;
}

function requireName(raw: string): string {
  const name = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,18}$/.test(name)) {
    throw new ClassError(
      'The class name is at most 18 characters of uppercase letters, digits and underscores.',
      'Correct the name and save again.',
    );
  }
  return name;
}

async function ensureClassTypes(tx: Tx, client: string, changedBy: string): Promise<void> {
  for (const row of CLASS_TYPE_DEFAULTS) {
    await tx.insert(classType).values({ client, createdBy: changedBy, ...row }).onConflictDoNothing();
  }
}

export interface ClassRow {
  classType: string;
  className: string;
  description: string;
  lifecycleStatus: string;
  assignments: Array<{
    position: number;
    characteristicName: string;
    requiredForClassification: boolean;
    dataFormat: string;
    characteristicStatus: string;
  }>;
}

export interface ClassChoices {
  classTypes: Array<{ classType: string; description: string; objectCategory: string }>;
  characteristics: Array<{ characteristicName: string; description: string; dataFormat: string; lifecycleStatus: string }>;
  classes: ClassRow[];
}

export async function listClasses(clientKey: string): Promise<ClassChoices> {
  const client = requireClient(clientKey);
  return withTenant(client, async (tx) => {
    await ensureClassTypes(tx, client, 'SYSTEM');
    const types = await tx.select().from(classType)
      .where(eq(classType.client, client)).orderBy(asc(classType.classType));
    const chars = await tx.select().from(characteristic)
      .where(eq(characteristic.client, client)).orderBy(asc(characteristic.characteristicName));
    const classRows = await tx.select().from(classificationClass)
      .where(eq(classificationClass.client, client))
      .orderBy(asc(classificationClass.classType), asc(classificationClass.className));
    const assignments = await tx.select().from(classAssignment)
      .where(eq(classAssignment.client, client))
      .orderBy(asc(classAssignment.classType), asc(classAssignment.className), asc(classAssignment.position));
    return {
      classTypes: types.filter((t) => t.isActive).map((t) => ({
        classType: t.classType, description: t.description, objectCategory: t.objectCategory,
      })),
      characteristics: chars.map((c) => ({
        characteristicName: c.characteristicName, description: c.description,
        dataFormat: c.dataFormat, lifecycleStatus: c.lifecycleStatus,
      })),
      classes: classRows.map((row) => ({
        classType: row.classType,
        className: row.className,
        description: row.description,
        lifecycleStatus: row.lifecycleStatus,
        assignments: assignments
          .filter((a) => a.classType === row.classType && a.className === row.className)
          .map((a) => {
            const char = chars.find((c) => c.characteristicName === a.characteristicName);
            return {
              position: a.position,
              characteristicName: a.characteristicName,
              requiredForClassification: a.requiredForClassification,
              dataFormat: char?.dataFormat ?? '',
              characteristicStatus: char?.lifecycleStatus ?? '',
            };
          }),
      })),
    };
  });
}

export interface ClassInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  classType: string;
  className: string;
  description: string;
  assignments: Array<{ characteristicName: string; requiredForClassification: boolean }>;
  reason: string;
}

export async function saveClass(input: ClassInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const name = requireName(input.className);
  const description = (input.description ?? '').trim();
  if (!description || description.length > 40) {
    throw new ClassError('The description is required and may be at most 40 characters.', 'Enter a description within the limit.');
  }
  const seen = new Set<string>();
  for (const assignment of input.assignments) {
    const key = (assignment.characteristicName ?? '').trim().toUpperCase();
    if (!key) continue;
    if (seen.has(key)) {
      throw new ClassError(`Characteristic ${key} stands twice in this class.`, 'Assign each characteristic at most once.');
    }
    seen.add(key);
  }

  return withTenant(client, async (tx) => {
    await ensureClassTypes(tx, client, changedBy);
    const [type] = await tx.select().from(classType)
      .where(and(eq(classType.client, client), eq(classType.classType, input.classType)));
    if (!type?.isActive) {
      throw new ClassError(`Class type ${input.classType} does not stand active.`, 'Pick a class type from the delivered catalogue.');
    }
    for (const key of seen) {
      const [char] = await tx.select().from(characteristic)
        .where(and(eq(characteristic.client, client), eq(characteristic.characteristicName, key)));
      if (!char) {
        throw new ClassError(`Characteristic ${key} does not stand.`, 'Define it on the characteristics screen first.');
      }
      if (char.lifecycleStatus === 'BLOCKED') {
        throw new ClassError(
          `Characteristic ${key} is blocked and cannot be newly assigned.`,
          'Reactivate the characteristic, or leave it out of this class.',
        );
      }
    }

    const [existing] = await tx.select().from(classificationClass).where(and(
      eq(classificationClass.client, client),
      eq(classificationClass.classType, input.classType),
      eq(classificationClass.className, name),
    )).for('update');

    if (input.mode === 'CREATE') {
      if (existing) {
        throw new ClassError(`Class ${name} already stands under ${input.classType}.`, 'Change the standing class, or choose a new name.');
      }
      await tx.insert(classificationClass).values({
        client, classType: input.classType, className: name, description,
        lifecycleStatus: 'DRAFT', createdBy: changedBy,
      });
    } else {
      if (!existing) throw new ClassError(`Class ${name} does not stand under ${input.classType}.`, 'Create it first, then change it.');
      const standing = await tx.select().from(classAssignment).where(and(
        eq(classAssignment.client, client),
        eq(classAssignment.classType, input.classType),
        eq(classAssignment.className, name),
      ));
      const assignmentsChanged = standing.length !== seen.size
        || standing.some((a) => !seen.has(a.characteristicName));
      if (existing.lifecycleStatus === 'BLOCKED' && assignmentsChanged) {
        throw new ClassError(
          `Class ${name} is blocked; its assignments cannot change while blocked.`,
          'Reactivate the class first, or change only its description.',
        );
      }
      await tx.update(classificationClass).set({ description, changedBy, changedAt: new Date() })
        .where(and(
          eq(classificationClass.client, client),
          eq(classificationClass.classType, input.classType),
          eq(classificationClass.className, name),
        ));
      await tx.delete(classAssignment).where(and(
        eq(classAssignment.client, client),
        eq(classAssignment.classType, input.classType),
        eq(classAssignment.className, name),
      ));
    }

    let position = 0;
    for (const assignment of input.assignments) {
      const key = (assignment.characteristicName ?? '').trim().toUpperCase();
      if (!key) continue;
      position += 1;
      await tx.insert(classAssignment).values({
        client,
        classType: input.classType,
        className: name,
        position,
        characteristicName: key,
        requiredForClassification: assignment.requiredForClassification === true,
        createdBy: changedBy,
      });
    }

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: `${input.classType}/${name}`,
      changeType: input.mode,
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      after: { classType: input.classType, className: name, description, characteristics: [...seen] },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { classType: input.classType, className: name, changed: true };
  });
}

export interface ClassKeyInput {
  client: string;
  changedBy: string;
  classType: string;
  className: string;
  reason: string;
}

const classKey = (input: ClassKeyInput) => and(
  eq(classificationClass.client, requireClient(input.client)),
  eq(classificationClass.classType, input.classType),
  eq(classificationClass.className, requireName(input.className)),
);

export async function setClassStatus(input: ClassKeyInput & { status: 'ACTIVE' | 'BLOCKED' }) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const name = requireName(input.className);

  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(classificationClass).where(classKey(input)).for('update');
    if (!existing) throw new ClassError(`Class ${name} does not stand under ${input.classType}.`);
    if (existing.lifecycleStatus === input.status) {
      return { className: name, changed: false };
    }
    await tx.update(classificationClass).set({
      lifecycleStatus: input.status, changedBy, changedAt: new Date(),
    }).where(classKey(input));
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: `${input.classType}/${name}`,
      changeType: 'CHANGE', changedBy, reason, transactionCode: ACTIVITY,
      before: { lifecycleStatus: existing.lifecycleStatus },
      after: { lifecycleStatus: input.status },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { className: name, changed: true };
  });
}

export async function deleteClass(input: ClassKeyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const name = requireName(input.className);

  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(classificationClass).where(classKey(input)).for('update');
    if (!existing) throw new ClassError(`Class ${name} does not stand under ${input.classType}.`);
    if (existing.lifecycleStatus !== 'DRAFT') {
      throw new ClassError(
        `Class ${name} has lived as ${existing.lifecycleStatus}; it blocks rather than deletes.`,
        'Block the class instead — deletion stands only for a draft without assignments.',
      );
    }
    const assignments = await tx.select().from(classAssignment).where(and(
      eq(classAssignment.client, client),
      eq(classAssignment.classType, input.classType),
      eq(classAssignment.className, name),
    ));
    if (assignments.length > 0) {
      throw new ClassError(
        `Class ${name} carries ${assignments.length} characteristic assignments; it blocks rather than deletes.`,
        'Remove the assignments and delete it as a draft, or block it.',
      );
    }
    await tx.delete(classificationClass).where(classKey(input));
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: `${input.classType}/${name}`,
      changeType: 'DELETE', changedBy, reason, transactionCode: ACTIVITY,
      before: { classType: input.classType, className: name },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { className: name, changed: true };
  });
}
