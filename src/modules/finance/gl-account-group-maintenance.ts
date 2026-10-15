/**
 * SCR-028 / FS00 — Account Group registry (`KTOKS`) and its field status matrix.
 *
 * The registry decides how an account may be maintained: the number range a group owns
 * and, field by field, whether FS00 suppresses a field, offers it or demands it. It is
 * maintained as a panel inside FS00 under the same capabilities (R-51/D-123), so this
 * module owns the writes and the screen owns the rendering — and because the screen
 * renders entirely from the matrix, a rule enforced only here would be invisible, and a
 * rule enforced only there would be optional.
 *
 * Four rules shape the writes:
 * - a range is read against the chart's account-number length (OB13 `KTKTB`), so a bound
 *   longer than the chart allows is refused rather than silently unreachable;
 * - a group's range may not overlap a sibling's, active or not, because the registry
 *   partitions the chart's number space and an overlap makes the range check on an
 *   account ambiguous;
 * - a range may not be narrowed past the accounts already inside the group, and a group
 *   is deactivated rather than deleted while accounts belong to it — there is no delete;
 * - a field the database cannot store without a value (`name`, `accountType`) may not be
 *   relaxed below MANDATORY, because a suppressed field is never submitted and the write
 *   would have nothing to store.
 *
 * The matrix stores only the fields that differ from the baseline in
 * `gl-account-vocabulary.ts`. A field with no row behaves exactly as the baseline says,
 * which keeps the table small and an audit diff down to the fields a consultant actually
 * moved.
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
// Aliased: several functions take a `chartOfAccounts` key, which would shadow the table.
import { chartOfAccounts as chartOfAccountsTable } from '../foundation/schema';
import { glAccount } from './schema';
import {
  glAccountGroup,
  glAccountGroupFieldStatus,
  groupChartAccounts,
} from './gl-account-group-schema';
import {
  DEFAULT_FIELD_STATUS,
  FIELD_STATUSES,
  GL_ACCOUNT_FIELD_LABELS,
  GL_ACCOUNT_FIELDS,
  STORAGE_MANDATORY_FIELDS,
  accountNumberInRange,
  type FieldStatus,
  type FieldStatusMatrix,
  type GlAccountField,
} from './gl-account-vocabulary';

const CREATE_ACTIVITY = 'CFG.FIN.GLACCOUNT.CREATE';
const CHANGE_ACTIVITY = 'CFG.FIN.GLACCOUNT.CHANGE';
const OBJECT_CLASS = 'gl_account_group';
/** The matrix keeps its own object class so registry and matrix history stay separable. */
const MATRIX_OBJECT_CLASS = 'gl_account_group_field_status';

const clientSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const chartCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'Chart of Accounts must be exactly four letters or numbers.'));
const groupCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'Account Group must be exactly four letters or numbers.'));
const descriptionSchema = z
  .string()
  .trim()
  .min(1, 'Description is required.')
  .max(50, 'Description must be 50 characters or fewer.');
const rangeBoundSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,10}$/, 'A range bound must be one to ten letters or numbers.');
const reasonSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((value) => value || undefined);
const versionSchema = z.coerce.number().int('Expected version must be a whole number.').min(0);
const actorSchema = z.string().trim().min(1, 'A changed-by actor is required.');

/** Business fields of one registry row; the group key is immutable after create. */
export const accountGroupValuesSchema = z.object({
  chartOfAccounts: chartCodeSchema,
  accountGroup: groupCodeSchema,
  description: descriptionSchema,
  fromAccountNumber: rangeBoundSchema,
  toAccountNumber: rangeBoundSchema,
});

export const accountGroupMaintenanceInputSchema = accountGroupValuesSchema.extend({
  client: clientSchema,
  changedBy: actorSchema,
  mode: z.enum(['CREATE', 'CHANGE']),
  expectedVersion: versionSchema,
  reason: reasonSchema,
});

export const accountGroupLifecycleInputSchema = z.object({
  client: clientSchema,
  changedBy: actorSchema,
  chartOfAccounts: chartCodeSchema,
  accountGroup: groupCodeSchema,
  isActive: z.boolean(),
  expectedVersion: versionSchema,
  reason: reasonSchema,
});

export const accountGroupFieldStatusInputSchema = z.object({
  client: clientSchema,
  changedBy: actorSchema,
  chartOfAccounts: chartCodeSchema,
  accountGroup: groupCodeSchema,
  expectedVersion: versionSchema,
  /** Field key → status. A field left out falls back to the baseline. */
  statuses: z.record(z.string(), z.string()).default({}),
  reason: reasonSchema,
});

export type AccountGroupValues = z.output<typeof accountGroupValuesSchema>;
export type AccountGroupMaintenanceInput = z.input<typeof accountGroupMaintenanceInputSchema>;
export type AccountGroupLifecycleInput = z.input<typeof accountGroupLifecycleInputSchema>;
export type AccountGroupFieldStatusInput = z.input<typeof accountGroupFieldStatusInputSchema>;

export class GlAccountGroupMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Account Group definition and try again.',
  ) {
    super(message);
    this.name = 'GlAccountGroupMaintenanceError';
  }
}

/**
 * One registry row as the panel and the field screen consume it.
 *
 * `fieldStatus` is the *effective* matrix — stored rows merged over the baseline — so a
 * caller never has to know which fields a group bothers to store.
 */
export interface AccountGroupRegistryRow {
  chartOfAccounts: string;
  accountGroup: string;
  description: string;
  fromAccountNumber: string;
  toAccountNumber: string;
  fieldStatus: FieldStatusMatrix;
  isActive: boolean;
  version: number;
  /** Accounts currently assigned to this group; a group with accounts is never deleted. */
  accountCount: number;
}

export interface AccountGroupSaveResult {
  created: boolean;
  changed: boolean;
  chartOfAccounts: string;
  accountGroup: string;
  description: string;
  fromAccountNumber: string;
  toAccountNumber: string;
  isActive: boolean;
  version: number;
}

/* ── Reads ─────────────────────────────────────────────────────────────────── */

/**
 * The registry with effective matrices and account counts.
 *
 * Counts come with the rows rather than per row: the panel shows whether deactivating a
 * group strands accounts, and asking that once per group would be a query per row.
 */
export async function listAccountGroups(
  client: string,
  options: { chartOfAccounts?: string } = {},
): Promise<AccountGroupRegistryRow[]> {
  const parsed = clientSchema.safeParse(client);
  if (!parsed.success) throw invalidInput(parsed.error);
  const tenant = parsed.data;
  const chart = options.chartOfAccounts
    ? chartCodeSchema.safeParse(options.chartOfAccounts)
    : null;
  if (chart && !chart.success) throw invalidInput(chart.error);

  return withTenant(tenant, async (tx) => {
    const filters = [eq(glAccountGroup.client, tenant)];
    if (chart) filters.push(eq(glAccountGroup.chartOfAccounts, chart.data));

    const [groups, statuses, counts] = await Promise.all([
      tx
        .select()
        .from(glAccountGroup)
        .where(and(...filters))
        .orderBy(asc(glAccountGroup.chartOfAccounts), asc(glAccountGroup.accountGroup)),
      tx
        .select()
        .from(glAccountGroupFieldStatus)
        .where(and(...(chart
          ? [eq(glAccountGroupFieldStatus.client, tenant), eq(glAccountGroupFieldStatus.chartOfAccounts, chart.data)]
          : [eq(glAccountGroupFieldStatus.client, tenant)]))),
      tx
        .select({
          chartOfAccounts: glAccount.chartOfAccounts,
          accountGroup: glAccount.accountGroup,
          accountCount: sql<number>`count(*)::int`,
        })
        .from(glAccount)
        .where(and(...(chart
          ? [eq(glAccount.client, tenant), eq(glAccount.chartOfAccounts, chart.data)]
          : [eq(glAccount.client, tenant)])))
        .groupBy(glAccount.chartOfAccounts, glAccount.accountGroup),
    ]);

    const matrixByGroup = new Map<string, FieldStatusMatrix>();
    for (const row of statuses) {
      const key = groupIdentity(row.chartOfAccounts, row.accountGroup);
      const matrix = matrixByGroup.get(key) ?? {};
      matrix[row.fieldKey as GlAccountField] = row.status as FieldStatus;
      matrixByGroup.set(key, matrix);
    }
    const countByGroup = new Map(
      counts.map((row) => [groupIdentity(row.chartOfAccounts, row.accountGroup), row.accountCount]),
    );

    return groups.map((row) => {
      const key = groupIdentity(row.chartOfAccounts, row.accountGroup);
      return {
        chartOfAccounts: row.chartOfAccounts.trim(),
        accountGroup: row.accountGroup.trim(),
        description: row.description.trim(),
        fromAccountNumber: row.fromAccountNumber.trim(),
        toAccountNumber: row.toAccountNumber.trim(),
        fieldStatus: matrixByGroup.get(key) ?? {},
        isActive: row.isActive,
        version: row.version,
        accountCount: countByGroup.get(key) ?? 0,
      };
    });
  });
}

/** Effective matrices for every group of one chart, keyed by group code. */
export async function accountGroupFieldStatusMatrices(
  client: string,
  chartOfAccounts: string,
): Promise<Record<string, FieldStatusMatrix>> {
  const groups = await listAccountGroups(client, { chartOfAccounts });
  return Object.fromEntries(groups.map((row) => [row.accountGroup, row.fieldStatus]));
}

/**
 * Account Group F4 for the field screen: active groups of the chart only.
 *
 * A deactivated group keeps its accounts readable but cannot be newly selected, exactly
 * as a deactivated Chart of Accounts behaves in OB13.
 */
export async function accountGroupChoices(
  client: string,
  chartOfAccounts: string,
): Promise<Array<{ code: string; name: string }>> {
  const groups = await listAccountGroups(client, { chartOfAccounts });
  return groups
    .filter((row) => row.isActive)
    .map((row) => ({ code: row.accountGroup, name: row.description }));
}

/**
 * Group-side account F4, resolved through the chart's Group CoA (OB13 `KTOKL`).
 *
 * The table exists and is keyed to the Group CoA registry but has no maintenance screen
 * (R-51/D-123), so this legitimately returns nothing until a consolidation round fills
 * it — an empty lookup is the honest answer, not an invented list.
 */
export async function groupAccountChoices(
  client: string,
  chartOfAccounts: string,
): Promise<Array<{ code: string; name: string }>> {
  const parsedClient = clientSchema.safeParse(client);
  if (!parsedClient.success) throw invalidInput(parsedClient.error);
  const parsedChart = chartCodeSchema.safeParse(chartOfAccounts);
  if (!parsedChart.success) throw invalidInput(parsedChart.error);
  const tenant = parsedClient.data;
  const chart = parsedChart.data;

  return withTenant(tenant, async (tx) => {
    const [chartRow] = await tx
      .select({ groupChart: chartOfAccountsTable.groupChart })
      .from(chartOfAccountsTable)
      .where(and(eq(chartOfAccountsTable.client, tenant), eq(chartOfAccountsTable.chartOfAccounts, chart)))
      .limit(1);
    const groupChart = chartRow?.groupChart?.trim();
    if (!groupChart) return [];

    const rows = await tx
      .select({
        code: groupChartAccounts.groupAccountNumber,
        name: groupChartAccounts.name,
      })
      .from(groupChartAccounts)
      .where(
        and(
          eq(groupChartAccounts.client, tenant),
          eq(groupChartAccounts.groupChartOfAccounts, groupChart),
          eq(groupChartAccounts.isActive, true),
        ),
      )
      .orderBy(asc(groupChartAccounts.groupAccountNumber));
    return rows.map((row) => ({ code: row.code.trim(), name: row.name.trim() }));
  });
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

/**
 * Create or change one Account Group.
 *
 * The group key is part of the identity and never changes: moving a range to another key
 * is a new group, and the old one is deactivated so its accounts keep their history.
 */
export async function saveAccountGroup(raw: AccountGroupMaintenanceInput): Promise<AccountGroupSaveResult> {
  const parsed = accountGroupMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, mode, expectedVersion, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await lockGroup(tx, client, values.chartOfAccounts, values.accountGroup);
    const chart = await requireChart(tx, client, values.chartOfAccounts);
    const [current] = await tx
      .select()
      .from(glAccountGroup)
      .where(groupKey(client, values.chartOfAccounts, values.accountGroup))
      .for('update');

    const activity = mode === 'CREATE' ? CREATE_ACTIVITY : CHANGE_ACTIVITY;

    // Creating something that already exists is not an error worth a rollback: the panel
    // reports it and the user opens Change instead. Mirrors OB13's create behaviour.
    if (mode === 'CREATE' && current) {
      await markActivityComplete(tx, client, activity, changedBy);
      return groupResult(current, { created: false, changed: false });
    }
    if (mode === 'CHANGE' && !current) throw groupNotFound(values.accountGroup);
    if (expectedVersion !== (current?.version ?? 0)) throw staleVersion(values.accountGroup);
    if (!chart.isActive) {
      throw new GlAccountGroupMaintenanceError(
        `Chart of Accounts ${values.chartOfAccounts} is deactivated.`,
        'Reactivate the Chart of Accounts in OB13 before maintaining its Account Groups.',
      );
    }
    // A blocked chart refuses new registry rows exactly as it refuses new accounts;
    // existing rows stay maintainable so a consultant can narrow a range or deactivate.
    if (!current && chart.isBlocked) {
      throw new GlAccountGroupMaintenanceError(
        `Chart of Accounts ${values.chartOfAccounts} is blocked; new Account Groups cannot be created.`,
        'Remove the Chart of Accounts block before creating an Account Group.',
      );
    }
    if (current && !current.isActive) {
      throw new GlAccountGroupMaintenanceError(
        `Account Group ${values.accountGroup} is deactivated and cannot be changed.`,
        'Reactivate the Account Group before changing its description or range.',
      );
    }

    requireRangeWithinChartLength(values, chart.accountNumberLength);
    requireRangeOrdered(values);

    if (current && rangeChanged(current, values)) {
      const outside = await accountsOutsideRange(tx, client, values);
      if (outside.length > 0) {
        throw new GlAccountGroupMaintenanceError(
          `Account Group ${values.accountGroup} cannot be narrowed: ${outside.length} ${outside.length === 1 ? 'account' : 'accounts'} (${outside.join(', ')}) would fall outside ${values.fromAccountNumber} to ${values.toAccountNumber}.`,
          'Keep the range wide enough for the accounts already in the group, or move those accounts to another group first.',
        );
      }
    }
    const overlap = await overlappingGroup(tx, client, values);
    if (overlap) {
      throw new GlAccountGroupMaintenanceError(
        `The range ${values.fromAccountNumber} to ${values.toAccountNumber} overlaps Account Group ${overlap.accountGroup} (${overlap.fromAccountNumber} to ${overlap.toAccountNumber}) of Chart of Accounts ${values.chartOfAccounts}.`,
        'Choose a range no other Account Group of this chart occupies, active or not.',
      );
    }

    if (current) {
      const before = groupSnapshot(current);
      if (sameGroupValues(before, values)) {
        await markActivityComplete(tx, client, activity, changedBy);
        return groupResult(current, { created: false, changed: false });
      }

      await tx
        .update(glAccountGroup)
        .set({
          description: values.description,
          fromAccountNumber: values.fromAccountNumber,
          toAccountNumber: values.toAccountNumber,
          version: current.version + 1,
          changedBy,
          changedAt: new Date(),
        })
        .where(groupKey(client, values.chartOfAccounts, values.accountGroup));

      const changeId = await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: groupIdentity(values.chartOfAccounts, values.accountGroup),
        changeType: 'CHANGE',
        changedBy,
        transactionCode: activity,
        reason,
        before,
        after: { ...before, ...values },
        fieldLabels: GROUP_FIELD_LABELS,
        // The range decides which accounts this group accepts, so moving it changes what
        // the books will take. An auditor cares about that, not about a description.
        securityRelevantFields: ['fromAccountNumber', 'toAccountNumber'],
      });
      if (!changeId) {
        throw new GlAccountGroupMaintenanceError(
          'Account Group change could not be recorded in change history.',
          'Retry the save. If the problem continues, contact an administrator.',
        );
      }
      await markActivityComplete(tx, client, activity, changedBy);
      return {
        created: false,
        changed: true,
        ...values,
        isActive: current.isActive,
        version: current.version + 1,
      };
    }

    await tx.insert(glAccountGroup).values({
      client,
      chartOfAccounts: values.chartOfAccounts,
      accountGroup: values.accountGroup,
      description: values.description,
      fromAccountNumber: values.fromAccountNumber,
      toAccountNumber: values.toAccountNumber,
      isActive: true,
      version: 1,
      createdBy: changedBy,
    });

    const changeId = await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: groupIdentity(values.chartOfAccounts, values.accountGroup),
      changeType: 'CREATE',
      changedBy,
      transactionCode: activity,
      reason,
      after: { ...values, isActive: true },
      fieldLabels: GROUP_FIELD_LABELS,
      securityRelevantFields: ['accountGroup', 'fromAccountNumber', 'toAccountNumber'],
    });
    if (!changeId) {
      throw new GlAccountGroupMaintenanceError(
        'Account Group creation could not be recorded in change history.',
        'Retry the save. If the problem continues, contact an administrator.',
      );
    }
    await markActivityComplete(tx, client, activity, changedBy);
    return { created: true, changed: true, ...values, isActive: true, version: 1 };
  });
}

/**
 * Deactivate or reactivate an Account Group.
 *
 * There is no delete: accounts keep their group foreign key for as long as they exist, so
 * a group leaves the F4 by being deactivated and its history stays intact. A reason is
 * mandatory when switching a group off, because from that moment no account may be
 * created against it — that is a change to what the books accept, and it is not cosmetic.
 */
export async function setAccountGroupActive(
  raw: AccountGroupLifecycleInput,
): Promise<{ chartOfAccounts: string; accountGroup: string; isActive: boolean; changed: boolean; version: number; accountCount: number }> {
  const parsed = accountGroupLifecycleInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, chartOfAccounts: chart, accountGroup: code, isActive, expectedVersion, reason } = parsed.data;

  if (!isActive && !reason) {
    throw new GlAccountGroupMaintenanceError(
      'A reason is required to deactivate an Account Group.',
      'Explain why the group is being taken out of use; the note is stored with the change.',
    );
  }

  return withTenant(client, async (tx) => {
    await lockGroup(tx, client, chart, code);
    const [current] = await tx
      .select()
      .from(glAccountGroup)
      .where(groupKey(client, chart, code))
      .for('update');
    if (!current) throw groupNotFound(code);
    if (expectedVersion !== current.version) throw staleVersion(code);
    if (current.isActive === isActive) {
      const accountCount = await countAccounts(tx, client, chart, code);
      return { chartOfAccounts: chart, accountGroup: code, isActive, changed: false, version: current.version, accountCount };
    }

    const before = groupSnapshot(current);
    await tx
      .update(glAccountGroup)
      .set({ isActive, version: current.version + 1, changedBy, changedAt: new Date() })
      .where(groupKey(client, chart, code));

    const changeId = await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: groupIdentity(chart, code),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: CHANGE_ACTIVITY,
      reason,
      before,
      after: { ...before, isActive },
      fieldLabels: GROUP_FIELD_LABELS,
      securityRelevantFields: ['isActive'],
    });
    if (!changeId) {
      throw new GlAccountGroupMaintenanceError(
        'Account Group lifecycle change could not be recorded in change history.',
        'Retry the change. If the problem continues, contact an administrator.',
      );
    }
    await markActivityComplete(tx, client, CHANGE_ACTIVITY, changedBy);
    const accountCount = await countAccounts(tx, client, chart, code);
    return { chartOfAccounts: chart, accountGroup: code, isActive, changed: true, version: current.version + 1, accountCount };
  });
}

/**
 * Replace one group's field status matrix.
 *
 * The whole matrix arrives at once, because that is how the panel edits it and because a
 * partial post would leave the caller guessing which fields were deliberately untouched.
 * Only fields that differ from the baseline are stored: a row that says what the baseline
 * already says is noise in the table and in the audit trail.
 */
export async function saveAccountGroupFieldStatus(
  raw: AccountGroupFieldStatusInput,
): Promise<{ chartOfAccounts: string; accountGroup: string; changed: boolean; version: number; fieldStatus: FieldStatusMatrix }> {
  const parsed = accountGroupFieldStatusInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, chartOfAccounts: chart, accountGroup: code, expectedVersion, reason } = parsed.data;
  const next = parseFieldStatuses(parsed.data.statuses);

  return withTenant(client, async (tx) => {
    await lockGroup(tx, client, chart, code);
    const [current] = await tx
      .select()
      .from(glAccountGroup)
      .where(groupKey(client, chart, code))
      .for('update');
    if (!current) throw groupNotFound(code);
    if (expectedVersion !== current.version) throw staleVersion(code);
    if (!current.isActive) {
      throw new GlAccountGroupMaintenanceError(
        `Account Group ${code} is deactivated and its field status cannot be changed.`,
        'Reactivate the Account Group before editing its field status matrix.',
      );
    }

    const stored = await tx
      .select()
      .from(glAccountGroupFieldStatus)
      .where(and(
        eq(glAccountGroupFieldStatus.client, client),
        eq(glAccountGroupFieldStatus.chartOfAccounts, chart),
        eq(glAccountGroupFieldStatus.accountGroup, code),
      ));
    const before: FieldStatusMatrix = {};
    for (const row of stored) before[row.fieldKey as GlAccountField] = row.status as FieldStatus;

    const movedFields = GL_ACCOUNT_FIELDS.filter(
      (field) => resolveStored(before, field) !== next[field],
    );
    if (movedFields.length === 0) {
      return {
        chartOfAccounts: chart,
        accountGroup: code,
        changed: false,
        version: current.version,
        fieldStatus: effectiveMatrix(before),
      };
    }

    // Rows that returned to the baseline are removed rather than kept as duplicates of it.
    const backToBaseline = GL_ACCOUNT_FIELDS.filter(
      (field) => next[field] === DEFAULT_FIELD_STATUS[field],
    );
    if (backToBaseline.length > 0) {
      await tx
        .delete(glAccountGroupFieldStatus)
        .where(and(
          eq(glAccountGroupFieldStatus.client, client),
          eq(glAccountGroupFieldStatus.chartOfAccounts, chart),
          eq(glAccountGroupFieldStatus.accountGroup, code),
          inArray(glAccountGroupFieldStatus.fieldKey, backToBaseline),
        ));
    }
    const differing = GL_ACCOUNT_FIELDS.filter(
      (field) => next[field] !== DEFAULT_FIELD_STATUS[field],
    );
    for (const field of differing) {
      await tx
        .insert(glAccountGroupFieldStatus)
        .values({
          client,
          chartOfAccounts: chart,
          accountGroup: code,
          fieldKey: field,
          status: next[field],
          createdBy: changedBy,
        })
        .onConflictDoUpdate({
          target: [
            glAccountGroupFieldStatus.client,
            glAccountGroupFieldStatus.chartOfAccounts,
            glAccountGroupFieldStatus.accountGroup,
            glAccountGroupFieldStatus.fieldKey,
          ],
          set: { status: next[field], changedBy, changedAt: new Date() },
        });
    }

    // The matrix shares the group's version: one row is one aggregate, so a consultant
    // editing the description and another editing the matrix cannot both win silently.
    await tx
      .update(glAccountGroup)
      .set({ version: current.version + 1, changedBy, changedAt: new Date() })
      .where(groupKey(client, chart, code));

    const beforeEffective: Record<string, unknown> = {};
    const afterEffective: Record<string, unknown> = {};
    for (const field of GL_ACCOUNT_FIELDS) {
      beforeEffective[field] = resolveStored(before, field);
      afterEffective[field] = next[field];
    }
    const changeId = await recordChange(tx, {
      client,
      objectClass: MATRIX_OBJECT_CLASS,
      objectKey: groupIdentity(chart, code),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: CHANGE_ACTIVITY,
      reason,
      before: beforeEffective,
      after: afterEffective,
      fieldLabels: MATRIX_FIELD_LABELS,
      // A field moved to SUPPRESS disappears from the screen and a field moved to
      // MANDATORY starts refusing saves: both change what the books will accept.
      securityRelevantFields: movedFields as string[],
    });
    if (!changeId) {
      throw new GlAccountGroupMaintenanceError(
        'Field status change could not be recorded in change history.',
        'Retry the save. If the problem continues, contact an administrator.',
      );
    }
    await markActivityComplete(tx, client, CHANGE_ACTIVITY, changedBy);

    return {
      chartOfAccounts: chart,
      accountGroup: code,
      changed: true,
      version: current.version + 1,
      fieldStatus: effectiveMatrix(next),
    };
  });
}

/* ── Guards and helpers ────────────────────────────────────────────────────── */

function parseFieldStatuses(statuses: Record<string, string>): Record<GlAccountField, FieldStatus> {
  const known = new Set<string>(GL_ACCOUNT_FIELDS);
  for (const key of Object.keys(statuses)) {
    if (!known.has(key)) {
      throw new GlAccountGroupMaintenanceError(
        `Field ${key} is not controlled by an Account Group.`,
        `Use one of: ${GL_ACCOUNT_FIELDS.join(', ')}.`,
      );
    }
  }

  const next = {} as Record<GlAccountField, FieldStatus>;
  for (const field of GL_ACCOUNT_FIELDS) {
    const raw = statuses[field]?.trim();
    if (raw === undefined || raw === '') {
      next[field] = DEFAULT_FIELD_STATUS[field];
      continue;
    }
    const status = raw.toUpperCase();
    if (!(FIELD_STATUSES as readonly string[]).includes(status)) {
      throw new GlAccountGroupMaintenanceError(
        `Field status ${raw} is not valid for ${field}.`,
        `Use one of: ${FIELD_STATUSES.join(', ')}.`,
      );
    }
    if (
      STORAGE_MANDATORY_FIELDS.includes(field) &&
      (status as FieldStatus) !== 'MANDATORY'
    ) {
      throw new GlAccountGroupMaintenanceError(
        `${MATRIX_FIELD_LABELS[field]} cannot be ${STATUS_WORD[status as FieldStatus]}: the account cannot be stored without it.`,
        'Leave this field mandatory; every other field may be offered or suppressed.',
      );
    }
    next[field] = status as FieldStatus;
  }
  return next;
}

/** Stored rows merged over the baseline — what the screen renders and the write checks. */
function effectiveMatrix(stored: FieldStatusMatrix): FieldStatusMatrix {
  const matrix: FieldStatusMatrix = {};
  for (const field of GL_ACCOUNT_FIELDS) {
    const status = resolveStored(stored, field);
    if (status !== DEFAULT_FIELD_STATUS[field]) matrix[field] = status;
  }
  return matrix;
}

function resolveStored(matrix: FieldStatusMatrix, field: GlAccountField): FieldStatus {
  return matrix[field] ?? DEFAULT_FIELD_STATUS[field];
}

async function requireChart(tx: Tx, client: string, chart: string) {
  const [row] = await tx
    .select({
      chartOfAccounts: chartOfAccountsTable.chartOfAccounts,
      accountNumberLength: chartOfAccountsTable.accountNumberLength,
      isActive: chartOfAccountsTable.isActive,
      isBlocked: chartOfAccountsTable.isBlocked,
    })
    .from(chartOfAccountsTable)
    .where(and(eq(chartOfAccountsTable.client, client), eq(chartOfAccountsTable.chartOfAccounts, chart)))
    .limit(1)
    .for('share');
  if (!row) {
    throw new GlAccountGroupMaintenanceError(
      `Chart of Accounts ${chart} is not defined in this tenant.`,
      'Define the Chart of Accounts in OB13 before maintaining its Account Groups.',
    );
  }
  return row;
}

function requireRangeWithinChartLength(values: AccountGroupValues, accountNumberLength: number) {
  for (const bound of [values.fromAccountNumber, values.toAccountNumber]) {
    if (bound.length > accountNumberLength) {
      throw new GlAccountGroupMaintenanceError(
        `Range bound ${bound} is longer than the ${accountNumberLength}-character G/L account number allowed by Chart of Accounts ${values.chartOfAccounts}.`,
        'Use range bounds no longer than the chart’s account number length.',
      );
    }
  }
}

function requireRangeOrdered(values: AccountGroupValues) {
  // Right-padded, matching the database check, so a short bound never swallows a longer
  // account number: `0010`–`0099` must not be read as containing `1000`.
  if (!accountNumberInRange(values.fromAccountNumber, values.fromAccountNumber, values.toAccountNumber)) {
    throw new GlAccountGroupMaintenanceError(
      `From Account Number ${values.fromAccountNumber} is greater than To Account Number ${values.toAccountNumber}.`,
      'Enter the lower bound first, or widen the range.',
    );
  }
}

function rangeChanged(current: typeof glAccountGroup.$inferSelect, values: AccountGroupValues) {
  return (
    current.fromAccountNumber.trim() !== values.fromAccountNumber ||
    current.toAccountNumber.trim() !== values.toAccountNumber
  );
}

/** Accounts of this group that a narrowed range would leave outside, oldest first. */
async function accountsOutsideRange(tx: Tx, client: string, values: AccountGroupValues) {
  const rows = await tx
    .select({ accountNumber: glAccount.accountNumber })
    .from(glAccount)
    .where(and(
      eq(glAccount.client, client),
      eq(glAccount.chartOfAccounts, values.chartOfAccounts),
      eq(glAccount.accountGroup, values.accountGroup),
      sql`not (rpad(${glAccount.accountNumber}, 10, '0') between rpad(${values.fromAccountNumber}, 10, '0') and rpad(${values.toAccountNumber}, 10, '0'))`,
    ))
    .orderBy(asc(glAccount.accountNumber))
    .limit(5);
  return rows.map((row) => row.accountNumber.trim());
}

/**
 * A sibling group whose range intersects the requested one.
 *
 * Inactive groups are included: their accounts still carry the group key, so their part
 * of the number space is still occupied.
 */
async function overlappingGroup(tx: Tx, client: string, values: AccountGroupValues) {
  const [row] = await tx
    .select({
      accountGroup: glAccountGroup.accountGroup,
      fromAccountNumber: glAccountGroup.fromAccountNumber,
      toAccountNumber: glAccountGroup.toAccountNumber,
    })
    .from(glAccountGroup)
    .where(and(
      eq(glAccountGroup.client, client),
      eq(glAccountGroup.chartOfAccounts, values.chartOfAccounts),
      ne(glAccountGroup.accountGroup, values.accountGroup),
      sql`rpad(${values.fromAccountNumber}, 10, '0') <= rpad(${glAccountGroup.toAccountNumber}, 10, '0')`,
      sql`rpad(${values.toAccountNumber}, 10, '0') >= rpad(${glAccountGroup.fromAccountNumber}, 10, '0')`,
    ))
    .orderBy(asc(glAccountGroup.accountGroup))
    .limit(1);
  return row
    ? {
        accountGroup: row.accountGroup.trim(),
        fromAccountNumber: row.fromAccountNumber.trim(),
        toAccountNumber: row.toAccountNumber.trim(),
      }
    : null;
}

async function countAccounts(tx: Tx, client: string, chart: string, code: string) {
  const [row] = await tx
    .select({ accountCount: sql<number>`count(*)::int` })
    .from(glAccount)
    .where(and(
      eq(glAccount.client, client),
      eq(glAccount.chartOfAccounts, chart),
      eq(glAccount.accountGroup, code),
    ));
  return row?.accountCount ?? 0;
}

function lockGroup(tx: Tx, client: string, chart: string, code: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/gl_account_group/${chart}/${code}`}, 0))`,
  );
}

function groupKey(client: string, chart: string, code: string) {
  return and(
    eq(glAccountGroup.client, client),
    eq(glAccountGroup.chartOfAccounts, chart),
    eq(glAccountGroup.accountGroup, code),
  );
}

/** The registry is chart-scoped, so the audit key carries the chart. */
function groupIdentity(chart: string, code: string) {
  return `${chart}/${code}`;
}

function groupSnapshot(row: typeof glAccountGroup.$inferSelect) {
  return {
    chartOfAccounts: row.chartOfAccounts.trim(),
    accountGroup: row.accountGroup.trim(),
    description: row.description.trim(),
    fromAccountNumber: row.fromAccountNumber.trim(),
    toAccountNumber: row.toAccountNumber.trim(),
    isActive: row.isActive,
  };
}

function sameGroupValues(
  before: ReturnType<typeof groupSnapshot>,
  after: AccountGroupValues,
) {
  return (
    before.description === after.description &&
    before.fromAccountNumber === after.fromAccountNumber &&
    before.toAccountNumber === after.toAccountNumber
  );
}

function groupResult(
  row: typeof glAccountGroup.$inferSelect,
  flags: { created: boolean; changed: boolean },
): AccountGroupSaveResult {
  return {
    ...flags,
    chartOfAccounts: row.chartOfAccounts.trim(),
    accountGroup: row.accountGroup.trim(),
    description: row.description.trim(),
    fromAccountNumber: row.fromAccountNumber.trim(),
    toAccountNumber: row.toAccountNumber.trim(),
    isActive: row.isActive,
    version: row.version,
  };
}

function invalidInput(error: z.ZodError): GlAccountGroupMaintenanceError {
  return new GlAccountGroupMaintenanceError(
    error.issues[0]?.message ?? 'Account Group input is invalid.',
    'Correct the indicated value and submit again.',
  );
}

function staleVersion(code: string) {
  return new GlAccountGroupMaintenanceError(
    `Account Group ${code} changed after it was opened.`,
    'Reload the Account Groups panel before saving your changes.',
  );
}

function groupNotFound(code: string) {
  return new GlAccountGroupMaintenanceError(
    `Account Group ${code} was not found.`,
    'Return to the Account Groups panel and select an existing group.',
  );
}

const GROUP_FIELD_LABELS = {
  chartOfAccounts: 'Chart of Accounts (KTOPL)',
  accountGroup: 'Account Group (KTOKS)',
  description: 'Description',
  fromAccountNumber: 'From Account Number',
  toAccountNumber: 'To Account Number',
  isActive: 'Active',
};

/** Shared with the account writer so both name a field the same way. */
const MATRIX_FIELD_LABELS = GL_ACCOUNT_FIELD_LABELS;

/** The statuses as English words, so a refusal reads as a sentence rather than as an enum. */
const STATUS_WORD: Record<FieldStatus, string> = {
  SUPPRESS: 'suppressed',
  OPTIONAL: 'optional',
  MANDATORY: 'mandatory',
};
