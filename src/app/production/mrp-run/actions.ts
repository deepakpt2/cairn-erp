'use server';

import { can, requireSession } from '@/platform/auth/current';
import {
  MRP_REGENERATE_CAPABILITY,
  MRP_RUN_CAPABILITY,
  MRP_RUN_ROUTE,
  MrpRunError,
  cancelMrpRun,
  mrpNamedRefusal,
  planMaterials,
  type MrpRunView,
} from '@/modules/production/mrp-run';

export interface MrpActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  run?: MrpRunView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function namedFields(form: FormData): Record<string, string> {
  return {
    mrpArea: text(form, 'mrpArea'),
    scheduleLine: text(form, 'scheduleLine'),
    background: text(form, 'background'),
    parallel: text(form, 'parallel'),
    deleteAndRecreate: text(form, 'deleteAndRecreate'),
    recreate: text(form, 'recreate'),
    calendar: text(form, 'calendar'),
    bom: text(form, 'bom'),
    companyCode: text(form, 'companyCode'),
    uuid: text(form, 'uuid'),
    post: text(form, 'post'),
    outbox: text(form, 'outbox'),
    period: text(form, 'period'),
    proposalQuantity: text(form, 'proposalQuantity'),
    bookQuantity: text(form, 'bookQuantity'),
  };
}

export async function planMaterialsAction(
  _previous: MrpActionState,
  form: FormData,
): Promise<MrpActionState> {
  const session = await requireSession(MRP_RUN_ROUTE);
  if (!can(session, MRP_RUN_CAPABILITY)) {
    return { ok: false, message: `You do not hold the planning capability (${MRP_RUN_CAPABILITY}).` };
  }
  const named = namedFields(form);
  const refused = mrpNamedRefusal(named);
  if (refused) return { ok: false, message: refused };
  const processingKey = text(form, 'processingKey').toUpperCase();
  if (processingKey === 'NEUPL' && !can(session, MRP_REGENERATE_CAPABILITY)) {
    return { ok: false, message: `You do not hold the regenerative planning capability (${MRP_REGENERATE_CAPABILITY}).` };
  }
  const check = text(form, 'intent') === 'check';
  try {
    const run = await planMaterials({
      client: session.user.client,
      requestedBy: session.user.username,
      requestKey: text(form, 'requestKey'),
      processingKey,
      plantFrom: text(form, 'plantFrom'),
      plantTo: text(form, 'plantTo') || undefined,
      materialFrom: text(form, 'materialFrom') || undefined,
      materialTo: text(form, 'materialTo') || undefined,
      mrpController: text(form, 'mrpController') || undefined,
      horizonStart: text(form, 'horizonStart') || undefined,
      horizonEnd: text(form, 'horizonEnd') || undefined,
      simulationOnly: check || text(form, 'simulationOnly') === 'on',
      confirmRegenerative: text(form, 'confirmRegenerative') === 'on',
      executionMode: text(form, 'executionMode') || undefined,
      planningMode: text(form, 'planningMode') || undefined,
      named,
    });
    return {
      ok: true,
      message: check
        ? `Check ${run.runNumber} wrote nothing. The run stands at ${run.status}.`
        : `Run ${run.runNumber} stands at ${run.status}.`,
      run,
    };
  } catch (caught) {
    if (caught instanceof MrpRunError) return { ok: false, message: caught.message, remedy: caught.remedy };
    throw caught;
  }
}

export async function cancelMrpRunAction(
  _previous: MrpActionState,
  form: FormData,
): Promise<MrpActionState> {
  const session = await requireSession(MRP_RUN_ROUTE);
  if (!can(session, MRP_RUN_CAPABILITY)) {
    return { ok: false, message: `You do not hold the planning capability (${MRP_RUN_CAPABILITY}).` };
  }
  const refused = mrpNamedRefusal(namedFields(form));
  if (refused) return { ok: false, message: refused };
  try {
    const run = await cancelMrpRun(session.user.client, text(form, 'runNumber'), session.user.username);
    return { ok: true, message: `Run ${run.runNumber} stands at ${run.status}.`, run };
  } catch (caught) {
    if (caught instanceof MrpRunError) return { ok: false, message: caught.message, remedy: caught.remedy };
    throw caught;
  }
}
