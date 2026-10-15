/** SCR-026 / OB13 Chart of Accounts definition and tenant-local F4 choices. */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument, documentIndex } from '../../platform/tables/audit-trail';
import { configActivityStatus } from '../../platform/tables/registry';
import { glAccount, journalEntry } from '../finance/schema';
import { chartOfAccounts, companyCode } from './schema';

const ACTIVITY = 'CFG.FIN.COA.DEFINE';
const OBJECT_CLASS = 'chart_of_accounts';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE'] as const;
const SUPPORTED_LANGUAGES = [{ code: 'EN', name: 'English' }] as const;

const clientSchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const chartCodeSchema = z.string().trim().transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'Chart of Accounts must be exactly four letters or numbers.'));
const descriptionSchema = z.string().trim().min(1, 'Description is required.').max(50, 'Description must be 50 characters or fewer.');
const languageSchema = z.string().trim().transform((value) => value.toUpperCase())
  .pipe(z.enum(['EN']));
const accountLengthSchema = z.coerce.number().int('G/L Account Number length must be a whole number.').min(1).max(10);
const groupChartSchema = z.string().trim().transform((value) => value.toUpperCase())
  .refine((value) => value === '' || /^[A-Z0-9]{4}$/.test(value), 'Group CoA must be blank or a four-character alphanumeric key.')
  .transform((value) => value || null);
const costElementIntegrationSchema = z.enum(['AUTOMATIC', 'MANUAL', 'NONE']);
const reasonSchema = z.string().trim().max(500).optional().transform((value) => value || undefined);

/** Business fields shown on OB13; the Chart of Accounts key is immutable after create. */
export const chartOfAccountsValuesSchema = z.object({
  chartOfAccounts: chartCodeSchema,
  name: descriptionSchema,
  language: languageSchema,
  accountNumberLength: accountLengthSchema,
  groupChart: groupChartSchema,
  costElementIntegration: costElementIntegrationSchema,
  isBlocked: z.boolean(),
}).strict();

export const chartOfAccountsMaintenanceInputSchema = chartOfAccountsValuesSchema.extend({
  client: clientSchema,
  changedBy: z.string().trim().min(1).max(60),
  mode: z.enum(['CREATE', 'CHANGE']),
  expectedVersion: z.number().int().nonnegative(),
  reason: reasonSchema,
}).strict();

const chartKeyInputSchema = z.object({ client: clientSchema, chartOfAccounts: chartCodeSchema }).strict();

export type ChartOfAccountsValues = z.output<typeof chartOfAccountsValuesSchema>;
export type ChartOfAccountsMaintenanceInput = z.input<typeof chartOfAccountsMaintenanceInputSchema>;
export type CostElementIntegration = z.infer<typeof costElementIntegrationSchema>;

export class ChartOfAccountsMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Chart of Accounts definition and try again.',
  ) {
    super(message);
    this.name = 'ChartOfAccountsMaintenanceError';
  }
}

/** Currently the app supports English only; both the dropdown and F4 use this list. */
export async function chartOfAccountsF4Choices(client: string) {
  const parsed = clientSchema.safeParse(client);
  if (!parsed.success) throw invalidInput(parsed.error);
  const tenant = parsed.data;

  return withTenant(tenant, async (tx) => {
    const groupCharts = await tx.select({
      code: chartOfAccounts.chartOfAccounts,
      name: chartOfAccounts.name,
      isActive: chartOfAccounts.isActive,
    })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.client, tenant), eq(chartOfAccounts.isActive, true)))
      .orderBy(asc(chartOfAccounts.chartOfAccounts));

    return {
      languages: SUPPORTED_LANGUAGES.map((row) => ({ ...row })),
      groupCharts: groupCharts.map((row) => ({
        code: row.code.trim(),
        name: row.name.trim(),
        isActive: row.isActive,
      })).filter((row) => /^[A-Z0-9]{4}$/.test(row.code)),
    };
  });
}

/** List retained charts with account/transaction lock status and audit version. */
export async function listChartOfAccounts(client: string) {
  const parsed = clientSchema.safeParse(client);
  if (!parsed.success) throw invalidInput(parsed.error);
  const tenant = parsed.data;

  return withTenant(tenant, async (tx) => {
    const [rows, accountCounts, journalCharts, indexedCharts, versions] = await Promise.all([
      tx.select().from(chartOfAccounts)
        .where(eq(chartOfAccounts.client, tenant))
        .orderBy(asc(chartOfAccounts.chartOfAccounts)),
      tx.select({
        chartOfAccounts: glAccount.chartOfAccounts,
        count: sql<number>`count(*)::int`,
      }).from(glAccount)
        .where(eq(glAccount.client, tenant))
        .groupBy(glAccount.chartOfAccounts),
      tx.select({ chartOfAccounts: companyCode.chartOfAccounts })
        .from(companyCode)
        .innerJoin(journalEntry, and(
          eq(journalEntry.client, companyCode.client),
          eq(journalEntry.companyCode, companyCode.companyCode),
        ))
        .where(and(eq(companyCode.client, tenant), isNotNull(companyCode.chartOfAccounts)))
        .groupBy(companyCode.chartOfAccounts),
      tx.select({ chartOfAccounts: companyCode.chartOfAccounts })
        .from(companyCode)
        .innerJoin(documentIndex, and(
          eq(documentIndex.client, companyCode.client),
          eq(documentIndex.companyCode, companyCode.companyCode),
        ))
        .where(and(eq(companyCode.client, tenant), isNotNull(companyCode.chartOfAccounts)))
        .groupBy(companyCode.chartOfAccounts),
      tx.select({ objectKey: changeDocument.objectKey, count: sql<number>`count(*)::int` })
        .from(changeDocument)
        .where(and(
          eq(changeDocument.client, tenant),
          eq(changeDocument.objectClass, OBJECT_CLASS),
        ))
        .groupBy(changeDocument.objectKey),
    ]);

    const accountsByChart = new Map(accountCounts.map((row) => [row.chartOfAccounts.trim(), row.count]));
    const usedCharts = new Set([
      ...journalCharts.flatMap((row) => row.chartOfAccounts ? [row.chartOfAccounts.trim()] : []),
      ...indexedCharts.flatMap((row) => row.chartOfAccounts ? [row.chartOfAccounts.trim()] : []),
    ]);
    const versionByChart = new Map(versions.map((row) => [row.objectKey, row.count]));

    return rows.map((row) => {
      const code = row.chartOfAccounts.trim();
      const glAccountCount = accountsByChart.get(code) ?? 0;
      const hasTransactions = usedCharts.has(code);
      return {
        chartOfAccounts: code,
        name: row.name.trim(),
        language: row.language.trim(),
        accountNumberLength: row.accountNumberLength,
        groupChart: row.groupChart?.trim() || null,
        costElementIntegration: row.costElementIntegration as CostElementIntegration,
        isBlocked: row.isBlocked,
        isActive: row.isActive,
        glAccountCount,
        hasTransactions,
        accountNumberLengthLocked: glAccountCount > 0 || hasTransactions,
        version: versionByChart.get(code) ?? 0,
      };
    });
  });
}

/** Create a chart or change non-key settings, with tenant locks and change history. */
export async function saveChartOfAccounts(raw: ChartOfAccountsMaintenanceInput) {
  const parsed = chartOfAccountsMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, mode, expectedVersion, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await lockChart(tx, client, values.chartOfAccounts);
    const [current] = await tx.select().from(chartOfAccounts)
      .where(chartKey(client, values.chartOfAccounts))
      .for('update');
    const version = await auditVersion(tx, client, values.chartOfAccounts);

    if (mode === 'CREATE' && current) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return noChangeResult(current, version);
    }
    if (mode === 'CHANGE' && !current) throw notFound(values.chartOfAccounts);
    if (mode === 'CREATE' && (expectedVersion !== 0 || version !== 0)) throw staleVersion(values.chartOfAccounts);
    if (mode === 'CHANGE' && expectedVersion !== version) throw staleVersion(values.chartOfAccounts);
    if (current && !current.isActive) {
      throw new ChartOfAccountsMaintenanceError(
        `Chart of Accounts ${values.chartOfAccounts} is inactive and cannot be changed.`,
        'Inactive Charts of Accounts are retained for history; no reactivation action is available.',
      );
    }

    await requirePrerequisites(tx, client);
    if (values.groupChart) await requireGroupChart(tx, client, values.chartOfAccounts, values.groupChart);

    if (current && current.accountNumberLength !== values.accountNumberLength) {
      if (await hasAccountsOrTransactions(tx, client, values.chartOfAccounts)) {
        throw new ChartOfAccountsMaintenanceError(
          `G/L Account Number length for Chart of Accounts ${values.chartOfAccounts} is locked because G/L accounts or transactional data exist.`,
          'Retain the established account-number length after the chart has been used.',
        );
      }
    }

    if (current) {
      const before = snapshot(current);
      const after = { ...values, isActive: current.isActive };
      if (sameValues(before, after)) {
        await markActivityComplete(tx, client, ACTIVITY, changedBy);
        return noChangeResult(current, version);
      }

      await tx.update(chartOfAccounts).set({
        name: values.name,
        language: values.language,
        accountNumberLength: values.accountNumberLength,
        groupChart: values.groupChart,
        costElementIntegration: values.costElementIntegration,
        isBlocked: values.isBlocked,
        changedBy,
        changedAt: new Date(),
      }).where(chartKey(client, values.chartOfAccounts));

      const changeId = await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: values.chartOfAccounts,
        changeType: 'CHANGE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        before,
        after,
        securityRelevantFields: ['accountNumberLength', 'groupChart', 'costElementIntegration', 'isBlocked'],
        fieldLabels: FIELD_LABELS,
      });
      if (!changeId) throw new ChartOfAccountsMaintenanceError('Chart of Accounts change could not be recorded in change history.');
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { created: false as const, changed: true as const, version: version + 1, ...values };
    }

    await tx.insert(chartOfAccounts).values({
      client,
      chartOfAccounts: values.chartOfAccounts,
      name: values.name,
      language: values.language,
      accountNumberLength: values.accountNumberLength,
      groupChart: values.groupChart,
      costElementIntegration: values.costElementIntegration,
      isBlocked: values.isBlocked,
      isActive: true,
      createdBy: changedBy,
    });

    const changeId = await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: values.chartOfAccounts,
      changeType: 'CREATE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      after: { ...values, isActive: true },
      securityRelevantFields: ['chartOfAccounts', 'accountNumberLength', 'groupChart', 'costElementIntegration', 'isBlocked'],
      fieldLabels: FIELD_LABELS,
    });
    if (!changeId) throw new ChartOfAccountsMaintenanceError('Chart of Accounts creation could not be recorded in change history.');
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { created: true as const, changed: true as const, version: version + 1, ...values };
  });
}

/** G/L master or any transaction indexed for a Company Code using this chart locks its length. */
export async function chartOfAccountsHasAccountsOrTransactions(client: string, code: string) {
  const parsed = chartKeyInputSchema.safeParse({ client, chartOfAccounts: code });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, (tx) => hasAccountsOrTransactions(tx, parsed.data.client, parsed.data.chartOfAccounts));
}

async function requirePrerequisites(tx: Tx, client: string) {
  const rows = await tx.select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, client),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length) throw new ChartOfAccountsMaintenanceError(
    `Chart of Accounts prerequisites are incomplete: ${missing.join(', ')}.`,
    'Complete Company Code definition in the configuration workbench first.',
  );
}

async function requireGroupChart(tx: Tx, client: string, chart: string, groupChart: string) {
  if (chart === groupChart) {
    throw new ChartOfAccountsMaintenanceError(
      `Chart of Accounts ${chart} cannot be its own Group CoA.`,
      'Choose a different existing Chart of Accounts or leave Group CoA blank.',
    );
  }
  const [existing] = await tx.select({ code: chartOfAccounts.chartOfAccounts })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.client, client),
      eq(chartOfAccounts.chartOfAccounts, groupChart),
      eq(chartOfAccounts.isActive, true),
    ))
    .limit(1);
  if (!existing) throw new ChartOfAccountsMaintenanceError(
    `Active Group CoA ${groupChart} is not defined in this tenant.`,
    'Choose an existing active Chart of Accounts from Group CoA F4, or leave the field blank.',
  );
}

async function hasAccountsOrTransactions(tx: Tx, client: string, chart: string) {
  const [account] = await tx.select({ accountNumber: glAccount.accountNumber })
    .from(glAccount)
    .where(and(eq(glAccount.client, client), eq(glAccount.chartOfAccounts, chart)))
    .limit(1);
  if (account) return true;

  const [posting] = await tx.select({ documentNumber: journalEntry.documentNumber })
    .from(companyCode)
    .innerJoin(journalEntry, and(
      eq(journalEntry.client, companyCode.client),
      eq(journalEntry.companyCode, companyCode.companyCode),
    ))
    .where(and(
      eq(companyCode.client, client),
      eq(companyCode.chartOfAccounts, chart),
    ))
    .limit(1);
  if (posting) return true;

  const [document] = await tx.select({ id: documentIndex.id })
    .from(companyCode)
    .innerJoin(documentIndex, and(
      eq(documentIndex.client, companyCode.client),
      eq(documentIndex.companyCode, companyCode.companyCode),
    ))
    .where(and(
      eq(companyCode.client, client),
      eq(companyCode.chartOfAccounts, chart),
    ))
    .limit(1);
  return Boolean(document);
}

async function lockChart(tx: Tx, client: string, code: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/chart_of_accounts/${code}`}, 0))`);
}

function chartKey(client: string, code: string) {
  return and(eq(chartOfAccounts.client, client), eq(chartOfAccounts.chartOfAccounts, code));
}

function snapshot(row: typeof chartOfAccounts.$inferSelect) {
  return {
    chartOfAccounts: row.chartOfAccounts.trim(),
    name: row.name.trim(),
    language: row.language.trim(),
    accountNumberLength: row.accountNumberLength,
    groupChart: row.groupChart?.trim() || null,
    costElementIntegration: row.costElementIntegration,
    isBlocked: row.isBlocked,
    isActive: row.isActive,
  };
}

function sameValues(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) {
  return before.name === after.name
    && before.language === after.language
    && before.accountNumberLength === after.accountNumberLength
    && before.groupChart === after.groupChart
    && before.costElementIntegration === after.costElementIntegration
    && before.isBlocked === after.isBlocked
    && before.isActive === after.isActive;
}

async function auditVersion(tx: Tx, client: string, code: string): Promise<number> {
  const [row] = await tx.select({ version: sql<number>`count(*)::int` })
    .from(changeDocument)
    .where(and(
      eq(changeDocument.client, client),
      eq(changeDocument.objectClass, OBJECT_CLASS),
      eq(changeDocument.objectKey, code),
    ));
  return row?.version ?? 0;
}

function noChangeResult(current: typeof chartOfAccounts.$inferSelect, version: number) {
  return {
    created: false as const,
    changed: false as const,
    chartOfAccounts: current.chartOfAccounts.trim(),
    name: current.name.trim(),
    language: current.language.trim(),
    accountNumberLength: current.accountNumberLength,
    groupChart: current.groupChart?.trim() || null,
    costElementIntegration: current.costElementIntegration as CostElementIntegration,
    isBlocked: current.isBlocked,
    isActive: current.isActive,
    version,
  };
}

function invalidInput(error: z.ZodError): ChartOfAccountsMaintenanceError {
  return new ChartOfAccountsMaintenanceError(
    error.issues[0]?.message ?? 'Chart of Accounts input is invalid.',
    'Correct the indicated value and submit again.',
  );
}

function staleVersion(code: string) {
  return new ChartOfAccountsMaintenanceError(
    `Chart of Accounts ${code} changed after it was opened.`,
    'Reload the current Chart of Accounts before saving your changes.',
  );
}

function notFound(code: string) {
  return new ChartOfAccountsMaintenanceError(
    `Chart of Accounts ${code} was not found.`,
    'Return to the overview and select an existing Chart of Accounts.',
  );
}

const FIELD_LABELS = {
  chartOfAccounts: 'Chart of Accounts (KTOPL)',
  name: 'Description (KTPLT)',
  language: 'Language Key (SPRAS)',
  accountNumberLength: 'Length of G/L Account Number (KTKTB)',
  groupChart: 'Group CoA',
  costElementIntegration: 'Cost Element Integration',
  isBlocked: 'Block flag',
  isActive: 'Active',
};
