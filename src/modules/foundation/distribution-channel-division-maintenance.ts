/** Audited tenant-scoped Distribution Channel and Division definitions — SCR-022. */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { changeDocument } from '../../platform/tables/audit-trail';
import {
  division as divisionTable,
  distributionChannel as distributionChannelTable,
  salesArea,
  salesOrgDistributionChannel,
} from './schema';

const DISTRIBUTION_CHANNEL_ACTIVITY = 'CFG.ORG.DISTCHANNEL.DEFINE';
const DIVISION_ACTIVITY = 'CFG.ORG.DIVISION.DEFINE';
const DISTRIBUTION_CHANNEL_OBJECT = 'distribution_channel';
const DIVISION_OBJECT = 'division';

type DefinitionKind = 'distributionChannel' | 'division';
type DefinitionRow = typeof distributionChannelTable.$inferSelect | typeof divisionTable.$inferSelect;

const tenantKeySchema = z.string().regex(/^[A-Za-z0-9]{2,4}$/);
const definitionKeySchema = z.string().trim()
  .regex(/^[A-Za-z0-9]{2}$/, 'Enter exactly two letters or numbers.')
  .transform((value) => value.toUpperCase());
const requiredNameSchema = z.string().trim()
  .min(1, 'Enter a name.')
  .max(20, 'Name must be 20 characters or fewer.');
const optionalReasonSchema = z.string().trim().max(500).optional().transform((value) => value || undefined);
const modeSchema = z.enum(['CREATE', 'CHANGE']);

export const distributionChannelDefinitionValuesSchema = z.object({ name: requiredNameSchema }).strict();
export const divisionDefinitionValuesSchema = z.object({ name: requiredNameSchema }).strict();

export const distributionChannelMaintenanceInputSchema = z.object({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
  mode: modeSchema,
  distributionChannel: definitionKeySchema,
  expectedVersion: z.number().int().nonnegative(),
  reason: optionalReasonSchema,
  values: distributionChannelDefinitionValuesSchema,
}).strict();
export const divisionMaintenanceInputSchema = z.object({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
  mode: modeSchema,
  division: definitionKeySchema,
  expectedVersion: z.number().int().nonnegative(),
  reason: optionalReasonSchema,
  values: divisionDefinitionValuesSchema,
}).strict();

export const distributionChannelDeactivationInputSchema = z.object({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
  distributionChannel: definitionKeySchema,
  expectedVersion: z.number().int().nonnegative(),
  reason: optionalReasonSchema,
}).strict();
export const divisionDeactivationInputSchema = z.object({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
  division: definitionKeySchema,
  expectedVersion: z.number().int().nonnegative(),
  reason: optionalReasonSchema,
}).strict();

const distributionChannelVersionInputSchema = z.object({ client: tenantKeySchema, distributionChannel: definitionKeySchema }).strict();
const divisionVersionInputSchema = z.object({ client: tenantKeySchema, division: definitionKeySchema }).strict();

export type DistributionChannelDefinitionValuesInput = z.input<typeof distributionChannelDefinitionValuesSchema>;
export type DivisionDefinitionValuesInput = z.input<typeof divisionDefinitionValuesSchema>;
export type DistributionChannelMaintenanceInput = z.input<typeof distributionChannelMaintenanceInputSchema>;
export type DivisionMaintenanceInput = z.input<typeof divisionMaintenanceInputSchema>;
export type DistributionChannelDeactivationInput = z.input<typeof distributionChannelDeactivationInputSchema>;
export type DivisionDeactivationInput = z.input<typeof divisionDeactivationInputSchema>;

const FIELD_LABELS: Record<DefinitionKind, Record<string, string>> = {
  distributionChannel: { distributionChannel: 'Distribution Channel', name: 'Name', isActive: 'Active' },
  division: { division: 'Division', name: 'Name', isActive: 'Active' },
};

export class DistributionDimensionMaintenanceError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(message: string, readonly remedy = 'Review the definition and try again.') {
    super(message);
    this.name = 'DistributionDimensionMaintenanceError';
  }
}

type SavePayload = {
  client: string;
  changedBy: string;
  mode: z.infer<typeof modeSchema>;
  code: string;
  expectedVersion: number;
  reason?: string;
  name: string;
};
type DeactivationPayload = {
  client: string;
  changedBy: string;
  code: string;
  expectedVersion: number;
  reason?: string;
};

function activity(kind: DefinitionKind) {
  return kind === 'distributionChannel' ? DISTRIBUTION_CHANNEL_ACTIVITY : DIVISION_ACTIVITY;
}
function objectClass(kind: DefinitionKind) {
  return kind === 'distributionChannel' ? DISTRIBUTION_CHANNEL_OBJECT : DIVISION_OBJECT;
}
function keyLabel(kind: DefinitionKind) {
  return kind === 'distributionChannel' ? 'Distribution Channel' : 'Division';
}
function snapshot(kind: DefinitionKind, code: string, name: string, isActive: boolean) {
  return kind === 'distributionChannel'
    ? { distributionChannel: code, name, isActive }
    : { division: code, name, isActive };
}

function invalidInput(error: z.ZodError, kind: DefinitionKind): DistributionDimensionMaintenanceError {
  return new DistributionDimensionMaintenanceError(
    error.issues[0]?.message ?? `${keyLabel(kind)} definition is invalid.`,
    'Correct the indicated value and submit the definition again.',
  );
}
function staleVersion(kind: DefinitionKind, code: string): DistributionDimensionMaintenanceError {
  return new DistributionDimensionMaintenanceError(
    `${keyLabel(kind)} ${code} changed after it was opened.`,
    'Reload the current definition before saving your changes.',
  );
}
function whereKey(kind: DefinitionKind, client: string, code: string) {
  return kind === 'distributionChannel'
    ? and(eq(distributionChannelTable.client, client), eq(distributionChannelTable.distributionChannel, code))
    : and(eq(divisionTable.client, client), eq(divisionTable.division, code));
}

async function lockDefinition(tx: Tx, kind: DefinitionKind, client: string, code: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/${kind}/${code}`}, 0))`);
}

async function auditVersion(tx: Tx, kind: DefinitionKind, client: string, code: string): Promise<number> {
  const [row] = await tx.select({ version: sql<number>`count(*)::int` })
    .from(changeDocument)
    .where(and(
      eq(changeDocument.client, client),
      eq(changeDocument.objectClass, objectClass(kind)),
      eq(changeDocument.objectKey, code),
    ));
  return row?.version ?? 0;
}

async function currentRow(tx: Tx, kind: DefinitionKind, client: string, code: string): Promise<DefinitionRow | undefined> {
  if (kind === 'distributionChannel') {
    const [row] = await tx.select().from(distributionChannelTable)
      .where(whereKey(kind, client, code)).for('update');
    return row;
  }
  const [row] = await tx.select().from(divisionTable)
    .where(whereKey(kind, client, code)).for('update');
  return row;
}

async function insertDefinition(tx: Tx, kind: DefinitionKind, client: string, code: string, name: string, changedBy: string) {
  if (kind === 'distributionChannel') {
    await tx.insert(distributionChannelTable).values({
      client, distributionChannel: code, name, isActive: true, createdBy: changedBy,
    });
  } else {
    await tx.insert(divisionTable).values({ client, division: code, name, isActive: true, createdBy: changedBy });
  }
}

async function updateName(tx: Tx, kind: DefinitionKind, client: string, code: string, name: string, changedBy: string) {
  if (kind === 'distributionChannel') {
    await tx.update(distributionChannelTable).set({ name, changedBy, changedAt: new Date() })
      .where(whereKey(kind, client, code));
  } else {
    await tx.update(divisionTable).set({ name, changedBy, changedAt: new Date() })
      .where(whereKey(kind, client, code));
  }
}

async function deactivateRow(tx: Tx, kind: DefinitionKind, client: string, code: string, changedBy: string) {
  if (kind === 'distributionChannel') {
    await tx.update(distributionChannelTable).set({ isActive: false, changedBy, changedAt: new Date() })
      .where(whereKey(kind, client, code));
  } else {
    await tx.update(divisionTable).set({ isActive: false, changedBy, changedAt: new Date() })
      .where(whereKey(kind, client, code));
  }
}

async function hasSalesAreaReference(tx: Tx, kind: DefinitionKind, client: string, code: string): Promise<boolean> {
  const reference = kind === 'distributionChannel'
    ? await tx.select({ salesOrg: salesArea.salesOrg }).from(salesArea).where(and(
      eq(salesArea.client, client), eq(salesArea.distributionChannel, code),
    )).limit(1)
    : await tx.select({ salesOrg: salesArea.salesOrg }).from(salesArea).where(and(
      eq(salesArea.client, client), eq(salesArea.division, code),
    )).limit(1);
  return reference.length > 0;
}

async function hasSalesOrgAssignmentReference(tx: Tx, client: string, code: string): Promise<boolean> {
  const [reference] = await tx
    .select({ salesOrg: salesOrgDistributionChannel.salesOrg })
    .from(salesOrgDistributionChannel)
    .where(and(
      eq(salesOrgDistributionChannel.client, client),
      eq(salesOrgDistributionChannel.distributionChannel, code),
    ))
    .limit(1);
  return Boolean(reference);
}

async function saveDefinition(kind: DefinitionKind, payload: SavePayload) {
  const { client, changedBy, mode, code, expectedVersion, reason, name } = payload;
  return withTenant(client, async (tx) => {
    // Serialize first-time duplicate attempts, for which no row can be locked yet.
    await lockDefinition(tx, kind, client, code);
    const current = await currentRow(tx, kind, client, code);
    const version = await auditVersion(tx, kind, client, code);

    if (mode === 'CREATE') {
      if (current) {
        throw new DistributionDimensionMaintenanceError(
          `${keyLabel(kind)} ${code} already exists.`,
          'Choose an unused code. Create never replaces or reactivates an existing definition.',
        );
      }
      if (expectedVersion !== 0 || version !== 0) throw staleVersion(kind, code);
      await insertDefinition(tx, kind, client, code, name, changedBy);
      const changeId = await recordChange(tx, {
        client, objectClass: objectClass(kind), objectKey: code, changeType: 'CREATE', changedBy,
        transactionCode: activity(kind), reason,
        after: snapshot(kind, code, name, true),
        securityRelevantFields: ['isActive'], fieldLabels: FIELD_LABELS[kind],
      });
      if (!changeId) {
        throw new DistributionDimensionMaintenanceError(
          `${keyLabel(kind)} creation could not be recorded in change history.`,
          'Retry the definition. If the problem continues, contact an administrator.',
        );
      }
      await markActivityComplete(tx, client, activity(kind), changedBy);
      return { code, created: true as const, changed: true as const, isActive: true, version: version + 1 };
    }

    if (!current) {
      throw new DistributionDimensionMaintenanceError(
        `${keyLabel(kind)} ${code} does not exist in this tenant.`,
        `Return to the ${keyLabel(kind)} list and choose an existing definition to change.`,
      );
    }
    if (expectedVersion !== version) throw staleVersion(kind, code);
    if (current.name === name) {
      await markActivityComplete(tx, client, activity(kind), changedBy);
      return { code, created: false as const, changed: false as const, isActive: current.isActive, version };
    }

    await updateName(tx, kind, client, code, name, changedBy);
    const changeId = await recordChange(tx, {
      client, objectClass: objectClass(kind), objectKey: code, changeType: 'CHANGE', changedBy,
      transactionCode: activity(kind), reason,
      before: snapshot(kind, code, current.name, current.isActive),
      after: snapshot(kind, code, name, current.isActive),
      securityRelevantFields: ['isActive'], fieldLabels: FIELD_LABELS[kind],
    });
    if (!changeId) {
      throw new DistributionDimensionMaintenanceError(
        `${keyLabel(kind)} change could not be recorded in change history.`,
        'Retry the definition. If the problem continues, contact an administrator.',
      );
    }
    await markActivityComplete(tx, client, activity(kind), changedBy);
    return { code, created: false as const, changed: true as const, isActive: current.isActive, version: version + 1 };
  });
}

async function deactivateDefinition(kind: DefinitionKind, payload: DeactivationPayload) {
  const { client, changedBy, code, expectedVersion, reason } = payload;
  return withTenant(client, async (tx) => {
    await lockDefinition(tx, kind, client, code);
    const current = await currentRow(tx, kind, client, code);
    if (!current) {
      throw new DistributionDimensionMaintenanceError(
        `${keyLabel(kind)} ${code} does not exist in this tenant.`,
        `Return to the ${keyLabel(kind)} list and choose an existing definition to deactivate.`,
      );
    }
    const version = await auditVersion(tx, kind, client, code);
    if (expectedVersion !== version) throw staleVersion(kind, code);
    if (!current.isActive) {
      await markActivityComplete(tx, client, activity(kind), changedBy);
      return { code, changed: false as const, isActive: false, version };
    }

    if (kind === 'distributionChannel' && await hasSalesOrgAssignmentReference(tx, client, code)) {
      throw new DistributionDimensionMaintenanceError(
        `Distribution Channel ${code} is still assigned to one or more Sales Organizations and cannot be deactivated.`,
        'Remove its Sales Organization assignments first; retain the Distribution Channel while any assignment depends on it.',
      );
    }

    if (await hasSalesAreaReference(tx, kind, client, code)) {
      throw new DistributionDimensionMaintenanceError(
        `${keyLabel(kind)} ${code} is still referenced by Sales Area configuration and cannot be deactivated.`,
        'Retain the definition while any Sales Area uses it.',
      );
    }

    await deactivateRow(tx, kind, client, code, changedBy);
    const changeId = await recordChange(tx, {
      client, objectClass: objectClass(kind), objectKey: code, changeType: 'CHANGE', changedBy,
      transactionCode: activity(kind), reason,
      before: snapshot(kind, code, current.name, true),
      after: snapshot(kind, code, current.name, false),
      securityRelevantFields: ['isActive'], fieldLabels: FIELD_LABELS[kind],
    });
    if (!changeId) {
      throw new DistributionDimensionMaintenanceError(
        `${keyLabel(kind)} deactivation could not be recorded in change history.`,
        'Retry deactivation. If the problem continues, contact an administrator.',
      );
    }
    await markActivityComplete(tx, client, activity(kind), changedBy);
    return { code, changed: true as const, isActive: false, version: version + 1 };
  });
}

export async function saveDistributionChannelDefinition(raw: DistributionChannelMaintenanceInput) {
  const parsed = distributionChannelMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error, 'distributionChannel');
  const { client, changedBy, mode, distributionChannel, expectedVersion, reason, values } = parsed.data;
  const result = await saveDefinition('distributionChannel', {
    client, changedBy, mode, code: distributionChannel, expectedVersion, reason, name: values.name,
  });
  return { distributionChannel: result.code, created: result.created, changed: result.changed, isActive: result.isActive, version: result.version };
}

export async function saveDivisionDefinition(raw: DivisionMaintenanceInput) {
  const parsed = divisionMaintenanceInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error, 'division');
  const { client, changedBy, mode, division, expectedVersion, reason, values } = parsed.data;
  const result = await saveDefinition('division', {
    client, changedBy, mode, code: division, expectedVersion, reason, name: values.name,
  });
  return { division: result.code, created: result.created, changed: result.changed, isActive: result.isActive, version: result.version };
}

export async function deactivateDistributionChannel(raw: DistributionChannelDeactivationInput) {
  const parsed = distributionChannelDeactivationInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error, 'distributionChannel');
  const { client, changedBy, distributionChannel, expectedVersion, reason } = parsed.data;
  const result = await deactivateDefinition('distributionChannel', { client, changedBy, code: distributionChannel, expectedVersion, reason });
  return { distributionChannel: result.code, changed: result.changed, isActive: result.isActive, version: result.version };
}

export async function deactivateDivision(raw: DivisionDeactivationInput) {
  const parsed = divisionDeactivationInputSchema.safeParse(raw);
  if (!parsed.success) throw invalidInput(parsed.error, 'division');
  const { client, changedBy, division, expectedVersion, reason } = parsed.data;
  const result = await deactivateDefinition('division', { client, changedBy, code: division, expectedVersion, reason });
  return { division: result.code, changed: result.changed, isActive: result.isActive, version: result.version };
}

export async function getDistributionChannelDefinitionVersion(client: string, code: string): Promise<number> {
  const parsed = distributionChannelVersionInputSchema.safeParse({ client, distributionChannel: code });
  if (!parsed.success) throw invalidInput(parsed.error, 'distributionChannel');
  return withTenant(parsed.data.client, (tx) => auditVersion(tx, 'distributionChannel', parsed.data.client, parsed.data.distributionChannel));
}

export async function getDivisionDefinitionVersion(client: string, code: string): Promise<number> {
  const parsed = divisionVersionInputSchema.safeParse({ client, division: code });
  if (!parsed.success) throw invalidInput(parsed.error, 'division');
  return withTenant(parsed.data.client, (tx) => auditVersion(tx, 'division', parsed.data.client, parsed.data.division));
}
