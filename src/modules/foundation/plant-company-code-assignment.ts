/** Protected initial Plant → Company Code assignment — SCR-015 / D-090. */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { companyCode, plant } from './schema';

const ASSIGNMENT_ACTIVITY = 'CFG.ORG.PLANT.ASSIGN_COMPANY';
const PREREQUISITES = ['CFG.ORG.PLANT.DEFINE'] as const;

/** Only the Plant and its destination Company Code are assignment inputs. */
export const plantCompanyCodeAssignmentValuesSchema = z.object({
  plant: z.string().trim().min(1).max(10),
  companyCode: z.string().trim().min(1).max(10),
});

/** Tenant and actor are accepted by the service only; the server action derives both from session. */
export const plantCompanyCodeAssignmentInputSchema = plantCompanyCodeAssignmentValuesSchema.extend({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
}).strict();

export type PlantCompanyCodeAssignmentInput = z.input<typeof plantCompanyCodeAssignmentInputSchema>;

export class PlantCompanyCodeAssignmentError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the Plant and Company Code, then try the initial assignment again.',
  ) {
    super(message);
    this.name = 'PlantCompanyCodeAssignmentError';
  }
}

/**
 * Performs the first Company Code assignment for a Plant. Repeating the same
 * assignment is idempotent; replacement and unassignment are deliberately
 * unavailable until the post-full-application-development milestone.
 */
export async function assignPlantCompanyCode(raw: PlantCompanyCodeAssignmentInput) {
  const parsed = plantCompanyCodeAssignmentInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlantCompanyCodeAssignmentError(
      parsed.error.issues[0]?.message ?? 'Plant Company Code assignment is invalid.',
      'Correct the indicated Plant or Company Code and submit the assignment again.',
    );
  }

  const { client, changedBy, ...values } = parsed.data;
  return withTenant(client, async (tx) => {
    // Serialize concurrent submissions, then lock the Plant before inspecting its assignment.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/plant_company_code/${values.plant}`}, 0))`,
    );

    const [current] = await tx
      .select({ plant: plant.plant, companyCode: plant.companyCode })
      .from(plant)
      .where(and(eq(plant.client, client), eq(plant.plant, values.plant)))
      .for('update');
    if (!current) {
      throw new PlantCompanyCodeAssignmentError(
        `Plant ${values.plant} does not exist in this tenant.`,
        'Define the Plant first (CFG.ORG.PLANT.DEFINE).',
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
      throw new PlantCompanyCodeAssignmentError(
        `Plant Company Code assignment prerequisites are incomplete: ${missing.join(', ')}.`,
        'Complete Plant definition in the configuration workbench first.',
      );
    }

    if (current.companyCode !== null) {
      if (current.companyCode === values.companyCode) {
        await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);
        return {
          assigned: false as const,
          plant: values.plant,
          companyCode: values.companyCode,
        };
      }
      throw new PlantCompanyCodeAssignmentError(
        `Plant ${values.plant} is already assigned to Company Code ${current.companyCode}.`,
        'This milestone supports initial assignment only. Reassignment and unassignment are deferred until after full application development.',
      );
    }

    const [destination] = await tx
      .select({ companyCode: companyCode.companyCode })
      .from(companyCode)
      .where(
        and(
          eq(companyCode.client, client),
          eq(companyCode.companyCode, values.companyCode),
          eq(companyCode.isActive, true),
        ),
      )
      .limit(1);
    if (!destination) {
      throw new PlantCompanyCodeAssignmentError(
        `Active Company Code ${values.companyCode} is not defined in this tenant.`,
        'Define and activate the Company Code first (CFG.ORG.COMPANYCODE.DEFINE).',
      );
    }

    const [updated] = await tx
      .update(plant)
      .set({
        companyCode: values.companyCode,
        changedBy,
        changedAt: new Date(),
      })
      .where(
        and(
          eq(plant.client, client),
          eq(plant.plant, values.plant),
          isNull(plant.companyCode),
        ),
      )
      .returning({ companyCode: plant.companyCode });
    if (!updated) {
      throw new PlantCompanyCodeAssignmentError(
        `Plant ${values.plant} changed while the assignment was being saved.`,
        'Reload the Plant and review its current Company Code before trying again.',
      );
    }

    await recordChange(tx, {
      client,
      objectClass: 'plant',
      objectKey: values.plant,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ASSIGNMENT_ACTIVITY,
      before: { companyCode: null },
      after: { companyCode: values.companyCode },
      securityRelevantFields: ['companyCode'],
    });
    await markActivityComplete(tx, client, ASSIGNMENT_ACTIVITY, changedBy);

    return {
      assigned: true as const,
      plant: values.plant,
      companyCode: values.companyCode,
    };
  });
}
