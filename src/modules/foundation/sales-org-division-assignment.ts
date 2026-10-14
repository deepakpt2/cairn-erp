/** OVXA Sales Organization ↔ Division assignment services. */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import {
  division as divisionDefinition,
  salesArea,
  salesOrg,
  salesOrgDivision,
} from './schema';

const ASSIGNMENT_ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_DIVISION';
const PREREQUISITES = ['CFG.ORG.SALESORG.DEFINE', 'CFG.ORG.DIVISION.DEFINE'] as const;

const tenantKeySchema = z.string().regex(/^[A-Za-z0-9]{2,4}$/);

/** Only the two owner-specified values are editable; tenant and actor are service-only inputs. */
export const salesOrgDivisionValuesSchema = z.object({
  salesOrg: z.string().trim().regex(
    /^[A-Z0-9]{4}$/,
    'Sales Organization must be four uppercase alphanumeric characters.',
  ),
  division: z.string().trim().regex(
    /^[A-Z0-9]{2}$/,
    'Division must be two uppercase alphanumeric characters.',
  ),
}).strict();

export const salesOrgDivisionAssignmentInputSchema = salesOrgDivisionValuesSchema.extend({
  client: tenantKeySchema,
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type SalesOrgDivisionAssignmentInput = z.input<typeof salesOrgDivisionAssignmentInputSchema>;

export class SalesOrgDivisionAssignmentError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Sales Organization and Division, then try the assignment again.',
  ) {
    super(message);
    this.name = 'SalesOrgDivisionAssignmentError';
  }
}

/**
 * Serialize changes to one Sales Organization / Division pair. Future Sales Area
 * creation must take this same transaction lock before checking the assignment and
 * inserting a Sales Area, so pair removal cannot race dependent-area creation.
 */
export async function lockSalesOrgDivisionPair(
  tx: Tx,
  client: string,
  salesOrgCode: string,
  divisionCode: string,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`${client}/sales_org_division/${salesOrgCode}/${divisionCode}`}, 0))`);
}

/** F4 data: only active, tenant-local Sales Organization and Division definitions. */
export async function salesOrgDivisionF4Choices(client: string) {
  const parsedClient = tenantKeySchema.safeParse(client);
  if (!parsedClient.success) {
    throw new SalesOrgDivisionAssignmentError(
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
    const divisions = await tx
      .select({ code: divisionDefinition.division, name: divisionDefinition.name })
      .from(divisionDefinition)
      .where(and(
        eq(divisionDefinition.client, parsedClient.data),
        eq(divisionDefinition.isActive, true),
      ))
      .orderBy(asc(divisionDefinition.division));

    return {
      salesOrganizations: organisations
        .map((row) => row.code.trim())
        .filter((code) => /^[A-Z0-9]{4}$/.test(code)),
      divisions: divisions
        .map((row) => ({ code: row.code.trim(), name: row.name.trim() }))
        .filter((row) => /^[A-Z0-9]{2}$/.test(row.code)),
    };
  });
}

/**
 * List assignments, including pairs whose source definition was later deactivated,
 * so maintainers can inspect and remove an unused pair without hiding its history.
 */
export async function listSalesOrgDivisionAssignments(client: string) {
  const parsedClient = tenantKeySchema.safeParse(client);
  if (!parsedClient.success) {
    throw new SalesOrgDivisionAssignmentError(
      'The current tenant key is invalid.',
      'Sign in to a valid tenant and reload the assignments.',
    );
  }

  return withTenant(parsedClient.data, (tx) =>
    tx
      .select({
        salesOrg: salesOrgDivision.salesOrg,
        salesOrgActive: salesOrg.isActive,
        division: salesOrgDivision.division,
        divisionName: divisionDefinition.name,
        divisionActive: divisionDefinition.isActive,
        createdAt: salesOrgDivision.createdAt,
      })
      .from(salesOrgDivision)
      .innerJoin(salesOrg, and(
        eq(salesOrg.client, salesOrgDivision.client),
        eq(salesOrg.salesOrg, salesOrgDivision.salesOrg),
      ))
      .innerJoin(divisionDefinition, and(
        eq(divisionDefinition.client, salesOrgDivision.client),
        eq(divisionDefinition.division, salesOrgDivision.division),
      ))
      .where(eq(salesOrgDivision.client, parsedClient.data))
      .orderBy(asc(salesOrgDivision.salesOrg), asc(salesOrgDivision.division)),
  );
}

/** Tenant-scoped OVXA assignment. Repeating an existing active pair is an idempotent no-op. */
export async function assignSalesOrgDivision(raw: SalesOrgDivisionAssignmentInput) {
  const parsed = salesOrgDivisionAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SalesOrgDivisionAssignmentError(
      parsed.error.issues[0]?.message ?? 'The Sales Organization / Division pair is invalid.',
      'Choose an active Sales Organization and Division from F4, then submit again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    await lockSalesOrgDivisionPair(tx, client, values.salesOrg, values.division);

    // Lock both source definitions while checking active state so deactivation cannot
    // pass a usage check before this new pair is committed.
    const [organisation] = await tx
      .select({ isActive: salesOrg.isActive })
      .from(salesOrg)
      .where(and(eq(salesOrg.client, client), eq(salesOrg.salesOrg, values.salesOrg)))
      .for('update');
    if (!organisation) {
      throw new SalesOrgDivisionAssignmentError(
        `Sales Organization ${values.salesOrg} does not exist in this tenant.`,
        'Define the Sales Organization first through OVX5.',
      );
    }
    if (!organisation.isActive) {
      throw new SalesOrgDivisionAssignmentError(
        `Sales Organization ${values.salesOrg} is inactive.`,
        'Activate the Sales Organization before assigning a Division.',
      );
    }

    const [division] = await tx
      .select({ isActive: divisionDefinition.isActive })
      .from(divisionDefinition)
      .where(and(
        eq(divisionDefinition.client, client),
        eq(divisionDefinition.division, values.division),
      ))
      .for('update');
    if (!division) {
      throw new SalesOrgDivisionAssignmentError(
        `Division ${values.division} does not exist in this tenant.`,
        'Define the Division first through OVXB.',
      );
    }
    if (!division.isActive) {
      throw new SalesOrgDivisionAssignmentError(
        `Division ${values.division} is inactive.`,
        'Activate the Division before assigning it to a Sales Organization.',
      );
    }

    await requireDefinitionPrerequisites(tx, client);

    // Validate active definitions and completed prerequisite activities even when
    // the same pair already exists; the duplicate itself remains a no-op.
    const [existing] = await tx
      .select({ salesOrg: salesOrgDivision.salesOrg })
      .from(salesOrgDivision)
      .where(and(
        eq(salesOrgDivision.client, client),
        eq(salesOrgDivision.salesOrg, values.salesOrg),
        eq(salesOrgDivision.division, values.division),
      ))
      .limit(1);
    if (existing) {
      await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
      return {
        assigned: false as const,
        salesOrg: values.salesOrg,
        division: values.division,
      };
    }

    const [created] = await tx
      .insert(salesOrgDivision)
      .values({
        client,
        salesOrg: values.salesOrg,
        division: values.division,
        createdBy: changedBy,
      })
      .onConflictDoNothing()
      .returning({ salesOrg: salesOrgDivision.salesOrg });

    // The transaction lock normally makes this branch unreachable; keep the
    // composite unique key as the final concurrency backstop.
    if (!created) {
      await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
      return {
        assigned: false as const,
        salesOrg: values.salesOrg,
        division: values.division,
      };
    }

    const changeId = await recordChange(tx, {
      client,
      objectClass: 'sales_org_division',
      objectKey: `${values.salesOrg}/${values.division}`,
      changeType: 'CREATE',
      changedBy,
      transactionCode: ASSIGNMENT_ACTIVITY,
      after: {
        salesOrg: values.salesOrg,
        division: values.division,
      },
      securityRelevantFields: ['salesOrg', 'division'],
      fieldLabels: {
        salesOrg: 'Sales Organization',
        division: 'Division',
      },
    });
    if (!changeId) {
      throw new SalesOrgDivisionAssignmentError(
        'The assignment could not be recorded in change history.',
        'Retry the assignment. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
    return {
      assigned: true as const,
      salesOrg: values.salesOrg,
      division: values.division,
    };
  });
}

/** Remove an unused pair while preserving its full change-document history. */
export async function unassignSalesOrgDivision(raw: SalesOrgDivisionAssignmentInput) {
  const parsed = salesOrgDivisionAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SalesOrgDivisionAssignmentError(
      parsed.error.issues[0]?.message ?? 'The Sales Organization / Division pair is invalid.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    await lockSalesOrgDivisionPair(tx, client, values.salesOrg, values.division);

    const [existing] = await tx
      .select({
        salesOrg: salesOrgDivision.salesOrg,
        division: salesOrgDivision.division,
      })
      .from(salesOrgDivision)
      .where(and(
        eq(salesOrgDivision.client, client),
        eq(salesOrgDivision.salesOrg, values.salesOrg),
        eq(salesOrgDivision.division, values.division),
      ))
      .for('update');
    if (!existing) {
      throw new SalesOrgDivisionAssignmentError(
        `Division ${values.division} is not assigned to Sales Organization ${values.salesOrg}.`,
        'Reload the current assignment list before removing a pair.',
      );
    }

    // Any Sales Area dependency blocks removal, irrespective of its channel or active state.
    const [dependentArea] = await tx
      .select({ distributionChannel: salesArea.distributionChannel })
      .from(salesArea)
      .where(and(
        eq(salesArea.client, client),
        eq(salesArea.salesOrg, values.salesOrg),
        eq(salesArea.division, values.division),
      ))
      .limit(1);
    if (dependentArea) {
      throw new SalesOrgDivisionAssignmentError(
        `Division ${values.division} cannot be removed from Sales Organization ${values.salesOrg} while a Sales Area uses the pair.`,
        'Remove or change every dependent Sales Area through its own configuration activity first.',
      );
    }

    const [removed] = await tx
      .delete(salesOrgDivision)
      .where(and(
        eq(salesOrgDivision.client, client),
        eq(salesOrgDivision.salesOrg, values.salesOrg),
        eq(salesOrgDivision.division, values.division),
      ))
      .returning({ salesOrg: salesOrgDivision.salesOrg });
    if (!removed) {
      throw new SalesOrgDivisionAssignmentError(
        `Sales Organization ${values.salesOrg} / Division ${values.division} changed while the assignment was being removed.`,
        'Reload the current assignment list before trying again.',
      );
    }

    const changeId = await recordChange(tx, {
      client,
      objectClass: 'sales_org_division',
      objectKey: `${values.salesOrg}/${values.division}`,
      changeType: 'DELETE',
      changedBy,
      transactionCode: ASSIGNMENT_ACTIVITY,
      before: {
        salesOrg: existing.salesOrg,
        division: existing.division,
      },
      securityRelevantFields: ['salesOrg', 'division'],
      fieldLabels: {
        salesOrg: 'Sales Organization',
        division: 'Division',
      },
    });
    if (!changeId) {
      throw new SalesOrgDivisionAssignmentError(
        'The assignment removal could not be recorded in change history.',
        'Retry the removal. If the problem continues, contact an administrator.',
      );
    }

    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
    return {
      removed: true as const,
      salesOrg: values.salesOrg,
      division: values.division,
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
    throw new SalesOrgDivisionAssignmentError(
      `OVXA prerequisites are incomplete: ${missing.join(', ')}.`,
      'Complete Sales Organization and Division definition in the configuration workbench first.',
    );
  }
}
