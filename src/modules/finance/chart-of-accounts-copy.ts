/**
 * SCR-027 / OBY7 — Copy Chart of Accounts.
 *
 * A copy moves every G/L account of one chart into another inside the same tenant. It is
 * all-or-nothing: every guard runs before the first write, so a refusal leaves the target
 * chart exactly as it was rather than half copied, and the whole copy lives in one
 * transaction that rolls back with it.
 *
 * The guards, in the order they are checked:
 * - a chart is not copied onto itself;
 * - both charts exist and are active and unblocked, the same condition FS00 reads when it
 *   offers a chart to create against;
 * - the source chart holds accounts at all;
 * - account numbers fit the target chart's length. A narrower target is refused outright,
 *   because truncating an account number would corrupt it; a wider one is refused unless
 *   padding is asked for, and then numbers are left-padded (1000 becomes 001000);
 * - every Account Group the source accounts use exists and is active in the target chart's
 *   registry, and each copied number falls inside that group's range there. The database
 *   enforces the first half through a foreign key; this check refuses first so the message
 *   names the groups instead of a constraint;
 * - group-side consolidation numbers resolve in the target chart's group chart, since
 *   `gl_account.group_account_number` has no declarative foreign key and nothing else
 *   would catch a dangling reference;
 * - existing target accounts are refused unless overwrite is asked for, and an overwrite is
 *   refused for the whole copy when any of those accounts carries postings, open items or a
 *   balance — the same facts `deleteGlAccount` protects, because replacing the master
 *   record of an account with history is a deletion in everything but name.
 *
 * Two contract points decided by the owner (R-52/D-124):
 * - the target Account Group's field status matrix governs the copied values, so a field the
 *   target group suppresses is not carried and the contract default is written instead. The
 *   dropped fields are listed in the copy document rather than vanishing silently;
 * - the audit trail is one summary document for the copy, not one per account. The
 *   consequence is deliberate and worth stating: an overwritten account's own change history
 *   does not show the overwrite, because no per-account document is written. The copy
 *   document names both charts, the options, the counts and what was dropped.
 *
 * `copyLongTexts` governs descriptions, because this schema stores no long text for a G/L
 * account — only `name`. New accounts always take the source description, since a name is
 * mandatory and there is nothing else to store; on an overwrite the flag decides whether the
 * source description replaces the target's. A true long-text store is an open item.
 *
 * Cross-tenant copies are out of scope by contract: they need a platform-admin service token
 * and encrypted export/import hooks, and this module never reads another tenant's rows.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import { withTenant } from '../../platform/db/client';
import { ConfigError, glAccountUsage } from '../foundation/services';
// Aliased: the input carries a `chartOfAccounts` key, which would shadow the table.
import { chartOfAccounts as chartOfAccountsTable } from '../foundation/schema';
import { glAccount } from './schema';
import { glAccountGroup, glAccountGroupFieldStatus, groupChartAccounts } from './gl-account-group-schema';
import {
  DEFAULT_LANGUAGE_KEY,
  DEFAULT_SORT_KEY,
  GL_ACCOUNT_FIELDS,
  GL_ACCOUNT_FIELD_LABELS,
  accountNumberInRange,
  deriveIsBalanceSheet,
  resolveFieldStatus,
  type FieldStatusMatrix,
  type GlAccountField,
  type GlAccountType,
} from './gl-account-vocabulary';

const ACTIVITY = 'CFG.FIN.COA.COPY';
const OBJECT_CLASS = 'chart_of_accounts_copy';
/** How many offending values a refusal names before falling back to a count. */
const NAMED_LIMIT = 5;

const clientSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const chartCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{4}$/, 'Chart of Accounts must be exactly four letters or numbers.')
  .transform((value) => value.toUpperCase());

const inputSchema = z.object({
  client: clientSchema,
  sourceChartOfAccounts: chartCodeSchema,
  targetChartOfAccounts: chartCodeSchema,
  copyLongTexts: z.boolean().default(true),
  overwriteExisting: z.boolean().default(false),
  padLeadingZeros: z.boolean().default(false),
  reason: z.string().trim().min(1).max(200),
  changedBy: z.string().trim().min(1),
});

export type CopyChartOfAccountsInput = z.input<typeof inputSchema>;

export interface CopyChartOfAccountsResult {
  sourceChartOfAccounts: string;
  targetChartOfAccounts: string;
  /** Accounts written for the first time into the target chart. */
  created: number;
  /** Existing target accounts replaced by their source record. */
  overwritten: number;
  /** Existing target accounts left alone because nothing differed. */
  unchanged: number;
  /** True when account numbers were left-padded to the target chart's length. */
  padded: boolean;
  /** Fields the target group's matrix suppressed, so the default was written instead. */
  droppedFields: string[];
  changeDocumentId: string | null;
}

/** What a suppressed field stores: the contract default, never a value from the source. */
const SUPPRESSED_DEFAULTS: Readonly<Record<GlAccountField, unknown>> = {
  name: undefined, // storage-mandatory: never suppressed
  accountType: undefined, // storage-mandatory: never suppressed
  glAccountType: 'BALANCE_SHEET',
  isOpenItemManaged: false,
  reconciliationType: null,
  requiresCostObject: false,
  isTaxRelevant: false,
  groupAccountNumber: null,
  languageKey: DEFAULT_LANGUAGE_KEY,
  sortKey: DEFAULT_SORT_KEY,
  isBlockedPosting: false,
  isBlockedCreation: false,
};

function nameSome(values: readonly string[], label: string): string {
  const named = values.slice(0, NAMED_LIMIT).join(', ');
  const rest = values.length - NAMED_LIMIT;
  return rest > 0 ? `${named} and ${rest} more ${label}` : named;
}

export async function copyChartOfAccounts(
  input: CopyChartOfAccountsInput,
): Promise<CopyChartOfAccountsResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(issue?.message ?? 'The copy request is not valid.', 'Correct the field and try again.');
  }
  const {
    client,
    sourceChartOfAccounts: source,
    targetChartOfAccounts: target,
    copyLongTexts,
    overwriteExisting,
    padLeadingZeros,
    reason,
    changedBy,
  } = parsed.data;

  if (source === target) {
    throw new ConfigError(
      `Chart of Accounts ${source} cannot be copied onto itself.`,
      'Choose a different target chart.',
    );
  }

  return withTenant(client, async (tx) => {
    const charts = await tx
      .select()
      .from(chartOfAccountsTable)
      .where(and(eq(chartOfAccountsTable.client, client), inArray(chartOfAccountsTable.chartOfAccounts, [source, target])));
    const byCode = new Map(charts.map((chart) => [chart.chartOfAccounts, chart]));

    for (const code of [source, target] as const) {
      const chart = byCode.get(code);
      const role = code === source ? 'copied from' : 'copied into';
      if (!chart) {
        throw new ConfigError(
          `Chart of Accounts ${code} does not exist in this tenant.`,
          'Define the chart in OB13 first.',
        );
      }
      if (!chart.isActive) {
        throw new ConfigError(
          `Chart of Accounts ${code} is deactivated and cannot be ${role}.`,
          'Reactivate the chart in OB13 first.',
        );
      }
      if (chart.isBlocked) {
        throw new ConfigError(
          `Chart of Accounts ${code} is blocked and cannot be ${role}.`,
          'Lift the block in OB13 first; a blocked chart keeps its accounts readable but takes no writes.',
        );
      }
    }
    const sourceChart = byCode.get(source)!;
    const targetChart = byCode.get(target)!;

    const sourceAccounts = await tx
      .select()
      .from(glAccount)
      .where(and(eq(glAccount.client, client), eq(glAccount.chartOfAccounts, source)))
      .orderBy(asc(glAccount.accountNumber));
    if (sourceAccounts.length === 0) {
      throw new ConfigError(
        `Chart of Accounts ${source} holds no G/L accounts, so there is nothing to copy.`,
        'Create accounts in FS00 first.',
      );
    }

    /* ── Account-number length ─────────────────────────────────────────────── */
    const sourceLength = sourceChart.accountNumberLength;
    const targetLength = targetChart.accountNumberLength;
    if (targetLength < sourceLength) {
      throw new ConfigError(
        `Chart of Accounts ${target} holds ${targetLength} characters and cannot take the ${sourceLength}-character account numbers of chart ${source}.`,
        'Choose a target chart of the same width or wider; account numbers are never truncated.',
      );
    }
    const padding = targetLength > sourceLength;
    if (padding && !padLeadingZeros) {
      throw new ConfigError(
        `Account numbers grow from ${sourceLength} to ${targetLength} characters when copied into chart ${target}.`,
        'Enable Pad leading zeros to left-pad them, or choose a target chart of the same width.',
      );
    }
    const tooLong = sourceAccounts
      .filter((account) => account.accountNumber.length > targetLength)
      .map((account) => account.accountNumber);
    if (tooLong.length > 0) {
      throw new ConfigError(
        `${nameSome(tooLong, 'account numbers')} in chart ${source} are longer than the ${targetLength} characters chart ${target} holds.`,
        'Choose a target chart wide enough for every source account number.',
      );
    }
    const mappedNumber = (accountNumber: string) =>
      padding ? accountNumber.padStart(targetLength, '0') : accountNumber;

    /* ── Account Group prerequisite ────────────────────────────────────────── */
    const usedGroups = [...new Set(sourceAccounts.map((account) => account.accountGroup))].sort();
    const targetGroups = await tx
      .select()
      .from(glAccountGroup)
      .where(and(eq(glAccountGroup.client, client), eq(glAccountGroup.chartOfAccounts, target)));
    const targetGroupByCode = new Map(targetGroups.map((group) => [group.accountGroup, group]));
    const missingGroups = usedGroups.filter((group) => !targetGroupByCode.has(group));
    if (missingGroups.length > 0) {
      throw new ConfigError(
        `Account Group ${nameSome(missingGroups, 'groups')} used by chart ${source} does not exist in chart ${target}, so nothing was copied.`,
        'Maintain the Account Group in the target chart first; a copy never creates registry entries.',
      );
    }
    const inactiveGroups = usedGroups.filter((group) => !targetGroupByCode.get(group)?.isActive);
    if (inactiveGroups.length > 0) {
      throw new ConfigError(
        `Account Group ${nameSome(inactiveGroups, 'groups')} is deactivated in chart ${target}, so nothing was copied.`,
        'Reactivate the group in the target chart, or move its accounts to another group first.',
      );
    }
    const outsideRange = sourceAccounts.filter((account) => {
      const group = targetGroupByCode.get(account.accountGroup)!;
      return !accountNumberInRange(mappedNumber(account.accountNumber), group.fromAccountNumber, group.toAccountNumber);
    });
    if (outsideRange.length > 0) {
      const first = outsideRange[0]!;
      const group = targetGroupByCode.get(first.accountGroup)!;
      throw new ConfigError(
        `${nameSome(outsideRange.map((a) => mappedNumber(a.accountNumber)), 'account numbers')} fall outside the range ${group.fromAccountNumber}–${group.toAccountNumber} that Account Group ${first.accountGroup} owns in chart ${target}.`,
        'Widen the group range in the target chart, or copy into a chart whose ranges cover these numbers.',
      );
    }

    /* ── Target matrix governs the copied values ───────────────────────────── */
    const matrixRows = await tx
      .select()
      .from(glAccountGroupFieldStatus)
      .where(and(eq(glAccountGroupFieldStatus.client, client), eq(glAccountGroupFieldStatus.chartOfAccounts, target)));
    const matrices = new Map<string, FieldStatusMatrix>();
    for (const row of matrixRows) {
      const matrix = matrices.get(row.accountGroup) ?? {};
      matrix[row.fieldKey as GlAccountField] = row.status as FieldStatusMatrix[GlAccountField];
      matrices.set(row.accountGroup, matrix);
    }
    const dropped = new Set<string>();
    const suppressed = (group: string, field: GlAccountField) => {
      const status = resolveFieldStatus(matrices.get(group), field);
      if (status !== 'SUPPRESS') return false;
      dropped.add(GL_ACCOUNT_FIELD_LABELS[field]);
      return true;
    };

    /* ── Group-side consolidation prerequisite ─────────────────────────────── */
    const carriedGroupNumbers = [
      ...new Set(
        sourceAccounts
          .filter((account) => account.groupAccountNumber && !suppressed(account.accountGroup, 'groupAccountNumber'))
          .map((account) => account.groupAccountNumber as string),
      ),
    ].sort();
    if (carriedGroupNumbers.length > 0) {
      const groupChart = targetChart.groupChart;
      if (!groupChart) {
        throw new ConfigError(
          `Chart of Accounts ${target} has no Group Chart of Accounts, so the ${carriedGroupNumbers.length} group account number(s) of chart ${source} have nowhere to point.`,
          'Assign a Group Chart of Accounts to the target chart in OB13, or let the target Account Group suppress the group account number.',
        );
      }
      const present = await tx
        .select({ groupAccountNumber: groupChartAccounts.groupAccountNumber })
        .from(groupChartAccounts)
        .where(and(
          eq(groupChartAccounts.client, client),
          eq(groupChartAccounts.groupChartOfAccounts, groupChart),
          inArray(groupChartAccounts.groupAccountNumber, carriedGroupNumbers),
        ));
      const known = new Set(present.map((row) => row.groupAccountNumber));
      const missing = carriedGroupNumbers.filter((number) => !known.has(number));
      if (missing.length > 0) {
        throw new ConfigError(
          `Group account ${nameSome(missing, 'numbers')} is not defined in Group Chart of Accounts ${groupChart}, so nothing was copied.`,
          'Maintain the group-side accounts first; a copy never creates them.',
        );
      }
    }

    /* ── Conflicts in the target chart ─────────────────────────────────────── */
    const mappedNumbers = sourceAccounts.map((account) => mappedNumber(account.accountNumber));
    const existing = await tx
      .select()
      .from(glAccount)
      .where(and(
        eq(glAccount.client, client),
        eq(glAccount.chartOfAccounts, target),
        inArray(glAccount.accountNumber, mappedNumbers),
      ));
    const existingByNumber = new Map(existing.map((account) => [account.accountNumber, account]));
    const conflicts = mappedNumbers.filter((number) => existingByNumber.has(number));

    if (conflicts.length > 0 && !overwriteExisting) {
      throw new ConfigError(
        `Chart of Accounts ${target} already holds ${nameSome(conflicts, 'account numbers')} (${conflicts.length} of ${mappedNumbers.length}), so nothing was copied.`,
        'Enable Overwrite existing accounts to replace them, or copy into an empty chart.',
      );
    }
    if (conflicts.length > 0) {
      // An account with history is never replaced: the same facts that protect it from
      // deletion protect it from an overwrite, and one blocked account refuses the copy.
      const blocked: string[] = [];
      for (const number of conflicts) {
        const usage = await glAccountUsage(tx, client, target, number);
        if (usage.facts.length > 0) blocked.push(`${number} (${usage.facts.join(', ')})`);
      }
      if (blocked.length > 0) {
        throw new ConfigError(
          `${nameSome(blocked, 'accounts')} in chart ${target} cannot be overwritten, so nothing was copied.`,
          'Copy into an empty chart, or block and replace those accounts one by one in FS00.',
        );
      }
    }

    /* ── Build the rows, then write ────────────────────────────────────────── */
    const now = new Date();
    let created = 0;
    let overwritten = 0;
    let unchanged = 0;

    for (const account of sourceAccounts) {
      const number = mappedNumber(account.accountNumber);
      const group = account.accountGroup;
      const value = (field: GlAccountField, source: unknown) =>
        suppressed(group, field) ? SUPPRESSED_DEFAULTS[field] : source;

      const glAccountType = value('glAccountType', account.glAccountType) as GlAccountType;
      const row = {
        accountNumber: number,
        name: account.name,
        accountType: account.accountType,
        accountGroup: group,
        glAccountType,
        isBalanceSheet: deriveIsBalanceSheet(glAccountType),
        isOpenItemManaged: value('isOpenItemManaged', account.isOpenItemManaged) as boolean,
        reconciliationType: value('reconciliationType', account.reconciliationType) as string | null,
        requiresCostObject: value('requiresCostObject', account.requiresCostObject) as boolean,
        isTaxRelevant: value('isTaxRelevant', account.isTaxRelevant) as boolean,
        groupAccountNumber: value('groupAccountNumber', account.groupAccountNumber) as string | null,
        languageKey: value('languageKey', account.languageKey) as string,
        sortKey: value('sortKey', account.sortKey) as string,
        isBlockedPosting: value('isBlockedPosting', account.isBlockedPosting) as boolean,
        isBlockedCreation: value('isBlockedCreation', account.isBlockedCreation) as boolean,
      };

      const previous = existingByNumber.get(number);
      if (!previous) {
        await tx.insert(glAccount).values({
          client,
          chartOfAccounts: target,
          ...row,
          createdBy: changedBy,
          createdAt: now,
          changedBy,
          changedAt: now,
        });
        created += 1;
        continue;
      }

      // On an overwrite the description follows the flag: without it the target keeps the
      // name it was given, because that is the only text this schema stores.
      const name = copyLongTexts ? row.name : previous.name;
      const candidate = { ...row, name };
      const differs = Object.entries(candidate).some(
        ([field, next]) => previous[field as keyof typeof previous] !== next,
      );
      if (!differs) {
        unchanged += 1;
        continue;
      }
      await tx
        .update(glAccount)
        .set({ ...candidate, changedBy, changedAt: now })
        .where(and(
          eq(glAccount.client, client),
          eq(glAccount.chartOfAccounts, target),
          eq(glAccount.accountNumber, number),
        ));
      overwritten += 1;
    }

    /* ── One summary document for the whole copy ───────────────────────────── */
    const changeDocumentId = await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: `${source}->${target}`,
      changeType: 'CREATE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      after: {
        sourceChartOfAccounts: source,
        targetChartOfAccounts: target,
        accountsInSource: sourceAccounts.length,
        created,
        overwritten,
        unchanged,
        accountNumberLengthFrom: padding ? sourceLength : targetLength,
        accountNumberLengthTo: targetLength,
        paddedWithLeadingZeros: padding,
        copyLongTexts,
        overwriteExisting,
        accountGroups: usedGroups.join(', '),
        fieldsDroppedByTargetMatrix: [...dropped].sort().join(', ') || 'none',
      },
      fieldLabels: {
        sourceChartOfAccounts: 'Source Chart of Accounts',
        targetChartOfAccounts: 'Target Chart of Accounts',
        accountsInSource: 'Accounts in source chart',
        created: 'Accounts created',
        overwritten: 'Accounts overwritten',
        unchanged: 'Accounts already identical',
        accountNumberLengthFrom: 'Account number length from',
        accountNumberLengthTo: 'Account number length to',
        paddedWithLeadingZeros: 'Padded with leading zeros',
        copyLongTexts: 'Copy descriptions',
        overwriteExisting: 'Overwrite existing accounts',
        accountGroups: 'Account Groups',
        fieldsDroppedByTargetMatrix: 'Fields dropped by the target matrix',
      },
      securityRelevantFields: ['overwriteExisting', 'isBlockedPosting'],
    });
    if (!changeDocumentId) {
      throw new ConfigError(
        'The chart copy could not be recorded in change history.',
        'Retry the copy. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, ACTIVITY, changedBy);

    return {
      sourceChartOfAccounts: source,
      targetChartOfAccounts: target,
      created,
      overwritten,
      unchanged,
      padded: padding,
      droppedFields: [...dropped].sort(),
      changeDocumentId,
    };
  });
}

/** Read the copy documents of a tenant, newest first, for the screen's history panel. */
export async function listChartCopies(client: string, limit = 20) {
  const parsed = clientSchema.safeParse(client);
  if (!parsed.success) {
    throw new ConfigError('The tenant key is not valid.', 'Reload the screen and try again.');
  }
  return withTenant(parsed.data, async (tx) =>
    tx
      .select()
      .from(changeDocument)
      .where(and(eq(changeDocument.client, parsed.data), eq(changeDocument.objectClass, OBJECT_CLASS)))
      .orderBy(desc(changeDocument.changedAt))
      .limit(limit),
  );
}
