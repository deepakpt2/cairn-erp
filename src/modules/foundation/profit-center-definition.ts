import { asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { appUser } from '../../platform/tables/security';
import { listCostCenterAreas, type CostCenterArea } from './cost-center-definition';
import { profitCenter, profitCenterNodeAssignment } from './schema';

export { listCostCenterAreas };
export type { CostCenterArea };

/**
 * Profit centre definition — the read side (SCR-045 stage 1).
 *
 * A profit centre is the unit profitability is reported on, defined as
 * validity periods inside a controlling area. The owner's package
 * (KE51) keys the master (area, centre, valid-to) with texts in a
 * separate language table, a mandatory hierarchy area naming a node of
 * the standard profit centre hierarchy, an optional segment, and
 * deletion guarded by postings and dependent objects.
 *
 * The forks (R-94) shape this product's version: SAP parity on the
 * names — the short name (at most 20) required, the long text (at most
 * 40) optional, both on the row as every master here keeps its name —
 * and on the lifecycle (hard delete refused while journal documents
 * dated inside the period carry the centre, plus the posting lock);
 * the segment kept at parity width, entered freely until a segment
 * master stands; and the **hierarchy deferred exactly as KS01's was** —
 * no hierarchy field is carried or judged here, the profit centre
 * hierarchy is its own following SCR, and this screen gains its
 * read-only placement afterward as the cost centre screen did.
 *
 * Journal lines already carry a profit centre code as text, so the
 * deletion judge has something real to count from the first day.
 */
export const ACTIVITY = 'CFG.COST.PROFITCENTER.DEFINE';

export interface ProfitCenterRow {
  controllingArea: string;
  profitCenter: string;
  validFrom: string;
  validTo: string;
  name: string;
  longText: string | null;
  personResponsible: string;
  responsibleUser: string | null;
  segment: string | null;
  isPostingLocked: boolean;
  /** The SCR-047a standard-hierarchy node this period is placed on, if any. */
  hierarchyNode: string | null;
}

export async function listProfitCenters(
  clientId: string,
  area: string,
): Promise<ProfitCenterRow[]> {
  if (area === '') return [];
  return withTenant(clientId, async (tx) => {
    const rows = await tx
      .select({
        controllingArea: profitCenter.controllingArea,
        profitCenter: profitCenter.profitCenter,
        validFrom: profitCenter.validFrom,
        validTo: profitCenter.validTo,
        name: profitCenter.name,
        longText: profitCenter.longText,
        personResponsible: profitCenter.personResponsible,
        responsibleUser: profitCenter.responsibleUser,
        segment: profitCenter.segment,
        isPostingLocked: profitCenter.isPostingLocked,
      })
      .from(profitCenter)
      .where(eq(profitCenter.controllingArea, area))
      .orderBy(asc(profitCenter.profitCenter), asc(profitCenter.validFrom));
    const assignments = await tx
      .select({
        node: profitCenterNodeAssignment.node,
        profitCenter: profitCenterNodeAssignment.profitCenter,
        validFrom: profitCenterNodeAssignment.validFrom,
      })
      .from(profitCenterNodeAssignment)
      .where(eq(profitCenterNodeAssignment.controllingArea, area));
    const placement = new Map(
      assignments.map((row) => [`${row.profitCenter}:${row.validFrom}`, row.node]),
    );
    return rows.map((row) => ({
      ...row,
      hierarchyNode: placement.get(`${row.profitCenter}:${row.validFrom}`) ?? null,
    }));
  });
}

export interface ResponsibleUserChoice {
  username: string;
  fullName: string;
}

/** The tenant's active users, for the responsible-user value help. */
export async function listResponsibleUsers(clientId: string): Promise<ResponsibleUserChoice[]> {
  return withTenant(clientId, async (tx) => {
    const rows = await tx
      .select({ username: appUser.username, fullName: appUser.fullName })
      .from(appUser)
      .where(eq(appUser.isActive, true))
      .orderBy(asc(appUser.username));
    return rows.map((row) => ({ username: row.username.trim(), fullName: row.fullName }));
  });
}

import { z } from 'zod';
import { and, countDistinct, gte, inArray, lte, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { journalEntry, journalEntryLine } from '../finance/schema';
import { controllingArea } from './schema';

/**
 * The write (SCR-045 stage 3; contract R-94).
 *
 * One save on the period key (controlling area, profit centre, valid
 * from) — immutable, as every period key here — with valid to re-set on
 * change so long as the new span overlaps no sibling, the overlap named.
 * The responsible user is judged against the tenant's user directory
 * when entered; the segment is kept at its parity width and entered
 * freely, because no segment master stands yet to judge it, and the
 * screen says so rather than pretending.
 *
 * Locking is its own act (the KS01 lifecycle): it stops the centre
 * being offered to new postings while history stays readable. Deletion
 * is refused while journal documents dated inside the period carry the
 * centre — journal lines already carry a profit centre code as text —
 * the refusal naming the count.
 *
 * A **reason is mandatory on every write**, one change document per
 * write with the responsible user, the segment and the lock state
 * security-relevant: they decide whose result this is and where postings
 * may still go.
 */
export const OBJECT_CLASS = 'profit_center';
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

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} is at most ${max} characters.`)
    .transform((value) => (value === '' ? null : value))
    .nullable();

export const profitCenterValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  controllingArea: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'The Controlling Area is exactly four letters or digits.')),
  profitCenter: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, 'The Profit Centre is up to ten letters or digits.')),
  validFrom: dateValue('Valid From'),
  validTo: dateValue('Valid To'),
  name: z.string().trim().min(1, 'The Name is required.').max(20, 'The Name is at most 20 characters.'),
  longText: optionalText(40, 'The Long Text'),
  personResponsible: z
    .string()
    .trim()
    .max(20, 'The Person Responsible is at most 20 characters.'),
  responsibleUser: optionalText(12, 'The Responsible User'),
  segment: optionalText(10, 'The Segment')
    .transform((value) => (value === null ? null : value.toUpperCase())),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};

export const profitCenterInputSchema = profitCenterValuesSchema.extend(actorFields).strict();
export type ProfitCenterInput = z.input<typeof profitCenterInputSchema>;

export const profitCenterLockInputSchema = z
  .object({
    controllingArea: profitCenterValuesSchema.shape.controllingArea,
    profitCenter: profitCenterValuesSchema.shape.profitCenter,
    validFrom: dateValue('Valid From'),
    locked: z.boolean(),
    reason: profitCenterValuesSchema.shape.reason,
  })
  .extend(actorFields)
  .strict();
export type ProfitCenterLockInput = z.input<typeof profitCenterLockInputSchema>;

export const profitCenterDeleteInputSchema = z
  .object({
    controllingArea: profitCenterValuesSchema.shape.controllingArea,
    profitCenter: profitCenterValuesSchema.shape.profitCenter,
    validFrom: dateValue('Valid From'),
    reason: profitCenterValuesSchema.shape.reason,
  })
  .extend(actorFields)
  .strict();
export type ProfitCenterDeleteInput = z.input<typeof profitCenterDeleteInputSchema>;

export class ProfitCenterError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the profit centre and try again.',
  ) {
    super(message);
    this.name = 'ProfitCenterError';
  }
}

export interface ProfitCenterSaveResult {
  changed: boolean;
  controllingArea: string;
  profitCenter: string;
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
    throw new ProfitCenterError(
      `Profit centre prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define the controlling area first: a profit centre exists inside a controlling area and nowhere else.',
    );
  }
}

const keyWhere = (
  clientId: string,
  key: { controllingArea: string; profitCenter: string; validFrom: string },
) =>
  and(
    eq(profitCenter.client, clientId),
    eq(profitCenter.controllingArea, key.controllingArea),
    eq(profitCenter.profitCenter, key.profitCenter),
    eq(profitCenter.validFrom, key.validFrom),
  );

function objectKeyFor(key: { controllingArea: string; profitCenter: string; validFrom: string }): string {
  return `${key.controllingArea}/${key.profitCenter}/${key.validFrom}`;
}

/**
 * How many journal documents dated inside this period carry the centre,
 * tenant-wide. This count is the deletion guard: postings are history,
 * and history outranks tidiness.
 */
export async function countProfitCenterDocuments(
  tx: Tx,
  clientId: string,
  key: { profitCenter: string; validFrom: string; validTo: string },
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
      eq(journalEntryLine.profitCenter, key.profitCenter),
      gte(journalEntry.postingDate, key.validFrom),
      lte(journalEntry.postingDate, key.validTo),
    ));
  return Number(row?.documents ?? 0);
}

const FIELD_LABELS = {
  validTo: 'Valid to',
  name: 'Name',
  longText: 'Long text',
  personResponsible: 'Person responsible',
  responsibleUser: 'Responsible user',
  segment: 'Segment',
  isPostingLocked: 'Posting locked',
} as const;

const EDITABLE_FIELDS = [
  'validTo',
  'name',
  'longText',
  'personResponsible',
  'responsibleUser',
  'segment',
] as const;

export async function saveProfitCenter(raw: ProfitCenterInput): Promise<ProfitCenterSaveResult> {
  const parsed = profitCenterInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfitCenterError(
      parsed.error.issues[0]?.message ?? 'The profit centre is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  if (values.validTo < values.validFrom) {
    throw new ProfitCenterError(
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
      throw new ProfitCenterError(
        `Controlling Area ${values.controllingArea} is not defined in this tenant.`,
        'Choose a controlling area that stands; profit centres exist inside controlling areas.',
      );
    }

    if (values.responsibleUser !== null) {
      const [user] = await tx
        .select({ username: appUser.username })
        .from(appUser)
        .where(and(eq(appUser.username, values.responsibleUser), eq(appUser.isActive, true)))
        .limit(1);
      if (!user) {
        throw new ProfitCenterError(
          `Responsible User ${values.responsibleUser} is not an active user of this tenant.`,
          'Choose a responsible user from the users who can sign in here, or leave the field empty.',
        );
      }
    }

    const [existing] = await tx
      .select()
      .from(profitCenter)
      .where(keyWhere(client, values))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new ProfitCenterError(
        `Profit Centre ${values.profitCenter} is already defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Change the period that exists, or start a new period outside its validity.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new ProfitCenterError(
        `Profit Centre ${values.profitCenter} is not defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Create the period first; the key of a period cannot be changed into existence.',
      );
    }

    const siblings = await tx
      .select({ validFrom: profitCenter.validFrom, validTo: profitCenter.validTo })
      .from(profitCenter)
      .where(and(
        eq(profitCenter.client, client),
        eq(profitCenter.controllingArea, values.controllingArea),
        eq(profitCenter.profitCenter, values.profitCenter),
      ));
    const overlap = siblings.find(
      (sibling) =>
        sibling.validFrom !== values.validFrom &&
        values.validFrom <= sibling.validTo &&
        sibling.validFrom <= values.validTo,
    );
    if (overlap) {
      throw new ProfitCenterError(
        `The period ${values.validFrom} to ${values.validTo} overlaps the period ${overlap.validFrom} to ${overlap.validTo} of Profit Centre ${values.profitCenter}.`,
        'Validity periods of one profit centre may not overlap; start the new period after the standing one ends, or re-set the standing period\'s end first.',
      );
    }

    const stored = {
      validTo: values.validTo,
      name: values.name,
      longText: values.longText,
      personResponsible: values.personResponsible,
      responsibleUser: values.responsibleUser,
      segment: values.segment,
    };
    const objectKey = objectKeyFor(values);
    const result: ProfitCenterSaveResult = {
      changed: true,
      controllingArea: values.controllingArea,
      profitCenter: values.profitCenter,
      validFrom: values.validFrom,
    };

    if (values.mode === 'CREATE') {
      await tx.insert(profitCenter).values({
        client,
        controllingArea: values.controllingArea,
        profitCenter: values.profitCenter,
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
          profitCenter: values.profitCenter,
          validFrom: values.validFrom,
          ...stored,
        },
        fieldLabels: {
          controllingArea: 'Controlling area',
          profitCenter: 'Profit centre',
          validFrom: 'Valid from',
          ...FIELD_LABELS,
        },
        securityRelevantFields: ['responsibleUser', 'segment'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    if (!existing) throw new ProfitCenterError('The profit centre changed under this request.');
    if (EDITABLE_FIELDS.every((field) => existing[field] === stored[field])) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(profitCenter)
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
      securityRelevantFields: ['responsibleUser', 'segment'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

export async function setProfitCenterPostingLock(
  raw: ProfitCenterLockInput,
): Promise<{ locked: boolean; changed: boolean }> {
  const parsed = profitCenterLockInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfitCenterError(
      parsed.error.issues[0]?.message ?? 'The posting lock request is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(profitCenter)
      .where(keyWhere(client, values))
      .for('update');
    if (!existing) {
      throw new ProfitCenterError(
        `Profit Centre ${values.profitCenter} is not defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Reload the profit centres; the period may already have been deleted.',
      );
    }

    if (existing.isPostingLocked === values.locked) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { locked: values.locked, changed: false };
    }

    await tx
      .update(profitCenter)
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

export async function deleteProfitCenter(raw: ProfitCenterDeleteInput): Promise<{ deleted: true }> {
  const parsed = profitCenterDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfitCenterError(
      parsed.error.issues[0]?.message ?? 'The profit centre deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(profitCenter)
      .where(keyWhere(client, values))
      .for('update');
    if (!existing) {
      throw new ProfitCenterError(
        `Profit Centre ${values.profitCenter} is not defined in Controlling Area ${values.controllingArea} from ${values.validFrom}.`,
        'Reload the profit centres; the period may already have been deleted.',
      );
    }

    const documents = await countProfitCenterDocuments(tx, client, {
      profitCenter: values.profitCenter,
      validFrom: existing.validFrom,
      validTo: existing.validTo,
    });
    if (documents > 0) {
      throw new ProfitCenterError(
        `Profit Centre ${values.profitCenter} carries ${documents} journal document${documents === 1 ? '' : 's'} dated inside this period and cannot be deleted.`,
        'History outranks tidiness: lock the profit centre for posting instead; the centre keeps its history and stops being offered to new postings.',
      );
    }

    await tx.delete(profitCenter).where(keyWhere(client, values));

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
        profitCenter: existing.profitCenter,
        validFrom: existing.validFrom,
        validTo: existing.validTo,
        name: existing.name,
        longText: existing.longText,
        personResponsible: existing.personResponsible,
        responsibleUser: existing.responsibleUser,
        segment: existing.segment,
        isPostingLocked: existing.isPostingLocked,
      },
      fieldLabels: {
        controllingArea: 'Controlling area',
        profitCenter: 'Profit centre',
        validFrom: 'Valid from',
        ...FIELD_LABELS,
      },
      securityRelevantFields: ['responsibleUser', 'segment', 'isPostingLocked'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}
