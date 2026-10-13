/** Protected initial Purchasing Organisation -> Company Code assignment — SCR-018 / D-092. */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { companyCode, purchasingOrg } from './schema';

const ASSIGNMENT_ACTIVITY = 'CFG.PROC.PURORG.ASSIGN_COMPANY';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.PROC.PURORG.DEFINE'] as const;

/** Only the Purchasing Organisation and its destination Company Code are assignment inputs. */
export const purchasingOrgCompanyCodeAssignmentValuesSchema = z.object({
  purchasingOrg: z.string().trim().regex(/^[A-Z0-9]{2,10}$/),
  companyCode: z.string().trim().min(1).max(10),
});

/** Tenant and actor are service inputs only; the protected action derives them from the session. */
export const purchasingOrgCompanyCodeAssignmentInputSchema = purchasingOrgCompanyCodeAssignmentValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type PurchasingOrgCompanyCodeAssignmentInput = z.input<typeof purchasingOrgCompanyCodeAssignmentInputSchema>;

export class PurchasingOrgCompanyCodeAssignmentError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Purchasing Organisation and Company Code, then try the assignment again.',
  ) {
    super(message);
    this.name = 'PurchasingOrgCompanyCodeAssignmentError';
  }
}

/**
 * Assigns one active tenant Company Code to a pending Purchasing Organisation.
 * Repeating that same assignment is idempotent. Replacement and unassignment
 * are deliberately outside this initial-assignment slice.
 */
export async function assignPurchasingOrgCompanyCode(raw: PurchasingOrgCompanyCodeAssignmentInput) {
  const parsed = purchasingOrgCompanyCodeAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PurchasingOrgCompanyCodeAssignmentError(
      parsed.error.issues[0]?.message ?? 'Purchasing Organisation Company Code assignment is invalid.',
      'Correct the indicated Purchasing Organisation or Company Code and submit the assignment again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    // Serialize competing first assignments, then lock the organisation row.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/purchasing_org_company_code/${values.purchasingOrg}`}, 0))`,
    );

    const [current] = await tx
      .select({
        purchasingOrg: purchasingOrg.purchasingOrg,
        companyCode: purchasingOrg.companyCode,
        isActive: purchasingOrg.isActive,
      })
      .from(purchasingOrg)
      .where(and(
        eq(purchasingOrg.client, client),
        eq(purchasingOrg.purchasingOrg, values.purchasingOrg),
      ))
      .for('update');
    if (!current) {
      throw new PurchasingOrgCompanyCodeAssignmentError(
        `Purchasing Organisation ${values.purchasingOrg} does not exist in this tenant.`,
        'Define the Purchasing Organisation first (CFG.PROC.PURORG.DEFINE).',
      );
    }
    if (!current.isActive) {
      throw new PurchasingOrgCompanyCodeAssignmentError(
        `Purchasing Organisation ${values.purchasingOrg} is inactive.`,
        'Only an active Purchasing Organisation can receive its initial Company Code assignment.',
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
      throw new PurchasingOrgCompanyCodeAssignmentError(
        `Purchasing Organisation Company Code assignment prerequisites are incomplete: ${missing.join(', ')}.`,
        'Complete Company Code and Purchasing Organisation definition in the configuration workbench first.',
      );
    }

    if (current.companyCode !== null) {
      if (current.companyCode === values.companyCode) {
        await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
        return {
          assigned: false as const,
          purchasingOrg: values.purchasingOrg,
          companyCode: values.companyCode,
        };
      }
      throw new PurchasingOrgCompanyCodeAssignmentError(
        `Purchasing Organisation ${values.purchasingOrg} is already assigned to Company Code ${current.companyCode}.`,
        'This initial-assignment activity cannot replace or clear an existing Company Code assignment.',
      );
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
      throw new PurchasingOrgCompanyCodeAssignmentError(
        `Active Company Code ${values.companyCode} is not defined in this tenant.`,
        'Define and activate the Company Code first (CFG.ORG.COMPANYCODE.DEFINE).',
      );
    }

    const [updated] = await tx
      .update(purchasingOrg)
      .set({ companyCode: values.companyCode, changedBy, changedAt: new Date() })
      .where(and(
        eq(purchasingOrg.client, client),
        eq(purchasingOrg.purchasingOrg, values.purchasingOrg),
        isNull(purchasingOrg.companyCode),
        eq(purchasingOrg.isActive, true),
      ))
      .returning({ companyCode: purchasingOrg.companyCode });
    if (!updated) {
      throw new PurchasingOrgCompanyCodeAssignmentError(
        `Purchasing Organisation ${values.purchasingOrg} changed while the assignment was being saved.`,
        'Reload the current assignment before trying again.',
      );
    }

    await recordChange(tx, {
      client,
      objectClass: 'purchasing_org',
      objectKey: values.purchasingOrg,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ASSIGNMENT_ACTIVITY,
      before: { companyCode: null },
      after: { companyCode: values.companyCode },
      securityRelevantFields: ['companyCode'],
      fieldLabels: { companyCode: 'Company Code' },
    });
    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);

    return {
      assigned: true as const,
      purchasingOrg: values.purchasingOrg,
      companyCode: values.companyCode,
    };
  });
}
