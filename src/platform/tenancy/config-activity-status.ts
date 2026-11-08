/**
 * What the configuration workbench reports, taken from the configuration itself.
 *
 * An activity stands completed because something marked it: the onboarding wizard,
 * the standard package, one of eighty configuration services. That works until the
 * rows are written by something that marks nothing — a package, a structure build,
 * a data load — and then the workbench asks for work that is already sitting in the
 * tenant. The workbench is the plan an implementation follows, so a step that says
 * "not started" over a full table is worse than no plan at all.
 *
 * There is a second failure with no symptoms at all: `markActivityComplete` is an
 * update, so on a tenant whose status row does not exist it marks nothing and says
 * nothing. Rows are created from the catalogue when the tenant is created, so a
 * tenant older than the catalogue carries gaps that nothing ever repairs.
 *
 * This module answers both by asking the tenant what it actually holds. Each rule
 * below is evidence, never an inference: a step is complete when the rows the step
 * defines are standing in that tenant. Completing on evidence is one-way — a step
 * marked completed by hand stays completed, whether or not evidence remains,
 * because a configuration can be undone deliberately and this is not the place to
 * decide that it was.
 */

import { sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../db/client';
import { configActivity, configActivityStatus } from '../tables/registry';

/**
 * The rows that evidence each step, keyed by activity. A step with no rule here is
 * left exactly as it stands: abilities and capabilities — maintaining a user,
 * resetting a password, configuring a mail server — are things a tenant can do, not
 * rows it holds, and inventing evidence for them would be a guess dressed as a fact.
 */
const EVIDENCE: Readonly<Record<string, (client: string) => ReturnType<typeof sql.raw> | ReturnType<typeof sql>>> = {
  'CFG.PLT.ROLE.DEFINE': (client) => sql`select 1 from role where client = ${client}`,
  'CFG.PLT.USER.CREATE': (client) => sql`select 1 from app_user where client = ${client}`,
  // The objects themselves are delivered with the tenant: what the step defines, and
  // what the screen maintains, are the intervals standing under them.
  'CFG.PLT.NUMBERRANGE.DEFINE': (client) => sql`select 1 from number_range where client = ${client}`,
  'CFG.ORG.COMPANYCODE.DEFINE': (client) => sql`select 1 from company_code where client = ${client}`,
  'CFG.FIN.COA.DEFINE': (client) => sql`select 1 from chart_of_accounts where client = ${client}`,
  'CFG.FIN.GLACCOUNT.CREATE': (client) => sql`select 1 from gl_account where client = ${client}`,
  'CFG.FIN.FYV.DEFINE': (client) => sql`select 1 from fiscal_year_variant where client = ${client}`,
  'CFG.FIN.PPV.DEFINE': (client) => sql`select 1 from posting_period_variant where client = ${client}`,
  'CFG.FIN.EXRATE.MAINTAIN': (client) => sql`select 1 from exchange_rate where client = ${client}`,
  'CFG.FIN.TAXCODE.DEFINE': (client) => sql`select 1 from tax_code where client = ${client}`,
  'CFG.FIN.HOUSEBANK.DEFINE': (client) => sql`select 1 from house_bank where client = ${client}`,
  'CFG.FIN.PAYTERMS.DEFINE': (client) => sql`select 1 from payment_terms where client = ${client}`,
  'CFG.FIN.PAYMENTMETHOD.DEFINE': (client) => sql`select 1 from payment_method where client = ${client}`,
  'CFG.FIN.DOCTYPE.DEFINE': (client) => sql`select 1 from document_type where client = ${client}`,
  'CFG.FIN.ACCTDET.DEFINE': (client) => sql`select 1 from account_determination where client = ${client}`,
  'CFG.FIN.TOLERANCE.DEFINE': (client) => sql`select 1 from employee_tolerance_group where client = ${client}`,
  'CFG.FIN.CREDIT.DEFINE': (client) => sql`select 1 from credit_control_area where client = ${client}`,
  'CFG.FIN.CCA.MAINTAIN': (client) => sql`select 1 from credit_control_area where client = ${client}`,
  'CFG.ORG.PLANT.DEFINE': (client) => sql`select 1 from plant where client = ${client}`,
  'CFG.ORG.STORAGELOC.DEFINE': (client) => sql`select 1 from storage_location where client = ${client}`,
  'CFG.ORG.SALESORG.DEFINE': (client) => sql`select 1 from sales_org where client = ${client}`,
  'CFG.ORG.DISTCHANNEL.DEFINE': (client) => sql`select 1 from distribution_channel where client = ${client}`,
  'CFG.ORG.DIVISION.DEFINE': (client) => sql`select 1 from division where client = ${client}`,
  'CFG.ORG.SALESAREA.DEFINE': (client) => sql`select 1 from sales_area where client = ${client}`,
  'CFG.ORG.INDUSTRY.DEFINE': (client) => sql`select 1 from industry where client = ${client}`,
  'CFG.PROC.PURORG.DEFINE': (client) => sql`select 1 from purchasing_org where client = ${client}`,
  'CFG.PROC.PURGROUP.DEFINE': (client) => sql`select 1 from purchasing_group where client = ${client}`,
  'CFG.PROC.RELEASE.DEFINE': (client) => sql`select 1 from release_strategy where client = ${client}`,
  'CFG.SALES.CONDITION.MAINTAIN': (client) => sql`select 1 from sales_condition_record where client = ${client}`,
  'CFG.COST.COSTCENTER.DEFINE': (client) => sql`select 1 from cost_center where client = ${client}`,
  'CFG.COST.COSTCENTERHIER.DEFINE': (client) => sql`select 1 from cost_center_hierarchy where client = ${client}`,
  'CFG.COST.ACTIVITYTYPE.DEFINE': (client) => sql`select 1 from activity_type where client = ${client}`,
  'CFG.COST.ACTIVITYRATE.CONFIRM': (client) => sql`select 1 from activity_rate where client = ${client}`,
  'CFG.COST.PROFITCENTER.DEFINE': (client) => sql`select 1 from profit_center where client = ${client}`,
  'CFG.COST.PROFITCENTERHIER.DEFINE': (client) => sql`select 1 from profit_center_hierarchy where client = ${client}`,
  'CFG.COST.SETTLEMENT.DEFINE': (client) => sql`select 1 from settlement_profile where client = ${client}`,
  'CFG.INV.MATERIALTYPE.DEFINE': (client) => sql`select 1 from material_type where client = ${client}`,
  'CFG.INV.VALCLASS.DEFINE': (client) => sql`select 1 from valuation_class where client = ${client}`,
  'CFG.INV.MATERIALGROUP.DEFINE': (client) => sql`select 1 from material_group where client = ${client}`,
  'CFG.INV.INDUSTRYSECTOR.DEFINE': (client) => sql`select 1 from industry_sector where client = ${client}`,
  'CFG.INV.MATERIALRANGE.DEFINE': (client) => sql`select 1 from number_range where client = ${client} and object_code = 'MATERIALNR'`,
  'CFG.INV.MATPERIOD.DEFINE': (client) => sql`select 1 from material_period_control where client = ${client}`,
  // The two returns movements are delivered with every tenant by the standard package (9237), so they
  // are not evidence that anybody configured the catalogue: without this exclusion, a tenant would
  // report its movement types configured on the strength of two rows it never chose. The codes are the
  // ones `sales/returns.ts:DELIVERED_RETURNS_MOVEMENTS` carries.
  'CFG.INV.MOVETYPE.CONFIG': (client) => sql`select 1 from movement_type
     where client = ${client} and movement_type not in ('RETURNS_RECEIPT', 'RETURNS_RECEIPT_REV')`,
  'CFG.INV.BATCHNUMBER.DEFINE': (client) => sql`select 1 from batch_number_assignment where client = ${client}`,
  'CFG.INV.BATCHSTATUS.DEFINE': (client) => sql`select 1 from batch_status_management where client = ${client}`,
  'CFG.PROC.CHARACTERISTIC.DEFINE': (client) => sql`select 1 from characteristic where client = ${client}`,
  'CFG.PROC.CLASS.DEFINE': (client) => sql`select 1 from classification_class where client = ${client}`,
  'CFG.PROD.WORKCENTER.DEFINE': (client) => sql`select 1 from work_center where client = ${client}`,
  'CFG.PROD.BOM.DEFINE': (client) => sql`select 1 from material_bom where client = ${client}`,
  'CFG.PROD.ROUTING.DEFINE': (client) => sql`select 1 from routing where client = ${client}`,
  'CFG.PROD.VERSION.DEFINE': (client) => sql`select 1 from production_version where client = ${client}`,
  'CFG.PROD.ORDERTYPE.DEFINE': (client) => sql`select 1 from production_order_type where client = ${client}`,
  'CFG.PROD.ORDERPARAM.DEFINE': (client) => sql`select 1 from production_order_type_parameter where client = ${client}`,
  'CFG.PEOPLE.RECORDTYPE.DEFINE': (client) => sql`select 1 from record_type where client = ${client}`,
  'CFG.PEOPLE.PAYCOMPONENT.DEFINE': (client) => sql`select 1 from pay_component where client = ${client}`,
};

export interface RecomputeResult {
  /** Steps in the catalogue. */
  activities: number;
  /** Status rows that were missing and are now standing. */
  rowsCreated: number;
  /** Steps this run marked complete because the tenant holds what they define. */
  completedNow: number;
  /** Steps already standing complete before this run. */
  alreadyComplete: number;
}

/**
 * Bring one tenant's workbench back into agreement with its own configuration.
 *
 * Runs inside a caller's transaction when one is given, so tenant creation can
 * settle its checklist in the same commit that writes the rows. Steps are never
 * un-completed, and the catalogue is never written to: this reads the configuration
 * and reports on it, it does not define anything.
 */
export async function recomputeActivityStatus(input: {
  client: string;
  by: string;
  tx?: Tx;
}): Promise<RecomputeResult> {
  const work = async (tx: Tx): Promise<RecomputeResult> => {
    const catalogue = await tx.select({ code: configActivity.code }).from(configActivity);
    const standing = await tx
      .select({ activityCode: configActivityStatus.activityCode, status: configActivityStatus.status })
      .from(configActivityStatus)
      .where(sql`${configActivityStatus.client} = ${input.client}`);
    const statusOf = new Map(standing.map((row) => [row.activityCode, row.status]));

    let rowsCreated = 0;
    for (const activity of catalogue) {
      if (statusOf.has(activity.code)) continue;
      await tx
        .insert(configActivityStatus)
        .values({ client: input.client, activityCode: activity.code, status: 'NOT_STARTED', createdBy: input.by })
        .onConflictDoNothing();
      statusOf.set(activity.code, 'NOT_STARTED');
      rowsCreated += 1;
    }

    let completedNow = 0;
    let alreadyComplete = 0;
    for (const activity of catalogue) {
      if (statusOf.get(activity.code) === 'COMPLETED') {
        alreadyComplete += 1;
        continue;
      }
      const evidence = EVIDENCE[activity.code];
      if (!evidence) continue;
      const rows = await tx.execute(sql`select 1 as found where exists (${evidence(input.client)})`);
      const held = Array.isArray(rows) ? rows.length > 0 : Boolean((rows as { rowCount?: number }).rowCount);
      if (!held) continue;
      await tx
        .update(configActivityStatus)
        .set({ status: 'COMPLETED', completedAt: new Date(), completedBy: input.by, changedBy: input.by, changedAt: new Date() })
        .where(sql`${configActivityStatus.client} = ${input.client} and ${configActivityStatus.activityCode} = ${activity.code}`);
      completedNow += 1;
    }

    return { activities: catalogue.length, rowsCreated, completedNow, alreadyComplete };
  };

  return input.tx ? await work(input.tx) : await withTenant(input.client, work);
}
