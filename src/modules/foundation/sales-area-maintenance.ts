/** OVXG tenant-scoped Sales Area maintenance business functions. */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import { configActivityStatus } from '../../platform/tables/registry';
import { customerSalesArea } from './customer-sales-area-schema';
import {
  distributionChannel,
  division,
  salesArea,
  salesOrg,
  salesOrgDistributionChannel,
  salesOrgDivision,
  salesOrgText,
} from './schema';
import { lockSalesOrgDistributionChannelPair } from './sales-org-distribution-channel-assignment';
import { lockSalesOrgDivisionPair } from './sales-org-division-assignment';

const SALES_AREA_ACTIVITY = 'CFG.ORG.SALESAREA.DEFINE';
const SALES_AREA_OBJECT_CLASS = 'sales_area';
const SALES_AREA_PREREQUISITES = [
  'CFG.ORG.SALESORG.DEFINE',
  'CFG.ORG.DISTCHANNEL.DEFINE',
  'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL',
  'CFG.ORG.DIVISION.DEFINE',
  'CFG.ORG.SALESORG.ASSIGN_DIVISION',
] as const;

const tenantKeySchema = z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/);
const salesOrgCodeSchema = z.string().trim().regex(/^[A-Z0-9]{4}$/);
const channelCodeSchema = z.string().trim().regex(/^[A-Z0-9]{2}$/);
const divisionCodeSchema = z.string().trim().regex(/^[A-Z0-9]{2}$/);
const languageKeySchema = z.string().trim().regex(/^[A-Z]$/);
const reasonSchema = z.string().trim().max(500).optional().transform((value) => value || undefined);

/** The Sales Area key is immutable; the required descriptive Name is the only editable value. */
export const salesAreaValuesSchema = z.object({
  salesOrg: salesOrgCodeSchema,
  distributionChannel: channelCodeSchema,
  division: divisionCodeSchema,
  name: z.string().trim().min(1, 'Sales Area Name is required.').max(160, 'Sales Area Name must be 160 characters or fewer.'),
}).strict();

export const salesAreaMaintenanceInputSchema = salesAreaValuesSchema.extend({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
  mode: z.enum(['CREATE', 'CHANGE']),
  expectedVersion: z.number().int().nonnegative(),
  reason: reasonSchema,
}).strict();

export const salesAreaKeyInputSchema = z.object({
  client: tenantKeySchema,
  salesOrg: salesOrgCodeSchema,
  distributionChannel: channelCodeSchema,
  division: divisionCodeSchema,
}).strict();

const salesAreaMutationInputSchema = salesAreaKeyInputSchema.extend({
  changedBy: z.string().trim().min(1).max(60),
  expectedVersion: z.number().int().nonnegative(),
  reason: reasonSchema,
}).strict();

const salesAreaF4InputSchema = z.object({
  client: tenantKeySchema,
  salesOrg: salesOrgCodeSchema.optional(),
  languageKey: languageKeySchema.default('E'),
}).strict();

export type SalesAreaMaintenanceInput = z.input<typeof salesAreaMaintenanceInputSchema>;
export type SalesAreaValues = z.output<typeof salesAreaValuesSchema>;
export type SalesAreaMutationInput = z.input<typeof salesAreaMutationInputSchema>;

export class SalesAreaMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Sales Area key and its OVXK/OVXA assignments, then try again.',
  ) {
    super(message);
    this.name = 'SalesAreaMaintenanceError';
  }
}

/** F4 values include existing definitions, including inactive ones; channel and division choices are scoped to the selected organization. */
export async function salesAreaF4Choices(client: string, selectedSalesOrg?: string, languageKey = 'E') {
  const parsed = salesAreaF4InputSchema.safeParse({ client, salesOrg: selectedSalesOrg, languageKey });
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client: tenant, salesOrg: selectedOrg, languageKey: language } = parsed.data;

  return withTenant(tenant, async (tx) => {
    const organisations = await tx.select({ code: salesOrg.salesOrg, isActive: salesOrg.isActive })
      .from(salesOrg)
      .where(eq(salesOrg.client, tenant))
      .orderBy(asc(salesOrg.salesOrg));
    const orgCodes = organisations.map((row) => row.code.trim());
    const orgTexts = orgCodes.length
      ? await tx.select({ code: salesOrgText.salesOrg, languageKey: salesOrgText.languageKey, name: salesOrgText.name })
        .from(salesOrgText)
        .where(and(
          eq(salesOrgText.client, tenant),
          inArray(salesOrgText.salesOrg, orgCodes),
          inArray(salesOrgText.languageKey, [...new Set([language, 'E'])]),
        ))
      : [];

    const channels = selectedOrg
      ? await tx.select({
        code: distributionChannel.distributionChannel,
        name: distributionChannel.name,
        isActive: distributionChannel.isActive,
      })
        .from(salesOrgDistributionChannel)
        .innerJoin(distributionChannel, and(
          eq(distributionChannel.client, salesOrgDistributionChannel.client),
          eq(distributionChannel.distributionChannel, salesOrgDistributionChannel.distributionChannel),
        ))
        .where(and(
          eq(salesOrgDistributionChannel.client, tenant),
          eq(salesOrgDistributionChannel.salesOrg, selectedOrg),
        ))
        .orderBy(asc(distributionChannel.distributionChannel))
      : [];
    const divisions = selectedOrg
      ? await tx.select({
        code: division.division,
        name: division.name,
        isActive: division.isActive,
      })
        .from(salesOrgDivision)
        .innerJoin(division, and(
          eq(division.client, salesOrgDivision.client),
          eq(division.division, salesOrgDivision.division),
        ))
        .where(and(
          eq(salesOrgDivision.client, tenant),
          eq(salesOrgDivision.salesOrg, selectedOrg),
        ))
        .orderBy(asc(division.division))
      : [];

    return {
      salesOrganizations: organisations
        .filter((row) => /^[A-Z0-9]{4}$/.test(row.code.trim()))
        .map((row) => {
          const code = row.code.trim();
          const local = orgTexts.find((text) => text.code.trim() === code && text.languageKey.trim() === language);
          const english = orgTexts.find((text) => text.code.trim() === code && text.languageKey.trim() === 'E');
          return { code, name: local?.name.trim() || english?.name.trim() || code, isActive: row.isActive };
        }),
      distributionChannels: channels
        .filter((row) => /^[A-Z0-9]{2}$/.test(row.code.trim()))
        .map((row) => ({ code: row.code.trim(), name: row.name.trim(), isActive: row.isActive })),
      divisions: divisions
        .filter((row) => /^[A-Z0-9]{2}$/.test(row.code.trim()))
        .map((row) => ({ code: row.code.trim(), name: row.name.trim(), isActive: row.isActive })),
    };
  });
}

/** List retained Sales Areas with source-definition status for active and inactive entries alike. */
export async function listSalesAreas(client: string, languageKey = 'E') {
  const parsed = z.object({ client: tenantKeySchema, languageKey: languageKeySchema }).safeParse({ client, languageKey });
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client: tenant, languageKey: language } = parsed.data;

  return withTenant(tenant, async (tx) => {
    const rows = await tx.select({
      salesOrg: salesArea.salesOrg,
      salesOrgActive: salesOrg.isActive,
      distributionChannel: salesArea.distributionChannel,
      distributionChannelName: distributionChannel.name,
      distributionChannelActive: distributionChannel.isActive,
      division: salesArea.division,
      divisionName: division.name,
      divisionActive: division.isActive,
      name: salesArea.name,
      isActive: salesArea.isActive,
      createdAt: salesArea.createdAt,
      changedAt: salesArea.changedAt,
    })
      .from(salesArea)
      .innerJoin(salesOrg, and(
        eq(salesOrg.client, salesArea.client),
        eq(salesOrg.salesOrg, salesArea.salesOrg),
      ))
      .innerJoin(distributionChannel, and(
        eq(distributionChannel.client, salesArea.client),
        eq(distributionChannel.distributionChannel, salesArea.distributionChannel),
      ))
      .innerJoin(division, and(
        eq(division.client, salesArea.client),
        eq(division.division, salesArea.division),
      ))
      .where(eq(salesArea.client, tenant))
      .orderBy(asc(salesArea.salesOrg), asc(salesArea.distributionChannel), asc(salesArea.division));

    const orgCodes = [...new Set(rows.map((row) => row.salesOrg.trim()))];
    const orgTexts = orgCodes.length
      ? await tx.select({ salesOrg: salesOrgText.salesOrg, languageKey: salesOrgText.languageKey, name: salesOrgText.name })
        .from(salesOrgText)
        .where(and(
          eq(salesOrgText.client, tenant),
          inArray(salesOrgText.salesOrg, orgCodes),
          inArray(salesOrgText.languageKey, [...new Set([language, 'E'])]),
        ))
      : [];

    return rows.map((row) => {
      const code = row.salesOrg.trim();
      const local = orgTexts.find((text) => text.salesOrg.trim() === code && text.languageKey.trim() === language);
      const english = orgTexts.find((text) => text.salesOrg.trim() === code && text.languageKey.trim() === 'E');
      return {
        ...row,
        salesOrg: code,
        distributionChannel: row.distributionChannel.trim(),
        division: row.division.trim(),
        name: row.name.trim(),
        salesOrgName: local?.name.trim() || english?.name.trim() || code,
        distributionChannelName: row.distributionChannelName.trim(),
        divisionName: row.divisionName.trim(),
      };
    });
  });
}

/** Create an area or change only its Name. Repeating an existing key is a no-op, even if the row is inactive. */
export async function saveSalesArea(raw: SalesAreaMaintenanceInput) {
  const parsed = salesAreaMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, mode, expectedVersion, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    if (mode === 'CREATE') {
      // These locks share the OVXK/OVXA removal protocol, so a Sales Area cannot
      // be inserted while either supporting assignment is concurrently removed.
      await lockSalesOrgDistributionChannelPair(tx, client, values.salesOrg, values.distributionChannel);
      await lockSalesOrgDivisionPair(tx, client, values.salesOrg, values.division);
    }
    await lockSalesArea(tx, client, values);

    const [current] = await tx.select().from(salesArea).where(areaKey(client, values)).for('update');
    const version = await auditVersion(tx, client, values);

    if (mode === 'CREATE') {
      if (current) return noChangeResult(current, version);
      if (expectedVersion !== 0 || version !== 0) throw staleVersion(values);
      await requireSalesAreaPrerequisites(tx, client);
      await requireSalesAreaAssignments(tx, client, values);

      const [created] = await tx.insert(salesArea).values({
        client,
        salesOrg: values.salesOrg,
        distributionChannel: values.distributionChannel,
        division: values.division,
        name: values.name,
        isActive: true,
        createdBy: changedBy,
      }).onConflictDoNothing().returning({ salesOrg: salesArea.salesOrg });

      // The tuple lock normally makes this branch unreachable; keep the primary
      // key as a final idempotency guard for non-service writers.
      if (!created) {
        const [raced] = await tx.select().from(salesArea).where(areaKey(client, values));
        if (raced) return noChangeResult(raced, await auditVersion(tx, client, values));
        throw new SalesAreaMaintenanceError('Sales Area creation did not persist.', 'Retry the save. If it continues, contact an administrator.');
      }

      const changeId = await recordChange(tx, {
        client,
        objectClass: SALES_AREA_OBJECT_CLASS,
        objectKey: areaObjectKey(values),
        changeType: 'CREATE',
        changedBy,
        transactionCode: SALES_AREA_ACTIVITY,
        reason,
        after: { ...values, isActive: true },
        securityRelevantFields: ['salesOrg', 'distributionChannel', 'division', 'isActive'],
        fieldLabels: SALES_AREA_FIELD_LABELS,
      });
      if (!changeId) throw new SalesAreaMaintenanceError('Sales Area creation could not be recorded in change history.');
      await markActivityComplete(tx, client, SALES_AREA_ACTIVITY, changedBy);
      return { created: true as const, changed: true as const, isActive: true, version: version + 1, ...values };
    }

    if (!current) throw notFound(values);
    if (expectedVersion !== version) throw staleVersion(values);
    if (current.name.trim() === values.name) return noChangeResult(current, version);

    await tx.update(salesArea).set({ name: values.name, changedBy, changedAt: new Date() })
      .where(areaKey(client, values));
    const changeId = await recordChange(tx, {
      client,
      objectClass: SALES_AREA_OBJECT_CLASS,
      objectKey: areaObjectKey(values),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: SALES_AREA_ACTIVITY,
      reason,
      before: { ...values, name: current.name.trim(), isActive: current.isActive },
      after: { ...values, isActive: current.isActive },
      fieldLabels: SALES_AREA_FIELD_LABELS,
    });
    if (!changeId) throw new SalesAreaMaintenanceError('Sales Area Name change could not be recorded in change history.');
    await markActivityComplete(tx, client, SALES_AREA_ACTIVITY, changedBy);
    return { created: false as const, changed: true as const, isActive: current.isActive, version: version + 1, ...values };
  });
}

/** Soft-deactivate only; retained customer Sales Area rows block deactivation. */
export async function deactivateSalesArea(raw: SalesAreaMutationInput) {
  const parsed = salesAreaMutationInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, expectedVersion, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await lockSalesArea(tx, client, values);
    const [current] = await tx.select().from(salesArea).where(areaKey(client, values)).for('update');
    if (!current) throw notFound(values);
    const version = await auditVersion(tx, client, values);
    if (expectedVersion !== version) throw staleVersion(values);
    if (!current.isActive) return noChangeResult(current, version);

    const [dependent] = await tx.select({ partnerNumber: customerSalesArea.partnerNumber })
      .from(customerSalesArea)
      .where(and(
        eq(customerSalesArea.client, client),
        eq(customerSalesArea.salesOrg, values.salesOrg),
        eq(customerSalesArea.distributionChannel, values.distributionChannel),
        eq(customerSalesArea.division, values.division),
      ))
      .limit(1);
    if (dependent) throw new SalesAreaMaintenanceError(
      `Sales Area ${areaObjectKey(values)} cannot be deactivated while customer ${dependent.partnerNumber.trim()} uses it.`,
      'Retain the Sales Area while any customer Sales Area references this key.',
    );

    await tx.update(salesArea).set({ isActive: false, changedBy, changedAt: new Date() })
      .where(areaKey(client, values));
    const changeId = await recordChange(tx, {
      client,
      objectClass: SALES_AREA_OBJECT_CLASS,
      objectKey: areaObjectKey(values),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: SALES_AREA_ACTIVITY,
      reason,
      before: { ...values, name: current.name.trim(), isActive: true },
      after: { ...values, name: current.name.trim(), isActive: false },
      securityRelevantFields: ['isActive'],
      fieldLabels: SALES_AREA_FIELD_LABELS,
    });
    if (!changeId) throw new SalesAreaMaintenanceError('Sales Area deactivation could not be recorded in change history.');
    return { changed: true as const, isActive: false, version: version + 1, ...values };
  });
}

/** Reactivate a retained Sales Area key; the OVXK/OVXA foreign keys preserve its allowed combinations. */
export async function reactivateSalesArea(raw: SalesAreaMutationInput) {
  const parsed = salesAreaMutationInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { client, changedBy, expectedVersion, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await lockSalesArea(tx, client, values);
    const [current] = await tx.select().from(salesArea).where(areaKey(client, values)).for('update');
    if (!current) throw notFound(values);
    const version = await auditVersion(tx, client, values);
    if (expectedVersion !== version) throw staleVersion(values);
    if (current.isActive) return noChangeResult(current, version);

    await requireSalesAreaPrerequisites(tx, client);
    await requireSalesAreaAssignments(tx, client, values);
    await tx.update(salesArea).set({ isActive: true, changedBy, changedAt: new Date() })
      .where(areaKey(client, values));
    const changeId = await recordChange(tx, {
      client,
      objectClass: SALES_AREA_OBJECT_CLASS,
      objectKey: areaObjectKey(values),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: SALES_AREA_ACTIVITY,
      reason,
      before: { ...values, name: current.name.trim(), isActive: false },
      after: { ...values, name: current.name.trim(), isActive: true },
      securityRelevantFields: ['isActive'],
      fieldLabels: SALES_AREA_FIELD_LABELS,
    });
    if (!changeId) throw new SalesAreaMaintenanceError('Sales Area reactivation could not be recorded in change history.');
    await markActivityComplete(tx, client, SALES_AREA_ACTIVITY, changedBy);
    return { changed: true as const, isActive: true, version: version + 1, ...values };
  });
}

/** Current audit-document count, used as an optimistic version for name/status changes. */
export async function getSalesAreaVersion(client: string, values: Omit<SalesAreaValues, 'name'>) {
  const parsed = z.object({ client: tenantKeySchema, salesOrg: salesOrgCodeSchema, distributionChannel: channelCodeSchema, division: divisionCodeSchema }).safeParse({ client, ...values });
  if (!parsed.success) throw invalidInput(parsed.error);
  return withTenant(parsed.data.client, (tx) => auditVersion(tx, parsed.data.client, parsed.data));
}

async function requireSalesAreaPrerequisites(tx: Tx, client: string) {
  const completedRows = await tx.select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, client),
      inArray(configActivityStatus.activityCode, [...SALES_AREA_PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(completedRows.map((row) => row.activityCode));
  const missing = SALES_AREA_PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length) throw new SalesAreaMaintenanceError(
    `OVXG prerequisites are incomplete: ${missing.join(', ')}.`,
    'Complete the Sales Organization, Distribution Channel, Division and OVXK/OVXA assignments first.',
  );
}

/** Verify existence and both assignment links without excluding inactive definitions. */
async function requireSalesAreaAssignments(tx: Tx, client: string, values: Pick<SalesAreaValues, 'salesOrg' | 'distributionChannel' | 'division'>) {
  const [organisation] = await tx.select({ code: salesOrg.salesOrg }).from(salesOrg)
    .where(and(eq(salesOrg.client, client), eq(salesOrg.salesOrg, values.salesOrg)))
    .for('share');
  if (!organisation) throw new SalesAreaMaintenanceError(
    `Sales Organization ${values.salesOrg} does not exist in this tenant.`,
    'Define the Sales Organization through OVX5 first.',
  );

  const [channel] = await tx.select({ code: distributionChannel.distributionChannel })
    .from(salesOrgDistributionChannel)
    .innerJoin(distributionChannel, and(
      eq(distributionChannel.client, salesOrgDistributionChannel.client),
      eq(distributionChannel.distributionChannel, salesOrgDistributionChannel.distributionChannel),
    ))
    .where(and(
      eq(salesOrgDistributionChannel.client, client),
      eq(salesOrgDistributionChannel.salesOrg, values.salesOrg),
      eq(salesOrgDistributionChannel.distributionChannel, values.distributionChannel),
    ))
    .for('share');
  if (!channel) throw new SalesAreaMaintenanceError(
    `Distribution Channel ${values.distributionChannel} is not linked to Sales Organization ${values.salesOrg}.`,
    'Assign the Distribution Channel to this Sales Organization through OVXK first.',
  );

  const [divisionRow] = await tx.select({ code: division.division })
    .from(salesOrgDivision)
    .innerJoin(division, and(
      eq(division.client, salesOrgDivision.client),
      eq(division.division, salesOrgDivision.division),
    ))
    .where(and(
      eq(salesOrgDivision.client, client),
      eq(salesOrgDivision.salesOrg, values.salesOrg),
      eq(salesOrgDivision.division, values.division),
    ))
    .for('share');
  if (!divisionRow) throw new SalesAreaMaintenanceError(
    `Division ${values.division} is not linked to Sales Organization ${values.salesOrg}.`,
    'Assign the Division to this Sales Organization through OVXA first.',
  );
}

async function lockSalesArea(tx: Tx, client: string, values: Pick<SalesAreaValues, 'salesOrg' | 'distributionChannel' | 'division'>) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`${client}/sales_area/${values.salesOrg}/${values.distributionChannel}/${values.division}`}, 0))`);
}

function areaKey(client: string, values: Pick<SalesAreaValues, 'salesOrg' | 'distributionChannel' | 'division'>) {
  return and(
    eq(salesArea.client, client),
    eq(salesArea.salesOrg, values.salesOrg),
    eq(salesArea.distributionChannel, values.distributionChannel),
    eq(salesArea.division, values.division),
  );
}

function areaObjectKey(values: Pick<SalesAreaValues, 'salesOrg' | 'distributionChannel' | 'division'>) {
  return `${values.salesOrg}/${values.distributionChannel}/${values.division}`;
}

async function auditVersion(
  tx: Tx,
  client: string,
  values: Pick<SalesAreaValues, 'salesOrg' | 'distributionChannel' | 'division'>,
): Promise<number> {
  const [row] = await tx.select({ version: sql<number>`count(*)::int` }).from(changeDocument).where(and(
    eq(changeDocument.client, client),
    eq(changeDocument.objectClass, SALES_AREA_OBJECT_CLASS),
    eq(changeDocument.objectKey, areaObjectKey(values)),
  ));
  return row?.version ?? 0;
}

function noChangeResult(current: typeof salesArea.$inferSelect, version: number) {
  return {
    created: false as const,
    changed: false as const,
    isActive: current.isActive,
    name: current.name.trim(),
    version,
    salesOrg: current.salesOrg.trim(),
    distributionChannel: current.distributionChannel.trim(),
    division: current.division.trim(),
  };
}

function invalidInput(error: z.ZodError): SalesAreaMaintenanceError {
  return new SalesAreaMaintenanceError(error.issues[0]?.message ?? 'Sales Area input is invalid.', 'Correct the indicated value and submit again.');
}

function staleVersion(values: Pick<SalesAreaValues, 'salesOrg' | 'distributionChannel' | 'division'>) {
  return new SalesAreaMaintenanceError(
    `Sales Area ${areaObjectKey(values)} changed after it was opened.`,
    'Reload the current Sales Area before saving your changes.',
  );
}

function notFound(values: Pick<SalesAreaValues, 'salesOrg' | 'distributionChannel' | 'division'>) {
  return new SalesAreaMaintenanceError(
    `Sales Area ${areaObjectKey(values)} was not found.`,
    'Return to the overview and select an existing Sales Area.',
  );
}

const SALES_AREA_FIELD_LABELS = {
  salesOrg: 'Sales Organization',
  distributionChannel: 'Distribution Channel',
  division: 'Division',
  name: 'Sales Area Name',
  isActive: 'Active',
};
