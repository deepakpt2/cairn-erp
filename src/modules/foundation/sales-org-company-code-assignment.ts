/** Protected initial Sales Organization -> Company Code assignment — SCR-021 / D-098 (OVX3). */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { companyCode, salesOrg } from './schema';

const ASSIGNMENT_ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_COMPANY';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.ORG.SALESORG.DEFINE'] as const;

/** Only the Sales Organization and its destination Company Code are assignment inputs (OVX3). */
export const salesOrgCompanyCodeAssignmentValuesSchema = z.object({
  salesOrg: z.string().trim().regex(/^[A-Z0-9]{4}$/, 'Sales Organization must be four uppercase alphanumeric characters.'),
  companyCode: z.string().trim().regex(/^[A-Z0-9]{4}$/, 'Company Code must be four uppercase alphanumeric characters.'),
});

/** Tenant and actor are service inputs only; the protected action derives them from the session. */
export const salesOrgCompanyCodeAssignmentInputSchema = salesOrgCompanyCodeAssignmentValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type SalesOrgCompanyCodeAssignmentInput = z.input<typeof salesOrgCompanyCodeAssignmentInputSchema>;

export class SalesOrgCompanyCodeAssignmentError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Sales Organization and Company Code, then try the assignment again.',
  ) {
    super(message);
    this.name = 'SalesOrgCompanyCodeAssignmentError';
  }
}

/**
 * Assigns one active tenant Company Code to an active Sales Organization (OVX3).
 * A Sales Organization can hold only one Company Code at a time; repeating the same
 * assignment is idempotent, replacement records an audited change, and clearing is not
 * part of this activity (owner-confirmed SCR-021 rule, 2026-10-14).
 */
export async function assignSalesOrgCompanyCode(raw: SalesOrgCompanyCodeAssignmentInput) {
  const parsed = salesOrgCompanyCodeAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SalesOrgCompanyCodeAssignmentError(
      parsed.error.issues[0]?.message ?? 'Sales Organization Company Code assignment is invalid.',
      'Correct the indicated Sales Organization or Company Code and submit the assignment again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    // Serialize competing first assignments, then lock the organisation row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/sales_org_company_code/${values.salesOrg}`}, 0))`,
    );

    const [current] = await tx
      .select({
        salesOrg: salesOrg.salesOrg,
        companyCode: salesOrg.companyCode,
        isActive: salesOrg.isActive,
      })
      .from(salesOrg)
      .where(and(
        eq(salesOrg.client, client),
        eq(salesOrg.salesOrg, values.salesOrg),
      ))
      .for('update');
    if (!current) {
      throw new SalesOrgCompanyCodeAssignmentError(
        `Sales Organization ${values.salesOrg} does not exist in this tenant.`,
        'Define the Sales Organization first (CFG.ORG.SALESORG.DEFINE).',
      );
    }
    if (!current.isActive) {
      throw new SalesOrgCompanyCodeAssignmentError(
        `Sales Organization ${values.salesOrg} is inactive.`,
        'Only an active Sales Organization can receive or change its Company Code assignment.',
      );
    }

    const completedPrerequisites = await tx
      .select({ activityCode: configActivityStatus.activityCode })
      .from(configActivityStatus)
      .where(and(
        eq(configActivityStatus.client, client),
        inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
        eq(configActivityStatus.status, 'COMPLETED'),
      ));
    const completed = new Set(completedPrerequisites.map((row) => row.activityCode));
    const missing = PREREQUISITES.filter((code) => !completed.has(code));
    if (missing.length > 0) {
      throw new SalesOrgCompanyCodeAssignmentError(
        `Sales Organization Company Code assignment prerequisites are incomplete: ${missing.join(', ')}.`,
        'Complete Company Code and Sales Organization definition in the configuration workbench first.',
      );
    }

    if (current.companyCode === values.companyCode) {
      await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
      return {
        assigned: false as const,
        reassigned: false as const,
        salesOrg: values.salesOrg,
        companyCode: values.companyCode,
      };
    }

    const [destination] = await tx
      .select({ companyCode: companyCode.companyCode })
      .from(companyCode)
      .where(and(
        eq(companyCode.client, client),
        eq(companyCode.companyCode, values.companyCode),
        eq(companyCode.isActive, true),
      ))
      .limit(1);
    if (!destination) {
      throw new SalesOrgCompanyCodeAssignmentError(
        `Active Company Code ${values.companyCode} is not defined in this tenant.`,
        'Define and activate the Company Code first (CFG.ORG.COMPANYCODE.DEFINE).',
      );
    }

    const previousCompanyCode = current.companyCode;
    const [updated] = await tx
      .update(salesOrg)
      .set({ companyCode: values.companyCode, changedBy, changedAt: new Date() })
      .where(and(
        eq(salesOrg.client, client),
        eq(salesOrg.salesOrg, values.salesOrg),
        previousCompanyCode === null
          ? isNull(salesOrg.companyCode)
          : eq(salesOrg.companyCode, previousCompanyCode),
        eq(salesOrg.isActive, true),
      ))
      .returning({ companyCode: salesOrg.companyCode });
    if (!updated) {
      throw new SalesOrgCompanyCodeAssignmentError(
        `Sales Organization ${values.salesOrg} changed while the assignment was being saved.`,
        'Reload the current assignment before trying again.',
      );
    }

    await recordChange(tx, {
      client,
      objectClass: 'sales_org',
      objectKey: values.salesOrg,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ASSIGNMENT_ACTIVITY,
      before: { companyCode: previousCompanyCode },
      after: { companyCode: values.companyCode },
      securityRelevantFields: ['companyCode'],
      fieldLabels: { companyCode: 'Company Code' },
    });
    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);

    return {
      assigned: true as const,
      reassigned: previousCompanyCode !== null,
      salesOrg: values.salesOrg,
      companyCode: values.companyCode,
    };
  });
}
