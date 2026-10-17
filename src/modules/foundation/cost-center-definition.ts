import { asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { controllingArea, controllingAreaCompany, costCenter, costCenterNodeAssignment } from './schema';

/**
 * Cost centre definition — the read side (SCR-041 stage 1).
 *
 * A cost centre is where cost accounting collects overhead. In the
 * reference layout (the KS01 package) master data rests on validity rows
 * keyed (area, centre, valid-from) with a separate language-text table,
 * and deletion is refused while postings stand against the centre in the
 * window, a posting lock being the standing alternative.
 *
 * The owner's four forks (R-90) shape this product's version: **true
 * validity periods** (SAP parity — non-overlapping rows per centre, valid
 * to re-settable while it overlaps none); **delete-when-unused plus the
 * posting lock** (journal lines already carry centre codes as text, so the
 * deletion refusal counts journal documents dated inside the period);
 * **product category words** — the single letters live as search
 * aliases only; **hierarchy placement deferred to SCR-042**, so this
 * screen carries no hierarchy field. Two package elements settle without
 * a fork in this product's pattern: the currency displays from the
 * controlling area rather than being stored twice, and the name lives on
 * the row (no language-text table), as every master here does.
 *
 * Postings carry centre codes as text today and do not validate them
 * against these rows yet; this activity defines the master they will read.
 */
export const ACTIVITY = 'CFG.COST.COSTCENTER.DEFINE';

export interface CostCenterCategory {
  category: string;
  /** The reference single letter, for search and display only — never stored. */
  referenceAlias: string;
}

export const COST_CENTER_CATEGORIES: CostCenterCategory[] = [
  { category: 'PRODUCTION', referenceAlias: 'F' },
  { category: 'ADMINISTRATION', referenceAlias: 'V' },
  { category: 'SERVICE', referenceAlias: 'S' },
  { category: 'SALES', referenceAlias: 'V (sales)' },
  { category: 'SUPPORT', referenceAlias: 'H' },
];

export function isCostCenterCategory(value: string): boolean {
  return COST_CENTER_CATEGORIES.some((entry) => entry.category === value);
}

export interface CostCenterArea {
  controllingArea: string;
  name: string;
  currency: string;
}

export interface CostCenterRow {
  controllingArea: string;
  costCenter: string;
  validFrom: string;
  validTo: string;
  name: string;
  personResponsible: string | null;
  category: string;
  companyCode: string;
  isPostingLocked: boolean;
  currency: string;
  /** Journal documents dated inside this period carrying the centre (the deletion judge). */
  journalDocuments: number;
  /** The standard-hierarchy node this period stands in (SCR-042), or null = not placed. */
  hierarchyNode: string | null;
}

export async function listCostCenterAreas(clientId: string): Promise<CostCenterArea[]> {
  return withTenant(clientId, async (tx) =>
    tx
      .select({
        controllingArea: controllingArea.controllingArea,
        name: controllingArea.name,
        currency: controllingArea.currency,
      })
      .from(controllingArea)
      .orderBy(asc(controllingArea.controllingArea)),
  );
}

export async function listCostCenters(clientId: string, area: string): Promise<CostCenterRow[]> {
  if (area === '') return [];
  return withTenant(clientId, async (tx) => {
    const rows = await tx
      .select({
        controllingArea: costCenter.controllingArea,
        costCenter: costCenter.costCenter,
        validFrom: costCenter.validFrom,
        validTo: costCenter.validTo,
        name: costCenter.name,
        personResponsible: costCenter.personResponsible,
        category: costCenter.category,
        companyCode: costCenter.companyCode,
        isPostingLocked: costCenter.isPostingLocked,
        currency: controllingArea.currency,
      })
      .from(costCenter)
      .innerJoin(
        controllingArea,
        eq(costCenter.controllingArea, controllingArea.controllingArea),
      )
      .where(eq(costCenter.controllingArea, area))
      .orderBy(asc(costCenter.costCenter), asc(costCenter.validFrom));
    const assignments = await tx
      .select({
        node: costCenterNodeAssignment.node,
        costCenter: costCenterNodeAssignment.costCenter,
        validFrom: costCenterNodeAssignment.validFrom,
      })
      .from(costCenterNodeAssignment)
      .where(eq(costCenterNodeAssignment.controllingArea, area));
    const placement = new Map(
      assignments.map((row) => [`${row.costCenter}:${row.validFrom}`, row.node]),
    );
    const counted = [];
    for (const row of rows) {
      counted.push({
        ...row,
        currency: row.currency.trim(),
        journalDocuments: await countCostCenterDocuments(tx, clientId, {
          costCenter: row.costCenter,
          validFrom: row.validFrom,
          validTo: row.validTo,
        }),
        hierarchyNode: placement.get(`${row.costCenter}:${row.validFrom}`) ?? null,
      });
    }
    return counted;
  });
}

/** The company codes assigned to an area (SCR-025), the KS01 value help. */
export async function listAreaCompanyCodes(clientId: string, area: string): Promise<string[]> {
  if (area === '') return [];
  return withTenant(clientId, async (tx) => {
    const rows = await tx
      .select({ companyCode: controllingAreaCompany.companyCode })
      .from(controllingAreaCompany)
      .where(eq(controllingAreaCompany.controllingArea, area))
      .orderBy(asc(controllingAreaCompany.companyCode));
    return rows.map((row) => row.companyCode);
  });
}

import { z } from 'zod';
import { and, countDistinct, gte, inArray, lte, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { journalEntry, journalEntryLine } from '../finance/schema';

/**
 * The write (SCR-041 stage 3; contract R-90).
 *
 * One save: create-or-change on the period key. The key — controlling
 * area, cost centre, valid from — is never a changeable field; valid to
 * may be re-set on change so long as the new span still overlaps no
 * sibling period (the database cannot see sibling rows; the service and
 * the check on the span together can). Locking is its own act: it stops
 * a centre being offered to new postings while the centre keeps its
 * history, the standing alternative to removal. Deletion is hard and
 * refuses while journal documents dated inside the period carry the
 * centre, the refusal stating the tenant-wide count from the journal
 * lines whose cost-centre column already carries codes as text.
 *
 * A **reason is mandatory on every write**, one change document per
 * write with the company code and lock state security-relevant: together
 * they decide which company a centre charges and whether it may charge
 * at all.
 */
export const OBJECT_CLASS = 'cost_center';
const PREREQUISITES = ['CFG.COST.CONTROLLINGAREA.DEFINE'] as const;

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

export const costCenterValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  controllingArea: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'The Controlling Area is exactly four letters or digits.')),
  costCenter: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, 'The Cost Centre is up to ten letters or digits.')),
  validFrom: dateValue('Valid From'),
  validTo: dateValue('Valid To'),
  name: z.string().trim().min(1, 'The Name is required.').max(40, 'The Name is at most 40 characters.'),
  personResponsible: z
    .string()
    .trim()
    .max(20, 'Person Responsible is at most 20 characters.')
    .transform((value) => (value === '' ? null : value)),
  category: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine(isCostCenterCategory, 'The Category is one of the defined cost centre categories.'),
  companyCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, 'The Company Code is up to ten letters or digits.')),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};

export const costCenterInputSchema = costCenterValuesSchema.extend(actorFields).strict();
export type CostCenterInput = z.input<typeof costCenterInputSchema>;

export const costCenterLockInputSchema = z
  .object({
    controllingArea: costCenterValuesSchema.shape.controllingArea,
    costCenter: costCenterValuesSchema.shape.costCenter,
    validFrom: dateValue('Valid From'),
    locked: z.boolean(),
    reason: costCenterValuesSchema.shape.reason,
  })
  .extend(actorFields)
  .strict();
export type CostCenterLockInput = z.input<typeof costCenterLockInputSchema>;

export const costCenterDeleteInputSchema = z
  .object({
    controllingArea: costCenterValuesSchema.shape.controllingArea,
    costCenter: costCenterValuesSchema.shape.costCenter,
    validFrom: dateValue('Valid From'),
    reason: costCenterValuesSchema.shape.reason,
  })
  .extend(actorFields)
  .strict();
export type CostCenterDeleteInput = z.input<typeof costCenterDeleteInputSchema>;

export class CostCenterError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the cost centre and try again.',
  ) {
    super(message);
    this.name = 'CostCenterError';
  }
}

export interface CostCenterSaveResult {
  changed: boolean;
  controllingArea: string;
  costCenter: string;
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
    throw new CostCenterError(
      `Cost centre prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define the controlling area first: a cost centre exists inside a controlling area, and there is nothing to define it in until the area stands.',
    );
  }
}

const keyWhere = (clientId: string, key: { controllingArea: string; costCenter: string; validFrom: string }) =>
  and(
    eq(costCenter.client, clientId),
    eq(costCenter.controllingArea, key.controllingArea),
    eq(costCenter.costCenter, key.costCenter),
    eq(costCenter.validFrom, key.validFrom),
  );

function objectKeyFor(key: { controllingArea: string; costCenter: string; validFrom: string }): string {
  return `${key.controllingArea}/${key.costCenter}/${key.validFrom}`;
}

/**
 * How many journal documents dated inside this period carry the centre,
 * tenant-wide. This count is the deletion guard: postings are history, and
 * history outranks tidiness.
 */
export async function countCostCenterDocuments(
  tx: Tx,
  clientId: string,
  key: { costCenter: string; validFrom: string; validTo: string },
): Promise<number> {
  const [row] = await tx
    .select({ documents: countDistinct(sql`(${journalEntry.documentNumber}, ${journalEntry.fiscalYear})`) })
    .from(journalEntryLine)
    .innerJoin(
      journalEntry,
      and(
        eq(journalEntryLine.documentNumber, journalEntry.documentNumber),
        eq(journalEntryLine.fiscalYear, journalEntry.fiscalYear),
      ),
    )
    .where(and(
      eq(journalEntryLine.client, clientId),
      eq(journalEntryLine.costCenter, key.costCenter),
      gte(journalEntry.postingDate, key.validFrom),
      lte(journalEntry.postingDate, key.validTo),
    ));
  return Number(row?.documents ?? 0);
}

const FIELD_LABELS = {
  validTo: 'Valid to',
  name: 'Name',
  personResponsible: 'Person responsible',
  category: 'Category',
  companyCode: 'Company code',
  isPostingLocked: 'Posting locked',
} as const;

const EDITABLE_FIELDS = ['validTo', 'name', 'personResponsible', 'category', 'companyCode'] as const;

/**
 * Create a cost centre period, or change the facts of one that stands.
 * The company code is judged against the area's assignment — a code
 * assigned to no area, or to another area, is refused by name — and the
 * validity span is judged against every sibling period of the centre.
 */
export async function saveCostCenter(raw: CostCenterInput): Promise<CostCenterSaveResult> {
  const parsed = costCenterInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CostCenterError(
      parsed.error.issues[0]?.message ?? 'The cost centre is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  if (values.validTo < values.validFrom) {
    throw new CostCenterError(
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
      throw new CostCenterError(
        `Controlling Area ${values.controllingArea} is not defined in this tenant.`,
        'Choose a controlling area that stands; cost centres exist inside controlling areas.',
      );
    }

    const [assignment] = await tx
      .select({ companyCode: controllingAreaCompany.companyCode })
      .from(controllingAreaCompany)
      .where(and(
        eq(controllingAreaCompany.client, client),
        eq(controllingAreaCompany.controllingArea, values.controllingArea),
        eq(controllingAreaCompany.companyCode, values.companyCode),
      ))
      .limit(1);
    if (!assignment) {
      throw new CostCenterError(
        `Company Code ${values.companyCode} is not assigned to Controlling Area ${values.controllingArea}.`,
        'Choose a company code assigned to this controlling area, or assign the company code to the area first.',
      );
    }

    const [existing] = await tx
      .select()
      .from(costCenter)
      .where(keyWhere(client, values))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new CostCenterError(
        `Cost Centre ${values.costCenter} is already defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Change the period that exists, or start a new period outside its validity.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new CostCenterError(
        `Cost Centre ${values.costCenter} is not defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Create the period first; the key of a period cannot be changed into existence.',
      );
    }

    const siblings = await tx
      .select({ validFrom: costCenter.validFrom, validTo: costCenter.validTo })
      .from(costCenter)
      .where(and(
        eq(costCenter.client, client),
        eq(costCenter.controllingArea, values.controllingArea),
        eq(costCenter.costCenter, values.costCenter),
      ));
    const overlap = siblings.find(
      (sibling) =>
        sibling.validFrom !== values.validFrom &&
        values.validFrom <= sibling.validTo &&
        sibling.validFrom <= values.validTo,
    );
    if (overlap) {
      throw new CostCenterError(
        `The period ${values.validFrom} to ${values.validTo} overlaps the period ${overlap.validFrom} to ${overlap.validTo} of Cost Centre ${values.costCenter}.`,
        'Validity periods of one cost centre may not overlap; start the new period after the standing one ends, or re-set the standing period\'s end first.',
      );
    }

    const stored = {
      validTo: values.validTo,
      name: values.name,
      personResponsible: values.personResponsible,
      category: values.category,
      companyCode: values.companyCode,
    };
    const objectKey = objectKeyFor(values);
    const result: CostCenterSaveResult = {
      changed: true,
      controllingArea: values.controllingArea,
      costCenter: values.costCenter,
      validFrom: values.validFrom,
    };

    if (values.mode === 'CREATE') {
      await tx.insert(costCenter).values({
        client,
        controllingArea: values.controllingArea,
        costCenter: values.costCenter,
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
          costCenter: values.costCenter,
          validFrom: values.validFrom,
          ...stored,
        },
        fieldLabels: {
          controllingArea: 'Controlling area',
          costCenter: 'Cost centre',
          validFrom: 'Valid from',
          ...FIELD_LABELS,
        },
        securityRelevantFields: ['companyCode'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    if (EDITABLE_FIELDS.every((field) => existing[field] === stored[field])) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(costCenter)
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
      securityRelevantFields: ['companyCode'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

/**
 * Lock or unlock a period for posting. The lock stops new postings being
 * offered the centre; the centre keeps its history and stays listed —
 * the standing alternative to deletion.
 */
export async function setCostCenterPostingLock(
  raw: CostCenterLockInput,
): Promise<{ locked: boolean; changed: boolean }> {
  const parsed = costCenterLockInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CostCenterError(
      parsed.error.issues[0]?.message ?? 'The posting lock request is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(costCenter)
      .where(keyWhere(client, values))
      .for('update');
    if (!existing) {
      throw new CostCenterError(
        `Cost Centre ${values.costCenter} is not defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Reload the cost centres; the period may already have been deleted.',
      );
    }

    if (existing.isPostingLocked === values.locked) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { locked: values.locked, changed: false };
    }

    await tx
      .update(costCenter)
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

/**
 * Delete a period. Refused while journal documents dated inside the
 * period carry the centre, the refusal stating how many — afterwards the
 * posting lock is the alternative, stated on the screen.
 */
export async function deleteCostCenter(raw: CostCenterDeleteInput): Promise<{ deleted: true }> {
  const parsed = costCenterDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CostCenterError(
      parsed.error.issues[0]?.message ?? 'The cost centre deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(costCenter)
      .where(keyWhere(client, values))
      .for('update');
    if (!existing) {
      throw new CostCenterError(
        `Cost Centre ${values.costCenter} is not defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Reload the cost centres; the period may already have been deleted.',
      );
    }

    const documents = await countCostCenterDocuments(tx, client, {
      costCenter: values.costCenter,
      validFrom: existing.validFrom,
      validTo: existing.validTo,
    });
    if (documents > 0) {
      throw new CostCenterError(
        `Cost Centre ${values.costCenter} carries ${documents} journal document${documents === 1 ? '' : 's'} dated inside this period and cannot be deleted.`,
        'History outranks tidiness: lock the cost centre for posting instead; the centre keeps its history and stops being offered to new postings.',
      );
    }

    await tx.delete(costCenter).where(keyWhere(client, values));

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
        costCenter: existing.costCenter,
        validFrom: existing.validFrom,
        validTo: existing.validTo,
        name: existing.name,
        personResponsible: existing.personResponsible,
        category: existing.category,
        companyCode: existing.companyCode,
        isPostingLocked: existing.isPostingLocked,
      },
      fieldLabels: {
        controllingArea: 'Controlling area',
        costCenter: 'Cost centre',
        validFrom: 'Valid from',
        ...FIELD_LABELS,
      },
      securityRelevantFields: ['companyCode', 'isPostingLocked'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}
