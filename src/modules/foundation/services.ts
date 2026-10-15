/**
 * Foundation services — CAIRN.md §20.2
 *
 * Services are the only place transactions are opened and the only place
 * configuration is written. Every write goes through recordChange, so the
 * workbench, the change log and the auditor's view all see the same history —
 * configuration changes matter as much as document changes, and often more,
 * because a changed posting period rule alters what the books will accept.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import { glAccount, journalEntryLine } from '../finance/schema';
import { glAccountGroup } from '../finance/gl-account-group-schema';
import {
  ACCOUNT_TYPES,
  accountNumberInRange,
  DEFAULT_LANGUAGE_KEY,
  DEFAULT_SORT_KEY,
  deriveGlAccountType,
  deriveIsBalanceSheet,
  GL_ACCOUNT_FIELD_LABELS,
  GL_ACCOUNT_TYPES,
  RECONCILIATION_TYPES,
  resolveFieldStatus,
  SUPPORTED_LANGUAGE_KEYS,
  type AccountType,
  type FieldStatusMatrix,
  type GlAccountField,
  type GlAccountType,
  type ReconciliationType,
} from '../finance/gl-account-vocabulary';
import { customerCompany } from './customer-company-schema';
import { supplierCompany } from './supplier-company-schema';
import {
  assertCompanyCodeFinancialSettingsCompatible,
  lockCompanyCodeOxxAssignments,
} from './controlling-area-company-compatibility';
import {
  chartOfAccounts,
  companyCode,
  fiscalYearVariant,
  plant,
  postingPeriodRule,
  storageLocation,
} from './schema';

export class ConfigError extends Error {
  readonly code = 'CAIRN_CONFIG';
  constructor(message: string, readonly remedy: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/* ── Company codes ─────────────────────────────────────────────────────────── */

export async function listCompanyCodes(client: string) {
  return withTenant(client, (tx) =>
    tx.select().from(companyCode).orderBy(asc(companyCode.companyCode)),
  );
}

export async function getCompanyCodeDetail(client: string, companyCodeKey: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(companyCode)
      .where(
        and(eq(companyCode.client, client), eq(companyCode.companyCode, companyCodeKey)),
      )
      .limit(1);

    if (rows.length === 0) return null;
    const company = rows[0];

    // The assigned configuration, resolved when the corresponding assignment exists.
    const coa = company.chartOfAccounts
      ? await tx
          .select()
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.client, client),
              eq(chartOfAccounts.chartOfAccounts, company.chartOfAccounts),
            ),
          )
          .limit(1)
      : [];

    const fyv = company.fiscalYearVariant
      ? await tx
          .select()
          .from(fiscalYearVariant)
          .where(
            and(
              eq(fiscalYearVariant.client, client),
              eq(fiscalYearVariant.variant, company.fiscalYearVariant),
            ),
          )
          .limit(1)
      : [];

    const plants = await tx
      .select()
      .from(plant)
      .where(and(eq(plant.client, client), eq(plant.companyCode, company.companyCode)))
      .orderBy(asc(plant.plant));

    const accountCount = company.chartOfAccounts
      ? await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(glAccount)
          .where(
            and(
              eq(glAccount.client, client),
              eq(glAccount.chartOfAccounts, company.chartOfAccounts),
            ),
          )
      : [{ count: 0 }];

    return {
      company,
      chartOfAccounts: coa[0] ?? null,
      fiscalYearVariant: fyv[0] ?? null,
      plants,
      accountCount: accountCount[0]?.count ?? 0,
    };
  });
}

export interface CompanyCodeInput {
  client: string;
  companyCode: string;
  name: string;
  chartOfAccounts: string;
  fiscalYearVariant: string;
  postingPeriodVariant: string;
  currency: string;
  country: string;
  city?: string;
  taxRegistrationNumber?: string;
  changedBy: string;
}

export async function upsertCompanyCode(input: CompanyCodeInput) {
  const { client, companyCode: code, changedBy } = input;
  const chartKey = input.chartOfAccounts.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(chartKey)) {
    throw new ConfigError('Chart of Accounts must be exactly four letters or numbers.', 'Choose a valid four-character Chart of Accounts key.');
  }

  return withTenant(client, async (tx) => {
    const linkedAreas = await lockCompanyCodeOxxAssignments(tx, client, code);
    const existing = await tx
      .select()
      .from(companyCode)
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, code)))
      .limit(1)
      .for('update');

    const [chart] = await tx.select({
      isActive: chartOfAccounts.isActive,
      isBlocked: chartOfAccounts.isBlocked,
    }).from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.client, client), eq(chartOfAccounts.chartOfAccounts, chartKey)))
      .limit(1)
      .for('share');
    if (!chart || !chart.isActive) {
      throw new ConfigError(`Active Chart of Accounts ${chartKey} is not defined in this tenant.`, 'Define and activate the Chart of Accounts first.');
    }
    if (chart.isBlocked && (existing.length === 0 || existing[0].chartOfAccounts !== chartKey)) {
      throw new ConfigError(`Chart of Accounts ${chartKey} is blocked and cannot be assigned to a Company Code.`, 'Remove the Chart of Accounts block before creating a new Company Code segment.');
    }

    const values = {
      client,
      companyCode: code,
      name: input.name,
      chartOfAccounts: chartKey,
      fiscalYearVariant: input.fiscalYearVariant,
      postingPeriodVariant: input.postingPeriodVariant,
      currency: input.currency,
      country: input.country,
      city: input.city,
      taxRegistrationNumber: input.taxRegistrationNumber,
    };

    if (existing.length === 0) {
      await tx.insert(companyCode).values({ ...values, createdBy: changedBy });
      await recordChange(tx, {
        client,
        objectClass: 'company_code',
        objectKey: code,
        changeType: 'CREATE',
        changedBy,
        transactionCode: 'CFG.ORG.COMPANYCODE.DEFINE',
        after: values,
      });
      await markActivityComplete(tx, client, 'CFG.ORG.COMPANYCODE.DEFINE', changedBy);
      return { created: true, companyCode: code };
    }

    const before = existing[0];
    await assertCompanyCodeFinancialSettingsCompatible(tx, client, code, {
      chartOfAccounts: values.chartOfAccounts,
      fiscalYearVariant: values.fiscalYearVariant,
      currency: values.currency,
    }, linkedAreas);
    await tx
      .update(companyCode)
      .set({ ...values, changedBy, changedAt: new Date() })
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, code)));

    await recordChange(tx, {
      client,
      objectClass: 'company_code',
      objectKey: code,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: 'CFG.ORG.COMPANYCODE.DEFINE',
      before: before as unknown as Record<string, unknown>,
      after: values,
      fieldLabels: {
        chartOfAccounts: 'Chart of accounts',
        fiscalYearVariant: 'Fiscal year variant',
        postingPeriodVariant: 'Posting period variant',
        currency: 'Local currency',
      },
      // Changing these alters what the books will accept, so they are flagged for
      // the auditor rather than buried among cosmetic fields (§16.3).
      securityRelevantFields: [
        'chartOfAccounts',
        'fiscalYearVariant',
        'postingPeriodVariant',
      ],
    });

    return { created: false, companyCode: code };
  });
}

/* ── G/L accounts ──────────────────────────────────────────────────────────── */

export async function listGlAccounts(
  client: string,
  options: { chartOfAccounts?: string; search?: string } = {},
) {
  return withTenant(client, async (tx) => {
    const filters = [eq(glAccount.client, client)];
    if (options.chartOfAccounts) {
      filters.push(eq(glAccount.chartOfAccounts, options.chartOfAccounts));
    }
    if (options.search && options.search.trim() !== '') {
      const term = `%${options.search.trim()}%`;
      filters.push(
        sql`(${glAccount.accountNumber} ilike ${term} or ${glAccount.name} ilike ${term})`,
      );
    }
    return tx
      .select()
      .from(glAccount)
      .where(and(...filters))
      .orderBy(asc(glAccount.accountNumber));
  });
}

/**
 * Chart-level G/L account values (SCR-028 / FS00).
 *
 * `is_balance_sheet` is not an input: it is derived from the G/L Account Type (`XBILK`)
 * and pinned by a database check, so a caller cannot store a flag that contradicts the
 * indicator the screen shows. The Account Group is mandatory — it owns the number range
 * the account must fall inside and the field status matrix the screen renders from.
 */
/** A G/L account row as stored, so a suppressed field can be read back by field key. */
type GlAccountRow = typeof glAccount.$inferSelect;

export interface GlAccountInput {
  client: string;
  chartOfAccounts: string;
  accountNumber: string;
  name: string;
  accountType: AccountType;
  /** Account Group (`KTOKS`) this account belongs to. */
  accountGroup: string;
  /** Statement placement (`XBILK`); derived from the account type when omitted. */
  glAccountType?: GlAccountType;
  isOpenItemManaged: boolean;
  /** Reconciliation account (`MITKZ`); null when the account reconciles nothing. */
  reconciliationType?: ReconciliationType | null;
  requiresCostObject: boolean;
  isTaxRelevant: boolean;
  /** Optional group-side account for consolidation roll-up. */
  groupAccountNumber?: string | null;
  /** Language Key (`SPRAS`). */
  languageKey?: string;
  /** Sort Key (`ZUAWE`). */
  sortKey?: string;
  /** Posting block (`XSPEB`). */
  isBlockedPosting?: boolean;
  /** Creation block (`XSPEA`). */
  isBlockedCreation?: boolean;
  changedBy: string;
  /**
   * FS00 mode. `CREATE` refuses an account number that already exists and `CHANGE`
   * refuses one that does not, because the number is immutable: a different number is a
   * different account, never an edit. Omitted by provisioning and seed callers, which
   * genuinely upsert.
   */
  mode?: 'CREATE' | 'CHANGE';
  /** Change-history count for this account; omit to skip the concurrency check. */
  expectedVersion?: number;
  /** Audit note. Mandatory when a block flag changes, per the FS00 contract. */
  reason?: string;
  /**
   * The Account Group's effective field status matrix. When present, a MANDATORY field
   * must carry a value and a SUPPRESSED field is taken from the stored record (or the
   * contract default on create) rather than from the post — a field the screen never
   * showed must not be editable by hand either.
   */
  fieldStatus?: FieldStatusMatrix;
}

export async function upsertGlAccount(input: GlAccountInput) {
  const { client, changedBy } = input;
  const coa = input.chartOfAccounts.trim().toUpperCase();
  const accountNumber = input.accountNumber.trim();
  if (!/^[A-Z0-9]{4}$/.test(coa)) {
    throw new ConfigError('Chart of Accounts must be exactly four letters or numbers.', 'Choose an existing four-character Chart of Accounts key.');
  }
  if (accountNumber.length < 1 || accountNumber.length > 10) {
    throw new ConfigError('G/L Account Number must be between 1 and 10 characters.', 'Enter an account number within the Chart of Accounts length limit.');
  }
  if (!(ACCOUNT_TYPES as readonly string[]).includes(input.accountType)) {
    throw new ConfigError(`Account Type ${input.accountType} is not valid.`, `Use one of: ${ACCOUNT_TYPES.join(', ')}.`);
  }
  if (input.glAccountType !== undefined && !(GL_ACCOUNT_TYPES as readonly string[]).includes(input.glAccountType)) {
    throw new ConfigError(`G/L Account Type ${input.glAccountType} is not valid.`, `Use one of: ${GL_ACCOUNT_TYPES.join(', ')}.`);
  }
  if (input.reconciliationType != null && !(RECONCILIATION_TYPES as readonly string[]).includes(input.reconciliationType)) {
    throw new ConfigError(`Reconciliation Account ${input.reconciliationType} is not valid.`, `Use one of: ${RECONCILIATION_TYPES.join(', ')}, or leave it empty.`);
  }
  const accountGroup = input.accountGroup.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(accountGroup)) {
    throw new ConfigError('Account Group must be exactly four letters or numbers.', 'Choose an Account Group defined for this Chart of Accounts.');
  }

  // The matrix belongs to the caller, not to the database, so its rules are applied before
  // the per-field normalizations below: a field the group demands is reported as missing
  // rather than as malformed, which is the difference between "you must fill this in" and
  // "the value you left out is the wrong shape".
  const statusOf = (field: GlAccountField) => resolveFieldStatus(input.fieldStatus, field);
  const suppressed = (field: GlAccountField) => statusOf(field) === 'SUPPRESS';
  const missingMandatory: string[] = [];
  if (statusOf('name') === 'MANDATORY' && input.name.trim() === '') {
    missingMandatory.push(GL_ACCOUNT_FIELD_LABELS.name);
  }
  if (statusOf('reconciliationType') === 'MANDATORY' && !input.reconciliationType) {
    missingMandatory.push(GL_ACCOUNT_FIELD_LABELS.reconciliationType);
  }
  if (statusOf('groupAccountNumber') === 'MANDATORY' && !(input.groupAccountNumber ?? '').trim()) {
    missingMandatory.push(GL_ACCOUNT_FIELD_LABELS.groupAccountNumber);
  }
  if (statusOf('languageKey') === 'MANDATORY' && !(input.languageKey ?? '').trim()) {
    missingMandatory.push(GL_ACCOUNT_FIELD_LABELS.languageKey);
  }
  if (statusOf('sortKey') === 'MANDATORY' && !(input.sortKey ?? '').trim()) {
    missingMandatory.push(GL_ACCOUNT_FIELD_LABELS.sortKey);
  }
  // Booleans are not checked for presence: `false` is a value, not an omission, and a
  // suppressed checkbox posts nothing either way — the stored default is the answer.
  if (missingMandatory.length > 0) {
    throw new ConfigError(
      `Account Group ${accountGroup} makes ${missingMandatory.join(', ')} mandatory.`,
      'Complete the mandatory fields, or change the field status in the Account Groups panel.',
    );
  }

  const languageKey = (input.languageKey ?? DEFAULT_LANGUAGE_KEY).trim().toUpperCase();
  if (!(SUPPORTED_LANGUAGE_KEYS as readonly string[]).includes(languageKey)) {
    throw new ConfigError(`Language Key ${languageKey} is not supported.`, `Use one of: ${SUPPORTED_LANGUAGE_KEYS.join(', ')}.`);
  }
  const sortKey = (input.sortKey ?? DEFAULT_SORT_KEY).trim();
  if (!/^[A-Za-z0-9]{3}$/.test(sortKey)) {
    throw new ConfigError('Sort Key must be exactly three letters or numbers.', 'Enter a three-character sort key, or leave the default 000.');
  }
  const groupAccountNumber = input.groupAccountNumber?.trim() ? input.groupAccountNumber.trim() : null;
  if (groupAccountNumber !== null && !/^[A-Za-z0-9]{1,10}$/.test(groupAccountNumber)) {
    throw new ConfigError('Group Account Number must be between 1 and 10 letters or numbers.', 'Enter the group-side account number, or leave it empty.');
  }

  return withTenant(client, async (tx) => {
    const [chart] = await tx.select({
      accountNumberLength: chartOfAccounts.accountNumberLength,
      isActive: chartOfAccounts.isActive,
      isBlocked: chartOfAccounts.isBlocked,
    }).from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.client, client), eq(chartOfAccounts.chartOfAccounts, coa)))
      .limit(1)
      .for('share');
    if (!chart || !chart.isActive) {
      throw new ConfigError(`Active Chart of Accounts ${coa} is not defined in this tenant.`, 'Define and activate the Chart of Accounts before maintaining G/L accounts.');
    }
    if (accountNumber.length > chart.accountNumberLength) {
      throw new ConfigError(
        `G/L Account Number ${accountNumber} exceeds the ${chart.accountNumberLength}-character limit for Chart of Accounts ${coa}.`,
        'Use an account number no longer than the chart’s configured maximum.',
      );
    }

    // Locked, so two saves of the same account serialize instead of overwriting each
    // other: the block-change reason rule and the matrix both read the stored row.
    const existing = await tx
      .select()
      .from(glAccount)
      .where(
        and(
          eq(glAccount.client, client),
          eq(glAccount.chartOfAccounts, coa),
          eq(glAccount.accountNumber, accountNumber),
        ),
      )
      .limit(1)
      .for('update');
    if (existing.length === 0 && chart.isBlocked) {
      throw new ConfigError(
        `Chart of Accounts ${coa} is blocked; new G/L accounts cannot be created.`,
        'Remove the Chart of Accounts block before creating a G/L account.',
      );
    }
    // The Account Group registry is chart-scoped: the group must exist for this chart,
    // be active, and own a range that contains the account number. Ranges are read
    // right-padded, exactly as the screen reads them.
    const [group] = await tx.select().from(glAccountGroup)
      .where(and(
        eq(glAccountGroup.client, client),
        eq(glAccountGroup.chartOfAccounts, coa),
        eq(glAccountGroup.accountGroup, accountGroup),
      ))
      .limit(1)
      .for('share');
    if (!group) {
      throw new ConfigError(
        `Account Group ${accountGroup} is not defined for Chart of Accounts ${coa} in this tenant.`,
        'Maintain the Account Group in the Account Groups panel before assigning accounts to it.',
      );
    }
    if (!group.isActive) {
      throw new ConfigError(
        `Account Group ${accountGroup} is deactivated.`,
        'Reactivate the Account Group or choose an active one.',
      );
    }
    if (!accountNumberInRange(accountNumber, group.fromAccountNumber, group.toAccountNumber)) {
      throw new ConfigError(
        `G/L Account Number ${accountNumber} is outside the ${group.fromAccountNumber} to ${group.toAccountNumber} range of Account Group ${accountGroup}.`,
        'Use a number inside the group range, or widen the range in the Account Groups panel.',
      );
    }

    const stored: GlAccountRow | undefined = existing[0];
    const version = await glAccountVersion(tx, client, coa, accountNumber);
    if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
      throw new ConfigError(
        `G/L Account ${accountNumber} changed after it was opened.`,
        'Reload the account before saving your changes.',
      );
    }
    if (input.mode === 'CREATE' && stored) {
      throw new ConfigError(
        `G/L Account ${accountNumber} already exists in Chart of Accounts ${coa}.`,
        'Open the account in Change mode. The account number is immutable, so another number is another account.',
      );
    }
    if (input.mode === 'CHANGE' && !stored) {
      throw new ConfigError(
        `G/L Account ${accountNumber} does not exist in Chart of Accounts ${coa}.`,
        'Create the account first, or choose an existing account number.',
      );
    }

    const accountType = suppressed('accountType')
      ? (stored?.accountType as AccountType | undefined) ?? input.accountType
      : input.accountType;
    const glAccountType = suppressed('glAccountType')
      ? (stored?.glAccountType as GlAccountType | undefined) ?? deriveGlAccountType(accountType)
      : input.glAccountType ?? deriveGlAccountType(accountType);
    const values = {
      client,
      chartOfAccounts: coa,
      accountNumber,
      name: suppressed('name') ? (stored?.name ?? input.name) : input.name,
      accountType,
      accountGroup,
      glAccountType,
      // Derived, never supplied by a caller: the stored flag follows the statement type
      // and a database check pins the two together.
      isBalanceSheet: deriveIsBalanceSheet(glAccountType),
      // A suppressed field is not a field the user chose: on change it keeps the stored
      // value, on create it takes the contract default, and in neither case the posted
      // one. Falling back to the post here would let a hand-built request edit a field the
      // screen was told never to render — which is the whole reason the matrix is checked
      // on the server rather than in the browser.
      isOpenItemManaged: suppressed('isOpenItemManaged')
        ? (stored?.isOpenItemManaged ?? false)
        : input.isOpenItemManaged,
      reconciliationType: suppressed('reconciliationType')
        ? (stored?.reconciliationType as ReconciliationType | null | undefined) ?? null
        : input.reconciliationType ?? null,
      requiresCostObject: suppressed('requiresCostObject')
        ? (stored?.requiresCostObject ?? false)
        : input.requiresCostObject,
      isTaxRelevant: suppressed('isTaxRelevant')
        ? (stored?.isTaxRelevant ?? false)
        : input.isTaxRelevant,
      groupAccountNumber: suppressed('groupAccountNumber')
        ? (stored?.groupAccountNumber ?? null)
        : groupAccountNumber,
      languageKey: suppressed('languageKey')
        ? (stored?.languageKey ?? DEFAULT_LANGUAGE_KEY)
        : languageKey,
      sortKey: suppressed('sortKey') ? (stored?.sortKey ?? DEFAULT_SORT_KEY) : sortKey,
      isBlockedPosting: suppressed('isBlockedPosting')
        ? (stored?.isBlockedPosting ?? false)
        : input.isBlockedPosting ?? false,
      isBlockedCreation: suppressed('isBlockedCreation')
        ? (stored?.isBlockedCreation ?? false)
        : input.isBlockedCreation ?? false,
    };

    const reason = input.reason?.trim() || undefined;
    const blocksChanged =
      stored !== undefined &&
      (stored.isBlockedPosting !== values.isBlockedPosting ||
        stored.isBlockedCreation !== values.isBlockedCreation);
    if (blocksChanged && !reason) {
      throw new ConfigError(
        'A reason is required to change a G/L account block.',
        'Explain the block change; the note is stored with the change history.',
      );
    }

    if (!stored) {
      await tx.insert(glAccount).values({ ...values, createdBy: changedBy });
      const changeId = await recordChange(tx, {
        client,
        objectClass: 'gl_account',
        objectKey: `${coa}/${accountNumber}`,
        changeType: 'CREATE',
        changedBy,
        transactionCode: 'CFG.FIN.GLACCOUNT.CREATE',
        reason,
        after: values,
        fieldLabels: GL_ACCOUNT_FIELD_LABELS,
      });
      if (!changeId) {
        throw new ConfigError(
          'G/L account creation could not be recorded in change history.',
          'Retry the save. If the problem continues, contact an administrator.',
        );
      }
      await markActivityComplete(tx, client, 'CFG.FIN.GLACCOUNT.CREATE', changedBy);
      return { created: true, changed: true, version: version + 1 };
    }

    const before = stored;
    await tx
      .update(glAccount)
      .set({ ...values, changedBy, changedAt: new Date() })
      .where(
        and(
          eq(glAccount.client, client),
          eq(glAccount.chartOfAccounts, coa),
          eq(glAccount.accountNumber, accountNumber),
        ),
      );

    const changeId = await recordChange(tx, {
      client,
      objectClass: 'gl_account',
      objectKey: `${coa}/${accountNumber}`,
      // A block change is recorded as BLOCK/UNBLOCK so an auditor filtering on blocking
      // sees it without reading every field diff.
      changeType: blocksChanged
        ? values.isBlockedPosting || values.isBlockedCreation
          ? 'BLOCK'
          : 'UNBLOCK'
        : 'CHANGE',
      changedBy,
      transactionCode: 'CFG.FIN.GLACCOUNT.CHANGE',
      reason,
      before: before as unknown as Record<string, unknown>,
      after: values,
      fieldLabels: GL_ACCOUNT_FIELD_LABELS,
      // Blocking an account or changing its type changes what may be posted
      // where. An auditor cares; these are not cosmetic edits.
      securityRelevantFields: [
        'accountType',
        'glAccountType',
        'isBlockedPosting',
        'isBlockedCreation',
        'reconciliationType',
      ],
    });
    if (!changeId && blocksChanged) {
      // Nothing differed but a block flag moved: that is exactly the change the contract
      // demands a reason for, so a missing history row is a failure, not a no-op.
      throw new ConfigError(
        'G/L account block change could not be recorded in change history.',
        'Retry the save. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, 'CFG.FIN.GLACCOUNT.CHANGE', changedBy);
    // recordChange returns null when every field already held this value, so "changed"
    // is a fact about the row rather than about the request having been accepted.
    return { created: false, changed: Boolean(changeId), version: version + 1 };
  });
}

/**
 * Change the two block flags of one account (FS00, `XSPEB`/`XSPEA`).
 *
 * The list screen offers blocking without opening the whole field screen, so this reads
 * and writes the flags inside one transaction rather than accepting a full row back from
 * the browser: a partial post cannot silently blank a field it never mentioned. A reason
 * is mandatory whenever a flag actually moves, which is the contract's rule for block
 * changes, and the change is recorded as BLOCK or UNBLOCK so an auditor can filter on it.
 */
export interface GlAccountBlockInput {
  client: string;
  chartOfAccounts: string;
  accountNumber: string;
  isBlockedPosting: boolean;
  isBlockedCreation: boolean;
  reason?: string;
  expectedVersion?: number;
  changedBy: string;
}

export async function setGlAccountBlocks(input: GlAccountBlockInput) {
  const { client, changedBy } = input;
  const coa = input.chartOfAccounts.trim().toUpperCase();
  const accountNumber = input.accountNumber.trim();
  const reason = input.reason?.trim() || undefined;
  if (!/^[A-Z0-9]{4}$/.test(coa)) {
    throw new ConfigError('Chart of Accounts must be exactly four letters or numbers.', 'Choose an existing four-character Chart of Accounts key.');
  }
  if (!/^[A-Za-z0-9]{1,10}$/.test(accountNumber)) {
    throw new ConfigError('G/L Account Number must be one to ten letters or numbers.', 'Choose an existing account number.');
  }

  return withTenant(client, async (tx) => {
    await lockGlAccount(tx, client, coa, accountNumber);
    const [before] = await tx
      .select()
      .from(glAccount)
      .where(glAccountKey(client, coa, accountNumber))
      .for('update');
    if (!before) {
      throw new ConfigError(
        `G/L Account ${accountNumber} does not exist in Chart of Accounts ${coa}.`,
        'Choose an existing account number.',
      );
    }
    const version = await glAccountVersion(tx, client, coa, accountNumber);
    if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
      throw new ConfigError(
        `G/L Account ${accountNumber} changed after it was opened.`,
        'Reload the account list before changing its blocks.',
      );
    }
    if (
      before.isBlockedPosting === input.isBlockedPosting &&
      before.isBlockedCreation === input.isBlockedCreation
    ) {
      return { chartOfAccounts: coa, accountNumber, changed: false, version };
    }
    if (!reason) {
      throw new ConfigError(
        'A reason is required to change a G/L account block.',
        'Explain the block change; the note is stored with the change history.',
      );
    }

    await tx
      .update(glAccount)
      .set({
        isBlockedPosting: input.isBlockedPosting,
        isBlockedCreation: input.isBlockedCreation,
        changedBy,
        changedAt: new Date(),
      })
      .where(glAccountKey(client, coa, accountNumber));

    const blocked = input.isBlockedPosting || input.isBlockedCreation;
    const changeId = await recordChange(tx, {
      client,
      objectClass: 'gl_account',
      objectKey: `${coa}/${accountNumber}`,
      changeType: blocked ? 'BLOCK' : 'UNBLOCK',
      changedBy,
      transactionCode: 'CFG.FIN.GLACCOUNT.CHANGE',
      reason,
      before: before as unknown as Record<string, unknown>,
      after: {
        ...(before as unknown as Record<string, unknown>),
        isBlockedPosting: input.isBlockedPosting,
        isBlockedCreation: input.isBlockedCreation,
      },
      fieldLabels: GL_ACCOUNT_FIELD_LABELS,
      securityRelevantFields: ['isBlockedPosting', 'isBlockedCreation'],
    });
    if (!changeId) {
      throw new ConfigError(
        'G/L account block change could not be recorded in change history.',
        'Retry the change. If the problem continues, contact an administrator.',
      );
    }
    await markActivityComplete(tx, client, 'CFG.FIN.GLACCOUNT.CHANGE', changedBy);
    return { chartOfAccounts: coa, accountNumber, changed: true, blocked, version: version + 1 };
  });
}

/**
 * Delete a G/L account (FS00, SCR-028).
 *
 * Deletion is a hard delete and only ever of an account that was never used: no document
 * line, no open item, a zero balance, and no Customer or Supplier company record pointing
 * at it as a reconciliation account. Anything else keeps the account and blocks it for
 * posting instead, because removing an account that carried postings would remove the
 * explanation of a balance that still exists.
 *
 * The reason is mandatory. It is the only thing that survives the row.
 */
export interface GlAccountDeletionInput {
  client: string;
  chartOfAccounts: string;
  accountNumber: string;
  changedBy: string;
  reason: string;
  /** Change-history count for this account; omit to skip the concurrency check. */
  expectedVersion?: number;
}

export async function deleteGlAccount(input: GlAccountDeletionInput) {
  const { client, changedBy } = input;
  const coa = input.chartOfAccounts.trim().toUpperCase();
  const accountNumber = input.accountNumber.trim();
  const reason = input.reason.trim();
  if (!/^[A-Z0-9]{4}$/.test(coa)) {
    throw new ConfigError('Chart of Accounts must be exactly four letters or numbers.', 'Choose an existing four-character Chart of Accounts key.');
  }
  if (!/^[A-Za-z0-9]{1,10}$/.test(accountNumber)) {
    throw new ConfigError('G/L Account Number must be one to ten letters or numbers.', 'Choose an existing account number.');
  }
  if (reason === '') {
    throw new ConfigError(
      'A reason is required to delete a G/L account.',
      'Explain the deletion; the note is stored with the change history.',
    );
  }

  return withTenant(client, async (tx) => {
    await lockGlAccount(tx, client, coa, accountNumber);
    const [before] = await tx
      .select()
      .from(glAccount)
      .where(glAccountKey(client, coa, accountNumber))
      .for('update');
    if (!before) {
      throw new ConfigError(
        `G/L Account ${accountNumber} does not exist in Chart of Accounts ${coa}.`,
        'Choose an existing account number.',
      );
    }
    const version = await glAccountVersion(tx, client, coa, accountNumber);
    if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
      throw new ConfigError(
        `G/L Account ${accountNumber} changed after it was opened.`,
        'Reload the account before deleting it.',
      );
    }

    const usage = await glAccountUsage(tx, client, coa, accountNumber);
    if (usage.facts.length > 0) {
      throw new ConfigError(
        `G/L Account ${coa}/${accountNumber} cannot be deleted while it still has ${usage.facts.join(', ')}.`,
        'Block the account for posting instead; an account with history is never removed.',
      );
    }

    const changeId = await recordChange(tx, {
      client,
      objectClass: 'gl_account',
      objectKey: `${coa}/${accountNumber}`,
      changeType: 'DELETE',
      changedBy,
      transactionCode: 'CFG.FIN.GLACCOUNT.CHANGE',
      reason,
      before: before as unknown as Record<string, unknown>,
      fieldLabels: GL_ACCOUNT_FIELD_LABELS,
      securityRelevantFields: ['accountNumber', 'accountType', 'reconciliationType'],
    });
    if (!changeId) {
      throw new ConfigError(
        'G/L account deletion could not be recorded in change history.',
        'Retry the deletion. If the problem continues, contact an administrator.',
      );
    }
    // Recorded before the row goes: the history is the only trace left of the account.
    await tx.delete(glAccount).where(glAccountKey(client, coa, accountNumber));
    await markActivityComplete(tx, client, 'CFG.FIN.GLACCOUNT.CHANGE', changedBy);
    return { deleted: true, accountNumber, chartOfAccounts: coa, version: version + 1 };
  });
}

/**
 * What still depends on one account, as the facts a refusal should name.
 *
 * Document lines are reached through the Company Code, because a line carries the account
 * number and the Company Code, and the Company Code carries the chart. One guard reports
 * every fact at once rather than three guards racing to be the first to refuse: an
 * accountant told "it has postings" and then "it also has open items" on the next attempt
 * learns nothing from either message.
 */
async function glAccountUsage(tx: Tx, client: string, coa: string, accountNumber: string) {
  const [lines] = await tx
    .select({
      lineCount: sql<number>`count(*)::int`,
      openLineCount: sql<number>`count(*) filter (where ${journalEntryLine.clearingDocument} is null)::int`,
      balance: sql<string>`coalesce(sum(case when ${journalEntryLine.debitCredit} = 'S' then ${journalEntryLine.amountLocal} else -${journalEntryLine.amountLocal} end), 0)`,
    })
    .from(journalEntryLine)
    .innerJoin(
      companyCode,
      and(
        eq(companyCode.client, journalEntryLine.client),
        eq(companyCode.companyCode, journalEntryLine.companyCode),
      ),
    )
    .where(and(
      eq(journalEntryLine.client, client),
      eq(journalEntryLine.glAccount, accountNumber),
      eq(companyCode.chartOfAccounts, coa),
    ));

  const [customers] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(customerCompany)
    .where(and(
      eq(customerCompany.client, client),
      eq(customerCompany.chartOfAccounts, coa),
      eq(customerCompany.reconciliationAccount, accountNumber),
    ));
  const [suppliers] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(supplierCompany)
    .where(and(
      eq(supplierCompany.client, client),
      eq(supplierCompany.chartOfAccounts, coa),
      eq(supplierCompany.reconciliationAccount, accountNumber),
    ));

  const lineCount = lines?.lineCount ?? 0;
  const openLineCount = lines?.openLineCount ?? 0;
  const balanceIsZero = Number(lines?.balance ?? '0') === 0;
  const facts: string[] = [];
  if (lineCount > 0) {
    facts.push(`${lineCount} document ${lineCount === 1 ? 'line' : 'lines'}`);
  }
  if (openLineCount > 0) {
    facts.push(`${openLineCount} open ${openLineCount === 1 ? 'item' : 'items'}`);
  }
  if (!balanceIsZero) {
    facts.push(`a balance of ${lines?.balance ?? '0'}`);
  }
  const customerCount = customers?.count ?? 0;
  if (customerCount > 0) {
    facts.push(`${customerCount} Customer company ${customerCount === 1 ? 'record' : 'records'} using it as a reconciliation account`);
  }
  const supplierCount = suppliers?.count ?? 0;
  if (supplierCount > 0) {
    facts.push(`${supplierCount} Supplier company ${supplierCount === 1 ? 'record' : 'records'} using it as a reconciliation account`);
  }
  return { lineCount, openLineCount, balanceIsZero, facts };
}

/**
 * The version a screen must post back to change one account.
 *
 * Exported so FS00 can render it as a hidden field: the account has no version column, so
 * its version is the count of change documents recorded against it, and a save is refused
 * when that count has moved since the screen was opened.
 */
export async function glAccountAuditVersion(
  client: string,
  chartOfAccounts: string,
  accountNumber: string,
): Promise<number> {
  const coa = chartOfAccounts.trim().toUpperCase();
  const number = accountNumber.trim();
  return withTenant(client, (tx) => glAccountVersion(tx, client, coa, number));
}

/**
 * Change-history count for one account.
 *
 * `gl_account` has no version column — the account is written by provisioning as well as
 * by FS00 — so its version is the number of change documents recorded against it, which
 * is the same optimistic-concurrency read OB13 uses for a chart.
 */
async function glAccountVersion(tx: Tx, client: string, coa: string, accountNumber: string) {
  const [row] = await tx
    .select({ version: sql<number>`count(*)::int` })
    .from(changeDocument)
    .where(and(
      eq(changeDocument.client, client),
      eq(changeDocument.objectClass, 'gl_account'),
      eq(changeDocument.objectKey, `${coa}/${accountNumber}`),
    ));
  return row?.version ?? 0;
}

function glAccountKey(client: string, coa: string, accountNumber: string) {
  return and(
    eq(glAccount.client, client),
    eq(glAccount.chartOfAccounts, coa),
    eq(glAccount.accountNumber, accountNumber),
  );
}

function lockGlAccount(tx: Tx, client: string, coa: string, accountNumber: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/gl_account/${coa}/${accountNumber}`}, 0))`,
  );
}

/* ── Posting periods ───────────────────────────────────────────────────────── */

export async function listPeriodRules(
  client: string,
  companyCodeKey: string,
  fiscalYear: number,
) {
  const { periodStatus } = await import('../../platform/periods');
  return withTenant(client, (tx) => periodStatus(tx, client, companyCodeKey, fiscalYear));
}

export interface PeriodRuleInput {
  client: string;
  variant: string;
  accountType: 'S' | 'K' | 'D' | 'A' | 'M';
  periodFrom: number;
  periodTo: number;
  allowSpecialPeriods: boolean;
  changedBy: string;
}

export async function updatePeriodRule(input: PeriodRuleInput) {
  const { client, variant, accountType, changedBy } = input;

  if (!['S', 'K', 'D', 'A', 'M'].includes(input.accountType) || !Number.isInteger(input.periodFrom) || !Number.isInteger(input.periodTo) || input.periodFrom < 1 || input.periodTo > 16 || input.periodFrom > input.periodTo) {
    throw new ConfigError(
      `Period range ${input.periodFrom} to ${input.periodTo} is not valid.`,
      'Enter a range between 1 and 16, where the first period is not later than the last.',
    );
  }

  return withTenant(client, async (tx) => {
    const existing = await tx
      .select()
      .from(postingPeriodRule)
      .where(
        and(
          eq(postingPeriodRule.client, client),
          eq(postingPeriodRule.variant, variant),
          eq(postingPeriodRule.accountType, accountType),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      throw new ConfigError(
        `No posting period rule exists for account type ${accountType} ` +
          `in variant ${variant}.`,
        'The standard configuration package creates these rules when a tenant is set up.',
      );
    }

    const before = existing[0];
    await tx
      .update(postingPeriodRule)
      .set({
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        allowSpecialPeriods: input.allowSpecialPeriods,
        changedBy,
        changedAt: new Date(),
      })
      .where(
        and(
          eq(postingPeriodRule.client, client),
          eq(postingPeriodRule.variant, variant),
          eq(postingPeriodRule.accountType, accountType),
        ),
      );

    // Reopening or closing a period changes what the books will accept, so it is
    // recorded as a change with a security-relevant flag and a reason field the
    // auditor can read (§16.6).
    await recordChange(tx, {
      client,
      objectClass: 'posting_period_rule',
      objectKey: `${variant}/${accountType}`,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: 'FIN.CLOSE.PERIOD',
      before: {
        periodFrom: before.periodFrom,
        periodTo: before.periodTo,
        allowSpecialPeriods: before.allowSpecialPeriods,
      },
      after: {
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        allowSpecialPeriods: input.allowSpecialPeriods,
      },
      securityRelevantFields: ['periodFrom', 'periodTo', 'allowSpecialPeriods'],
    });

    return { accountType };
  });
}

/* ── Plants and storage locations ──────────────────────────────────────────── */

export async function listPlants(client: string, companyCodeKey?: string) {
  return withTenant(client, async (tx) => {
    const filters = [eq(plant.client, client)];
    if (companyCodeKey) filters.push(eq(plant.companyCode, companyCodeKey));

    const plants = await tx
      .select()
      .from(plant)
      .where(and(...filters))
      .orderBy(asc(plant.plant));

    const result = [];
    for (const p of plants) {
      const locations = await tx
        .select()
        .from(storageLocation)
        .where(and(eq(storageLocation.client, client), eq(storageLocation.plant, p.plant)))
        .orderBy(asc(storageLocation.storageLocation));
      result.push({ ...p, storageLocations: locations });
    }
    return result;
  });
}

/** Everything the foundation screens need for their selection lists. */
export async function listConfigurationChoices(client: string) {
  return withTenant(client, async (tx) => ({
    charts: await tx
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.client, client))
      .orderBy(asc(chartOfAccounts.chartOfAccounts)),
    fiscalYearVariants: await tx
      .select()
      .from(fiscalYearVariant)
      .where(eq(fiscalYearVariant.client, client))
      .orderBy(asc(fiscalYearVariant.variant)),
  }));
}

export { withTenant, type Tx };
