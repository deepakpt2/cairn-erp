'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  PRICING_DEFINE_CAPABILITY,
  PricingProcedureMaintenanceError,
  addPricingProcedureStep,
  changeConditionType,
  changePricingProcedure,
  changePricingProcedureStep,
  changeProcedureDetermination,
  defineConditionType,
  definePricingProcedure,
  defineProcedureDetermination,
} from '@/modules/sales/pricing-procedure-maintenance';

export interface PricingActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/pricing-procedure';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optionalNumber(form: FormData, name: string): number | null {
  const raw = text(form, name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function flag(form: FormData, name: string): boolean {
  const raw = text(form, name);
  return raw === 'on' || raw === 'true' || raw === 'yes';
}

function refuse(error: unknown): PricingActionState {
  if (error instanceof PricingProcedureMaintenanceError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function denied(): PricingActionState {
  return {
    ok: false,
    message: `You do not hold the authority ${PRICING_DEFINE_CAPABILITY}.`,
    remedy: 'Ask an administrator for an exact-code role assignment; wildcard role patterns do not grant this authority.',
  };
}

/**
 * Define a condition type. The gate precedes the call, as it does on every configuration screen:
 * deciding what a figure on a customer's invoice means is not a sales act.
 */
export async function defineConditionTypeAction(
  _previous: PricingActionState,
  form: FormData,
): Promise<PricingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PRICING_DEFINE_CAPABILITY)) return denied();
  try {
    const { conditionType } = await defineConditionType({
      client: session.user.client,
      changedBy: session.user.username,
      conditionType: text(form, 'conditionType'),
      name: text(form, 'name'),
      conditionClass: text(form, 'conditionClass'),
      calculationType: text(form, 'calculationType'),
      isNegative: flag(form, 'isNegative'),
      isStatistical: flag(form, 'isStatistical'),
      accountKey: text(form, 'accountKey') || null,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Condition type ${conditionType} now stands, and a step may be written for it.` };
  } catch (error) {
    return refuse(error);
  }
}

/** Change a condition type: what a screen shows, whether it takes away, and whether it is offered. */
export async function changeConditionTypeAction(
  _previous: PricingActionState,
  form: FormData,
): Promise<PricingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PRICING_DEFINE_CAPABILITY)) return denied();
  try {
    const conditionType = text(form, 'conditionType');
    const isActive = text(form, 'isActive');
    const { conditionType: saved } = await changeConditionType({
      client: session.user.client,
      changedBy: session.user.username,
      conditionType,
      name: text(form, 'name') || undefined,
      accountKey: text(form, 'accountKey') || undefined,
      isStatistical: flag(form, 'isStatistical'),
      isNegative: flag(form, 'isNegative'),
      isActive: isActive ? isActive === 'true' : undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Condition type ${saved} stands as it is now written.` };
  } catch (error) {
    return refuse(error);
  }
}

/** Define a procedure: a named set of steps, which is worth nothing until the steps stand. */
export async function defineProcedureAction(
  _previous: PricingActionState,
  form: FormData,
): Promise<PricingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PRICING_DEFINE_CAPABILITY)) return denied();
  try {
    const { procedureCode } = await definePricingProcedure({
      client: session.user.client,
      changedBy: session.user.username,
      procedureCode: text(form, 'procedureCode'),
      name: text(form, 'name'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Procedure ${procedureCode} stands. It prices nothing until it carries a step.` };
  } catch (error) {
    return refuse(error);
  }
}

/** Change a procedure: the name a screen shows, and whether it is offered to the determination. */
export async function changeProcedureAction(
  _previous: PricingActionState,
  form: FormData,
): Promise<PricingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PRICING_DEFINE_CAPABILITY)) return denied();
  try {
    const procedureCode = text(form, 'procedureCode');
    const isActive = text(form, 'isActive');
    await changePricingProcedure({
      client: session.user.client,
      changedBy: session.user.username,
      procedureCode,
      name: text(form, 'name') || undefined,
      isActive: isActive ? isActive === 'true' : undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Procedure ${procedureCode} stands as it is now written.` };
  } catch (error) {
    return refuse(error);
  }
}

/** Add a step: the condition type, where it is executed, and the span its percentage is taken on. */
export async function addStepAction(
  _previous: PricingActionState,
  form: FormData,
): Promise<PricingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PRICING_DEFINE_CAPABILITY)) return denied();
  try {
    const stepNumber = Number(text(form, 'stepNumber'));
    const { procedureCode } = await addPricingProcedureStep({
      client: session.user.client,
      changedBy: session.user.username,
      procedureCode: text(form, 'procedureCode'),
      stepNumber,
      conditionType: text(form, 'conditionType'),
      fromStep: optionalNumber(form, 'fromStep'),
      toStep: optionalNumber(form, 'toStep'),
      isRequired: flag(form, 'isRequired'),
      conditionLevel: text(form, 'conditionLevel') || 'ITEM',
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Step ${stepNumber} of ${procedureCode} now stands.` };
  } catch (error) {
    return refuse(error);
  }
}

/** Change a step: the span, whether the document may go without it, and whether it is executed. */
export async function changeStepAction(
  _previous: PricingActionState,
  form: FormData,
): Promise<PricingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PRICING_DEFINE_CAPABILITY)) return denied();
  try {
    const stepNumber = Number(text(form, 'stepNumber'));
    const isActive = text(form, 'isActive');
    await changePricingProcedureStep({
      client: session.user.client,
      changedBy: session.user.username,
      procedureCode: text(form, 'procedureCode'),
      stepNumber,
      fromStep: optionalNumber(form, 'fromStep'),
      toStep: optionalNumber(form, 'toStep'),
      isRequired: flag(form, 'isRequired'),
      conditionLevel: text(form, 'conditionLevel') || undefined,
      isActive: isActive ? isActive === 'true' : undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Step ${stepNumber} stands as it is now written.` };
  } catch (error) {
    return refuse(error);
  }
}

/** Define which procedure answers for a sales area, a document type and a customer. */
export async function defineDeterminationAction(
  _previous: PricingActionState,
  form: FormData,
): Promise<PricingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PRICING_DEFINE_CAPABILITY)) return denied();
  try {
    await defineProcedureDetermination({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg: text(form, 'salesOrg'),
      distributionChannel: text(form, 'distributionChannel'),
      division: text(form, 'division'),
      documentPricingProcedure: text(form, 'documentPricingProcedure'),
      customerPricingProcedure: text(form, 'customerPricingProcedure') || '*',
      procedureCode: text(form, 'procedureCode'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: 'The determination stands: documents of that type, for that customer, are priced by the procedure named.',
    };
  } catch (error) {
    return refuse(error);
  }
}

/** Repoint a determination at another procedure. */
export async function changeDeterminationAction(
  _previous: PricingActionState,
  form: FormData,
): Promise<PricingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PRICING_DEFINE_CAPABILITY)) return denied();
  try {
    await changeProcedureDetermination({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg: text(form, 'salesOrg'),
      distributionChannel: text(form, 'distributionChannel'),
      division: text(form, 'division'),
      documentPricingProcedure: text(form, 'documentPricingProcedure'),
      customerPricingProcedure: text(form, 'customerPricingProcedure'),
      procedureCode: text(form, 'procedureCode'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: 'The determination points at the procedure now named.' };
  } catch (error) {
    return refuse(error);
  }
}
