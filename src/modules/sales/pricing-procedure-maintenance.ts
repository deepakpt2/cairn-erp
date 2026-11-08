/**
 * Maintaining the pricing procedure.
 *
 * Since 9238 the condition technique is configuration: a master of condition types, a procedure of
 * ordered steps, and a determination that decides which procedure answers for a sales area, a document
 * and a customer. None of it could be written except by a migration, so a tenant who wanted a discount
 * step at a different point in the arithmetic still needed a deployment — the thing the condition
 * technique exists to end.
 *
 * What is maintained here is deliberately the whole of each row and no more, and there is no delete
 * anywhere in it. A step is withdrawn rather than removed, because a step is part of the rule a document
 * was priced by, and a document read years from now must still be able to say what priced it; the
 * application role is granted no DELETE on any of these tables to break that with.
 *
 * Three refusals carry the substance of the screen:
 *
 * A step whose span does not close is refused — a percentage step that names no span has nothing to be
 * calculated on, and discovering that at the moment a customer is being invoiced is the worst possible
 * time to discover it.
 *
 * A step at the header is refused for a condition type whose rate is read from a material, because a
 * header condition names no material to read it from.
 *
 * And a condition type that stands in a procedure, or has records maintained under it, is not withdrawn:
 * a procedure that quietly loses a step prices every future document differently, and nobody would be
 * told which rule had changed.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  salesConditionRecord, salesConditionType, salesPricingProcedure, salesPricingProcedureStep,
  salesProcedureDetermination,
} from './schema';
import { PRICING_PROCEDURE_ROUTE } from './pricing-procedure';

export const PRICING_DEFINE_CAPABILITY = 'CFG.SALES.PRICING.DEFINE';
export const PRICING_PROCEDURE_OBJECT_CLASS = 'sales_pricing_procedure';
export const CONDITION_TYPE_OBJECT_CLASS = 'sales_condition_type';
export const DETERMINATION_OBJECT_CLASS = 'sales_procedure_determination';

export const CONDITION_CLASSES = ['PRICE', 'DISCOUNT', 'FREIGHT', 'TAX', 'COST'] as const;
export const CALCULATION_TYPES = ['FIXED', 'PERCENTAGE', 'MATERIAL_COST'] as const;
export const CONDITION_LEVELS = ['ITEM', 'HEADER'] as const;

const CODE = /^[A-Z0-9]{1,6}$/;
const TYPE_CODE = /^[A-Z0-9]{4}$/;
const AREA_CODE = /^[A-Z0-9]{0,4}$/;

export class PricingProcedureMaintenanceError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PricingProcedureMaintenanceError';
    this.remedy = remedy;
  }
}

export interface ConditionTypeRow {
  conditionType: string;
  name: string;
  conditionClass: string;
  calculationType: string;
  isNegative: boolean;
  isStatistical: boolean;
  accountKey: string | null;
  isActive: boolean;
  /** How many condition records stand under this type — what a withdrawal would leave unreadable. */
  recordsStanding: number;
  /** How many procedure steps of this type stand. */
  stepsStanding: number;
}

export interface ProcedureStepRow {
  stepNumber: number;
  conditionType: string;
  conditionTypeName: string;
  conditionClass: string;
  calculationType: string;
  fromStep: number | null;
  toStep: number | null;
  isRequired: boolean;
  conditionLevel: string;
  isActive: boolean;
}

export interface ProcedureRow {
  procedureCode: string;
  name: string;
  isActive: boolean;
  steps: ProcedureStepRow[];
  /** How many documents have been priced by this procedure, over orders and billing documents. */
  documentsStanding: number;
}

export interface DeterminationRow {
  salesOrg: string;
  distributionChannel: string;
  division: string;
  documentPricingProcedure: string;
  customerPricingProcedure: string;
  procedureCode: string;
  /** Whether the sales area the row names stands, blank meaning every area. */
  areaStands: boolean;
}

export interface PricingConfiguration {
  types: ConditionTypeRow[];
  procedures: ProcedureRow[];
  determinations: DeterminationRow[];
}

/** What the screen reads: the whole of the pricing configuration, as it stands for this tenant. */
export async function listPricingConfiguration(client: string): Promise<PricingConfiguration> {
  return withTenant(client, async (tx) => {
    const types = await listConditionTypes(tx, client);
    const procedures = await listProcedures(tx, client);
    const determinations = await listDeterminations(tx, client);
    return { types, procedures, determinations };
  });
}

async function listConditionTypes(tx: Tx, client: string): Promise<ConditionTypeRow[]> {
  const rows = await tx.execute(sql`
    select t.condition_type, t.name, t.condition_class, t.calculation_type, t.is_negative,
           t.is_statistical, t.account_key, t.is_active,
           (select count(*) from sales_condition_record r
             where r.client = t.client and r.condition_type = t.condition_type) as records_standing,
           (select count(*) from sales_pricing_procedure_step s
             where s.client = t.client and s.condition_type = t.condition_type and s.is_active)
             as steps_standing
      from sales_condition_type t
     where t.client = ${client}
     order by t.condition_type
  `) as unknown as Array<{
    condition_type: string; name: string; condition_class: string; calculation_type: string;
    is_negative: boolean; is_statistical: boolean; account_key: string | null; is_active: boolean;
    records_standing: string | number; steps_standing: string | number;
  }>;
  return rows.map((row) => ({
    conditionType: row.condition_type,
    name: row.name,
    conditionClass: row.condition_class,
    calculationType: row.calculation_type,
    isNegative: row.is_negative,
    isStatistical: row.is_statistical,
    accountKey: row.account_key,
    isActive: row.is_active,
    recordsStanding: Number(row.records_standing),
    stepsStanding: Number(row.steps_standing),
  }));
}

async function listProcedures(tx: Tx, client: string): Promise<ProcedureRow[]> {
  const procedures = await tx.select().from(salesPricingProcedure)
    .where(eq(salesPricingProcedure.client, client))
    .orderBy(asc(salesPricingProcedure.procedureCode));
  const steps = await tx.select({
    procedureCode: salesPricingProcedureStep.procedureCode,
    stepNumber: salesPricingProcedureStep.stepNumber,
    conditionType: salesPricingProcedureStep.conditionType,
    conditionTypeName: salesConditionType.name,
    conditionClass: salesConditionType.conditionClass,
    calculationType: salesConditionType.calculationType,
    fromStep: salesPricingProcedureStep.fromStep,
    toStep: salesPricingProcedureStep.toStep,
    isRequired: salesPricingProcedureStep.isRequired,
    conditionLevel: salesPricingProcedureStep.conditionLevel,
    isActive: salesPricingProcedureStep.isActive,
  }).from(salesPricingProcedureStep)
    .innerJoin(salesConditionType, and(
      eq(salesConditionType.client, salesPricingProcedureStep.client),
      eq(salesConditionType.conditionType, salesPricingProcedureStep.conditionType),
    ))
    .where(eq(salesPricingProcedureStep.client, client))
    .orderBy(asc(salesPricingProcedureStep.procedureCode), asc(salesPricingProcedureStep.stepNumber));

  return Promise.all(procedures.map(async (procedure) => {
    const [priced] = await tx.execute(sql`
      select (select count(*) from sales_document_condition c
               where c.client = ${client} and c.document_category = 'ORDER'
                 and c.document_number in (
                   select o.order_number from sales_order o where o.client = ${client}
                 ))
             + (select count(*) from sales_document_condition c
                 where c.client = ${client} and c.document_category = 'BILLING')
             as documents_standing
    `) as unknown as Array<{ documents_standing: string | number }>;
    return {
      procedureCode: procedure.procedureCode,
      name: procedure.name,
      isActive: procedure.isActive,
      // The withdrawn steps are listed too: a step that has been withdrawn is still part of what the
      // procedure once said, and a reader needs to see it to know why a document was priced as it was.
      steps: steps.filter((step) => step.procedureCode === procedure.procedureCode).map((step) => ({
        stepNumber: step.stepNumber,
        conditionType: step.conditionType,
        conditionTypeName: step.conditionTypeName,
        conditionClass: step.conditionClass,
        calculationType: step.calculationType,
        fromStep: step.fromStep,
        toStep: step.toStep,
        isRequired: step.isRequired,
        conditionLevel: step.conditionLevel,
        isActive: step.isActive,
      })),
      documentsStanding: Number(priced?.documents_standing ?? 0),
    };
  }));
}

async function listDeterminations(tx: Tx, client: string): Promise<DeterminationRow[]> {
  const rows = await tx.execute(sql`
    select d.sales_org, d.distribution_channel, d.division, d.document_pricing_procedure,
           d.customer_pricing_procedure, d.procedure_code,
           d.sales_org = '' or exists (
             select 1 from sales_area a
              where a.client = d.client and a.sales_org = d.sales_org
                and a.distribution_channel = d.distribution_channel and a.division = d.division
           ) as area_stands
      from sales_procedure_determination d
     where d.client = ${client}
     order by d.sales_org, d.distribution_channel, d.division,
              d.document_pricing_procedure, d.customer_pricing_procedure
  `) as unknown as Array<{
    sales_org: string; distribution_channel: string; division: string;
    document_pricing_procedure: string; customer_pricing_procedure: string;
    procedure_code: string; area_stands: boolean;
  }>;
  return rows.map((row) => ({
    salesOrg: row.sales_org,
    distributionChannel: row.distribution_channel,
    division: row.division,
    documentPricingProcedure: row.document_pricing_procedure,
    customerPricingProcedure: row.customer_pricing_procedure,
    procedureCode: row.procedure_code,
    areaStands: row.area_stands,
  }));
}

/**
 * Define a condition type: what a figure on a document means, how it becomes an amount, and the key the
 * ledger account will be determined by.
 */
export async function defineConditionType(input: {
  client: string; changedBy: string;
  conditionType: string; name: string; conditionClass: string; calculationType: string;
  isNegative: boolean; isStatistical: boolean; accountKey?: string | null;
}): Promise<{ conditionType: string }> {
  const conditionType = input.conditionType.trim().toUpperCase();
  if (!TYPE_CODE.test(conditionType)) {
    throw new PricingProcedureMaintenanceError(
      `A condition type is four letters or numbers, and ${input.conditionType.trim() || 'nothing'} is not.`,
      'Enter four characters, as the delivered master does: PR00, K007, KF00, MWST.',
    );
  }
  const conditionClass = input.conditionClass.trim().toUpperCase();
  if (!CONDITION_CLASSES.includes(conditionClass as (typeof CONDITION_CLASSES)[number])) {
    throw new PricingProcedureMaintenanceError(
      `Condition class ${input.conditionClass.trim() || '(none)'} is not one this system knows: ${CONDITION_CLASSES.join(', ')}.`,
      `Name one of ${CONDITION_CLASSES.join(', ')}. The class is what a total is made of and what the ledger is determined by.`,
    );
  }
  const calculationType = input.calculationType.trim().toUpperCase();
  if (!CALCULATION_TYPES.includes(calculationType as (typeof CALCULATION_TYPES)[number])) {
    throw new PricingProcedureMaintenanceError(
      `Calculation type ${input.calculationType.trim() || '(none)'} is not one the pricing engine executes: ${CALCULATION_TYPES.join(', ')}.`,
      `Name one of ${CALCULATION_TYPES.join(', ')}. A calculation the engine cannot execute is a step that prices nothing.`,
    );
  }
  const accountKey = (input.accountKey ?? '').trim().toUpperCase() || null;
  if (accountKey && !/^[A-Z0-9]{3}$/.test(accountKey)) {
    throw new PricingProcedureMaintenanceError(
      `Account key ${accountKey} is not three characters, as the revenue keys are.`,
      'Name a three-character key, as ERL, ERS, ERF and MWS are.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const [inserted] = await tx.insert(salesConditionType).values({
      client: input.client,
      conditionType,
      name: input.name.trim(),
      conditionClass,
      calculationType,
      isNegative: input.isNegative,
      isStatistical: input.isStatistical,
      accountKey,
      createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ conditionType: salesConditionType.conditionType });
    if (!inserted) {
      throw new PricingProcedureMaintenanceError(
        `Condition type ${conditionType} already stands for this tenant.`,
        'Change the type that stands rather than redefining it: every record and every step names the type that stands.',
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: CONDITION_TYPE_OBJECT_CLASS, objectKey: conditionType,
      changeType: 'CREATE', changedBy: input.changedBy,
      after: { name: input.name.trim(), conditionClass, calculationType, accountKey },
    });
    return { conditionType };
  });
}

/**
 * Change a condition type: the name a screen shows, what it adds to or takes away, whether it is
 * statistical, the key the ledger is found by, and whether it is offered at all.
 *
 * The class and the calculation are not changed here. They are what the engine executes and what the
 * figures on a document mean; a type that needs another calculation is another type.
 */
export async function changeConditionType(input: {
  client: string; changedBy: string; conditionType: string;
  name?: string; isNegative?: boolean; isStatistical?: boolean;
  accountKey?: string | null; isActive?: boolean;
}): Promise<{ conditionType: string }> {
  const conditionType = input.conditionType.trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(salesConditionType).where(and(
      eq(salesConditionType.client, input.client),
      eq(salesConditionType.conditionType, conditionType),
    )).limit(1);
    if (!standing) {
      throw new PricingProcedureMaintenanceError(
        `Condition type ${conditionType} does not stand for this tenant, so there is nothing to change.`,
        `Define it at ${PRICING_PROCEDURE_ROUTE} first.`,
      );
    }
    if (input.isActive === false && (await stepsOrRecordsStanding(tx, input.client, conditionType)) > 0) {
      const [usage] = await tx.execute(sql`
        select (select count(*) from sales_condition_record r
                 where r.client = ${input.client} and r.condition_type = ${conditionType})
               + (select count(*) from sales_pricing_procedure_step s
                   where s.client = ${input.client} and s.condition_type = ${conditionType} and s.is_active)
               as usage
      `) as unknown as Array<{ usage: string | number }>;
      throw new PricingProcedureMaintenanceError(
        `Condition type ${conditionType} still carries ${Number(usage?.usage ?? 0)} records or steps, so it cannot be withdrawn.`,
        'Withdraw the steps that use it and close the records maintained under it, then withdraw the type. A type that quietly disappears changes how every future document is priced.',
      );
    }
    const values: Record<string, unknown> = { changedBy: input.changedBy, changedAt: new Date() };
    if (input.name !== undefined) values.name = input.name.trim();
    if (input.isNegative !== undefined) values.isNegative = input.isNegative;
    if (input.isStatistical !== undefined) values.isStatistical = input.isStatistical;
    if (input.accountKey !== undefined) values.accountKey = (input.accountKey ?? '').trim().toUpperCase() || null;
    if (input.isActive !== undefined) values.isActive = input.isActive;
    await tx.update(salesConditionType).set(values).where(and(
      eq(salesConditionType.client, input.client),
      eq(salesConditionType.conditionType, conditionType),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: CONDITION_TYPE_OBJECT_CLASS, objectKey: conditionType,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { name: standing.name, accountKey: standing.accountKey, isActive: standing.isActive },
      after: values,
    });
    return { conditionType };
  });
}

async function stepsOrRecordsStanding(tx: Tx, client: string, conditionType: string): Promise<number> {
  const [row] = await tx.execute(sql`
    select (select count(*) from sales_condition_record r
             where r.client = ${client} and r.condition_type = ${conditionType})
           + (select count(*) from sales_pricing_procedure_step s
               where s.client = ${client} and s.condition_type = ${conditionType} and s.is_active) as usage
  `) as unknown as Array<{ usage: string | number }>;
  return Number(row?.usage ?? 0);
}

/** Define a pricing procedure: a named, ordered set of steps. */
export async function definePricingProcedure(input: {
  client: string; changedBy: string; procedureCode: string; name: string;
}): Promise<{ procedureCode: string }> {
  const procedureCode = input.procedureCode.trim().toUpperCase();
  if (!CODE.test(procedureCode)) {
    throw new PricingProcedureMaintenanceError(
      `A procedure code is at most six letters or numbers, and ${input.procedureCode.trim() || 'nothing'} is not.`,
      'Enter up to six characters, as the delivered procedure does: RVAA01.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const [inserted] = await tx.insert(salesPricingProcedure).values({
      client: input.client,
      procedureCode,
      name: input.name.trim(),
      createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ procedureCode: salesPricingProcedure.procedureCode });
    if (!inserted) {
      throw new PricingProcedureMaintenanceError(
        `Pricing procedure ${procedureCode} already stands for this tenant.`,
        'Change the procedure that stands, or add steps to it. Two procedures cannot answer for one determination.',
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: PRICING_PROCEDURE_OBJECT_CLASS, objectKey: procedureCode,
      changeType: 'CREATE', changedBy: input.changedBy, after: { name: input.name.trim() },
    });
    return { procedureCode };
  });
}

/** Change a procedure: the name a screen shows, and whether it is offered at all. */
export async function changePricingProcedure(input: {
  client: string; changedBy: string; procedureCode: string; name?: string; isActive?: boolean;
}): Promise<{ procedureCode: string }> {
  const procedureCode = input.procedureCode.trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(salesPricingProcedure).where(and(
      eq(salesPricingProcedure.client, input.client),
      eq(salesPricingProcedure.procedureCode, procedureCode),
    )).limit(1);
    if (!standing) {
      throw new PricingProcedureMaintenanceError(
        `Pricing procedure ${procedureCode} does not stand for this tenant, so there is nothing to change.`,
        `Define it at ${PRICING_PROCEDURE_ROUTE} first.`,
      );
    }
    const values: Record<string, unknown> = { changedBy: input.changedBy, changedAt: new Date() };
    if (input.name !== undefined) values.name = input.name.trim();
    if (input.isActive !== undefined) values.isActive = input.isActive;
    await tx.update(salesPricingProcedure).set(values).where(and(
      eq(salesPricingProcedure.client, input.client),
      eq(salesPricingProcedure.procedureCode, procedureCode),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: PRICING_PROCEDURE_OBJECT_CLASS, objectKey: procedureCode,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { name: standing.name, isActive: standing.isActive }, after: values,
    });
    return { procedureCode };
  });
}

/**
 * Add a step to a procedure: a condition type, where in the order it is executed, the span of steps its
 * percentage is calculated on, whether the document may go without it, and whether it stands once for
 * the document or once for every item.
 */
export async function addPricingProcedureStep(input: {
  client: string; changedBy: string; procedureCode: string; stepNumber: number; conditionType: string;
  fromStep?: number | null; toStep?: number | null; isRequired?: boolean; conditionLevel?: string;
}): Promise<{ procedureCode: string; stepNumber: number }> {
  const procedureCode = input.procedureCode.trim().toUpperCase();
  const conditionType = input.conditionType.trim().toUpperCase();
  const conditionLevel = (input.conditionLevel ?? 'ITEM').trim().toUpperCase();
  if (!CONDITION_LEVELS.includes(conditionLevel as (typeof CONDITION_LEVELS)[number])) {
    throw new PricingProcedureMaintenanceError(
      `A step stands at the item or at the header, and ${input.conditionLevel} is neither.`,
      'Name ITEM for a step that prices every line, or HEADER for one that prices the document and is distributed to the lines.',
    );
  }
  if (!Number.isInteger(input.stepNumber) || input.stepNumber <= 0) {
    throw new PricingProcedureMaintenanceError(
      `A step number is a whole number greater than zero, and ${input.stepNumber} is not.`,
      'Number the steps in tens, as the delivered procedure does, so a later step can be inserted between two.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const [procedure] = await tx.select().from(salesPricingProcedure).where(and(
      eq(salesPricingProcedure.client, input.client),
      eq(salesPricingProcedure.procedureCode, procedureCode),
    )).limit(1);
    if (!procedure) {
      throw new PricingProcedureMaintenanceError(
        `Pricing procedure ${procedureCode} does not stand for this tenant, so no step can be added to it.`,
        `Define the procedure at ${PRICING_PROCEDURE_ROUTE} first.`,
      );
    }
    const type = await requireConditionType(tx, input.client, conditionType);
    const fromStep = input.fromStep ?? null;
    const toStep = input.toStep ?? null;
    if ((fromStep === null) !== (toStep === null)) {
      throw new PricingProcedureMaintenanceError(
        'A step names both ends of the span it is calculated on, or neither.',
        'Name the first and the last step of the span, or leave both blank where the step needs no base.',
      );
    }
    if (fromStep !== null && toStep !== null && fromStep > toStep) {
      throw new PricingProcedureMaintenanceError(
        `The span of step ${input.stepNumber} runs from ${fromStep} to ${toStep}, which ends before it starts.`,
        'Name the earlier step first: a span is read in the order the steps stand, not in the order they are typed.',
      );
    }
    if (type.calculationType === 'PERCENTAGE' && fromStep === null) {
      throw new PricingProcedureMaintenanceError(
        `Condition type ${conditionType} is calculated as a percentage, and step ${input.stepNumber} names no span to calculate it on.`,
        'Name the span of steps the percentage is taken on — the price alone is step 10 to step 10.',
      );
    }
    if (conditionLevel === 'HEADER' && type.calculationType === 'MATERIAL_COST') {
      throw new PricingProcedureMaintenanceError(
        `Condition type ${conditionType} is a cost read from the material, and a header condition names no material to read it from.`,
        'Stand the step at the item level, where the material is known.',
      );
    }
    const [inserted] = await tx.insert(salesPricingProcedureStep).values({
      client: input.client,
      procedureCode,
      stepNumber: input.stepNumber,
      conditionType,
      fromStep,
      toStep,
      isRequired: input.isRequired ?? false,
      conditionLevel,
      createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ stepNumber: salesPricingProcedureStep.stepNumber });
    if (!inserted) {
      throw new PricingProcedureMaintenanceError(
        `Step ${input.stepNumber} already stands in procedure ${procedureCode}.`,
        'Number the step elsewhere, or change the step that stands.',
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: PRICING_PROCEDURE_OBJECT_CLASS,
      objectKey: `${procedureCode}/${input.stepNumber}`, changeType: 'CREATE', changedBy: input.changedBy,
      after: { conditionType, fromStep, toStep, isRequired: input.isRequired ?? false, conditionLevel },
    });
    return { procedureCode, stepNumber: input.stepNumber };
  });
}

/**
 * Change a step: the span, whether it is required, the level it stands at, and whether it is executed at
 * all. A step is withdrawn rather than deleted, because the documents priced by this procedure keep the
 * rule they were priced under.
 */
export async function changePricingProcedureStep(input: {
  client: string; changedBy: string; procedureCode: string; stepNumber: number;
  fromStep?: number | null; toStep?: number | null; isRequired?: boolean;
  conditionLevel?: string; isActive?: boolean;
}): Promise<{ procedureCode: string; stepNumber: number }> {
  const procedureCode = input.procedureCode.trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(salesPricingProcedureStep).where(and(
      eq(salesPricingProcedureStep.client, input.client),
      eq(salesPricingProcedureStep.procedureCode, procedureCode),
      eq(salesPricingProcedureStep.stepNumber, input.stepNumber),
    )).limit(1);
    if (!standing) {
      throw new PricingProcedureMaintenanceError(
        `Step ${input.stepNumber} does not stand in procedure ${procedureCode}, so there is nothing to change.`,
        `Add the step at ${PRICING_PROCEDURE_ROUTE} first.`,
      );
    }
    const type = await requireConditionType(tx, input.client, standing.conditionType);
    const fromStep = input.fromStep === undefined ? standing.fromStep : input.fromStep;
    const toStep = input.toStep === undefined ? standing.toStep : input.toStep;
    if ((fromStep === null) !== (toStep === null)) {
      throw new PricingProcedureMaintenanceError(
        'A step names both ends of the span it is calculated on, or neither.',
        'Name the first and the last step of the span, or leave both blank where the step needs no base.',
      );
    }
    if (fromStep !== null && toStep !== null && fromStep > toStep) {
      throw new PricingProcedureMaintenanceError(
        `The span of step ${input.stepNumber} runs from ${fromStep} to ${toStep}, which ends before it starts.`,
        'Name the earlier step first: a span is read in the order the steps stand, not in the order they are typed.',
      );
    }
    if (type.calculationType === 'PERCENTAGE' && fromStep === null) {
      throw new PricingProcedureMaintenanceError(
        `Condition type ${standing.conditionType} is calculated as a percentage, and the step names no span to calculate it on.`,
        'Name the span of steps the percentage is taken on — the price alone is step 10 to step 10.',
      );
    }
    let conditionLevel = standing.conditionLevel;
    if (input.conditionLevel !== undefined) {
      conditionLevel = input.conditionLevel.trim().toUpperCase();
      if (!CONDITION_LEVELS.includes(conditionLevel as (typeof CONDITION_LEVELS)[number])) {
        throw new PricingProcedureMaintenanceError(
          `A step stands at the item or at the header, and ${input.conditionLevel} is neither.`,
          'Name ITEM for a step that prices every line, or HEADER for one that prices the document and is distributed to the lines.',
        );
      }
      if (conditionLevel === 'HEADER' && type.calculationType === 'MATERIAL_COST') {
        throw new PricingProcedureMaintenanceError(
          `Condition type ${standing.conditionType} is a cost read from the material, and a header condition names no material to read it from.`,
          'Stand the step at the item level, where the material is known.',
        );
      }
    }
    const values = {
      fromStep,
      toStep,
      isRequired: input.isRequired ?? standing.isRequired,
      conditionLevel,
      isActive: input.isActive ?? standing.isActive,
      changedBy: input.changedBy,
      changedAt: new Date(),
    };
    await tx.update(salesPricingProcedureStep).set(values).where(and(
      eq(salesPricingProcedureStep.client, input.client),
      eq(salesPricingProcedureStep.procedureCode, procedureCode),
      eq(salesPricingProcedureStep.stepNumber, input.stepNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: PRICING_PROCEDURE_OBJECT_CLASS,
      objectKey: `${procedureCode}/${input.stepNumber}`, changeType: 'CHANGE', changedBy: input.changedBy,
      before: {
        fromStep: standing.fromStep, toStep: standing.toStep, isRequired: standing.isRequired,
        conditionLevel: standing.conditionLevel, isActive: standing.isActive,
      },
      after: values,
    });
    return { procedureCode, stepNumber: input.stepNumber };
  });
}

async function requireConditionType(
  tx: Tx,
  client: string,
  conditionType: string,
): Promise<{ conditionType: string; name: string; conditionClass: string; calculationType: string }> {
  const [type] = await tx.select({
    conditionType: salesConditionType.conditionType,
    name: salesConditionType.name,
    conditionClass: salesConditionType.conditionClass,
    calculationType: salesConditionType.calculationType,
  }).from(salesConditionType).where(and(
    eq(salesConditionType.client, client),
    eq(salesConditionType.conditionType, conditionType),
  )).limit(1);
  if (!type) {
    throw new PricingProcedureMaintenanceError(
      `Condition type ${conditionType} does not stand for this tenant, so no step can be written for it.`,
      `Define the condition type at ${PRICING_PROCEDURE_ROUTE} first. A step whose type does not stand is a step the engine cannot execute.`,
    );
  }
  if (type.calculationType === 'MATERIAL_COST') return { ...type };
  return type;
}

/**
 * Define which procedure prices a document: the sales area, the procedure the document type carries and
 * the one the customer carries, and the procedure that answers for them. A blank sales area means every
 * area, and `*` means every customer procedure — both are rows, not fallbacks, so what the wildcard
 * grants can be read and replaced.
 */
export async function defineProcedureDetermination(input: {
  client: string; changedBy: string;
  salesOrg?: string; distributionChannel?: string; division?: string;
  documentPricingProcedure: string; customerPricingProcedure: string; procedureCode: string;
}): Promise<void> {
  const salesOrg = (input.salesOrg ?? '').trim().toUpperCase();
  const distributionChannel = (input.distributionChannel ?? '').trim().toUpperCase();
  const division = (input.division ?? '').trim().toUpperCase();
  const customerPricingProcedure = input.customerPricingProcedure.trim().toUpperCase() || '*';
  if (!AREA_CODE.test(salesOrg) || !/^[A-Z0-9]{0,2}$/.test(distributionChannel) || !/^[A-Z0-9]{0,2}$/.test(division)) {
    throw new PricingProcedureMaintenanceError(
      'A sales area is named by up to four characters of sales organization and two each of channel and division.',
      'Leave all three blank for every sales area, or name the area the row answers for.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const [procedure] = await tx.select().from(salesPricingProcedure).where(and(
      eq(salesPricingProcedure.client, input.client),
      eq(salesPricingProcedure.procedureCode, input.procedureCode.trim().toUpperCase()),
    )).limit(1);
    if (!procedure) {
      throw new PricingProcedureMaintenanceError(
        `Pricing procedure ${input.procedureCode.trim().toUpperCase()} does not stand for this tenant, so no determination can point at it.`,
        `Define the procedure at ${PRICING_PROCEDURE_ROUTE} first.`,
      );
    }
    const [inserted] = await tx.insert(salesProcedureDetermination).values({
      client: input.client,
      salesOrg,
      distributionChannel,
      division,
      documentPricingProcedure: input.documentPricingProcedure.trim().toUpperCase(),
      customerPricingProcedure,
      procedureCode: input.procedureCode.trim().toUpperCase(),
      createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ procedureCode: salesProcedureDetermination.procedureCode });
    if (!inserted) {
      throw new PricingProcedureMaintenanceError(
        'A determination already stands for that sales area, document procedure and customer procedure.',
        'Two rows cannot answer for one combination: the engine would have to choose, and a price nobody can name the rule for is not a price.',
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: DETERMINATION_OBJECT_CLASS,
      objectKey: `${salesOrg}/${distributionChannel}/${division}/${input.documentPricingProcedure}/${customerPricingProcedure}`,
      changeType: 'CREATE', changedBy: input.changedBy,
      after: { procedureCode: input.procedureCode.trim().toUpperCase() },
    });
  });
}

/** Repoint a determination at another procedure. */
export async function changeProcedureDetermination(input: {
  client: string; changedBy: string;
  salesOrg: string; distributionChannel: string; division: string;
  documentPricingProcedure: string; customerPricingProcedure: string; procedureCode: string;
}): Promise<void> {
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(salesProcedureDetermination).where(and(
      eq(salesProcedureDetermination.client, input.client),
      eq(salesProcedureDetermination.salesOrg, input.salesOrg),
      eq(salesProcedureDetermination.distributionChannel, input.distributionChannel),
      eq(salesProcedureDetermination.division, input.division),
      eq(salesProcedureDetermination.documentPricingProcedure, input.documentPricingProcedure),
      eq(salesProcedureDetermination.customerPricingProcedure, input.customerPricingProcedure),
    )).limit(1);
    if (!standing) {
      throw new PricingProcedureMaintenanceError(
        'No determination stands for that combination, so there is nothing to change.',
        `Define it at ${PRICING_PROCEDURE_ROUTE} first.`,
      );
    }
    const [procedure] = await tx.select().from(salesPricingProcedure).where(and(
      eq(salesPricingProcedure.client, input.client),
      eq(salesPricingProcedure.procedureCode, input.procedureCode.trim().toUpperCase()),
    )).limit(1);
    if (!procedure) {
      throw new PricingProcedureMaintenanceError(
        `Pricing procedure ${input.procedureCode.trim().toUpperCase()} does not stand for this tenant, so no determination can point at it.`,
        `Define the procedure at ${PRICING_PROCEDURE_ROUTE} first.`,
      );
    }
    await tx.update(salesProcedureDetermination)
      .set({
        procedureCode: input.procedureCode.trim().toUpperCase(),
        changedBy: input.changedBy,
        changedAt: new Date(),
      })
      .where(and(
        eq(salesProcedureDetermination.client, input.client),
        eq(salesProcedureDetermination.salesOrg, input.salesOrg),
        eq(salesProcedureDetermination.distributionChannel, input.distributionChannel),
        eq(salesProcedureDetermination.division, input.division),
        eq(salesProcedureDetermination.documentPricingProcedure, input.documentPricingProcedure),
        eq(salesProcedureDetermination.customerPricingProcedure, input.customerPricingProcedure),
      ));
    await recordChange(tx, {
      client: input.client, objectClass: DETERMINATION_OBJECT_CLASS,
      objectKey: `${input.salesOrg}/${input.distributionChannel}/${input.division}/${input.documentPricingProcedure}/${input.customerPricingProcedure}`,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { procedureCode: standing.procedureCode },
      after: { procedureCode: input.procedureCode.trim().toUpperCase() },
    });
  });
}

/** How many condition records stand under a type: what the maintenance screen warns about. */
export async function conditionRecordsStanding(client: string, conditionType: string): Promise<number> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.execute(sql`select count(*)::int as n from sales_condition_record
      where client = ${client} and condition_type = ${conditionType}`) as unknown as Array<{ n: number }>;
    return Number(row?.n ?? 0);
  });
}
