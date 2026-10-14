/** OVXK Sales Organization ↔ Distribution Channel assignment services. */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import {
  distributionChannel,
  salesArea,
  salesOrg,
  salesOrgDistributionChannel,
} from './schema';

const ASSIGNMENT_ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL';
const PREREQUISITES = ['CFG.ORG.SALESORG.DEFINE', 'CFG.ORG.DISTCHANNEL.DEFINE'] as const;

const tenantKeySchema = z.string().regex(/^[A-Za-z0-9]{2,4}$/);

/** Only the two owner-specified values are editable; tenant and actor are service-only inputs. */
export const salesOrgDistributionChannelValuesSchema = z.object({
  salesOrg: z.string().trim().regex(/^[A-Z0-9]{4}$/,
    'Sales Organization must be four uppercase alphanumeric characters.'),
  distributionChannel: z.string().trim().regex(/^[A-Z0-9]{2}$/,
    'Distribution Channel must be two uppercase alphanumeric characters.'),
}).strict();

export const salesOrgDistributionChannelAssignmentInputSchema = salesOrgDistributionChannelValuesSchema.extend({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type SalesOrgDistributionChannelAssignmentInput =
  z.input<typeof salesOrgDistributionChannelAssignmentInputSchema>;

export class SalesOrgDistributionChannelAssignmentError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Sales Organization and Distribution Channel, then try the assignment again.',
  ) {
    super(message);
    this.name = 'SalesOrgDistributionChannelAssignmentError';
  }
}

/**
 * Serialize mutations for one pair. Future Sales Area creation must acquire the
 * same transaction lock before it creates a dependent Sales Area, so unassignment
 * and dependent creation cannot race each other.
 */
export async function lockSalesOrgDistributionChannelPair(
  tx: Tx,
  client: string,
  salesOrgCode: string,
  distributionChannelCode: string,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`${client}/sales_org_distribution_channel/${salesOrgCode}/${distributionChannelCode}`}, 0))`);
}

/** F4 data: only active, tenant-local definitions can be selected. */
export async function salesOrgDistributionChannelF4Choices(client: string) {
  const parsedClient = tenantKeySchema.safeParse(client);
  if (!parsedClient.success) {
    throw new SalesOrgDistributionChannelAssignmentError(
      'The current tenant key is invalid.',
      'Sign in to a valid tenant and reload the assignment form.',
    );
  }

  return withTenant(parsedClient.data, async (tx) => {
    const organisations = await tx
      .select({ code: salesOrg.salesOrg })
      .from(salesOrg)
      .where(and(eq(salesOrg.client, parsedClient.data), eq(salesOrg.isActive, true)))
      .orderBy(asc(salesOrg.salesOrg));
    const channels = await tx
      .select({ code: distributionChannel.distributionChannel, name: distributionChannel.name })
      .from(distributionChannel)
      .where(and(
        eq(distributionChannel.client, parsedClient.data),
        eq(distributionChannel.isActive, true),
      ))
      .orderBy(asc(distributionChannel.distributionChannel));

    return {
      salesOrganizations: organisations
        .map((row) => row.code.trim())
        .filter((code) => /^[A-Z0-9]{4}$/.test(code)),
      distributionChannels: channels
        .map((row) => ({ code: row.code.trim(), name: row.name.trim() }))
        .filter((row) => /^[A-Z0-9]{2}$/.test(row.code)),
    };
  });
}

/**
 * List all assigned pairs, including pairs whose source definition was later
 * deactivated, so maintainers can still inspect and (when unused) remove them.
 */
export async function listSalesOrgDistributionChannelAssignments(client: string) {
  const parsedClient = tenantKeySchema.safeParse(client);
  if (!parsedClient.success) {
    throw new SalesOrgDistributionChannelAssignmentError(
      'The current tenant key is invalid.',
      'Sign in to a valid tenant and reload the assignments.',
    );
  }

  return withTenant(parsedClient.data, (tx) =>
    tx
      .select({
        salesOrg: salesOrgDistributionChannel.salesOrg,
        salesOrgActive: salesOrg.isActive,
        distributionChannel: salesOrgDistributionChannel.distributionChannel,
        distributionChannelName: distributionChannel.name,
        distributionChannelActive: distributionChannel.isActive,
        createdAt: salesOrgDistributionChannel.createdAt,
      })
      .from(salesOrgDistributionChannel)
      .innerJoin(salesOrg, and(
        eq(salesOrg.client, salesOrgDistributionChannel.client),
        eq(salesOrg.salesOrg, salesOrgDistributionChannel.salesOrg),
      ))
      .innerJoin(distributionChannel, and(
        eq(distributionChannel.client, salesOrgDistributionChannel.client),
        eq(distributionChannel.distributionChannel, salesOrgDistributionChannel.distributionChannel),
      ))
      .where(eq(salesOrgDistributionChannel.client, parsedClient.data))
      .orderBy(
        asc(salesOrgDistributionChannel.salesOrg),
        asc(salesOrgDistributionChannel.distributionChannel),
      ),
  );
}

/** Tenant-scoped OVXK assignment. Repeating an existing pair is an audited no-op. */
export async function assignSalesOrgDistributionChannel(
  raw: SalesOrgDistributionChannelAssignmentInput,
) {
  const parsed = salesOrgDistributionChannelAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SalesOrgDistributionChannelAssignmentError(
      parsed.error.issues[0]?.message ?? 'The Sales Organization / Distribution Channel pair is invalid.',
      'Choose an active Sales Organization and Distribution Channel from F4, then submit again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    await lockSalesOrgDistributionChannelPair(tx, client, values.salesOrg, values.distributionChannel);

    // The pair lock serializes retries before the existing-row check.
    const [existing] = await tx
      .select({ salesOrg: salesOrgDistributionChannel.salesOrg })
      .from(salesOrgDistributionChannel)
      .where(and(
        eq(salesOrgDistributionChannel.client, client),
        eq(salesOrgDistributionChannel.salesOrg, values.salesOrg),
        eq(salesOrgDistributionChannel.distributionChannel, values.distributionChannel),
      ))
      .limit(1);
    if (existing) {
      await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
      return {
        assigned: false as const,
        salesOrg: values.salesOrg,
        distributionChannel: values.distributionChannel,
      };
    }

    // Lock the source rows while checking active state so a concurrent deactivation
    // cannot pass its usage check before this pair is committed.
    const [organisation] = await tx
      .select({ isActive: salesOrg.isActive })
      .from(salesOrg)
      .where(and(eq(salesOrg.client, client), eq(salesOrg.salesOrg, values.salesOrg)))
      .for('update');
    if (!organisation) {
      throw new SalesOrgDistributionChannelAssignmentError(
        `Sales Organization ${values.salesOrg} does not exist in this tenant.`,
        'Define the Sales Organization first through OVX5.',
      );
    }
    if (!organisation.isActive) {
      throw new SalesOrgDistributionChannelAssignmentError(
        `Sales Organization ${values.salesOrg} is inactive.`,
        'Activate the Sales Organization before assigning a Distribution Channel.',
      );
    }

    const [channel] = await tx
      .select({ isActive: distributionChannel.isActive })
      .from(distributionChannel)
      .where(and(
        eq(distributionChannel.client, client),
        eq(distributionChannel.distributionChannel, values.distributionChannel),
      ))
      .for('update');
    if (!channel) {
      throw new SalesOrgDistributionChannelAssignmentError(
        `Distribution Channel ${values.distributionChannel} does not exist in this tenant.`,
        'Define the Distribution Channel first through OVXI.',
      );
    }
    if (!channel.isActive) {
      throw new SalesOrgDistributionChannelAssignmentError(
        `Distribution Channel ${values.distributionChannel} is inactive.`,
        'Activate the Distribution Channel before assigning it.',
      );
    }

    await requireDefinitionPrerequisites(tx, client);

    const [created] = await tx
      .insert(salesOrgDistributionChannel)
      .values({
        client,
        salesOrg: values.salesOrg,
        distributionChannel: values.distributionChannel,
        createdBy: changedBy,
      })
      .onConflictDoNothing()
      .returning({ salesOrg: salesOrgDistributionChannel.salesOrg });

    // The transaction lock normally makes this branch unreachable; keep the
    // unique key as the final concurrency backstop.
    if (!created) {
      await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
      return {
        assigned: false as const,
        salesOrg: values.salesOrg,
        distributionChannel: values.distributionChannel,
      };
    }

    await recordChange(tx, {
      client,
      objectClass: 'sales_org_distribution_channel',
      objectKey: `${values.salesOrg}/${values.distributionChannel}`,
      changeType: 'CREATE',
      changedBy,
      transactionCode: ASSIGNMENT_ACTIVITY,
      after: {
        salesOrg: values.salesOrg,
        distributionChannel: values.distributionChannel,
      },
      securityRelevantFields: ['salesOrg', 'distributionChannel'],
      fieldLabels: {
        salesOrg: 'Sales Organization',
        distributionChannel: 'Distribution Channel',
      },
    });
    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);

    return {
      assigned: true as const,
      salesOrg: values.salesOrg,
      distributionChannel: values.distributionChannel,
    };
  });
}

/** Remove an unused pair while preserving its full change-document history. */
export async function unassignSalesOrgDistributionChannel(
  raw: SalesOrgDistributionChannelAssignmentInput,
) {
  const parsed = salesOrgDistributionChannelAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SalesOrgDistributionChannelAssignmentError(
      parsed.error.issues[0]?.message ?? 'The Sales Organization / Distribution Channel pair is invalid.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    await lockSalesOrgDistributionChannelPair(tx, client, values.salesOrg, values.distributionChannel);

    const [existing] = await tx
      .select({
        salesOrg: salesOrgDistributionChannel.salesOrg,
        distributionChannel: salesOrgDistributionChannel.distributionChannel,
        createdAt: salesOrgDistributionChannel.createdAt,
      })
      .from(salesOrgDistributionChannel)
      .where(and(
        eq(salesOrgDistributionChannel.client, client),
        eq(salesOrgDistributionChannel.salesOrg, values.salesOrg),
        eq(salesOrgDistributionChannel.distributionChannel, values.distributionChannel),
      ))
      .for('update');
    if (!existing) {
      throw new SalesOrgDistributionChannelAssignmentError(
        `Sales Organization ${values.salesOrg} is not assigned to Distribution Channel ${values.distributionChannel}.`,
        'Reload the current assignment list before removing a pair.',
      );
    }

    const [dependentArea] = await tx
      .select({ division: salesArea.division })
      .from(salesArea)
      .where(and(
        eq(salesArea.client, client),
        eq(salesArea.salesOrg, values.salesOrg),
        eq(salesArea.distributionChannel, values.distributionChannel),
      ))
      .limit(1);
    if (dependentArea) {
      throw new SalesOrgDistributionChannelAssignmentError(
        `Distribution Channel ${values.distributionChannel} cannot be removed from Sales Organization ${values.salesOrg} while a Sales Area uses the pair.`,
        'Remove or change the dependent Sales Area through its own configuration activity first.',
      );
    }

    const [removed] = await tx
      .delete(salesOrgDistributionChannel)
      .where(and(
        eq(salesOrgDistributionChannel.client, client),
        eq(salesOrgDistributionChannel.salesOrg, values.salesOrg),
        eq(salesOrgDistributionChannel.distributionChannel, values.distributionChannel),
      ))
      .returning({ salesOrg: salesOrgDistributionChannel.salesOrg });
    if (!removed) {
      throw new SalesOrgDistributionChannelAssignmentError(
        `Sales Organization ${values.salesOrg} changed while its Distribution Channel assignment was being removed.`,
        'Reload the current assignment list before trying again.',
      );
    }

    await recordChange(tx, {
      client,
      objectClass: 'sales_org_distribution_channel',
      objectKey: `${values.salesOrg}/${values.distributionChannel}`,
      changeType: 'DELETE',
      changedBy,
      transactionCode: ASSIGNMENT_ACTIVITY,
      before: {
        salesOrg: existing.salesOrg,
        distributionChannel: existing.distributionChannel,
      },
      securityRelevantFields: ['salesOrg', 'distributionChannel'],
      fieldLabels: {
        salesOrg: 'Sales Organization',
        distributionChannel: 'Distribution Channel',
      },
    });
    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);

    return {
      removed: true as const,
      salesOrg: values.salesOrg,
      distributionChannel: values.distributionChannel,
    };
  });
}

async function requireDefinitionPrerequisites(tx: Tx, client: string) {
  const completedRows = await tx
    .select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, client),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(completedRows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length > 0) {
    throw new SalesOrgDistributionChannelAssignmentError(
      `OVXK prerequisites are incomplete: ${missing.join(', ')}.`,
      'Complete Sales Organization and Distribution Channel definition in the configuration workbench first.',
    );
  }
}
