/** Protected initial CoA assignment — SCR-013 / CAIRN.md §6.2. */
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { chartOfAccounts, companyCode } from './schema';

const ASSIGNMENT_ACTIVITY = 'CFG.ORG.COMPANYCODE.ASSIGN_COA';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.FIN.COA.DEFINE'] as const;

/** Values accepted for the one-time, initial Company Code → CoA assignment. */
export const companyCodeCoaAssignmentValuesSchema = z.object({
  companyCode: z.string().trim().min(1).max(10),
  chartOfAccounts: z.string().trim().min(1).max(8),
});

/** Tenant and actor are service inputs; the protected server action supplies them from its session. */
export const companyCodeCoaAssignmentInputSchema = companyCodeCoaAssignmentValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type CompanyCodeCoaAssignmentInput = z.input<typeof companyCodeCoaAssignmentInputSchema>;

export class CompanyCodeCoaAssignmentError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Company Code and chart of accounts, then try again.',
  ) {
    super(message);
    this.name = 'CompanyCodeCoaAssignmentError';
  }
}

/**
 * Assigns an existing active CoA to a Company Code that has no CoA yet.
 * Repeating the same assignment is idempotent; replacing a different existing
 * assignment is refused until reassignment semantics are separately approved.
 */
export async function assignCompanyCodeCoa(raw: CompanyCodeCoaAssignmentInput) {
  const parsed = companyCodeCoaAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CompanyCodeCoaAssignmentError(
      parsed.error.issues[0]?.message ?? 'Company Code chart assignment is invalid.',
      'Correct the indicated value and submit the assignment again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    // Serialize simultaneous attempts before locking and inspecting the target row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/company_code_coa/${values.companyCode}`}, 0))`,
    );

    const [current] = await tx
      .select()
      .from(companyCode)
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, values.companyCode)))
      .for('update');
    if (!current) {
      throw new CompanyCodeCoaAssignmentError(
        `Company code ${values.companyCode} does not exist in this tenant.`,
        'Define the Company Code first (CFG.ORG.COMPANYCODE.DEFINE).',
      );
    }

    const completedPrerequisites = await tx
      .select({ activityCode: configActivityStatus.activityCode })
      .from(configActivityStatus)
      .where(
        and(
          eq(configActivityStatus.client, client),
          inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
          eq(configActivityStatus.status, 'COMPLETED'),
        ),
      );
    const completed = new Set(completedPrerequisites.map((row) => row.activityCode));
    const missing = PREREQUISITES.filter((code) => !completed.has(code));
    if (missing.length > 0) {
      throw new CompanyCodeCoaAssignmentError(
        `Chart-of-accounts assignment prerequisites are incomplete: ${missing.join(', ')}.`,
        'Complete Company Code definition and chart-of-accounts definition in the configuration workbench first.',
      );
    }

    if (current.chartOfAccounts !== null) {
      if (current.chartOfAccounts === values.chartOfAccounts) {
        await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
        return {
          assigned: false as const,
          companyCode: values.companyCode,
          chartOfAccounts: values.chartOfAccounts,
        };
      }
      throw new CompanyCodeCoaAssignmentError(
        `Company code ${values.companyCode} already has chart of accounts ${current.chartOfAccounts} assigned.`,
        'This initial assignment action does not replace an existing chart of accounts.',
      );
    }

    const [chart] = await tx
      .select({ chartOfAccounts: chartOfAccounts.chartOfAccounts })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.client, client),
          eq(chartOfAccounts.chartOfAccounts, values.chartOfAccounts),
          eq(chartOfAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (!chart) {
      throw new CompanyCodeCoaAssignmentError(
        `Active chart of accounts ${values.chartOfAccounts} is not defined in this tenant.`,
        'Define and activate the chart of accounts first (CFG.FIN.COA.DEFINE).',
      );
    }

    const [updated] = await tx
      .update(companyCode)
      .set({
        chartOfAccounts: values.chartOfAccounts,
        changedBy,
        changedAt: new Date(),
      })
      .where(
        and(
          eq(companyCode.client, client),
          eq(companyCode.companyCode, values.companyCode),
          isNull(companyCode.chartOfAccounts),
        ),
      )
      .returning({ chartOfAccounts: companyCode.chartOfAccounts });
    if (!updated) {
      throw new CompanyCodeCoaAssignmentError(
        `Company code ${values.companyCode} changed while the assignment was being saved.`,
        'Reload the Company Code and review its current assignment before trying again.',
      );
    }

    await recordChange(tx, {
      client,
      objectClass: 'company_code',
      objectKey: values.companyCode,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ASSIGNMENT_ACTIVITY,
      before: { chartOfAccounts: null },
      after: { chartOfAccounts: values.chartOfAccounts },
      securityRelevantFields: ['chartOfAccounts'],
    });
    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);

    return {
      assigned: true as const,
      companyCode: values.companyCode,
      chartOfAccounts: values.chartOfAccounts,
    };
  });
}
