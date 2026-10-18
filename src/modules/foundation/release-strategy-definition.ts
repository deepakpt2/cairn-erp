/**
 * Release strategies — SCR-059 / R-107 (the CFG.PROC.RELEASE.DEFINE
 * screen, standing in the seed since the platform round).
 *
 * Groups own the codes approvers act under; a strategy binds a group
 * to a classification class and judges a document against its
 * criteria. This round is configuration plus the determination judge
 * the release-acts round (SCR-060) will call — no document's release
 * status moves here. Values in criteria are judged against the
 * characteristic's own format and allowed values; only
 * characteristics in the delivered document-attribute catalogue may
 * be judged, because only those attributes exist on a document.
 */
import { and, asc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import {
  characteristic, characteristicValue, classAssignment, classificationClass,
  releaseCode, releaseGroup, releaseStrategy, releaseStrategyCriterion, releaseStrategyStep,
} from './characteristic-schema';

export const ACTIVITY = 'CFG.PROC.RELEASE.DEFINE';
const OBJECT_CLASS = 'release_strategy';
const PRODUCTION = process.env.NODE_ENV === 'production';

/** The house communication structure: attributes a document carries. */
export const RELEASE_ATTRIBUTES: Record<string, string[]> = {
  PURCHASE_REQUISITION: ['TOTAL_VALUE', 'PLANT', 'PURCHASING_GROUP', 'COMPANY_CODE'],
  PURCHASE_ORDER: ['TOTAL_VALUE', 'PLANT', 'PURCHASING_GROUP', 'COMPANY_CODE', 'SUPPLIER', 'PURCHASING_ORG'],
};

/** The class type a group's strategies must read, per category. */
export const CATEGORY_CLASS_TYPE: Record<string, string> = {
  PURCHASE_REQUISITION: 'PURCHASE_REQUISITION',
  PURCHASE_ORDER: 'PURCHASE_ORDER',
};

const OPERATORS = ['EQ', 'GE', 'GT', 'LE', 'LT', 'BETWEEN'] as const;

export class ReleaseStrategyError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ReleaseStrategyError';
    this.remedy = remedy;
  }
}

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new ReleaseStrategyError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new ReleaseStrategyError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new ReleaseStrategyError('A reason is required for every release-strategy change.', 'State why this change is being made.');
  }
  return value;
}

function requireCode(raw: string, label: string, max: number): string {
  const code = (raw ?? '').trim().toUpperCase();
  if (!new RegExp(`^[A-Z0-9_]{1,${max}}$`).test(code)) {
    throw new ReleaseStrategyError(`${label} is at most ${max} characters of uppercase letters, digits and underscores.`, 'Correct the code and save again.');
  }
  return code;
}

export interface ReleaseGroupRow {
  groupCode: string;
  documentCategory: string;
  description: string;
  codes: Array<{ code: string; description: string }>;
}

export interface ReleaseStrategyRow {
  groupCode: string;
  strategyCode: string;
  description: string;
  classType: string;
  className: string;
  priority: number;
  lifecycleStatus: string;
  criteria: Array<{ characteristicName: string; operator: string; valueFrom: string; valueTo: string | null }>;
  steps: string[];
}

export interface ReleaseConfiguration {
  groups: ReleaseGroupRow[];
  strategies: ReleaseStrategyRow[];
  classes: Array<{
    classType: string; className: string; lifecycleStatus: string;
    characteristics: string[];
  }>;
}

export async function listReleaseConfiguration(clientKey: string): Promise<ReleaseConfiguration> {
  const client = requireClient(clientKey);
  return withTenant(client, async (tx) => {
    const groups = await tx.select().from(releaseGroup)
      .where(eq(releaseGroup.client, client)).orderBy(asc(releaseGroup.groupCode));
    const codes = await tx.select().from(releaseCode)
      .where(eq(releaseCode.client, client)).orderBy(asc(releaseCode.groupCode), asc(releaseCode.code));
    const strategies = await tx.select().from(releaseStrategy)
      .where(eq(releaseStrategy.client, client))
      .orderBy(asc(releaseStrategy.priority), asc(releaseStrategy.groupCode), asc(releaseStrategy.strategyCode));
    const criteria = await tx.select().from(releaseStrategyCriterion)
      .where(eq(releaseStrategyCriterion.client, client));
    const steps = await tx.select().from(releaseStrategyStep)
      .where(eq(releaseStrategyStep.client, client))
      .orderBy(asc(releaseStrategyStep.groupCode), asc(releaseStrategyStep.strategyCode), asc(releaseStrategyStep.step));
    const classes = await tx.select().from(classificationClass)
      .where(eq(classificationClass.client, client));
    const assignments = await tx.select().from(classAssignment)
      .where(eq(classAssignment.client, client)).orderBy(asc(classAssignment.position));
    return {
      groups: groups.map((g) => ({
        groupCode: g.groupCode,
        documentCategory: g.documentCategory,
        description: g.description,
        codes: codes.filter((c) => c.groupCode === g.groupCode)
          .map((c) => ({ code: c.code, description: c.description })),
      })),
      strategies: strategies.map((s) => ({
        groupCode: s.groupCode,
        strategyCode: s.strategyCode,
        description: s.description,
        classType: s.classType,
        className: s.className,
        priority: s.priority,
        lifecycleStatus: s.lifecycleStatus,
        criteria: criteria
          .filter((c) => c.groupCode === s.groupCode && c.strategyCode === s.strategyCode)
          .map((c) => ({
            characteristicName: c.characteristicName, operator: c.operator,
            valueFrom: c.valueFrom, valueTo: c.valueTo,
          })),
        steps: steps
          .filter((st) => st.groupCode === s.groupCode && st.strategyCode === s.strategyCode)
          .map((st) => st.releaseCode),
      })),
      classes: classes.map((c) => ({
        classType: c.classType,
        className: c.className,
        lifecycleStatus: c.lifecycleStatus,
        characteristics: assignments
          .filter((a) => a.classType === c.classType && a.className === c.className)
          .map((a) => a.characteristicName),
      })),
    };
  });
}

export interface ReleaseGroupInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  groupCode: string;
  documentCategory: string;
  description: string;
  codes: Array<{ code: string; description: string }>;
  reason: string;
}

export async function saveReleaseGroup(input: ReleaseGroupInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const groupCode = requireCode(input.groupCode, 'The release group', 12);
  const description = (input.description ?? '').trim();
  if (!description || description.length > 60) {
    throw new ReleaseStrategyError('The group description is required and may be at most 60 characters.');
  }
  if (!RELEASE_ATTRIBUTES[input.documentCategory]) {
    throw new ReleaseStrategyError('The document category is PURCHASE_REQUISITION or PURCHASE_ORDER.');
  }
  const codes = input.codes
    .filter((row) => (row.code ?? '').trim())
    .map((row) => ({ code: requireCode(row.code, 'A release code', 8), description: (row.description ?? '').trim() }));
  for (const row of codes) {
    if (!row.description || row.description.length > 60) {
      throw new ReleaseStrategyError(`Release code ${row.code} needs a description of at most 60 characters.`);
    }
  }
  if (new Set(codes.map((c) => c.code)).size !== codes.length) {
    throw new ReleaseStrategyError('A release code stands twice in this group.', 'Name each code once.');
  }

  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(releaseGroup)
      .where(and(eq(releaseGroup.client, client), eq(releaseGroup.groupCode, groupCode))).for('update');
    if (input.mode === 'CREATE') {
      if (existing) throw new ReleaseStrategyError(`Release group ${groupCode} already stands.`, 'Change the standing group, or choose a new code.');
      await tx.insert(releaseGroup).values({
        client, groupCode, documentCategory: input.documentCategory, description, createdBy: changedBy,
      });
    } else {
      if (!existing) throw new ReleaseStrategyError(`Release group ${groupCode} does not stand.`, 'Create it first, then change it.');
      if (existing.documentCategory !== input.documentCategory) {
        throw new ReleaseStrategyError(
          `Release group ${groupCode} judges ${existing.documentCategory} documents; its category never changes.`,
          'Create a new group for the other category.',
        );
      }
      const usedSteps = await tx.select().from(releaseStrategyStep)
        .where(and(eq(releaseStrategyStep.client, client), eq(releaseStrategyStep.groupCode, groupCode)));
      const removed = (await tx.select().from(releaseCode)
        .where(and(eq(releaseCode.client, client), eq(releaseCode.groupCode, groupCode))))
        .filter((standing) => !codes.some((c) => c.code === standing.code));
      for (const row of removed) {
        if (usedSteps.some((s) => s.releaseCode === row.code)) {
          throw new ReleaseStrategyError(
            `Release code ${row.code} is sequenced by a strategy and cannot leave the group.`,
            'Remove it from the strategy steps first.',
          );
        }
      }
      await tx.update(releaseGroup).set({ description, changedBy, changedAt: new Date() })
        .where(and(eq(releaseGroup.client, client), eq(releaseGroup.groupCode, groupCode)));
      await tx.delete(releaseCode)
        .where(and(eq(releaseCode.client, client), eq(releaseCode.groupCode, groupCode)));
    }
    for (const row of codes) {
      await tx.insert(releaseCode).values({ client, groupCode, createdBy: changedBy, ...row });
    }
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: groupCode, changeType: input.mode,
      changedBy, reason, transactionCode: ACTIVITY,
      after: { groupCode, documentCategory: input.documentCategory, codes: codes.map((c) => c.code) },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { groupCode, changed: true };
  });
}

export async function deleteReleaseGroup(input: {
  client: string; changedBy: string; groupCode: string; reason: string;
}) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const groupCode = requireCode(input.groupCode, 'The release group', 12);
  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(releaseGroup)
      .where(and(eq(releaseGroup.client, client), eq(releaseGroup.groupCode, groupCode))).for('update');
    if (!existing) throw new ReleaseStrategyError(`Release group ${groupCode} does not stand.`);
    const strategies = await tx.select().from(releaseStrategy)
      .where(and(eq(releaseStrategy.client, client), eq(releaseStrategy.groupCode, groupCode)));
    if (strategies.length > 0) {
      throw new ReleaseStrategyError(
        `Release group ${groupCode} carries ${strategies.length} strategies and cannot be deleted under them.`,
        'Delete or move the strategies first.',
      );
    }
    await tx.delete(releaseGroup)
      .where(and(eq(releaseGroup.client, client), eq(releaseGroup.groupCode, groupCode)));
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: groupCode, changeType: 'DELETE',
      changedBy, reason, transactionCode: ACTIVITY,
      before: { groupCode, documentCategory: existing.documentCategory },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { groupCode, changed: true };
  });
}

export interface ReleaseStrategyInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  groupCode: string;
  strategyCode: string;
  description: string;
  className: string;
  priority: number;
  criteria: Array<{ characteristicName: string; operator: string; valueFrom: string; valueTo: string }>;
  steps: string[];
  reason: string;
}

function judgeCriterionValue(
  characteristicName: string,
  dataFormat: string,
  allowed: string[],
  additionalValuesAllowed: boolean,
  operator: string,
  value: string,
): void {
  if (dataFormat === 'NUM' || dataFormat === 'CURR') {
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      throw new ReleaseStrategyError(`Criterion value ${value} for ${characteristicName} is not a number.`, 'Enter a numeric threshold for this characteristic.');
    }
    return;
  }
  if (dataFormat === 'DATE' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ReleaseStrategyError(`Criterion value ${value} for ${characteristicName} is not a date (YYYY-MM-DD).`);
  }
  if (allowed.length > 0 && !additionalValuesAllowed && !allowed.includes(value)) {
    throw new ReleaseStrategyError(
      `Criterion value ${value} is not among the allowed values of ${characteristicName}.`,
      'Pick one of the characteristic\'s allowed values, or allow additional values on the characteristic.',
    );
  }
  void operator;
}

export async function saveReleaseStrategy(input: ReleaseStrategyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const groupCode = requireCode(input.groupCode, 'The release group', 12);
  const strategyCode = requireCode(input.strategyCode, 'The strategy', 12);
  const description = (input.description ?? '').trim();
  if (!description || description.length > 60) {
    throw new ReleaseStrategyError('The strategy description is required and may be at most 60 characters.');
  }
  if (!Number.isInteger(input.priority) || input.priority < 1) {
    throw new ReleaseStrategyError('The priority is a positive whole number; the lowest wins.');
  }
  const steps = input.steps.map((s) => (s ?? '').trim().toUpperCase()).filter(Boolean);
  if (steps.length === 0) throw new ReleaseStrategyError('A strategy sequences at least one release code.');
  if (steps.length > 8) throw new ReleaseStrategyError('A strategy sequences at most eight release codes.');
  if (new Set(steps).size !== steps.length) throw new ReleaseStrategyError('A release code stands twice in this strategy.');

  return withTenant(client, async (tx) => {
    const [group] = await tx.select().from(releaseGroup)
      .where(and(eq(releaseGroup.client, client), eq(releaseGroup.groupCode, groupCode)));
    if (!group) throw new ReleaseStrategyError(`Release group ${groupCode} does not stand.`, 'Define the group first.');
    const classTypeWanted = CATEGORY_CLASS_TYPE[group.documentCategory];
    const [clazz] = await tx.select().from(classificationClass).where(and(
      eq(classificationClass.client, client),
      eq(classificationClass.classType, classTypeWanted),
      eq(classificationClass.className, input.className),
    ));
    if (!clazz) {
      throw new ReleaseStrategyError(
        `Class ${input.className} does not stand under ${classTypeWanted}, the type ${group.documentCategory} strategies read.`,
        'Define the class under the matching type on the classes screen.',
      );
    }
    const assignments = await tx.select().from(classAssignment).where(and(
      eq(classAssignment.client, client),
      eq(classAssignment.classType, classTypeWanted),
      eq(classAssignment.className, input.className),
    ));
    const catalogue = RELEASE_ATTRIBUTES[group.documentCategory];
    for (const criterion of input.criteria) {
      const name = (criterion.characteristicName ?? '').trim().toUpperCase();
      if (!assignments.some((a) => a.characteristicName === name)) {
        throw new ReleaseStrategyError(`Characteristic ${name} is not assigned to class ${input.className}.`, 'Judge only the characteristics the class gathers.');
      }
      if (!catalogue.includes(name)) {
        throw new ReleaseStrategyError(
          `Characteristic ${name} is not a ${group.documentCategory} document attribute, so no document can be judged by it.`,
          `Judged attributes: ${catalogue.join(', ')}.`,
        );
      }
      if (!(OPERATORS as readonly string[]).includes(criterion.operator)) {
        throw new ReleaseStrategyError(`Comparison ${criterion.operator} does not stand.`);
      }
      const [char] = await tx.select().from(characteristic)
        .where(and(eq(characteristic.client, client), eq(characteristic.characteristicName, name)));
      if (!char) throw new ReleaseStrategyError(`Characteristic ${name} does not stand.`);
      if (char.lifecycleStatus === 'BLOCKED') {
        throw new ReleaseStrategyError(`Characteristic ${name} is blocked and cannot be judged.`);
      }
      const allowed = (await tx.select().from(characteristicValue)
        .where(and(eq(characteristicValue.client, client), eq(characteristicValue.characteristicName, name))))
        .map((v) => v.valueText);
      judgeCriterionValue(name, char.dataFormat, allowed, char.additionalValuesAllowed, criterion.operator, criterion.valueFrom.trim());
      if (criterion.operator === 'BETWEEN') {
        if (!char.intervalsAllowed) {
          throw new ReleaseStrategyError(`Characteristic ${name} does not allow interval values, so BETWEEN cannot judge it.`);
        }
        if (!criterion.valueTo.trim()) throw new ReleaseStrategyError('A BETWEEN criterion names both ends of its interval.');
        judgeCriterionValue(name, char.dataFormat, allowed, char.additionalValuesAllowed, criterion.operator, criterion.valueTo.trim());
      }
    }
    const groupCodes = await tx.select().from(releaseCode)
      .where(and(eq(releaseCode.client, client), eq(releaseCode.groupCode, groupCode)));
    for (const step of steps) {
      if (!groupCodes.some((c) => c.code === step)) {
        throw new ReleaseStrategyError(`Release code ${step} does not belong to group ${groupCode}.`, 'Sequence only codes the group owns.');
      }
    }

    const [existing] = await tx.select().from(releaseStrategy).where(and(
      eq(releaseStrategy.client, client),
      eq(releaseStrategy.groupCode, groupCode),
      eq(releaseStrategy.strategyCode, strategyCode),
    )).for('update');

    if (input.mode === 'CREATE') {
      if (existing) throw new ReleaseStrategyError(`Strategy ${strategyCode} already stands in group ${groupCode}.`, 'Change the standing strategy, or choose a new code.');
      await tx.insert(releaseStrategy).values({
        client, groupCode, strategyCode, description,
        classType: classTypeWanted, className: input.className,
        priority: input.priority, lifecycleStatus: 'DRAFT', createdBy: changedBy,
      });
    } else {
      if (!existing) throw new ReleaseStrategyError(`Strategy ${strategyCode} does not stand in group ${groupCode}.`, 'Create it first, then change it.');
      await tx.update(releaseStrategy).set({
        description, className: input.className, priority: input.priority,
        changedBy, changedAt: new Date(),
      }).where(and(
        eq(releaseStrategy.client, client),
        eq(releaseStrategy.groupCode, groupCode),
        eq(releaseStrategy.strategyCode, strategyCode),
      ));
      await tx.delete(releaseStrategyCriterion).where(and(
        eq(releaseStrategyCriterion.client, client),
        eq(releaseStrategyCriterion.groupCode, groupCode),
        eq(releaseStrategyCriterion.strategyCode, strategyCode),
      ));
      await tx.delete(releaseStrategyStep).where(and(
        eq(releaseStrategyStep.client, client),
        eq(releaseStrategyStep.groupCode, groupCode),
        eq(releaseStrategyStep.strategyCode, strategyCode),
      ));
    }
    for (const criterion of input.criteria) {
      await tx.insert(releaseStrategyCriterion).values({
        client, groupCode, strategyCode,
        characteristicName: criterion.characteristicName.trim().toUpperCase(),
        operator: criterion.operator,
        valueFrom: criterion.valueFrom.trim(),
        valueTo: criterion.operator === 'BETWEEN' ? criterion.valueTo.trim() : null,
        createdBy: changedBy,
      });
    }
    let step = 0;
    for (const code of steps) {
      step += 1;
      await tx.insert(releaseStrategyStep).values({
        client, groupCode, strategyCode, step, releaseCode: code, createdBy: changedBy,
      });
    }
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: `${groupCode}/${strategyCode}`, changeType: input.mode,
      changedBy, reason, transactionCode: ACTIVITY,
      after: {
        groupCode, strategyCode, className: input.className, priority: input.priority,
        criteria: input.criteria.map((c) => c.characteristicName), steps,
      },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { groupCode, strategyCode, changed: true };
  });
}

export interface ReleaseStrategyKeyInput {
  client: string;
  changedBy: string;
  groupCode: string;
  strategyCode: string;
  reason: string;
}

export async function setReleaseStrategyStatus(input: ReleaseStrategyKeyInput & { status: 'ACTIVE' | 'BLOCKED' }) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const groupCode = requireCode(input.groupCode, 'The release group', 12);
  const strategyCode = requireCode(input.strategyCode, 'The strategy', 12);

  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(releaseStrategy).where(and(
      eq(releaseStrategy.client, client),
      eq(releaseStrategy.groupCode, groupCode),
      eq(releaseStrategy.strategyCode, strategyCode),
    )).for('update');
    if (!existing) throw new ReleaseStrategyError(`Strategy ${strategyCode} does not stand in group ${groupCode}.`);
    if (existing.lifecycleStatus === input.status) return { strategyCode, changed: false };
    if (input.status === 'ACTIVE') {
      const [clazz] = await tx.select().from(classificationClass).where(and(
        eq(classificationClass.client, client),
        eq(classificationClass.classType, existing.classType),
        eq(classificationClass.className, existing.className),
      ));
      if (clazz?.lifecycleStatus !== 'ACTIVE') {
        throw new ReleaseStrategyError(
          `Class ${existing.className} is not active, so strategy ${strategyCode} cannot activate beneath it.`,
          'Activate the class first.',
        );
      }
      const steps = await tx.select().from(releaseStrategyStep).where(and(
        eq(releaseStrategyStep.client, client),
        eq(releaseStrategyStep.groupCode, groupCode),
        eq(releaseStrategyStep.strategyCode, strategyCode),
      ));
      if (steps.length === 0) throw new ReleaseStrategyError('A strategy sequences at least one release code before it can activate.');
    }
    await tx.update(releaseStrategy).set({
      lifecycleStatus: input.status, changedBy, changedAt: new Date(),
    }).where(and(
      eq(releaseStrategy.client, client),
      eq(releaseStrategy.groupCode, groupCode),
      eq(releaseStrategy.strategyCode, strategyCode),
    ));
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: `${groupCode}/${strategyCode}`, changeType: 'CHANGE',
      changedBy, reason, transactionCode: ACTIVITY,
      before: { lifecycleStatus: existing.lifecycleStatus },
      after: { lifecycleStatus: input.status },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { strategyCode, changed: true };
  });
}

export async function deleteReleaseStrategy(input: ReleaseStrategyKeyInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const groupCode = requireCode(input.groupCode, 'The release group', 12);
  const strategyCode = requireCode(input.strategyCode, 'The strategy', 12);

  return withTenant(client, async (tx) => {
    const [existing] = await tx.select().from(releaseStrategy).where(and(
      eq(releaseStrategy.client, client),
      eq(releaseStrategy.groupCode, groupCode),
      eq(releaseStrategy.strategyCode, strategyCode),
    )).for('update');
    if (!existing) throw new ReleaseStrategyError(`Strategy ${strategyCode} does not stand in group ${groupCode}.`);
    if (existing.lifecycleStatus !== 'DRAFT') {
      throw new ReleaseStrategyError(
        `Strategy ${strategyCode} has lived as ${existing.lifecycleStatus}; it blocks rather than deletes.`,
        'Block the strategy instead — deletion stands only for a draft.',
      );
    }
    await tx.delete(releaseStrategy).where(and(
      eq(releaseStrategy.client, client),
      eq(releaseStrategy.groupCode, groupCode),
      eq(releaseStrategy.strategyCode, strategyCode),
    ));
    await recordChange(tx, {
      client, objectClass: OBJECT_CLASS, objectKey: `${groupCode}/${strategyCode}`, changeType: 'DELETE',
      changedBy, reason, transactionCode: ACTIVITY,
      before: { groupCode, strategyCode },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { strategyCode, changed: true };
  });
}

/** What a document offers the judge: attribute name → value. */
export type ReleaseAttributes = Record<string, string | number>;

/** Pure criterion matching, exported for the release-acts round. */
export function criterionMatches(
  dataFormat: string,
  operator: string,
  valueFrom: string,
  valueTo: string | null,
  actual: string | number | undefined,
): boolean {
  if (actual === undefined) return false;
  const numeric = dataFormat === 'NUM' || dataFormat === 'CURR';
  const compare = (a: string | number, b: string): number => {
    if (numeric) return Number(a) - Number(b);
    return String(a) < b ? -1 : String(a) > b ? 1 : 0;
  };
  switch (operator) {
    case 'EQ': return compare(actual, valueFrom) === 0;
    case 'GE': return compare(actual, valueFrom) >= 0;
    case 'GT': return compare(actual, valueFrom) > 0;
    case 'LE': return compare(actual, valueFrom) <= 0;
    case 'LT': return compare(actual, valueFrom) < 0;
    case 'BETWEEN': return valueTo !== null && compare(actual, valueFrom) >= 0 && compare(actual, valueTo) <= 0;
    default: return false;
  }
}

export interface ReleaseDetermination {
  groupCode: string;
  strategyCode: string;
  steps: string[];
}

/**
 * The determination judge SCR-060 calls: the first ACTIVE strategy
 * (lowest priority number, then group and strategy code) whose every
 * criterion holds against the document's attributes, or null — the
 * document needs no release.
 */
export async function determineRelease(
  clientKey: string,
  documentCategory: string,
  attributes: ReleaseAttributes,
): Promise<ReleaseDetermination | null> {
  const client = requireClient(clientKey);
  return withTenant(client, async (tx) => {
    const groups = await tx.select().from(releaseGroup).where(and(
      eq(releaseGroup.client, client), eq(releaseGroup.documentCategory, documentCategory),
    ));
    if (groups.length === 0) return null;
    const strategies = await tx.select().from(releaseStrategy).where(and(
      eq(releaseStrategy.client, client), eq(releaseStrategy.lifecycleStatus, 'ACTIVE'),
    ));
    const candidates = strategies
      .filter((s) => groups.some((g) => g.groupCode === s.groupCode))
      .sort((a, b) => a.priority - b.priority || a.groupCode.localeCompare(b.groupCode) || a.strategyCode.localeCompare(b.strategyCode));
    for (const strategy of candidates) {
      const criteria = await tx.select().from(releaseStrategyCriterion).where(and(
        eq(releaseStrategyCriterion.client, client),
        eq(releaseStrategyCriterion.groupCode, strategy.groupCode),
        eq(releaseStrategyCriterion.strategyCode, strategy.strategyCode),
      ));
      let matches = true;
      for (const criterion of criteria) {
        const [char] = await tx.select().from(characteristic).where(and(
          eq(characteristic.client, client),
          eq(characteristic.characteristicName, criterion.characteristicName),
        ));
        if (!char || !criterionMatches(
          char.dataFormat, criterion.operator, criterion.valueFrom, criterion.valueTo,
          attributes[criterion.characteristicName],
        )) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const steps = await tx.select().from(releaseStrategyStep).where(and(
        eq(releaseStrategyStep.client, client),
        eq(releaseStrategyStep.groupCode, strategy.groupCode),
        eq(releaseStrategyStep.strategyCode, strategy.strategyCode),
      )).orderBy(asc(releaseStrategyStep.step));
      return {
        groupCode: strategy.groupCode,
        strategyCode: strategy.strategyCode,
        steps: steps.map((s) => s.releaseCode),
      };
    }
    return null;
  });
}
