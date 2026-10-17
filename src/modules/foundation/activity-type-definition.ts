import { asc, eq } from 'drizzle-orm';

import { db } from '../../platform/db/client';
import { withTenant } from '../../platform/db/client';
import { unitOfMeasure } from '../../platform/tables/reference';
import { listCostCenterAreas, type CostCenterArea } from './cost-center-definition';
import { COST_CENTER_CATEGORIES } from './cost-center-definition';
import { activityType } from './schema';

export { listCostCenterAreas };
export type { CostCenterArea };
export { COST_CENTER_CATEGORIES };

/**
 * Activity type definition — the read side (SCR-043 stage 1).
 *
 * An activity type is the measurable output a cost centre performs —
 * labour hours, machine runs, setups — priced later per period (SCR-044)
 * and charged to whoever consumed it. The owner's package (KL01) keys
 * the master (area, type, valid-from) on validity rows with a separate
 * language-text table, two single-digit behaviour fields, and deletion
 * refused while planning or allocations stand.
 *
 * The four forks (R-92) shape this product's version: **SAP parity** on
 * the vocabularies (category 1–4 and price indicator 1–3 stored as the
 * reference's digits, their meanings displayed as words beside them);
 * **SAP parity** on the unit (any unit standing in the global
 * unit_of_measure table, judged on existence); **SAP parity** on
 * applicability (the type may name the KS01 cost-centre categories it is
 * valid for — canonical subset, blank meaning all); and the **KS01
 * lifecycle** (delete plus an independent posting lock). Validity is the
 * KS01 period shape — non-overlapping rows, valid to re-settable while
 * it overlaps none — and the name lives on the row.
 *
 * Nothing prices or allocates against these rows yet; this activity
 * defines the master SCR-044 will read.
 */
export const ACTIVITY = 'CFG.COST.ACTIVITYTYPE.DEFINE';

export interface ActivityCategoryOption {
  code: string;
  label: string;
}

export const ACTIVITY_CATEGORIES: ActivityCategoryOption[] = [
  { code: '1', label: 'Manual entry, manual allocation' },
  { code: '2', label: 'Indirect determination, indirect allocation' },
  { code: '3', label: 'Manual entry, indirect allocation' },
  { code: '4', label: 'Manual entry, no allocation' },
];

export const PRICE_INDICATORS: ActivityCategoryOption[] = [
  { code: '1', label: 'Automatic (based on activity)' },
  { code: '2', label: 'Automatic (based on capacity)' },
  { code: '3', label: 'Manual entry' },
];

export function activityCategoryLabel(code: string): string {
  return ACTIVITY_CATEGORIES.find((entry) => entry.code === code)?.label ?? code;
}

export function priceIndicatorLabel(code: string): string {
  return PRICE_INDICATORS.find((entry) => entry.code === code)?.label ?? code;
}

/** Split the stored canonical subset ('' = every category). */
export function parseValidCategories(stored: string): string[] {
  return stored === '' ? [] : stored.split(',').filter(Boolean);
}

/** Join chosen categories in the canonical KS01 catalogue order ('' = every category). */
export function canonicalValidCategories(chosen: string[]): string {
  const wanted = new Set(chosen);
  return COST_CENTER_CATEGORIES.map((entry) => entry.category)
    .filter((category) => wanted.has(category))
    .join(',');
}

export interface ActivityTypeRow {
  controllingArea: string;
  activityType: string;
  validFrom: string;
  validTo: string;
  name: string;
  activityUnit: string;
  category: string;
  priceIndicator: string;
  /** '' = valid for every cost centre category. */
  validCcCategories: string;
  isPostingLocked: boolean;
}

export interface ActivityUnitChoice {
  code: string;
  name: string;
  dimension: string;
}

export async function listActivityTypes(
  clientId: string,
  area: string,
): Promise<ActivityTypeRow[]> {
  if (area === '') return [];
  return withTenant(clientId, async (tx) =>
    tx
      .select({
        controllingArea: activityType.controllingArea,
        activityType: activityType.activityType,
        validFrom: activityType.validFrom,
        validTo: activityType.validTo,
        name: activityType.name,
        activityUnit: activityType.activityUnit,
        category: activityType.category,
        priceIndicator: activityType.priceIndicator,
        validCcCategories: activityType.validCcCategories,
        isPostingLocked: activityType.isPostingLocked,
      })
      .from(activityType)
      .where(eq(activityType.controllingArea, area))
      .orderBy(asc(activityType.activityType), asc(activityType.validFrom)),
  );
}

/** Every unit standing in the global unit of measure table, by dimension then code. */
export async function listActivityUnits(): Promise<ActivityUnitChoice[]> {
  const rows = await db()
    .select({
      code: unitOfMeasure.code,
      name: unitOfMeasure.name,
      dimension: unitOfMeasure.dimension,
    })
    .from(unitOfMeasure)
    .orderBy(asc(unitOfMeasure.dimension), asc(unitOfMeasure.code));
  return rows.map((row) => ({ ...row, code: row.code.trim(), dimension: row.dimension.trim() }));
}

import { z } from 'zod';
import { and, inArray } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { controllingArea } from './schema';

/**
 * The write (SCR-043 stage 3; contract R-92).
 *
 * One save on the period key (controlling area, activity type, valid
 * from) — immutable, as every period key here — with valid to re-set on
 * change so long as the new span overlaps no sibling, the overlap named.
 * The activity unit is judged against the global unit_of_measure table
 * (any standing unit; SAP parity), the two behaviour digits against
 * their catalogues, and the valid cost-centre categories against the
 * KS01 catalogue — stored as the canonical subset, blank meaning all.
 *
 * Locking is its own act (the KS01 lifecycle): it stops the type being
 * offered to new pricing and allocation while history stands.
 * Deletion is hard and — today — unconditional: nothing prices or
 * allocates against these rows yet, so there is nothing to count;
 * SCR-044's rates will give the judge its count, and the screen says so.
 *
 * A **reason is mandatory on every write**, one change document per
 * write with the unit, category, price indicator and lock
 * security-relevant: together they decide what a price will be computed
 * from when rates arrive.
 */
export const OBJECT_CLASS = 'activity_type';
const PREREQUISITES = ['CFG.COST.COSTCENTER.DEFINE'] as const;

const dateValue = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} is a date (YYYY-MM-DD).`)
    .refine((value) => {
      const [year, month, day] = value.split('-').map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    }, `${label} is a real calendar date.`);

export const activityTypeValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  controllingArea: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'The Controlling Area is exactly four letters or digits.')),
  activityType: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,6}$/, 'The Activity Type is up to six letters or digits.')),
  validFrom: dateValue('Valid From'),
  validTo: dateValue('Valid To'),
  name: z.string().trim().min(1, 'The Name is required.').max(40, 'The Name is at most 40 characters.'),
  activityUnit: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase()),
  category: z
    .string()
    .trim()
    .refine(
      (value) => ACTIVITY_CATEGORIES.some((entry) => entry.code === value),
      'The Activity Category is one of 1 (manual entry, manual allocation), 2 (indirect determination, indirect allocation), 3 (manual entry, indirect allocation), 4 (manual entry, no allocation).',
    ),
  priceIndicator: z
    .string()
    .trim()
    .refine(
      (value) => PRICE_INDICATORS.some((entry) => entry.code === value),
      'The Price Indicator is one of 1 (automatic on activity), 2 (automatic on capacity), 3 (manual entry).',
    ),
  validCcCategories: z
    .array(
      z
        .string()
        .trim()
        .transform((value) => value.toUpperCase()),
    )
    .refine(
      (chosen) =>
        chosen.every((category) =>
          COST_CENTER_CATEGORIES.some((entry) => entry.category === category),
        ),
      'The valid cost centre categories are chosen from the defined categories.',
    )
    .transform((chosen) => canonicalValidCategories(chosen)),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};

export const activityTypeInputSchema = activityTypeValuesSchema.extend(actorFields).strict();
export type ActivityTypeInput = z.input<typeof activityTypeInputSchema>;

export const activityTypeLockInputSchema = z
  .object({
    controllingArea: activityTypeValuesSchema.shape.controllingArea,
    activityType: activityTypeValuesSchema.shape.activityType,
    validFrom: dateValue('Valid From'),
    locked: z.boolean(),
    reason: activityTypeValuesSchema.shape.reason,
  })
  .extend(actorFields)
  .strict();
export type ActivityTypeLockInput = z.input<typeof activityTypeLockInputSchema>;

export const activityTypeDeleteInputSchema = z
  .object({
    controllingArea: activityTypeValuesSchema.shape.controllingArea,
    activityType: activityTypeValuesSchema.shape.activityType,
    validFrom: dateValue('Valid From'),
    reason: activityTypeValuesSchema.shape.reason,
  })
  .extend(actorFields)
  .strict();
export type ActivityTypeDeleteInput = z.input<typeof activityTypeDeleteInputSchema>;

export class ActivityTypeError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the activity type and try again.',
  ) {
    super(message);
    this.name = 'ActivityTypeError';
  }
}

export interface ActivityTypeSaveResult {
  changed: boolean;
  controllingArea: string;
  activityType: string;
  validFrom: string;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function assertPrerequisites(tx: Tx, clientId: string): Promise<void> {
  const rows = await tx
    .select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, clientId),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length > 0) {
    throw new ActivityTypeError(
      `Activity type prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define cost centres first: an activity type is priced against cost centres, and there is nothing to price it against until they stand.',
    );
  }
}

const keyWhere = (
  clientId: string,
  key: { controllingArea: string; activityType: string; validFrom: string },
) =>
  and(
    eq(activityType.client, clientId),
    eq(activityType.controllingArea, key.controllingArea),
    eq(activityType.activityType, key.activityType),
    eq(activityType.validFrom, key.validFrom),
  );

function objectKeyFor(key: { controllingArea: string; activityType: string; validFrom: string }): string {
  return `${key.controllingArea}/${key.activityType}/${key.validFrom}`;
}

const FIELD_LABELS = {
  validTo: 'Valid to',
  name: 'Name',
  activityUnit: 'Activity unit',
  category: 'Activity category',
  priceIndicator: 'Price indicator',
  validCcCategories: 'Valid cost centre categories',
  isPostingLocked: 'Posting locked',
} as const;

const EDITABLE_FIELDS = [
  'validTo',
  'name',
  'activityUnit',
  'category',
  'priceIndicator',
  'validCcCategories',
] as const;

export async function saveActivityType(raw: ActivityTypeInput): Promise<ActivityTypeSaveResult> {
  const parsed = activityTypeInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ActivityTypeError(
      parsed.error.issues[0]?.message ?? 'The activity type is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  if (values.validTo < values.validFrom) {
    throw new ActivityTypeError(
      `Valid To ${values.validTo} precedes Valid From ${values.validFrom}.`,
      'A validity period cannot end before it begins; set the end on or after the start.',
    );
  }

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [area] = await tx
      .select({ controllingArea: controllingArea.controllingArea })
      .from(controllingArea)
      .where(and(eq(controllingArea.client, client), eq(controllingArea.controllingArea, values.controllingArea)))
      .limit(1);
    if (!area) {
      throw new ActivityTypeError(
        `Controlling Area ${values.controllingArea} is not defined in this tenant.`,
        'Choose a controlling area that stands; activity types exist inside controlling areas.',
      );
    }

    const [unit] = await tx
      .select({ code: unitOfMeasure.code })
      .from(unitOfMeasure)
      .where(eq(unitOfMeasure.code, values.activityUnit))
      .limit(1);
    if (!unit) {
      throw new ActivityTypeError(
        `Activity Unit ${values.activityUnit} is not a unit of measure that stands.`,
        'Choose a unit from the unit of measure table; an activity type is measured in a unit that exists.',
      );
    }

    const [existing] = await tx
      .select()
      .from(activityType)
      .where(keyWhere(client, values))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new ActivityTypeError(
        `Activity Type ${values.activityType} is already defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Change the period that exists, or start a new period outside its validity.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new ActivityTypeError(
        `Activity Type ${values.activityType} is not defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Create the period first; the key of a period cannot be changed into existence.',
      );
    }

    const siblings = await tx
      .select({ validFrom: activityType.validFrom, validTo: activityType.validTo })
      .from(activityType)
      .where(and(
        eq(activityType.client, client),
        eq(activityType.controllingArea, values.controllingArea),
        eq(activityType.activityType, values.activityType),
      ));
    const overlap = siblings.find(
      (sibling) =>
        sibling.validFrom !== values.validFrom &&
        values.validFrom <= sibling.validTo &&
        sibling.validFrom <= values.validTo,
    );
    if (overlap) {
      throw new ActivityTypeError(
        `The period ${values.validFrom} to ${values.validTo} overlaps the period ${overlap.validFrom} to ${overlap.validTo} of Activity Type ${values.activityType}.`,
        'Validity periods of one activity type may not overlap; start the new period after the standing one ends, or re-set the standing period\'s end first.',
      );
    }

    const stored = {
      validTo: values.validTo,
      name: values.name,
      activityUnit: values.activityUnit,
      category: values.category,
      priceIndicator: values.priceIndicator,
      validCcCategories: values.validCcCategories,
    };
    const objectKey = objectKeyFor(values);
    const result: ActivityTypeSaveResult = {
      changed: true,
      controllingArea: values.controllingArea,
      activityType: values.activityType,
      validFrom: values.validFrom,
    };

    if (values.mode === 'CREATE') {
      await tx.insert(activityType).values({
        client,
        controllingArea: values.controllingArea,
        activityType: values.activityType,
        validFrom: values.validFrom,
        ...stored,
        isPostingLocked: false,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey,
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: {
          controllingArea: values.controllingArea,
          activityType: values.activityType,
          validFrom: values.validFrom,
          ...stored,
        },
        fieldLabels: {
          controllingArea: 'Controlling area',
          activityType: 'Activity type',
          validFrom: 'Valid from',
          ...FIELD_LABELS,
        },
        securityRelevantFields: ['activityUnit', 'category', 'priceIndicator'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    if (!existing) throw new ActivityTypeError('The activity type changed under this request.');
    if (EDITABLE_FIELDS.every((field) => existing[field] === stored[field])) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(activityType)
      .set({ ...stored, changedBy, changedAt: new Date() })
      .where(keyWhere(client, values));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, existing[field]])),
      after: { ...stored },
      fieldLabels: FIELD_LABELS,
      securityRelevantFields: ['activityUnit', 'category', 'priceIndicator'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

export async function setActivityTypePostingLock(
  raw: ActivityTypeLockInput,
): Promise<{ locked: boolean; changed: boolean }> {
  const parsed = activityTypeLockInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ActivityTypeError(
      parsed.error.issues[0]?.message ?? 'The posting lock request is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(activityType)
      .where(keyWhere(client, values))
      .for('update');
    if (!existing) {
      throw new ActivityTypeError(
        `Activity Type ${values.activityType} is not defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Reload the activity types; the period may already have been deleted.',
      );
    }

    if (existing.isPostingLocked === values.locked) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { locked: values.locked, changed: false };
    }

    await tx
      .update(activityType)
      .set({ isPostingLocked: values.locked, changedBy, changedAt: new Date() })
      .where(keyWhere(client, values));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: objectKeyFor(values),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { isPostingLocked: existing.isPostingLocked },
      after: { isPostingLocked: values.locked },
      fieldLabels: FIELD_LABELS,
      securityRelevantFields: ['isPostingLocked'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { locked: values.locked, changed: true };
  });
}

export async function deleteActivityType(raw: ActivityTypeDeleteInput): Promise<{ deleted: true }> {
  const parsed = activityTypeDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ActivityTypeError(
      parsed.error.issues[0]?.message ?? 'The activity type deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(activityType)
      .where(keyWhere(client, values))
      .for('update');
    if (!existing) {
      throw new ActivityTypeError(
        `Activity Type ${values.activityType} is not defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Reload the activity types; the period may already have been deleted.',
      );
    }

    await tx.delete(activityType).where(keyWhere(client, values));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: objectKeyFor(values),
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        controllingArea: existing.controllingArea,
        activityType: existing.activityType,
        validFrom: existing.validFrom,
        validTo: existing.validTo,
        name: existing.name,
        activityUnit: existing.activityUnit,
        category: existing.category,
        priceIndicator: existing.priceIndicator,
        validCcCategories: existing.validCcCategories,
        isPostingLocked: existing.isPostingLocked,
      },
      fieldLabels: {
        controllingArea: 'Controlling area',
        activityType: 'Activity type',
        validFrom: 'Valid from',
        ...FIELD_LABELS,
      },
      securityRelevantFields: ['activityUnit', 'category', 'priceIndicator', 'isPostingLocked'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}
